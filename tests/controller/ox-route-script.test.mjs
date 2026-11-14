import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import { loadRouteProfile, validateRouteProfile } from "../../packages/core/dist/index.js";
import { trackedMkdtemp } from "./helpers/tracked-temp.mjs";

const execFileAsync = promisify(execFile);

const NOTICE = "Created by scripts/ox_route.mjs init-opencode. This profile contains no credentials; the installed opencode launcher provides authentication.";

function expectedProfile(id, launcher, provider, model, reasoning, agent) {
	return {
		version: 1,
		id,
		status: "active",
		harness: "opencode",
		tier: "trusted-host",
		launcher: { command: launcher, versionArgs: ["--version"] },
		route: { source: "explicit", provider, model, reasoning },
		...(agent ? { agent: { defaultProfile: agent } } : {}),
		defaults: { timeoutSeconds: 3_600, reportOnlyCostUsdMicros: 50_000 },
		pricingPolicy: "report-only",
		credentialPolicy: "from-installed-harness",
		notice: NOTICE,
	};
}

function initArguments(profileDirectory, extra = []) {
	return [
		"scripts/ox_route.mjs", "init-opencode",
		"--launcher", "opencode-fixture",
		"--provider", "fixture-provider",
		"--model", "fixture-model",
		"--reasoning", "medium",
		"--id", "route-onboarding",
		"--profile-dir", profileDirectory,
		...extra,
	];
}

function initArgumentsMissing(profileDirectory, flag) {
	const arguments_ = initArguments(profileDirectory);
	const index = arguments_.indexOf(flag);
	return [...arguments_.slice(0, index), ...arguments_.slice(index + 2)];
}

function runScript(arguments_) {
	return execFileAsync(process.execPath, arguments_, {
		cwd: process.cwd(),
		env: process.env,
		maxBuffer: 1024 * 1024,
	});
}

function collectStrings(value, visit) {
	if (typeof value === "string") visit(value);
	else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, visit));
	else if (value && typeof value === "object") Object.values(value).forEach((item) => collectStrings(item, visit));
}

test("init-opencode writes a create-only profile the shared core loader accepts", async () => {
	const directory = await trackedMkdtemp(join(tmpdir(), "ox-driver-ox-route-init-"));
	const result = await runScript(initArguments(directory));
	const summary = JSON.parse(result.stdout);
	assert.equal(summary.created, true);
	assert.equal(summary.profile, "route-onboarding");
	assert.equal(summary.filePath, join(directory, "route-onboarding.json"));
	assert.match(summary.sha256, /^[0-9a-f]{64}$/);
	assert.deepEqual(summary.route, { source: "explicit", provider: "fixture-provider", model: "fixture-model", reasoning: "medium" });

	const fileStatus = await stat(summary.filePath);
	assert.equal(fileStatus.mode & 0o777, 0o600);
	const parsed = JSON.parse(await readFile(summary.filePath, "utf8"));
	assert.deepEqual(parsed, expectedProfile("route-onboarding", "opencode-fixture", "fixture-provider", "fixture-model", "medium"));
	collectStrings(parsed, (value) => assert.doesNotMatch(value, /(api[_-]?key|secret|password|bearer|sk-[a-z0-9]{8}|-----BEGIN)/i));

	const resolved = await loadRouteProfile(directory, "route-onboarding", { expectedHarness: "opencode", expectedTier: "trusted-host" });
	assert.equal(resolved.sha256, summary.sha256);
	assert.equal(resolved.pricingPolicy, "report-only");
	assert.equal(resolved.agent, undefined);
});

