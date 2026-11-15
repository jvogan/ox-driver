import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { initProject, loadProjectPreset } from "../../packages/cli/dist/project-config.js";
import { trackedMkdtemp } from "../controller/helpers/tracked-temp.mjs";

const execute = promisify(execFile);

async function repository() {
	const root = await trackedMkdtemp("ox-project-");
	await execute("git", ["init", "--quiet", root]);
	return root;
}

function preset(overrides = {}) {
	return { route: "opencode-default", ownedPaths: ["."], excludedPaths: [".env"], checks: ["npm test"], ...overrides };
}

function config(presets = { default: preset() }, defaultPreset = "default") {
	return { version: 1, defaultPreset, presets };
}

async function store(root, value) {
	await writeFile(join(root, "ox-driver.json"), typeof value === "string" ? value : JSON.stringify(value), { mode: 0o644 });
}

test("init creates portable configuration at the Git root and preserves explicit reviewer settings", async () => {
	const root = await repository();
	const child = join(root, "src", "nested");
	await mkdir(child, { recursive: true });
	const result = await initProject({
		repository: child, route: "opencode-default", checks: ["npm test"], ownedPaths: ["src"], excludedPaths: ["dist"],
		presetName: "reviewed", reviewer: "pi", reviewerRoute: "pi-default", agent: "builder", childAgents: ["researcher"],
		timeoutSeconds: 7200, reportOnlyCostUsdMicros: 12345, reviewerTimeoutSeconds: 5400, reviewerReportOnlyCostUsdMicros: 6789,
	});
	assert.equal(result.repository, root);
	assert.equal(result.configPath, join(root, "ox-driver.json"));
	assert.deepEqual(result.preset.excludedPaths, [".env", "dist"]);
	assert.deepEqual(await loadProjectPreset(child), result);
	const raw = JSON.parse(await readFile(result.configPath, "utf8"));
	assert.deepEqual(raw, config({ reviewed: result.preset }, "reviewed"));
	assert.equal(JSON.stringify(raw).includes(root), false);
	assert.equal(raw.presets.reviewed.reviewer.harness, "pi");
	assert.equal(raw.presets.reviewed.reviewerTimeoutSeconds, 5400);
	assert.equal(raw.presets.reviewed.childAgents[0], "researcher");
	assert.equal((await lstat(result.configPath)).mode & 0o022, 0);
	await assert.rejects(access(join(child, "ox-driver.json")));
});

test("loader selects named or default presets and preserves omitted execution defaults", async () => {
	const root = await repository();
	const secondary = preset({ route: "opencode-secondary", checks: [], noCheck: true, reviewer: { harness: "omp", route: "omp-default" } });
	await store(root, config({ default: preset({ excludedPaths: [] }), secondary }));
	const first = await loadProjectPreset(root);
	assert.equal(first.presetName, "default");
	assert.deepEqual(first.preset.excludedPaths, [".env"]);
	assert.equal("timeoutSeconds" in first.preset, false);
	assert.equal("reportOnlyCostUsdMicros" in first.preset, false);
	assert.deepEqual((await loadProjectPreset(root, "secondary")).preset, secondary);
	await assert.rejects(loadProjectPreset(root, "missing"), /available presets/);
});

test("init requires a selected route and explicit acceptance policy without creating state", async () => {
	const root = await repository();
	for (const [options, message] of [
		[{ checks: ["npm test"] }, /requires --route/],
		[{ route: "opencode-default" }, /requires --check COMMAND/],
		[{ route: "opencode-default", checks: ["npm test"], noCheck: true }, /mutually exclusive/],
		[{ route: "opencode-default", noCheck: true, reviewer: "pi" }, /explicit --reviewer-route/],
		[{ route: "opencode-default", noCheck: true, reviewerRoute: "pi-default" }, /requires --reviewer/],
	]) await assert.rejects(initProject({ repository: root, ...options }), message);
	assert.deepEqual((await readdir(root)).sort(), [".git"]);
	const result = await initProject({ repository: root, route: "opencode-default", noCheck: true });
	assert.deepEqual(result.preset, { route: "opencode-default", ownedPaths: ["."], excludedPaths: [".env"], checks: [], noCheck: true });
});

test("init never replaces an existing config or follows a config symlink", async () => {
	const root = await repository();
	const options = { repository: root, route: "opencode-default", checks: ["npm test"] };
	await initProject(options);
	const original = await readFile(join(root, "ox-driver.json"), "utf8");
	await assert.rejects(initProject(options), /already exists/);
	assert.equal(await readFile(join(root, "ox-driver.json"), "utf8"), original);
	assert.deepEqual((await readdir(root)).sort(), [".git", "ox-driver.json"]);
	const other = await repository();
	const target = join(other, "outside.json");
	await writeFile(target, original);
	await symlink(target, join(other, "ox-driver.json"));
	await assert.rejects(initProject({ ...options, repository: other }), /already exists/);
	await assert.rejects(loadProjectPreset(other), /regular file.*symlink/);
	assert.equal(await readFile(target, "utf8"), original);
});

