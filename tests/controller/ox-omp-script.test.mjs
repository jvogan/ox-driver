import assert from "node:assert/strict";
import test from "node:test";

import { buildOmpWorkerSpec, parseOmpWorkerArgs } from "../../scripts/ox_omp.mjs";

test("OMP lane arguments preserve route, scope, checks, timeout, and cost telemetry", () => {
	const options = parseOmpWorkerArgs([
		"/tmp/repository", "review", "the", "change",
		"--route", "omp-default",
		"--exclude", "secrets",
		"--check", "npm test",
		"--timeout", "900",
		"--cost-ceiling", "0.03",
		"--expected-workspace-sha256", "a".repeat(64),
		"--expected-route-profile-sha256", "b".repeat(64),
	]);
	assert.equal(options.routeProfile, "omp-default");
	assert.equal(options.objective, "review the change");
	assert.equal(options.timeoutSeconds, 900);
	assert.equal(options.reportOnlyCostUsdMicros, 30_000);
	assert.deepEqual(options.acceptanceCommands, ["npm test"]);
	assert.ok(options.excludedPaths.includes("secrets"));

	const spec = buildOmpWorkerSpec(options, "/tmp/repository");
	assert.equal(spec.harness, "omp");
	assert.equal(spec.execution.writerPolicy, "read-only");
	assert.equal(spec.execution.reportOnlyCostUsdMicros, 30_000);
	assert.equal(spec.task.expectedWorkspaceSha256, "a".repeat(64));
	assert.equal(spec.execution.expectedRouteProfileSha256, "b".repeat(64));
	assert.deepEqual(spec.acceptance.commands, ["npm test"]);
});

test("OMP lanes reject writing and agent-selection flags", () => {
	for (const args of [
		["/tmp/repository", "review", "--writer"],
		["/tmp/repository", "review", "--owned", "src"],
		["/tmp/repository", "review", "--agent", "writer"],
		["/tmp/repository", "review", "--child-agent", "researcher"],
	]) assert.throws(() => parseOmpWorkerArgs(args), /read-only|cannot own|do not accept/);
});
