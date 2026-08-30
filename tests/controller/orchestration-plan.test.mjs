import assert from "node:assert/strict";
import test from "node:test";

import {
	MAX_ORCHESTRATION_PLAN_LANES,
	validateOrchestrationPlan,
} from "../../packages/core/dist/index.js";

function lane(overrides = {}) {
	return {
		id: "build",
		role: "builder",
		objective: "implement the parser module",
		workerPath: "/tmp/worktrees/build",
		...overrides,
	};
}

function plan(lanes, overrides = {}) {
	return { version: 1, lanes, ...overrides };
}

test("accepts and freezes a complete heterogeneous plan", () => {
	const result = validateOrchestrationPlan(plan([
		lane({ route: "route-a", agent: "agent-a", childAgents: ["researcher-a"], ownedPaths: ["src"], checks: ["npm test"], timeoutSeconds: 600, costCeilingUsd: 0.05 }),
		lane({ id: "docs", role: "documenter", objective: "document it", workerPath: "/tmp/worktrees/docs", excludedPaths: [".env"] }),
	]));
	assert.equal(result.version, 1);
	assert.equal(result.lanes[0].route, "route-a");
	assert.deepEqual(result.lanes[0].childAgents, ["researcher-a"]);
	assert.equal(Object.isFrozen(result.lanes[0].childAgents), true);
	assert.equal(result.lanes[1].role, "documenter");
	assert.equal(Object.isFrozen(result), true);
	assert.equal(Object.isFrozen(result.lanes), true);
	assert.equal(Object.isFrozen(result.lanes[0]), true);
});

test("rejects unsupported versions, fields, and lane counts", () => {
	assert.throws(() => validateOrchestrationPlan([]), /must be an object/);
	assert.throws(() => validateOrchestrationPlan(plan([lane(), lane()], { version: 2 })), /version must equal 1/);
	assert.throws(() => validateOrchestrationPlan(plan([lane(), lane()], { concurrency: 4 })), /plan\.concurrency is not supported/);
	assert.throws(() => validateOrchestrationPlan(plan([lane()])), /between 2 and 32/);
	const lanes = Array.from({ length: MAX_ORCHESTRATION_PLAN_LANES + 1 }, (_, index) => lane({
		id: `lane-${index}`,
		role: `role-${index}`,
		workerPath: `/tmp/worktrees/${index}`,
	}));
	assert.throws(() => validateOrchestrationPlan(plan(lanes)), /between 2 and 32/);
});

test("rejects duplicate ids, roles, and worker paths", () => {
	assert.throws(() => validateOrchestrationPlan(plan([
		lane(), lane({ role: "other", workerPath: "/tmp/worktrees/other" }),
	])), /duplicates lane id build/);
	assert.throws(() => validateOrchestrationPlan(plan([
		lane(), lane({ id: "other", workerPath: "/tmp/worktrees/other" }),
	])), /duplicates lane role builder/);
	assert.throws(() => validateOrchestrationPlan(plan([
		lane(), lane({ id: "other", role: "other" }),
	])), /duplicates lane worker path/);
});

test("rejects unsafe paths and invalid numeric values", () => {
	for (const workerPath of ["relative/path", "/tmp/../escape", "/tmp/\0escape"]) {
		assert.throws(() => validateOrchestrationPlan(plan([
			lane({ workerPath }), lane({ id: "other", role: "other", workerPath: "/tmp/worktrees/other" }),
		])), /workerPath/);
	}
	assert.throws(() => validateOrchestrationPlan(plan([
		lane({ ownedPaths: ["../escape"] }), lane({ id: "other", role: "other", workerPath: "/tmp/worktrees/other" }),
	])), /must stay relative/);
	assert.throws(() => validateOrchestrationPlan(plan([
		lane({ timeoutSeconds: 86_401 }), lane({ id: "other", role: "other", workerPath: "/tmp/worktrees/other" }),
	])), /between 1 and 86400/);
	assert.throws(() => validateOrchestrationPlan(plan([
		lane({ costCeilingUsd: Number.POSITIVE_INFINITY }), lane({ id: "other", role: "other", workerPath: "/tmp/worktrees/other" }),
	])), /non-negative finite/);
});

test("rejects oversized text and duplicate checks before returning any lane", () => {
	assert.throws(() => validateOrchestrationPlan(plan([
		lane({ id: "x".repeat(1025) }), lane({ id: "other", role: "other", workerPath: "/tmp/worktrees/other" }),
	])), /at most 1024 UTF-8 bytes/);
	assert.throws(() => validateOrchestrationPlan(plan([
		lane({ objective: "x".repeat(16 * 1024 + 1) }), lane({ id: "other", role: "other", workerPath: "/tmp/worktrees/other" }),
	])), /at most 16384 UTF-8 bytes/);
	assert.throws(() => validateOrchestrationPlan(plan([
		lane({ checks: ["npm test", "npm test"] }), lane({ id: "other", role: "other", workerPath: "/tmp/worktrees/other" }),
	])), /checks must not contain duplicates/);
});

test("accepts the OpenCode selector and rejects unavailable harnesses", () => {
	const value = validateOrchestrationPlan({ version: 1, lanes: [
		lane(),
		lane({ id: "review", role: "reviewer", harness: "opencode", workerPath: "/workers/review" }),
	]});
	assert.equal(value.lanes[1].harness, "opencode");
	assert.throws(
		() => validateOrchestrationPlan({ version: 1, lanes: [lane(), lane({ id: "x", role: "y", workerPath: "/workers/x", harness: "unsupported" })] }),
		/harness must be "opencode"/,
	);
});

test("requires a delegation-capable primary for child agents", () => {
	assert.throws(() => validateOrchestrationPlan(plan([
		lane({ childAgents: ["researcher"] }),
		lane({ id: "other", role: "other", workerPath: "/tmp/worktrees/other" }),
	])), /childAgents requires an explicit delegation-capable agent/);
});
