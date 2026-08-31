#!/usr/bin/env node

// Pi lane runner for herd, retry, and direct orchestrations. Read-only
// solo review remains the default. An explicit --writer selects a full-power
// trusted-host solo writer with real owned-path reconciliation. The script
// accepts the shared runWorker argv and dispatches one trusted-host Pi run
// through the controller CLI. The
// CLI's receipt JSON and its OX_DRIVER_RUN_ID stderr marker pass through
// untouched, so the shared supervisor can cancel and recover Pi lanes exactly
// like OpenCode lanes. --agent is refused (the Pi lane has no root profiles).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "packages/cli/dist/main.js");
const DEFAULT_PI_ROUTE_PROFILE = process.env.OX_DRIVER_PI_PROFILE?.trim() || "pi-protected-inherited";

function fail(message) {
	throw new Error(message);
}

function relativeScope(value, flag) {
	if (!value || isAbsolute(value) || value.includes("\0") || value.split(/[\\/]+/).includes("..")) {
		fail(`${flag} must be a relative path that stays inside the reviewed repository`);
	}
	return value;
}

export function parsePiWorkerArgs(args) {
	let timeoutSeconds = 3_600;
	let reportOnlyCostUsdMicros = 50_000;
	let writer = false;
	let route;
	let profileDirectory;
	let expectedWorkspaceSha256;
	let expectedRouteProfileSha256;
	const excludedPaths = [".env", ".git"];
	const ownedPaths = [];
	const acceptanceCommands = [];
	const positional = [];
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--timeout") {
			timeoutSeconds = Number(args[++index]);
			if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) fail("--timeout must be an integer from 1 to 86400 seconds");
		} else if (argument === "--cost-ceiling") {
			const dollars = Number(args[++index]);
			const micros = Math.round(dollars * 1_000_000);
			if (!Number.isFinite(dollars) || dollars < 0 || !Number.isSafeInteger(micros)) fail("--cost-ceiling must be a non-negative dollar amount representable in integer micros");
			reportOnlyCostUsdMicros = micros;
		} else if (argument === "--route") {
			route = args[++index]?.trim() || fail("--route requires a profile id");
		} else if (argument === "--profile-dir") {
			const directory = args[++index]?.trim() || fail("--profile-dir requires an absolute directory");
			if (!isAbsolute(directory)) fail("--profile-dir must be an absolute directory");
			profileDirectory = directory;
		} else if (argument === "--agent") {
			fail("a Pi lane does not accept --agent");
		} else if (argument === "--writer") {
			writer = true;
		} else if (argument === "--expected-workspace-sha256") {
			expectedWorkspaceSha256 = args[++index]?.trim();
			if (!expectedWorkspaceSha256 || !/^[0-9a-f]{64}$/.test(expectedWorkspaceSha256)) fail("--expected-workspace-sha256 requires a lowercase SHA-256 digest");
		} else if (argument === "--expected-route-profile-sha256") {
			expectedRouteProfileSha256 = args[++index]?.trim();
			if (!expectedRouteProfileSha256 || !/^[0-9a-f]{64}$/.test(expectedRouteProfileSha256)) fail("--expected-route-profile-sha256 requires a lowercase SHA-256 digest");
		} else if (argument === "--check") {
			const command = args[++index]?.trim();
			if (!command) fail("--check requires a non-empty controller-owned acceptance command");
			acceptanceCommands.push(command);
		} else if (argument === "--owned") ownedPaths.push(relativeScope(args[++index], "--owned"));
		else if (argument === "--exclude") excludedPaths.push(relativeScope(args[++index], "--exclude"));
		else if (argument?.startsWith("--")) fail(`unknown option: ${argument}`);
		else positional.push(argument);
	}
	const [repository, ...objectiveParts] = positional;
	if (!repository || objectiveParts.length === 0) {
		fail("usage: ox_pi.mjs <repository> <objective...> [--writer --owned path] [--exclude path] [--check command] [--timeout seconds] [--cost-ceiling dollars]");
	}
	if (writer && ownedPaths.length === 0) fail("--writer requires at least one --owned path");
	return {
		repository: resolve(repository),
		objective: objectiveParts.join(" "),
		timeoutSeconds,
		reportOnlyCostUsdMicros,
		routeProfile: route ?? DEFAULT_PI_ROUTE_PROFILE,
		profileDirectory,
		expectedWorkspaceSha256,
		expectedRouteProfileSha256,
		writer,
		acceptanceCommands,
		ownedPaths: [...new Set(ownedPaths)],
		excludedPaths: [...new Set(excludedPaths)],
	};
}