test("concurrent init publishes exactly one complete configuration", async () => {
	const root = await repository();
	const results = await Promise.allSettled([
		initProject({ repository: root, route: "opencode-first", checks: ["first-check"] }),
		initProject({ repository: root, route: "opencode-second", checks: ["second-check"] }),
	]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(results.filter((result) => result.status === "rejected").length, 1);
	const loaded = await loadProjectPreset(root);
	assert.ok(["opencode-first", "opencode-second"].includes(loaded.preset.route));
	assert.deepEqual((await readdir(root)).sort(), [".git", "ox-driver.json"]);
});

test("loader rejects duplicate JSON keys, reserved keys, and unsupported fields", async () => {
	const root = await repository();
	const valid = JSON.stringify(config());
	for (const [source, message] of [
		[valid.replace('"version":1', '"version":1,"version":1'), /duplicate JSON key/],
		[valid.replace('"route":"opencode-default"', '"route":"first","r\\u006fute":"second"'), /duplicate JSON key/],
		[valid.replace('"default":{', '"__proto__":{'), /reserved JSON key/],
		[config({ constructor: preset() }, "constructor"), /reserved|identifier/],
		[{ ...config(), launcher: "/machine/launcher" }, /unsupported field launcher/],
		[{ ...config(), version: 2 }, /version must be 1/],
		[config({ default: preset({ provider: "example" }) }), /unsupported field provider/],
		[config({ default: preset({ reviewer: { harness: "opencode", route: "review-route" } }) }), /harness must be pi or omp/],
	]) {
		await store(root, source);
		await assert.rejects(loadProjectPreset(root), message);
	}
	await store(root, '{"version": invalid-private-value}');
	await assert.rejects(loadProjectPreset(root), (error) => {
		assert.equal(error.message, "project config must contain valid JSON");
		return true;
	});
});

test("loader validates scope, route identifiers, capacities, and every named preset", async () => {
	const root = await repository();
	for (const overrides of [
		{ route: "../route" }, { route: "route\nother" }, { route: "sk-abcdefghijklmnopqrstuvwx" },
		{ route: "/machine/launcher" }, { ownedPaths: ["../outside"] }, { ownedPaths: ["a/../b"] },
		{ ownedPaths: ["C:\\outside"] }, { ownedPaths: [] }, { ownedPaths: [".", "."] },
		{ checks: [] }, { checks: ["npm test"], noCheck: true }, { noCheck: false },
		{ checks: ["npm test", "npm test"] }, { checks: ["API_KEY=example-secret-value npm test"] },
		{ childAgents: ["researcher"] }, { agent: "builder", childAgents: ["researcher", "researcher"] },
		{ timeoutSeconds: 0 }, { timeoutSeconds: 86401 }, { reportOnlyCostUsdMicros: -1 },
		{ reviewerTimeoutSeconds: 120 }, { reviewer: { harness: "pi", route: "../reviewer" } },
	]) {
		await store(root, config({ default: preset(), invalid: preset(overrides) }));
		await assert.rejects(loadProjectPreset(root), undefined, JSON.stringify(overrides));
	}
	await store(root, config({ default: preset() }, "missing"));
	await assert.rejects(loadProjectPreset(root), /must name an existing preset/);
});

test("loader rejects oversized, invalid UTF-8, shared writable, and nonregular files", async () => {
	const root = await repository();
	await store(root, " ".repeat(262145));
	await assert.rejects(loadProjectPreset(root), /262144 bytes/);
	await writeFile(join(root, "ox-driver.json"), Buffer.from([0xff, 0xfe]));
	await assert.rejects(loadProjectPreset(root), /encoded data|encoding/i);
	await store(root, config());
	await chmod(join(root, "ox-driver.json"), 0o666);
	await assert.rejects(loadProjectPreset(root), /non-writable-by-others/);
	const other = await repository();
	await mkdir(join(other, "ox-driver.json"));
	await assert.rejects(loadProjectPreset(other), /regular file/);
});

test("project commands require Git and missing config gives an actionable initialization command", async () => {
	const empty = await trackedMkdtemp("ox-project-not-git-");
	await assert.rejects(initProject({ repository: empty, route: "opencode-default", noCheck: true }), /require a Git repository/);
	assert.deepEqual(await readdir(empty), []);
	await assert.rejects(loadProjectPreset(await repository()), /run ox-driver init --route ROUTE --check COMMAND/);
});
