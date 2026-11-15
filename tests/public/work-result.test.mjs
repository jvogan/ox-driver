import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { OrchestrationReceiptStore, RunStore } from "../../packages/core/dist/index.js";
import {
	buildWorkResult,
	formatWorkResult,
	getWorkResult,
	exportWorkPatch,
} from "../../packages/cli/dist/work-result.js";
import { trackedMkdtemp } from "../controller/helpers/tracked-temp.mjs";

async function fixture() {
	const root = await trackedMkdtemp("ox-result-");
	const orchestrationStore = new OrchestrationReceiptStore(join(root, "orchestrations"));
	const runStore = new RunStore(join(root, "state"));
	const allocation = await orchestrationStore.allocate();
	const runId = randomUUID(),
		worktreeId = randomUUID(),
		workspace = join(root, "workspace");
	const artifact = join(runStore.runDirectory(runId), "artifacts");
	await mkdir(artifact, { recursive: true });
	const patch = "diff --git a/a b/a\n";
	await writeFile(join(artifact, "harness.patch"), patch);
	const run = {
		runId,
		status: "completed",
		harness: "opencode",
		acceptance: [{ command: "npm test", passed: true }],
		changedPaths: ["a"],
		unownedChangedPaths: [],
		finalOutput: "Finished",
		patchPath: join("runs", runId, "artifacts", "harness.patch"),
		patchSha256: createHash("sha256").update(patch).digest("hex"),
	};
	await writeFile(join(runStore.runDirectory(runId), "receipt.json"), JSON.stringify(run));
	const receipt = await orchestrationStore.persist({
		version: 1,
		kind: "task",
		...allocation,
		objective: "Implement feature",
		status: "completed",
		source: root,
		requestedRef: "HEAD",
		requestedWorktreeId: worktreeId,
		requestedRunId: runId,
		checksDeclared: true,
		workspace: { id: worktreeId, source: root, path: workspace, baseCommit: "a".repeat(40), status: "dirty" },
		workers: [{ workerPath: workspace, role: "builder", runId, status: "completed" }],
		integrationRecommendation: "inspect-worktree-diff-and-integrate-selected-changes",
		autoMerged: false,
	});
	return { root, orchestrationStore, runStore, receipt, run, runId, artifact, patch };
}

test("saved result reads durable output, changed paths, checks and unknown cost without routes", async () => {
	const f = await fixture();
	const result = await getWorkResult(f.receipt.orchestrationId, f);
	const human = formatWorkResult(result);
	assert.match(human, /Work completed/);
	assert.match(human, /Changed paths:\n  a/);
	assert.match(human, /npm test — passed/);
	assert.match(human, /Reported cost: unknown/);
	assert.equal(result.report.workers[0].finalOutput, "Finished");
});

test("failure and adverse review stay visible and terminal controls are removed", async () => {
	const f = await fixture();
	await writeFile(
		join(f.runStore.runDirectory(f.runId), "receipt.json"),
		JSON.stringify({ ...f.run, status: "failed", finalOutput: "\u001b[31mCritical: do not merge", acceptance: [] }),
	);
	const result = await buildWorkResult(
		{
			...f.receipt,
			kind: "pair",
			status: "failed",
			workers: [{ workerPath: f.root, role: "reviewer", status: "failed", runId: f.runId }],
		},
		f.runStore,
	);
	const human = formatWorkResult(result);
	assert.match(human, /Work failed/);
	assert.match(human, /Reviewer findings \(advisory\)/);
	assert.match(human, /Critical: do not merge/);
	assert.match(human, /Checks: none recorded/);
	assert.doesNotMatch(human, /\u001b/);
});

test("patch export verifies bytes, refuses escapes and preserves existing destinations", async () => {
	const f = await fixture(),
		id = f.receipt.orchestrationId,
		destination = join(f.root, "export.patch");
	assert.equal((await exportWorkPatch(id, undefined, f)).toString(), f.patch);
	await exportWorkPatch(id, destination, f);
	await assert.rejects(exportWorkPatch(id, destination, f), /EEXIST/);
	assert.equal(await readFile(destination, "utf8"), f.patch);
	const linked = join(f.root, "link.patch");
	await symlink(destination, linked);
	await assert.rejects(exportWorkPatch(id, linked, f), /EEXIST|ELOOP/);
	await writeFile(join(f.artifact, "harness.patch"), "tampered");
	await assert.rejects(exportWorkPatch(id, undefined, f), /hash mismatch/);
	await writeFile(
		join(f.runStore.runDirectory(f.runId), "receipt.json"),
		JSON.stringify({ ...f.run, patchPath: "../outside" }),
	);
	await assert.rejects(exportWorkPatch(id, undefined, f), /outside/);
});