export function buildPiWorkerSpec(options, cwd) {
	return {
		version: 1,
		tier: "trusted-host",
		harness: "pi",
		routeProfile: options.routeProfile,
		task: {
			objective: options.writer
				? `${options.objective} Complete the work directly with the normal guarded Pi tools. Stay inside the declared owned paths, do not delegate, and finish with changed files, command results, and unresolved work.`
				: `${options.objective} Explore the repository with ls, grep, find, and read. Do not modify files or retry denied calls. Finish with a concise, source-path-grounded report.`,
			cwd,
			ownedPaths: options.writer ? options.ownedPaths : [],
			excludedPaths: options.excludedPaths,
			...(options.expectedWorkspaceSha256 ? { expectedWorkspaceSha256: options.expectedWorkspaceSha256 } : {}),
		},
		execution: {
			session: "ephemeral",
			topology: "solo",
			writerPolicy: options.writer ? "one-writer" : "read-only",
			network: "configured",
			timeoutSeconds: options.timeoutSeconds,
			...(options.expectedRouteProfileSha256 ? { expectedRouteProfileSha256: options.expectedRouteProfileSha256 } : {}),
			reportOnlyCostUsdMicros: options.reportOnlyCostUsdMicros,
		},
		acceptance: {
			commands: options.acceptanceCommands,
			requireCleanUnownedPaths: true,
			timeoutSeconds: options.timeoutSeconds,
			continueOnFailure: true,
		},
	};
}

async function main() {
	const options = parsePiWorkerArgs(process.argv.slice(2));
	const cwd = await realpath(options.repository);
	const spec = buildPiWorkerSpec(options, cwd);
	const scratch = await mkdtemp(`${tmpdir()}/ox-pi-spec-`);
	const specPath = resolve(scratch, "run.json");
	const requestedRunId = process.env.OX_DRIVER_REQUESTED_RUN_ID?.trim() || randomUUID();
	const env = {
		...process.env,
		OX_DRIVER_PI_TRUSTED_HOST: "1",
		OX_DRIVER_REQUESTED_RUN_ID: requestedRunId,
		...(options.profileDirectory ? { OX_DRIVER_ROUTE_PROFILE_DIR: options.profileDirectory } : {}),
	};
	// The usefulness-case wrapper changes the CLI output shape; lane receipts
	// must stay bare JSON for the shared worker collector.
	delete env.OX_DRIVER_PI_USEFULNESS_CASE_ROOT;
	delete env.OX_DRIVER_PI_USEFULNESS_CASE_SHA256;
	try {
		await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		const exitCode = await new Promise((resolveRun, rejectRun) => {
			const child = spawn(process.execPath, [CLI, "run", specPath], {
				cwd: ROOT,
				env,
				stdio: ["ignore", "inherit", "inherit"],
			});
			let terminating = false;
			const terminate = (signal) => {
				if (terminating) return;
				terminating = true;
				const cancel = spawn(process.execPath, [CLI, "cancel", requestedRunId], { cwd: ROOT, env, stdio: "ignore" });
				const fallback = setTimeout(() => child.kill(signal), 1_500);
				cancel.once("close", () => { clearTimeout(fallback); child.kill(signal); });
				cancel.once("error", () => { clearTimeout(fallback); child.kill(signal); });
			};
			const onInt = () => terminate("SIGINT");
			const onTerm = () => terminate("SIGTERM");
			process.on("SIGINT", onInt);
			process.on("SIGTERM", onTerm);
			child.once("error", rejectRun);
			child.once("close", (code) => {
				process.off("SIGINT", onInt);
				process.off("SIGTERM", onTerm);
				resolveRun(code ?? 1);
			});
		});
		process.exitCode = exitCode;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