test("--agent records the default agent and check validates through the shared loader", async () => {
	const directory = await trackedMkdtemp(join(tmpdir(), "ox-driver-ox-route-agent-"));
	const initialized = await runScript(initArguments(directory, ["--agent", "builder"]));
	const summary = JSON.parse(initialized.stdout);
	assert.deepEqual(summary.agent, { defaultProfile: "builder" });
	const parsed = JSON.parse(await readFile(summary.filePath, "utf8"));
	assert.deepEqual(parsed, expectedProfile("route-onboarding", "opencode-fixture", "fixture-provider", "fixture-model", "medium", "builder"));

	const checked = await runScript(["scripts/ox_route.mjs", "check", "--id", "route-onboarding", "--profile-dir", directory]);
	const verdict = JSON.parse(checked.stdout);
	assert.equal(verdict.valid, true);
	assert.equal(verdict.sha256, summary.sha256);
	assert.deepEqual(verdict.launcher, { command: "opencode-fixture", versionArgs: ["--version"] });
	assert.deepEqual(verdict.agent, { defaultProfile: "builder" });
});

test("init-opencode never overwrites an existing profile without --force", async () => {
	const directory = await trackedMkdtemp(join(tmpdir(), "ox-driver-ox-route-overwrite-"));
	await runScript(initArguments(directory));
	const filePath = join(directory, "route-onboarding.json");
	const before = await readFile(filePath, "utf8");
	await assert.rejects(runScript(initArguments(directory)), (error) => {
		assert.equal(error.code, 1);
		assert.match(error.stderr, /refusing to overwrite/);
		assert.match(error.stderr, /--force/);
		return true;
	});
	assert.equal(await readFile(filePath, "utf8"), before);

	const replaced = await runScript([...initArguments(directory).map((item) => (item === "fixture-model" ? "corrected-model" : item)), "--force"]);
	const summary = JSON.parse(replaced.stdout);
	assert.equal(summary.created, true);
	assert.equal(summary.replacedExisting, true);
	assert.equal(summary.route.model, "corrected-model");
	assert.notEqual(await readFile(filePath, "utf8"), before);
});

test("init-opencode rejects invalid input before writing anything", async () => {
	const directory = await trackedMkdtemp(join(tmpdir(), "ox-driver-ox-route-invalid-"));
	const cases = [
		{ args: initArgumentsMissing(directory, "--provider"), message: /--provider is required/ },
		{ args: ["scripts/ox_route.mjs", "init-opencode", "--agent", "builder", "--provider", "p", "--model", "m", "--reasoning", "r", "--profile-dir", directory], message: /--launcher is required/ },
		{ args: ["scripts/ox_route.mjs", "init-opencode", "--launcher", "opencode-fixture", "--provider", "p", "--model", "m", "--reasoning", "r", "--id", "Bad_Id", "--profile-dir", directory], message: /canonical lowercase profile id/ },
		{ args: ["scripts/ox_route.mjs", "init-opencode", "--launcher", "opencode-fixture", "--provider", "p", "--model", "m", "--reasoning", "r", "--profile-dir", "relative/routes"], message: /--profile-dir must be an absolute directory/ },
		{ args: [...initArguments(directory), "--api-key", "sk-demo-value-12345678"], message: /unknown option: --api-key/ },
		{ args: ["scripts/ox_route.mjs", "frobnicate"], message: /usage:/ },
	];
	for (const item of cases) {
		await assert.rejects(runScript(item.args), (error) => {
			assert.match(error.stderr, item.message);
			return true;
		});
	}
	assert.deepEqual(await readdir(directory), []);
});

test("check reports a missing profile without creating anything", async () => {
	const directory = await trackedMkdtemp(join(tmpdir(), "ox-driver-ox-route-missing-"));
	await assert.rejects(runScript(["scripts/ox_route.mjs", "check", "--profile-dir", directory]), (error) => {
		assert.equal(error.code, 1);
		assert.match(error.stderr, /was not found/);
		return true;
	});
	assert.deepEqual(await readdir(directory), []);
});

