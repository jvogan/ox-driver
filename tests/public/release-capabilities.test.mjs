import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

import {
	AdapterRegistry,
	officialTargetAdapterBindings,
	validateOrchestrationPlan,
} from "../../packages/core/dist/index.js";
import { AcpAdapter } from "../../packages/adapters/acp/dist/index.js";
import { DshAdapter } from "../../packages/adapters/dsh/dist/index.js";

const execFileAsync = promisify(execFile);

const commandEntryPoints = [
	"packages/cli/dist/main.js",
	"packages/opencode-cli/bin/ox-driver.mjs",
	"scripts/ox_route.mjs",
	"scripts/ox_opencode.mjs",
	"scripts/ox_pi.mjs",
	"scripts/ox_omp.mjs",
	"scripts/ox_workspace.mjs",
	"scripts/ox_pair.mjs",
	"scripts/ox_herd.mjs",
	"scripts/ox_team.mjs",
	"scripts/ox_orchestration.mjs",
	"scripts/ox_integrate.mjs",
];

const libraryModules = ["scripts/distribution.mjs", "scripts/lane-runners.mjs", "scripts/orchestration-retry.mjs"];

const expectedBindings = [
	["acp", "acp-v1-quarantined"],
	["dsh", "dsh-sdk-v1-quarantined"],
	["omp", "omp-rpc-v2"],
	["opencode", "opencode-v2"],
	["pi", "pi-v1"],
];

test("release keeps all dispatch and inspection adapters registered", () => {
	assert.deepEqual(
		officialTargetAdapterBindings.map(({ harness, adapterId }) => [harness, adapterId]).sort(),
		expectedBindings,
	);
});

test("orchestration accepts single-harness and mixed OpenCode, Pi, and OMP teams", () => {
	const plan = validateOrchestrationPlan({ version: 1, lanes: [
		{ id: "writer", role: "writer", objective: "implement", workerPath: "/tmp/writer", harness: "opencode", checks: ["npm test"] },
		{ id: "reviewer", role: "reviewer", objective: "review", workerPath: "/tmp/reviewer", harness: "pi", route: "pi-default" },
		{ id: "omp", role: "second-reviewer", objective: "review again", workerPath: "/tmp/omp", harness: "omp" },
	] });
	assert.deepEqual(plan.lanes.map((lane) => lane.harness), ["opencode", "pi", "omp"]);
	for (const harness of ["opencode", "pi", "omp"]) {
		const singleHarness = validateOrchestrationPlan({ version: 1, lanes: [
			{ id: `${harness}-a`, role: "review-a", objective: "review", workerPath: `/tmp/${harness}-a`, harness },
			{ id: `${harness}-b`, role: "review-b", objective: "review", workerPath: `/tmp/${harness}-b`, harness },
		] });
		assert.deepEqual(singleHarness.lanes.map((lane) => lane.harness), [harness, harness]);
	}
	assert.throws(() => validateOrchestrationPlan({ version: 1, lanes: [
		{ id: "unknown", role: "reviewer", objective: "review", workerPath: "/tmp/unknown", harness: "unknown" },
		{ id: "writer", role: "writer", objective: "write", workerPath: "/tmp/writer", harness: "opencode", checks: ["npm test"] },
	] }), /harness must be "opencode", "pi", or "omp"/);
});

test("ACP and DSH remain inspection-only adapters", async () => {
	const registry = new AdapterRegistry();
	const acp = new AcpAdapter();
	const dsh = new DshAdapter({ root: "/tmp/ox-driver-missing-dsh" });
	registry.register(acp);
	registry.register(dsh);
	const spec = {
		version: 1, tier: "trusted-host", task: { objective: "inspect", cwd: "/tmp", ownedPaths: [], excludedPaths: [] },
		execution: { session: "ephemeral", topology: "solo", writerPolicy: "read-only", network: "configured", timeoutSeconds: 60 },
		acceptance: { commands: [], requireCleanUnownedPaths: true },
	};
	for (const adapter of [acp, dsh]) {
		const issues = await adapter.preflight({ ...spec, harness: adapter.harness }, {
			version: 1, adapterId: adapter.id, harness: adapter.harness, compatibility: "blocked", available: false, capabilities: {}, notices: [],
		});
		assert.ok(issues.some((issue) => issue.severity === "error"));
	}
});

test("release ships a file for every documented command surface", async () => {
	for (const path of [...commandEntryPoints, ...libraryModules]) await access(path);
	const readme = await readFile("README.md", "utf8");
	for (const harness of ["OpenCode", "Pi", "OMP", "ACP", "DeepSeek Harness"]) assert.match(readme, new RegExp(harness));
});

test("every shipped command loads and states its own argument contract", async () => {
	for (const script of commandEntryPoints) {
		const { stdout, stderr } = await execFileAsync(process.execPath, [script], {
			cwd: process.cwd(),
			maxBuffer: 4 * 1024 * 1024,
		}).catch((error) => error);
		const output = `${stdout ?? ""}${stderr ?? ""}`;
		assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|SyntaxError/, script);
		assert.match(output, /usage|requires/i, script);
	}
});

test("shipped orchestration modules resolve their imports inside the release", async () => {
	const { OX_DRIVER_DISTRIBUTION, OX_DRIVER_SUPPORTS_OMP_LANES, OX_DRIVER_SUPPORTS_PI_LANES } = await import("../../scripts/distribution.mjs");
	assert.equal(typeof OX_DRIVER_DISTRIBUTION, "string");
	assert.equal(typeof OX_DRIVER_SUPPORTS_PI_LANES, "boolean");
	assert.equal(typeof OX_DRIVER_SUPPORTS_OMP_LANES, "boolean");
	const retry = await import("../../scripts/orchestration-retry.mjs");
	assert.equal(typeof retry.retryOrchestration, "function");
});
