import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { loadRouteProfile } from "../../packages/core/dist/index.js";
import { trackedMkdtemp } from "./helpers/tracked-temp.mjs";

const execFileAsync = promisify(execFile);

const NOTICE = "Created by scripts/ox_route.mjs init-opencode. This profile contains no credentials; the operator's installed OpenCode launcher provides the route's authentication.";

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