test("both commands default to the opencode-default profile id", async () => {
	const directory = await trackedMkdtemp(join(tmpdir(), "ox-driver-ox-route-default-"));
	await runScript([
		"scripts/ox_route.mjs", "init-opencode",
		"--launcher", "opencode-fixture",
		"--provider", "fixture-provider",
		"--model", "fixture-model",
		"--reasoning", "medium",
		"--profile-dir", directory,
	]);
	const parsed = JSON.parse(await readFile(join(directory, "opencode-default.json"), "utf8"));
	assert.deepEqual(parsed, expectedProfile("opencode-default", "opencode-fixture", "fixture-provider", "fixture-model", "medium"));
	const checked = await runScript(["scripts/ox_route.mjs", "check", "--profile-dir", directory]);
	const verdict = JSON.parse(checked.stdout);
	assert.equal(verdict.valid, true);
	assert.equal(verdict.profile, "opencode-default");
});

test("init-pi creates a direct trusted-host route without credentials", async () => {
	const directory = await trackedMkdtemp(join(tmpdir(), "ox-driver-ox-route-pi-"));
	const result = await runScript([
		"scripts/ox_route.mjs", "init-pi", "--launcher", "pi", "--provider", "provider-a",
		"--model", "model-a", "--reasoning", "max", "--expected-version", "0.84.4",
		"--profile-dir", directory,
	]);
	const summary = JSON.parse(result.stdout);
	assert.equal(summary.profile, "pi-default");
	const parsed = JSON.parse(await readFile(join(directory, "pi-default.json"), "utf8"));
	assert.equal(parsed.harness, "pi");
	assert.equal(parsed.tier, "trusted-host");
	assert.deepEqual(parsed.runtime, { mode: "direct", expectedVersion: "0.84.4" });
	assert.deepEqual(parsed.route, { source: "explicit", provider: "provider-a", model: "model-a", reasoning: "max" });
	collectStrings(parsed, (value) => assert.doesNotMatch(value, /(api[_-]?key|secret|password|bearer|sk-[a-z0-9]{8}|-----BEGIN)/i));
});

test("init-omp records paths and environment names without environment values", async () => {
	const directory = await trackedMkdtemp(join(tmpdir(), "ox-driver-ox-route-omp-"));
	const agentDirectory = join(directory, "agent");
	const homeDirectory = join(directory, "home");
	const result = await runScript([
		"scripts/ox_route.mjs", "init-omp", "--launcher", "omp", "--provider", "provider-b",
		"--model", "model-b", "--reasoning", "high", "--agent-dir", agentDirectory,
		"--home-dir", homeDirectory, "--env", "PROVIDER_TOKEN", "--profile-dir", directory,
	]);
	const summary = JSON.parse(result.stdout);
	assert.equal(summary.profile, "omp-default");
	const parsed = JSON.parse(await readFile(join(directory, "omp-default.json"), "utf8"));
	assert.equal(parsed.harness, "omp");
	assert.equal(parsed.tier, "attested");
	assert.deepEqual(parsed.runtime.environmentNames, ["PROVIDER_TOKEN"]);
	assert.equal(JSON.stringify(parsed).includes(process.env.PROVIDER_TOKEN ?? "__missing__"), false);
});


test("OpenCode initializer persists launcher pins and honors the route directory environment", async () => {
	const directory = await trackedMkdtemp(join(tmpdir(), "ox-route-pins-"));
	const args = initArguments(directory, ["--expected-version", "1.2.3", "--expected-sha256", "a".repeat(64)]);
	const directoryFlag = args.indexOf("--profile-dir");
	args.splice(directoryFlag, 2);
	const result = await execFileAsync(process.execPath, args, { env: { ...process.env, OX_DRIVER_ROUTE_PROFILE_DIR: directory } });
	const profile = JSON.parse(await readFile(JSON.parse(result.stdout).filePath, "utf8"));
	assert.deepEqual(profile.runtime, { expectedVersion: "1.2.3", expectedSha256: "a".repeat(64) });
});

