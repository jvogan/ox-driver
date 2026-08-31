import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { trackedMkdtemp } from "./helpers/tracked-temp.mjs";
import { buildPiWorkerSpec, parsePiWorkerArgs } from "../../scripts/ox_pi.mjs";

const execFileAsync = promisify(execFile);

async function invoke(args) {
	try {
		const result = await execFileAsync(process.execPath, ["scripts/ox_pi.mjs", ...args], {
			cwd: process.cwd(),
			maxBuffer: 1024 * 1024,
		});
		return { code: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
	}
}

test("pi lane runner fails closed on writer-only or wrong-route arguments before any dispatch", async () => {
	const worker = await trackedMkdtemp(join(tmpdir(), "ox-pi-worker-"));

	const agent = await invoke([worker, "review the lane", "--agent", "custom"]);
	assert.equal(agent.code, 1);
	assert.match(agent.stderr, /Pi lane does not accept --agent/);
	assert.equal(agent.stderr.includes("OX_DRIVER_RUN_ID"), false);

	const route = await invoke([worker, "review the lane", "--route", "opencode-default"]);
	assert.equal(route.code, 1);
	assert.match(route.stderr, /targets opencode, not pi/);
	assert.equal(route.stderr.includes("OX_DRIVER_RUN_ID"), false);

	const usage = await invoke([worker]);
	assert.equal(usage.code, 1);
	assert.match(usage.stderr, /usage: ox_pi\.mjs/);
});

test("pi lane writer is explicit, owns real paths, and preserves full-power defaults", async () => {
	const worker = await trackedMkdtemp(join(tmpdir(), "ox-pi-writer-worker-"));
	assert.throws(
		() => parsePiWorkerArgs([worker, "implement the task", "--writer"]),
		/--writer requires at least one --owned path/,
	);

	const options = parsePiWorkerArgs([
		worker,
		"implement the task",
		"--writer",
		"--owned", "src",
		"--owned", "src/generated.ts",
		"--check", "test -f src/generated.ts",
		"--profile-dir", worker,
	]);
	const spec = buildPiWorkerSpec(options, worker);
	assert.equal(spec.execution.topology, "solo");
	assert.equal(spec.execution.writerPolicy, "one-writer");
	assert.equal(spec.execution.timeoutSeconds, 3_600);
	assert.equal(spec.execution.maxChildren, undefined);
	assert.equal(spec.execution.maxProviderRequests, undefined);
	assert.equal(spec.execution.maxToolCalls, undefined);
	assert.equal(spec.execution.maxCostUsdMicros, undefined);
	assert.deepEqual(spec.task.ownedPaths, ["src", "src/generated.ts"]);
	assert.deepEqual(spec.acceptance.commands, ["test -f src/generated.ts"]);
	assert.equal(options.profileDirectory, worker);
	assert.match(spec.task.objective, /do not delegate/i);

	const review = buildPiWorkerSpec(parsePiWorkerArgs([
		worker,
		"review the task",
		"--owned", "ignored-for-review",
	]), worker);
	assert.equal(review.execution.writerPolicy, "read-only");
	assert.deepEqual(review.task.ownedPaths, []);
	assert.equal(review.execution.timeoutSeconds, 3_600);
});
