#!/usr/bin/env node

import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_LOADER = resolve(ROOT, "packages/core/dist/index.js");
const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const DEFAULT_PROFILE_ID = "opencode-default";
const DEFAULT_TIMEOUT_SECONDS = 3_600;
const DEFAULT_REPORT_ONLY_COST_USD_MICROS = 50_000;
const NOTICE = "Created by scripts/ox_route.mjs init-opencode. This profile contains no credentials; the operator's installed OpenCode launcher provides the route's authentication.";

const USAGE = `usage:
  ox_route.mjs init-opencode --launcher <command> --provider <provider> --model <model> --reasoning <effort>
                             [--agent <agent-profile>] [--id <profile-id>] [--profile-dir <absolute-directory>]
                             [--force]
  ox_route.mjs check [--id <profile-id>] [--profile-dir <absolute-directory>]

example:
  ox_route.mjs init-opencode --launcher opencode --provider openrouter \\
    --model z-ai/glm-5.3-flash --reasoning max

The provider, model, and reasoning values must name a route your installed
OpenCode launcher can already reach; they map to OpenCode's --model
provider/model and --variant flags. init and check validate shape only. The
first dispatch verifies the route against the launcher, so confirm an
unfamiliar triple with one small --no-check task before real work.

init-opencode creates one trusted-host OpenCode route profile with an explicit
route. It refuses to overwrite an existing profile unless --force is given,
and writes no credentials or secrets; authentication stays with the installed
OpenCode launcher. check validates a profile through the compiled core
route-profile loader. Both commands default --id to ${DEFAULT_PROFILE_ID} and
--profile-dir to the controller's user route directory
($XDG_CONFIG_HOME/ox-driver/routes, default ~/.config/ox-driver/routes).`;

function fail(message) {
	throw new Error(message);
}

function bounded(value, flag, maximum) {
	if (typeof value !== "string" || !value || value.length > maximum || /[\0-\x1f\x7f]/.test(value)) {
		fail(`${flag} must be a non-empty string of at most ${maximum} characters without control characters`);
	}
	return value;
}

function print(value) {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function defaultProfileDirectory() {
	const configured = process.env.XDG_CONFIG_HOME?.trim();
	if (configured && !isAbsolute(configured)) fail("XDG_CONFIG_HOME must be an absolute path");
	return join(configured || join(homedir(), ".config"), "ox-driver", "routes");
}

function parse(argv) {
	const [command, ...rest] = argv;
	if (command !== "init-opencode" && command !== "check") fail(USAGE);
	const initOnly = new Set(["--launcher", "--provider", "--model", "--reasoning", "--agent"]);
	const shared = new Set(["--id", "--profile-dir"]);
	const values = new Map();
	let force = false;
	for (let index = 0; index < rest.length; index += 1) {
		const flag = rest[index];
		if (flag === "--force") {
			if (command === "check") fail(`unknown option for check: ${flag}\n\n${USAGE}`);
			force = true;
			continue;
		}
		if (!initOnly.has(flag) && !shared.has(flag)) fail(`unknown option: ${flag}\n\n${USAGE}`);
		if (command === "check" && initOnly.has(flag)) fail(`unknown option for check: ${flag}\n\n${USAGE}`);
		if (values.has(flag)) fail(`${flag} was given more than once`);
		const value = rest[++index]?.trim() || fail(`${flag} requires a value`);
		values.set(flag, value);
	}
	const profileDirectory = values.get("--profile-dir") ?? defaultProfileDirectory();
	if (!isAbsolute(profileDirectory)) fail("--profile-dir must be an absolute directory");
	const id = values.get("--id") ?? DEFAULT_PROFILE_ID;
	if (!PROFILE_ID.test(id)) fail("--id must be a canonical lowercase profile id (letters, digits, dot, underscore, hyphen)");
	if (command === "check") return { command, id, profileDirectory };
	for (const flag of ["--launcher", "--provider", "--model", "--reasoning"]) {
		if (!values.has(flag)) fail(`${flag} is required for init-opencode\n\n${USAGE}`);
	}
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
	};
}

async function coreLoader() {
	let core;
	try {
		core = await import(pathToFileURL(CORE_LOADER).href);
	} catch {
		return fail(`the compiled core loader is unavailable at ${CORE_LOADER}; run \`npm run build\` first`);
	}
	if (typeof core.validateRouteProfile !== "function" || typeof core.loadRouteProfile !== "function") {
		fail(`the compiled core loader at ${CORE_LOADER} does not export the route-profile loader; run \`npm run build\` first`);
	}
	return core;
}

async function initOpenCode(options, core) {
	const profile = {
		version: 1,
		id: options.id,
		status: "active",
		harness: "opencode",
		tier: "trusted-host",
		launcher: { command: options.launcher, versionArgs: ["--version"] },
		route: { source: "explicit", provider: options.provider, model: options.model, reasoning: options.reasoning },
		...(options.agent ? { agent: { defaultProfile: options.agent } } : {}),
		defaults: { timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, reportOnlyCostUsdMicros: DEFAULT_REPORT_ONLY_COST_USD_MICROS },
		pricingPolicy: "report-only",
		credentialPolicy: "from-installed-harness",
		notice: NOTICE,
	};
	core.validateRouteProfile(profile);
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
	const resolved = await core.loadRouteProfile(options.profileDirectory, options.id, { expectedHarness: "opencode", expectedTier: "trusted-host" });
	print({
		created: true,
		...(options.force && existed ? { replacedExisting: true } : {}),
		profile: resolved.id,
		status: resolved.status,
		harness: resolved.harness,
		tier: resolved.tier,
		route: resolved.route,
		...(resolved.agent ? { agent: resolved.agent } : {}),
		filePath: resolved.filePath,
		sha256: resolved.sha256,
	});
}

async function checkProfile(options, core) {
	const filePath = join(options.profileDirectory, `${options.id}.json`);
	await access(filePath).catch(() => fail(`route profile ${options.id} was not found in ${options.profileDirectory}; run init-opencode first or pass --profile-dir`));
	const resolved = await core.loadRouteProfile(options.profileDirectory, options.id, { expectedHarness: "opencode", expectedTier: "trusted-host" });
	print({
		valid: true,
		profile: resolved.id,
		status: resolved.status,
		harness: resolved.harness,
		tier: resolved.tier,
		route: resolved.route,
		launcher: resolved.launcher,
		...(resolved.agent ? { agent: resolved.agent } : {}),
		filePath: resolved.filePath,
		sha256: resolved.sha256,
	});
}

async function main() {
	const options = parse(process.argv.slice(2));
	const core = await coreLoader();
	if (options.command === "init-opencode") await initOpenCode(options, core);
	else await checkProfile(options, core);
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