test("forced profile replacement rejects symlinks and preserves target bytes", async () => {
	const directory = await trackedMkdtemp(join(tmpdir(), "ox-route-symlink-"));
	const target = join(directory, "target");
	await writeFile(target, "preserved profile target\n");
	await symlink(target, join(directory, "route-onboarding.json"));
	await assert.rejects(runScript(initArguments(directory, ["--force"])), (error) => {
		assert.match(error.stderr, /non-regular profile/);
		return true;
	});
	assert.equal(await readFile(target, "utf8"), "preserved profile target\n");
	assert.deepEqual((await readdir(directory)).sort(), ["route-onboarding.json", "target"]);
});

test("list inspects inactive and invalid routes independently without launching a harness", async () => {
	const directory = await trackedMkdtemp(join(tmpdir(), "ox-route-list-"));
	const route = expectedProfile("candidate-route", "/unavailable/launcher", "fixture", "fixture", "high");
	route.status = "candidate";
	route.runtime = { expectedVersion: "fixture-v1", expectedSha256: "b".repeat(64) };
	await writeFile(join(directory, "candidate-route.json"), JSON.stringify(route));
	await writeFile(join(directory, "invalid-route.json"), "{broken");
	const result = await runScript(["scripts/ox_route.mjs", "list", "--profile-dir", directory]);
	const summary = JSON.parse(result.stdout);
	assert.equal(summary.modelCalls, 0);
	assert.equal(summary.profiles.length, 2);
	assert.deepEqual(summary.profiles[0].pins, route.runtime);
	assert.equal(summary.profiles[0].harness, "opencode");
	assert.equal(summary.profiles[0].status, "candidate");
	assert.equal(summary.profiles[1].valid, false);
	assert.match(summary.profiles[1].error, /valid UTF-8 JSON/);
});

test("route help succeeds for --help and -h", async () => {
	for (const flag of ["--help", "-h"]) {
		const result = await runScript(["scripts/ox_route.mjs", flag]);
		assert.match(result.stdout, /ox_route.mjs list/);
		assert.equal(result.stderr, "");
	}
});


test("route schema and runtime agree on guarded directories, environment names, and unsupported agent fields", async () => {
	const schema = JSON.parse(await readFile(new URL("../../schemas/route-profile.schema.json", import.meta.url), "utf8"));
	const validate = new Ajv2020({ strict: false }).compile(schema);
	const base = expectedProfile("fixture-route", "fixture-launcher", "fixture", "fixture", "high");
	const cases = [
		{ name: "plain OpenCode", value: base, accepted: true },
		{ name: "guarded directories", value: { ...base, runtime: { mode: "guarded", agentDirectory: "/tmp/fixture-agent", homeDirectory: "/tmp/fixture-home", environmentNames: ["FIXTURE_TOKEN"] } }, accepted: true },
		{ name: "missing guarded directories", value: { ...base, runtime: { mode: "guarded" } }, accepted: false },
		{ name: "relative guarded directory", value: { ...base, runtime: { mode: "guarded", agentDirectory: "relative", homeDirectory: "/tmp/fixture-home" } }, accepted: false },
		{ name: "leading underscore environment name", value: { ...base, runtime: { environmentNames: ["_FIXTURE"] } }, accepted: false },
		{ name: "lowercase environment name", value: { ...base, runtime: { environmentNames: ["fixture"] } }, accepted: false },
		{ name: "Pi agent profile", value: { ...base, harness: "pi", agent: { defaultProfile: "fixture-agent" } }, accepted: false },
		{ name: "OMP agent profile", value: { ...base, harness: "omp", agent: { allowedProfiles: ["fixture-agent"] } }, accepted: false },
	];
	for (const fixture of cases) {
		assert.equal(validate(fixture.value), fixture.accepted, `${fixture.name}: ${JSON.stringify(validate.errors)}`);
		if (fixture.accepted) assert.doesNotThrow(() => validateRouteProfile(fixture.value), fixture.name);
		else assert.throws(() => validateRouteProfile(fixture.value), undefined, fixture.name);
	}
});
