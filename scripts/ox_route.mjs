#!/usr/bin/env node

import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_LOADER = resolve(ROOT, "packages/core/dist/index.js");
const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_TIMEOUT_SECONDS = 3_600;
const DEFAULT_REPORT_ONLY_COST_USD_MICROS = 50_000;

const USAGE = `usage:
  ox_route.mjs init-opencode --launcher <command> --provider <provider> --model <model> --reasoning <effort> [options]
  ox_route.mjs init-pi       --launcher <command> --provider <provider> --model <model> --reasoning <effort> [options]
  ox_route.mjs init-omp      --launcher <command> --provider <provider> --model <model> --reasoning <effort>
                             --agent-dir <absolute-directory> --home-dir <absolute-directory> [options]
  ox_route.mjs check [--id <profile-id>] [--profile-dir <absolute-directory>]

shared options:
  --id <profile-id>                 Defaults to opencode-default, pi-default, or omp-default.
  --profile-dir <absolute-path>     Defaults to the user Ox Driver route directory.
  --expected-version <text>         Require this text in the launcher's version output.
  --expected-sha256 <digest>        Require this exact launcher digest.
  --force                           Replace an existing profile.

OpenCode also accepts --agent <profile>. OMP accepts repeated --env <NAME>
values. Environment names are recorded; values remain in the process
environment and are never written to the route profile.

Examples:
  ox_route.mjs init-opencode --launcher opencode --provider openrouter \\
    --model z-ai/glm-5.3-flash --reasoning max
  ox_route.mjs init-pi --launcher pi --provider openrouter \\
    --model z-ai/glm-5.3-flash --reasoning max --expected-version 0.84.4

Each init command writes a route profile without credentials. The installed
harness keeps responsibility for authentication. check validates a profile
through the compiled core loader and makes no model call.`;

function fail(message) { throw new Error(message); }

function bounded(value, flag, maximum) {
	if (typeof value !== "string" || !value || value.length > maximum || /[\0-\x1f\x7f]/.test(value)) {
		fail(`${flag} must be a non-empty string of at most ${maximum} characters without control characters`);
	}
	return value;
}

function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

function defaultProfileDirectory() {
	const configured = process.env.XDG_CONFIG_HOME?.trim();
	if (configured && !isAbsolute(configured)) fail("XDG_CONFIG_HOME must be an absolute path");
	return join(configured || join(homedir(), ".config"), "ox-driver", "routes");
}

function defaultId(command) {
	return command === "init-pi" ? "pi-default" : command === "init-omp" ? "omp-default" : "opencode-default";
}

function parse(argv) {
	const [command, ...rest] = argv;
	if (!["init-opencode", "init-pi", "init-omp", "check"].includes(command)) fail(USAGE);
	const valueFlags = new Set([
		"--launcher", "--provider", "--model", "--reasoning", "--agent", "--id", "--profile-dir",
		"--expected-version", "--expected-sha256", "--agent-dir", "--home-dir", "--env",
	]);
	const values = new Map();
	const environmentNames = [];
	let force = false;
	for (let index = 0; index < rest.length; index += 1) {
		const flag = rest[index];
		if (flag === "--force") {
			if (command === "check") fail(`unknown option for check: ${flag}\n\n${USAGE}`);
			force = true;
			continue;
		}
		if (!valueFlags.has(flag)) fail(`unknown option: ${flag}\n\n${USAGE}`);
		if (command === "check" && !["--id", "--profile-dir"].includes(flag)) fail(`unknown option for check: ${flag}\n\n${USAGE}`);
		const value = rest[++index]?.trim() || fail(`${flag} requires a value`);
		if (flag === "--env") {
			if (command !== "init-omp") fail("--env is available only for init-omp");
			if (!ENVIRONMENT_NAME.test(value)) fail("--env must be an uppercase environment-variable name");
			environmentNames.push(value);
			continue;
		}
		if (values.has(flag)) fail(`${flag} was given more than once`);
		values.set(flag, value);
	}
	const profileDirectory = values.get("--profile-dir") ?? defaultProfileDirectory();
	if (!isAbsolute(profileDirectory)) fail("--profile-dir must be an absolute directory");
	const id = values.get("--id") ?? defaultId(command);
	if (!PROFILE_ID.test(id)) fail("--id must be a canonical lowercase profile id (letters, digits, dot, underscore, hyphen)");
	if (command === "check") return { command, id, profileDirectory };
	for (const flag of ["--launcher", "--provider", "--model", "--reasoning"]) {
		if (!values.has(flag)) fail(`${flag} is required for ${command}\n\n${USAGE}`);
	}
	if (command === "init-omp") {
		for (const flag of ["--agent-dir", "--home-dir"]) if (!values.has(flag)) fail(`${flag} is required for init-omp`);
		if (!isAbsolute(values.get("--agent-dir")) || !isAbsolute(values.get("--home-dir"))) fail("--agent-dir and --home-dir must be absolute directories");
	}
	if (command !== "init-opencode" && values.has("--agent")) fail("--agent is available only for init-opencode");
	const expectedSha256 = values.get("--expected-sha256");
	if (expectedSha256 && !SHA256.test(expectedSha256)) fail("--expected-sha256 must be a lowercase SHA-256 digest");
	return {
		command,
		id,
		profileDirectory,
		force,
		launcher: bounded(values.get("--launcher"), "--launcher", 4096),
		provider: bounded(values.get("--provider"), "--provider", 256),
		model: bounded(values.get("--model"), "--model", 512),
		reasoning: bounded(values.get("--reasoning"), "--reasoning", 128),
		...(values.has("--agent") ? { agent: bounded(values.get("--agent"), "--agent", 256) } : {}),
		...(values.has("--expected-version") ? { expectedVersion: bounded(values.get("--expected-version"), "--expected-version", 128) } : {}),
		...(expectedSha256 ? { expectedSha256 } : {}),
		...(values.has("--agent-dir") ? { agentDirectory: values.get("--agent-dir") } : {}),
		...(values.has("--home-dir") ? { homeDirectory: values.get("--home-dir") } : {}),
		environmentNames: [...new Set(environmentNames)],
	};
}

