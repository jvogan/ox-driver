import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import {
	AdapterRegistry,
	officialTargetAdapterBindings,
	validateOrchestrationPlan,
} from "../../packages/core/dist/index.js";
import { AcpAdapter } from "../../packages/adapters/acp/dist/index.js";
import { DshAdapter } from "../../packages/adapters/dsh/dist/index.js";

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

test("orchestration keeps OpenCode writers and Pi review lanes", () => {
	const plan = validateOrchestrationPlan({ version: 1, lanes: [
		{ id: "writer", role: "writer", objective: "implement", workerPath: "/tmp/writer", harness: "opencode", checks: ["npm test"] },
		{ id: "reviewer", role: "reviewer", objective: "review", workerPath: "/tmp/reviewer", harness: "pi", route: "pi-default" },
	] });
	assert.deepEqual(plan.lanes.map((lane) => lane.harness), ["opencode", "pi"]);
	assert.throws(() => validateOrchestrationPlan({ version: 1, lanes: [
		{ id: "omp", role: "reviewer", objective: "review", workerPath: "/tmp/omp", harness: "omp" },
		{ id: "writer", role: "writer", objective: "write", workerPath: "/tmp/writer", harness: "opencode", checks: ["npm test"] },
	] }), /harness must be "opencode" or "pi"/);
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

test("release includes every advertised command surface", async () => {
	for (const path of [
		"packages/cli/dist/main.js",
		"packages/opencode-cli/bin/ox-driver.mjs",
		"scripts/ox_route.mjs",
		"scripts/ox_opencode.mjs",
		"scripts/ox_pi.mjs",
		"scripts/ox_herd.mjs",
		"scripts/orchestration-retry.mjs",
		"scripts/ox_integrate.mjs",
	]) await access(path);
	const readme = await readFile("README.md", "utf8");
	for (const harness of ["OpenCode", "Pi", "OMP", "ACP", "DeepSeek Harness"]) assert.match(readme, new RegExp(harness));
});
