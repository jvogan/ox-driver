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

test("accepts a per-lane harness selector and rejects unknown values", () => {
	const plan = validateOrchestrationPlan({ version: 1, lanes: [
		lane(),
		lane({ id: "review", role: "reviewer", harness: "pi", workerPath: "/workers/review", checks: undefined }),
	]});
	assert.equal(plan.lanes[0].harness, undefined);
	assert.equal(plan.lanes[1].harness, "pi");
	assert.throws(
		() => validateOrchestrationPlan({ version: 1, lanes: [lane(), lane({ id: "x", role: "y", workerPath: "/workers/x", harness: "codex" })] }),
		/harness must be "opencode", "pi", or "omp"/,
	);
	assert.throws(
		() => validateOrchestrationPlan({ version: 1, lanes: [lane(), lane({ id: "x", role: "y", workerPath: "/workers/x", runner: "custom" })] }),
		/runner is not supported/,
	);
});

test("requires a delegation-capable primary and keeps child agents off Pi lanes", () => {
	assert.throws(() => validateOrchestrationPlan(plan([
		lane({ childAgents: ["researcher"] }),
		lane({ id: "other", role: "other", workerPath: "/tmp/worktrees/other" }),
	])), /childAgents requires an explicit delegation-capable agent/);
	assert.throws(() => validateOrchestrationPlan(plan([
		lane({ harness: "pi", agent: "primary", childAgents: ["researcher"] }),
		lane({ id: "other", role: "other", workerPath: "/tmp/worktrees/other" }),
	])), /childAgents is unavailable for Pi lanes/);
});

test("keeps shell acceptance commands off read-only Pi lanes", () => {
	assert.throws(() => validateOrchestrationPlan(plan([
		lane(),
		lane({ id: "review", role: "reviewer", harness: "pi", workerPath: "/workers/review", checks: ["npm test"] }),
	])), /checks is unavailable for read-only Pi lanes/);
});

test("accepts OMP review lanes and rejects OMP writers", () => {
	const result = validateOrchestrationPlan(plan([
		lane({ harness: "opencode" }),
		lane({ id: "review", role: "reviewer", harness: "omp", writerPolicy: "read-only", workerPath: "/workers/review", checks: ["npm test"] }),
	]));
	assert.equal(result.lanes[1].harness, "omp");
	assert.throws(() => validateOrchestrationPlan(plan([
		lane({ harness: "opencode" }),
		lane({ id: "review", role: "reviewer", harness: "omp", writerPolicy: "one-writer", workerPath: "/workers/review", ownedPaths: ["src"] }),
	])), /writerPolicy "one-writer" is unavailable for OMP lanes/);
});

test("accepts dependency-ordered shared worktrees and rejects cycles", () => {
	const result = validateOrchestrationPlan(plan([
		lane({ harness: "pi", writerPolicy: "one-writer", ownedPaths: ["src"], checks: ["npm test"] }),
		lane({ id: "review", role: "reviewer", harness: "pi", workerPath: "/tmp/worktrees/build", dependsOn: ["build"] }),
	]));
	assert.deepEqual(result.lanes[1].dependsOn, ["build"]);
	assert.throws(() => validateOrchestrationPlan(plan([
		lane({ harness: "pi", dependsOn: ["review"] }),
		lane({ id: "review", role: "reviewer", harness: "pi", workerPath: "/tmp/worktrees/review", dependsOn: ["build"] }),
	])), /dependency cycle/);
});
