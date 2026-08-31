#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "packages", "cli", "dist", "main.js");

function fail(message) {
	throw new Error(message);
}

function relativeScope(value, flag) {
	if (!value || isAbsolute(value) || value.includes("\0") || value.split(/[\\/]+/).includes("..")) {
		fail(`${flag} must be a relative path that stays inside the reviewed repository`);
	}
	return value;
}

export function parseOmpWorkerArgs(args) {
	let timeoutSeconds = 3_600;
	let reportOnlyCostUsdMicros = 50_000;
	let routeProfile = process.env.OX_DRIVER_OMP_PROFILE?.trim() || "omp-default";
	let profileDirectory;
	let expectedWorkspaceSha256;
	let expectedRouteProfileSha256;
	const excludedPaths = [".env", ".git"];
	const acceptanceCommands = [];
	const positional = [];
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--timeout") {
			timeoutSeconds = Number(args[++index]);
			if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) fail("--timeout must be an integer from 1 to 86400 seconds");
		} else if (argument === "--cost-ceiling") {
			const dollars = Number(args[++index]);
			const micros = Math.round(dollars * 1_000_000);
			if (!Number.isFinite(dollars) || dollars < 0 || !Number.isSafeInteger(micros)) fail("--cost-ceiling must be a non-negative dollar amount representable in integer micros");
			reportOnlyCostUsdMicros = micros;
		} else if (argument === "--route") routeProfile = args[++index]?.trim() || fail("--route requires a profile id");
		else if (argument === "--profile-dir") {
			profileDirectory = args[++index]?.trim() || fail("--profile-dir requires an absolute directory");
			if (!isAbsolute(profileDirectory)) fail("--profile-dir requires an absolute directory");
		} else if (argument === "--expected-workspace-sha256") {
			expectedWorkspaceSha256 = args[++index]?.trim();
			if (!expectedWorkspaceSha256 || !/^[0-9a-f]{64}$/.test(expectedWorkspaceSha256)) fail("--expected-workspace-sha256 requires a lowercase SHA-256 digest");
		} else if (argument === "--expected-route-profile-sha256") {
			expectedRouteProfileSha256 = args[++index]?.trim();
			if (!expectedRouteProfileSha256 || !/^[0-9a-f]{64}$/.test(expectedRouteProfileSha256)) fail("--expected-route-profile-sha256 requires a lowercase SHA-256 digest");
		} else if (argument === "--check") acceptanceCommands.push(args[++index]?.trim() || fail("--check requires a command"));
		else if (argument === "--exclude") excludedPaths.push(relativeScope(args[++index], "--exclude"));
		else if (argument === "--owned") fail("OMP review lanes cannot own writable paths");
		else if (argument === "--writer") fail("OMP lanes are read-only");
		else if (argument === "--agent" || argument === "--child-agent") fail(`OMP lanes do not accept ${argument}`);
		else if (argument?.startsWith("--")) fail(`unknown option: ${argument}`);
		else positional.push(argument);
	}
	const [repository, ...objectiveParts] = positional;
	if (!repository || objectiveParts.length === 0) fail("usage: ox_omp.mjs <repository> <objective...> [--exclude path] [--check command] [--route id] [--timeout seconds] [--cost-ceiling dollars]");
	return {
		repository: resolve(repository),
		objective: objectiveParts.join(" "),
		timeoutSeconds,
		reportOnlyCostUsdMicros,
		routeProfile,
		profileDirectory,
		expectedWorkspaceSha256,
		expectedRouteProfileSha256,
		excludedPaths: [...new Set(excludedPaths)],
		acceptanceCommands: [...new Set(acceptanceCommands)],
	};
}

export function buildOmpWorkerSpec(options, cwd) {
	return {
		version: 1,
		tier: "attested",
		harness: "omp",
		routeProfile: options.routeProfile,
		task: {
			objective: options.objective,
			cwd,
			ownedPaths: [],
			excludedPaths: options.excludedPaths,
			...(options.expectedWorkspaceSha256 ? { expectedWorkspaceSha256: options.expectedWorkspaceSha256 } : {}),
		},
		execution: {
			session: "ephemeral",
			topology: "solo",
			writerPolicy: "read-only",
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
	const options = parseOmpWorkerArgs(process.argv.slice(2));
	const cwd = await realpath(options.repository);
	const spec = buildOmpWorkerSpec(options, cwd);
	const scratch = await mkdtemp(`${tmpdir()}/ox-omp-spec-`);
	const specPath = resolve(scratch, "run.json");
	const requestedRunId = process.env.OX_DRIVER_REQUESTED_RUN_ID?.trim() || randomUUID();
	const env = {
		...process.env,
		OX_DRIVER_REQUESTED_RUN_ID: requestedRunId,
		...(options.profileDirectory ? { OX_DRIVER_ROUTE_PROFILE_DIR: options.profileDirectory } : {}),
	};
	try {
		await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		const exitCode = await new Promise((resolveRun, rejectRun) => {
			const child = spawn(process.execPath, [CLI, "run", specPath], { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"] });
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