async function coreLoader() {
	try {
		const core = await import(pathToFileURL(CORE_LOADER).href);
		if (typeof core.validateRouteProfile !== "function" || typeof core.loadRouteProfile !== "function") throw new Error("exports unavailable");
		return core;
	} catch {
		return fail(`the compiled core loader is unavailable at ${CORE_LOADER}; run \`npm run build\` first`);
	}
}

function profileFor(options) {
	const harness = options.command.slice("init-".length);
	const runtime = harness === "pi"
		? { mode: "direct", ...(options.expectedVersion ? { expectedVersion: options.expectedVersion } : {}), ...(options.expectedSha256 ? { expectedSha256: options.expectedSha256 } : {}) }
		: harness === "omp"
			? { mode: "guarded", agentDirectory: options.agentDirectory, homeDirectory: options.homeDirectory, environmentNames: options.environmentNames, ...(options.expectedVersion ? { expectedVersion: options.expectedVersion } : {}), ...(options.expectedSha256 ? { expectedSha256: options.expectedSha256 } : {}) }
			: undefined;
	return {
		version: 1,
		id: options.id,
		status: "active",
		harness,
		tier: harness === "omp" ? "attested" : "trusted-host",
		launcher: { command: options.launcher, versionArgs: ["--version"] },
		route: { source: "explicit", provider: options.provider, model: options.model, reasoning: options.reasoning },
		...(options.agent ? { agent: { defaultProfile: options.agent } } : {}),
		defaults: { timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, reportOnlyCostUsdMicros: DEFAULT_REPORT_ONLY_COST_USD_MICROS },
		...(runtime ? { runtime } : {}),
		pricingPolicy: "report-only",
		credentialPolicy: "from-installed-harness",
		notice: `Created by scripts/ox_route.mjs ${options.command}. This profile contains no credentials; the installed ${harness} launcher provides authentication.`,
	};
}

async function initProfile(options, core) {
	const profile = profileFor(options);
	core.validateRouteProfile(profile);
	if (profile.harness === "omp") {
		for (const directory of [profile.runtime.agentDirectory, profile.runtime.homeDirectory]) {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const metadata = await stat(directory);
			if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) {
				fail(`OMP runtime directory must be a mode-0700 directory: ${directory}`);
			}
		}
	}
	await mkdir(options.profileDirectory, { recursive: true, mode: 0o700 });
	const filePath = join(options.profileDirectory, `${options.id}.json`);
	const existed = await access(filePath).then(() => true, () => false);
	try {
		await writeFile(filePath, `${JSON.stringify(profile, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: options.force ? "w" : "wx" });
	} catch (error) {
		if (error && typeof error === "object" && error.code === "EEXIST") {
			fail(`refusing to overwrite the existing profile at ${filePath}; rerun with --force to replace it, or choose another --id`);
		}
		throw error;
	}
	const resolved = await core.loadRouteProfile(options.profileDirectory, options.id, { expectedHarness: profile.harness, expectedTier: profile.tier });
	print({
		created: true,
		...(options.force && existed ? { replacedExisting: true } : {}),
		profile: resolved.id,
		status: resolved.status,
		harness: resolved.harness,
		tier: resolved.tier,
		route: resolved.route,
		...(resolved.agent ? { agent: resolved.agent } : {}),
		...(resolved.runtime ? { runtime: resolved.runtime } : {}),
		filePath: resolved.filePath,
		sha256: resolved.sha256,
	});
}

async function checkProfile(options, core) {
	const filePath = join(options.profileDirectory, `${options.id}.json`);
	await access(filePath).catch(() => fail(`route profile ${options.id} was not found in ${options.profileDirectory}`));
	const resolved = await core.loadRouteProfile(options.profileDirectory, options.id);
	print({ valid: true, profile: resolved.id, status: resolved.status, harness: resolved.harness, tier: resolved.tier, route: resolved.route, launcher: resolved.launcher, ...(resolved.agent ? { agent: resolved.agent } : {}), ...(resolved.runtime ? { runtime: resolved.runtime } : {}), filePath: resolved.filePath, sha256: resolved.sha256 });
}

async function main() {
	const options = parse(process.argv.slice(2));
	const core = await coreLoader();
	if (options.command === "check") await checkProfile(options, core);
	else await initProfile(options, core);
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