test("default run store honors OX_DRIVER_STATE_DIR for saved results and patches", async () => {
	const f = await fixture();
	const oldRun = process.env.OX_DRIVER_STATE_DIR,
		oldOrchestration = process.env.OX_DRIVER_ORCHESTRATION_STATE_DIR;
	process.env.OX_DRIVER_STATE_DIR = f.runStore.root;
	process.env.OX_DRIVER_ORCHESTRATION_STATE_DIR = f.orchestrationStore.root;
	try {
		const result = await getWorkResult(f.receipt.orchestrationId);
		assert.equal(result.report.workers[0].finalOutput, "Finished");
		assert.equal((await exportWorkPatch(f.receipt.orchestrationId)).toString(), f.patch);
	} finally {
		if (oldRun === undefined) delete process.env.OX_DRIVER_STATE_DIR;
		else process.env.OX_DRIVER_STATE_DIR = oldRun;
		if (oldOrchestration === undefined) delete process.env.OX_DRIVER_ORCHESTRATION_STATE_DIR;
		else process.env.OX_DRIVER_ORCHESTRATION_STATE_DIR = oldOrchestration;
	}
});

test("known reported cost is shown and the structured result retains usage", async () => {
	const f = await fixture();
	await writeFile(
		join(f.runStore.runDirectory(f.runId), "receipt.json"),
		JSON.stringify({ ...f.run, costReport: { observedUsdMicros: 1234000 }, usage: { inputTokens: 5 } }),
	);
	const result = await getWorkResult(f.receipt.orchestrationId, f);
	assert.match(formatWorkResult(result), /Reported cost: \$1\.234000/);
	assert.equal(result.report.workers[0].usage.inputTokens, 5);
});

test("patch export refuses a symlinked artifact directory", async () => {
	const f = await fixture();
	await rm(f.artifact, { recursive: true });
	const outside = join(f.root, "outside");
	await mkdir(outside);
	await writeFile(join(outside, "harness.patch"), f.patch);
	await symlink(outside, f.artifact);
	await assert.rejects(exportWorkPatch(f.receipt.orchestrationId, undefined, f), /parent is not a directory/);
});

test("a failure before a worker starts retains its stage and cause", async () => {
	const f = await fixture();
	const result = await buildWorkResult(
		{
			...f.receipt,
			status: "failed",
			workers: [],
			failure: { stage: "route-preflight", message: "launcher unavailable\u001b[0m" },
		},
		f.runStore,
	);
	assert.equal(result.failure.stage, "route-preflight");
	assert.match(formatWorkResult(result), /Failure \(route-preflight\): launcher unavailable/);
	assert.doesNotMatch(formatWorkResult(result), /\u001b/);
});

test("patch export refuses a symlinked run receipt", async () => {
	const f = await fixture();
	const receipt = join(f.runStore.runDirectory(f.runId), "receipt.json");
	const outside = join(f.root, "other-receipt.json");
	await writeFile(outside, JSON.stringify(f.run));
	await rm(receipt);
	await symlink(outside, receipt);
	await assert.rejects(
		exportWorkPatch(f.receipt.orchestrationId, undefined, f),
		/run receipt is not a bounded regular file/,
	);
});

test("resume is suggested only when a handoff checkpoint was recorded", async () => {
	const f = await fixture();
	const receipt = {
		...f.receipt,
		kind: "handoff",
		status: "failed",
		workers: [],
		checkpointId: f.receipt.orchestrationId,
	};
	const missing = await buildWorkResult(receipt, f.runStore);
	assert.doesNotMatch(formatWorkResult(missing), /Resume:/);
	const recorded = await buildWorkResult({ ...receipt, planSha256: "a".repeat(64) }, f.runStore);
	assert.match(formatWorkResult(recorded), /Resume: ox-driver handoff resume/);
});
