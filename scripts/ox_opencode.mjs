#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "packages/opencode-cli/dist/main.js");
const CORE = resolve(ROOT, "packages/core/dist/index.js");

function fail(message) {
	throw new Error(message);
}

function relativeScope(value, flag) {
	if (!value || isAbsolute(value) || value.includes("\0") || value.split(/[\\/]+/).includes("..")) {
		fail(`${flag} must be a relative path that stays inside the task repository`);
	}
	return value;
}

function parse(args) {
	let timeoutSeconds = 3_600;
	let reportOnlyCostUsdMicros = 50_000;
	let agentProfile;
	let routeProfile = process.env.OX_DRIVER_OPENCODE_PROFILE?.trim() || "opencode-default";
	let profileDirectory;
	let expectedWorkspaceSha256;
	let expectedRouteProfileSha256;
	const ownedPaths = [];
	const excludedPaths = [".env", ".git"];
	const acceptanceCommands = [];
	const childProfiles = [];
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
		} else if (argument === "--agent") {
			agentProfile = args[++index]?.trim() || fail("--agent requires a profile");
		} else if (argument === "--child-agent") {
			const child = args[++index]?.trim() || fail("--child-agent requires a profile");
			if (childProfiles.includes(child)) fail("--child-agent must not repeat a profile");
			childProfiles.push(child);
		} else if (argument === "--route") {
			routeProfile = args[++index]?.trim() || fail("--route requires a profile id");
		} else if (argument === "--profile-dir") {
			profileDirectory = args[++index]?.trim() || fail("--profile-dir requires an absolute directory");
			if (!isAbsolute(profileDirectory)) fail("--profile-dir must be an absolute directory");
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
		fail("usage: ox_opencode.mjs <repository> <objective...> [--owned path] [--exclude path] [--route id] [--profile-dir absolute-path] [--agent profile] [--child-agent profile] [--check command] [--timeout seconds] [--cost-ceiling dollars]");
	}
	return {
		repository: resolve(repository),
		objective: objectiveParts.join(" "),
		timeoutSeconds,
		reportOnlyCostUsdMicros,
		agentProfile,
		childProfiles,
		routeProfile,
		profileDirectory,
		expectedWorkspaceSha256,
		expectedRouteProfileSha256,
		acceptanceCommands,
		ownedPaths: ownedPaths.length > 0 ? [...new Set(ownedPaths)] : ["."],
		excludedPaths: [...new Set(excludedPaths)],
	};
}

async function resolveRoute(options) {
	const core = await import(pathToFileURL(CORE).href).catch(() => fail(`compiled core is unavailable at ${CORE}; run npm run build`));
	const configured = process.env.XDG_CONFIG_HOME?.trim();
	if (configured && !isAbsolute(configured)) fail("XDG_CONFIG_HOME must be an absolute path");
	const user = options.profileDirectory
		?? process.env.OX_DRIVER_ROUTE_PROFILE_DIR?.trim()
		?? join(configured || join(homedir(), ".config"), "ox-driver", "routes");
	if (!isAbsolute(user)) fail("route profile directory must be absolute");
	const bundled = resolve(ROOT, "profiles", "routes");
	for (const directory of [...new Set([user, bundled])]) {
		const path = join(directory, `${options.routeProfile}.json`);
		if (!await access(path).then(() => true, () => false)) continue;
		const profile = await core.loadRouteProfile(directory, options.routeProfile, { expectedHarness: "opencode", expectedTier: "trusted-host" });
		if (profile.route.source !== "explicit") fail("flat child receipts require an explicit provider/model/reasoning route profile");
		return { provider: profile.route.provider, model: profile.route.model, reasoning: profile.route.reasoning };
	}
	fail(`route profile ${options.routeProfile} was not found`);
}

async function main() {
	const options = parse(process.argv.slice(2));
	const cwd = await realpath(options.repository);
	const childRoute = options.childProfiles.length > 0 ? await resolveRoute(options) : undefined;
	const scratch = await mkdtemp(`${tmpdir()}/ox-opencode-spec-`);
	const specPath = resolve(scratch, "run.json");
	const spec = {
		version: 1,
		tier: "trusted-host",
		harness: "opencode",
		routeProfile: options.routeProfile,
		task: {
			objective: options.objective,
			cwd,
			ownedPaths: options.ownedPaths,
			excludedPaths: options.excludedPaths,
			...(options.expectedWorkspaceSha256 ? { expectedWorkspaceSha256: options.expectedWorkspaceSha256 } : {}),
		},
		execution: {
			session: "new",
			...(options.agentProfile ? { agentProfile: options.agentProfile } : {}),
			topology: childRoute ? "flat" : "solo",
			writerPolicy: "one-writer",
			network: "configured",
			timeoutSeconds: options.timeoutSeconds,
			...(childRoute ? {
				childPolicy: {
					allowedProfiles: options.childProfiles,
					allowedRoutes: [childRoute],
				},
			} : {}),
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
	try {
		await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		try {
			const result = await execFileAsync(process.execPath, [CLI, "run", specPath], {
				cwd: ROOT,
				env: {
					...process.env,
					...(options.profileDirectory ? { OX_DRIVER_ROUTE_PROFILE_DIR: options.profileDirectory } : {}),
				},
				maxBuffer: 32 * 1024 * 1024,
			});
			process.stdout.write(result.stdout);
			if (result.stderr) process.stderr.write(result.stderr);
		} catch (error) {
			const failed = error && typeof error === "object" ? error : {};
			if (typeof failed.stdout === "string" && failed.stdout) process.stdout.write(failed.stdout);
			if (typeof failed.stderr === "string" && failed.stderr) process.stderr.write(failed.stderr);
			if (typeof failed.stdout !== "string" || !failed.stdout) throw error;
			process.exitCode = typeof failed.code === "number" ? failed.code : 1;
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
