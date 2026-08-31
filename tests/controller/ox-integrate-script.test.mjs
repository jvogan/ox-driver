import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
	compactWorkerReceipt,
	ManagedWorktreeStore,
	OrchestrationReceiptStore,
	RunStore,
} from "../../packages/core/dist/index.js";
import { trackedMkdtemp } from "./helpers/tracked-temp.mjs";

const execFileAsync = promisify(execFile);

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

async function git(cwd, ...args) {
	return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function fixture() {
	const stateHome = await trackedMkdtemp(join(tmpdir(), "ox-integrate-state-"));
	const stateRoot = join(stateHome, "ox-driver");
	const workspaceState = join(stateHome, "workspaces");
	const orchestrationStore = new OrchestrationReceiptStore(join(stateRoot, "orchestrations"));
	const runStore = new RunStore(stateRoot, join(stateRoot, "leases"));
	const workerRoot = join(stateHome, "workers");
	await mkdir(workerRoot);
	const allocation = await orchestrationStore.allocate();
	const env = {
		...process.env,
		XDG_STATE_HOME: stateHome,
		OX_DRIVER_STATE_DIR: stateRoot,
		OX_DRIVER_WORKSPACE_STATE_DIR: workspaceState,
	};
	return { stateHome, stateRoot, workspaceState, orchestrationStore, runStore, workerRoot, allocation, env };
}

async function sourceRepository() {
	const cwd = await trackedMkdtemp(join(tmpdir(), "ox-integrate-source-"));
	await git(cwd, "init", "--quiet");
	await git(cwd, "config", "user.email", "fixture@example.invalid");
	await git(cwd, "config", "user.name", "Ox Integrate Fixture");
	await mkdir(join(cwd, "src"));
	await writeFile(join(cwd, "src", "a.txt"), "alpha\n");
	await writeFile(join(cwd, "src", "b.txt"), "beta\n");
	await git(cwd, "add", ".");
	await git(cwd, "commit", "--quiet", "-m", "fixture");
	return { cwd, baseCommit: await git(cwd, "rev-parse", "HEAD") };
}

// Produce a real patch the way the controller does: mutate a clone of the
// source and diff its staged state against the base commit.
async function lanePatch(source, mutate) {
	const clone = await trackedMkdtemp(join(tmpdir(), "ox-integrate-clone-"));
	await execFileAsync("git", ["clone", "--quiet", source.cwd, clone]);
	await mutate(clone);
	await execFileAsync("git", ["add", "-A"], { cwd: clone });
	const { stdout } = await execFileAsync(
		"git",
		["diff", "--cached", "--binary", source.baseCommit],
		{ cwd: clone, maxBuffer: 16 * 1024 * 1024 },
	);
	return stdout;
}

async function childReceipt(value, { runId, changedPaths, patch, baseCommit, harness = "opencode", tamper = false }) {
	await value.runStore.create(runId, {});
	let patchFields = {};
	if (patch !== undefined) {
		const relativePath = join("runs", runId, "artifacts", "harness.patch");
		await writeFile(join(value.stateRoot, relativePath), patch);
		patchFields = {
			patchPath: relativePath,
			patchSha256: tamper ? sha256(`${patch}tampered`) : sha256(patch),
			...(baseCommit ? { patchBaseCommit: baseCommit } : {}),
		};
	}
	const receipt = {
		version: 1,
		runId,
		harness,
		status: "completed",
		finishedAt: new Date().toISOString(),
		costReport: { observedUsdMicros: 1000 },
		changedPaths,
		unownedChangedPaths: [],
		acceptance: [{ command: "fixture", passed: true }],
		finalOutput: "useful lane output",
		...patchFields,
	};
	await value.runStore.writeReceipt(receipt);
	return receipt;
}

async function persistHerd(value, lanes) {
	const workers = [];
	for (const lane of lanes) {
		const workerPath = join(value.workerRoot, lane.laneId);
		await mkdir(workerPath, { recursive: true });
		workers.push({
			...compactWorkerReceipt(lane.receipt, workerPath, lane.laneId),
			laneId: lane.laneId,
			...(lane.worktreeId ? { worktreeId: lane.worktreeId } : {}),
		});
	}
	return value.orchestrationStore.persist({
		version: 1,
		kind: "herd",
		orchestrationId: value.allocation.orchestrationId,
		receiptPath: value.allocation.receiptPath,
		objective: "Integrate selected lane changes",
		status: "completed",
		failurePolicy: "collect",
		checksDeclared: true,
		concurrency: lanes.length,
		workerCount: workers.length,
		completedWorkers: workers.length,
		workers,
		integrationRecommendation: "review-worker-diffs-and-integrate-selected-changes",
		autoMerged: false,
	});
}

async function integrate(value, args) {
	try {
		const result = await execFileAsync(
			process.execPath,
			["scripts/ox_integrate.mjs", ...args],
			{ cwd: process.cwd(), env: value.env, maxBuffer: 16 * 1024 * 1024 },
		);
		return { code: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		return { code: error.code, stdout: error.stdout, stderr: error.stderr };
	}
}

test("integrate proposes, exports, and applies Pi and OpenCode changes with passing checks", async () => {
	const value = await fixture();
	const source = await sourceRepository();
	const patchA = await lanePatch(source, (clone) => writeFile(join(clone, "src", "a.txt"), "alpha changed by lane-a\n"));
	const patchB = await lanePatch(source, async (clone) => {
		await writeFile(join(clone, "src", "b.txt"), "beta changed by lane-b\n");
		await writeFile(join(clone, "src", "b-new.txt"), "created by lane-b\n");
	});
	const patchC = await lanePatch(source, (clone) => writeFile(join(clone, "src", "a.txt"), "alpha changed by lane-c\n"));
	const receiptA = await childReceipt(value, { runId: randomUUID(), changedPaths: ["src/a.txt"], patch: patchA, baseCommit: source.baseCommit, harness: "pi" });
	const receiptB = await childReceipt(value, { runId: randomUUID(), changedPaths: ["src/b-new.txt", "src/b.txt"], patch: patchB, baseCommit: source.baseCommit });
	const receiptC = await childReceipt(value, { runId: randomUUID(), changedPaths: ["src/a.txt"], patch: patchC, baseCommit: source.baseCommit });
	await persistHerd(value, [
		{ laneId: "lane-a", receipt: receiptA },
		{ laneId: "lane-b", receipt: receiptB },
		{ laneId: "lane-c", receipt: receiptC },
	]);
	const id = value.allocation.orchestrationId;

	const proposed = await integrate(value, ["propose", id]);
	assert.equal(proposed.code, 2);
	const proposal = JSON.parse(proposed.stdout);
	assert.deepEqual(proposal.overlaps, [{ laneIds: ["lane-a", "lane-c"], paths: ["src/a.txt"] }]);
	assert.deepEqual(proposal.conflictLaneIds, ["lane-a", "lane-c"]);
	assert.deepEqual(proposal.applyOrder, ["lane-b"]);
	assert.deepEqual(proposal.unavailableLaneIds, []);
	const laneB = proposal.lanes.find((lane) => lane.laneId === "lane-b");
	assert.equal(laneB.source, "receipt");
	assert.equal(laneB.baseCommit, source.baseCommit);
	assert.deepEqual(laneB.diffstat.files.map((file) => file.path).sort(), ["src/b-new.txt", "src/b.txt"]);

	const outA = join(value.stateHome, "lane-a.patch");
	const exportedA = await integrate(value, ["export", id, "--lane", "lane-a", "--out", outA]);
	assert.equal(exportedA.code, 0);
	assert.equal(JSON.parse(exportedA.stdout).patchSha256, sha256(patchA));
	assert.equal(await readFile(outA, "utf8"), patchA);
	const exportedB = await integrate(value, ["export", id, "--lane", "lane-b"]);
	assert.equal(exportedB.code, 0);
	assert.equal(exportedB.stdout, patchB);
	const filtered = await integrate(value, ["export", id, "--lane", "lane-b", "--path", "src/b-new.txt"]);
	assert.equal(filtered.code, 0);
	assert.match(filtered.stdout, /b-new\.txt/);
	assert.ok(!filtered.stdout.includes("diff --git a/src/b.txt"));
	const overwrite = await integrate(value, ["export", id, "--lane", "lane-b", "--out", outA]);
	assert.equal(overwrite.code, 1);
	assert.match(overwrite.stderr, /EEXIST/);

	// A conflict with the unselected lane-c must not block applying lane-a.
	const applied = await integrate(value, [
		"apply", id, "--lane", "lane-a", "--lane", "lane-b", "--repo", source.cwd,
		"--check", "grep -q lane-a src/a.txt && grep -q lane-b src/b.txt && test -f src/b-new.txt",
	]);
	assert.equal(applied.code, 0);
	const outcome = JSON.parse(applied.stdout);
	assert.equal(outcome.status, "integrated");
	assert.equal(outcome.workspace.baseCommit, source.baseCommit);
	assert.deepEqual(outcome.applied.map((item) => item.laneId), ["lane-a", "lane-b"]);
	assert.equal(outcome.checks.length, 1);
	assert.equal(outcome.checks[0].passed, true);
	assert.ok(outcome.cleanupCommand.includes(outcome.workspace.id));
	assert.equal(await readFile(join(outcome.workspace.path, "src", "a.txt"), "utf8"), "alpha changed by lane-a\n");
	assert.equal(await readFile(join(outcome.workspace.path, "src", "b-new.txt"), "utf8"), "created by lane-b\n");

	const conflicting = await integrate(value, ["apply", id, "--lane", "lane-a", "--lane", "lane-c", "--repo", source.cwd, "--no-check"]);
	assert.equal(conflicting.code, 1);
	assert.match(conflicting.stderr, /overlap/);

	const failing = await integrate(value, ["apply", id, "--lane", "lane-b", "--repo", source.cwd, "--check", "false"]);
	assert.equal(failing.code, 1);
	const failure = JSON.parse(failing.stdout);
	assert.equal(failure.status, "checks-failed");
	assert.equal(failure.checks[0].passed, false);
});

test("integrate reports no-change, tampered, missing, and live-worktree lanes honestly", async () => {
	const value = await fixture();
	const source = await sourceRepository();
	const patchA = await lanePatch(source, (clone) => writeFile(join(clone, "src", "a.txt"), "alpha tampered lane\n"));
	const noChange = await childReceipt(value, { runId: randomUUID(), changedPaths: [] });
	const tampered = await childReceipt(value, { runId: randomUUID(), changedPaths: ["src/a.txt"], patch: patchA, baseCommit: source.baseCommit, tamper: true });
	const missing = await childReceipt(value, { runId: randomUUID(), changedPaths: ["src/b.txt"] });
	const worktrees = new ManagedWorktreeStore(value.workspaceState);
	const workspace = await worktrees.create(source.cwd);
	await writeFile(join(workspace.path, "src", "b.txt"), "beta changed live\n");
	const live = await childReceipt(value, { runId: randomUUID(), changedPaths: ["src/b.txt"] });
	await persistHerd(value, [
		{ laneId: "lane-none", receipt: noChange },
		{ laneId: "lane-tampered", receipt: tampered },
		{ laneId: "lane-missing", receipt: missing },
		{ laneId: "lane-live", receipt: live, worktreeId: workspace.id },
	]);
	const id = value.allocation.orchestrationId;

	const proposed = await integrate(value, ["propose", id]);
	assert.equal(proposed.code, 2);
	const proposal = JSON.parse(proposed.stdout);
	const byLane = Object.fromEntries(proposal.lanes.map((lane) => [lane.laneId, lane]));
	assert.equal(byLane["lane-none"].source, "none");
	assert.equal(byLane["lane-none"].noChanges, true);
	assert.equal(byLane["lane-tampered"].source, "unavailable");
	assert.match(byLane["lane-tampered"].reason, /digest/);
	assert.equal(byLane["lane-missing"].source, "unavailable");
	assert.equal(byLane["lane-live"].source, "worktree");
	assert.equal(byLane["lane-live"].baseCommit, workspace.baseCommit);
	assert.deepEqual(byLane["lane-live"].diffstat.files.map((file) => file.path), ["src/b.txt"]);
	assert.deepEqual(proposal.unavailableLaneIds.sort(), ["lane-missing", "lane-tampered"]);
	assert.deepEqual(proposal.applyOrder, ["lane-live"]);

	const applied = await integrate(value, ["apply", id, "--lane", "lane-live", "--repo", source.cwd, "--check", "grep -q live src/b.txt"]);
	assert.equal(applied.code, 0);
	assert.equal(JSON.parse(applied.stdout).status, "integrated");
});

test("integrate refuses mixed base commits and reports a mid-sequence apply failure", async () => {
	const value = await fixture();
	const source = await sourceRepository();
	const patchA = await lanePatch(source, (clone) => writeFile(join(clone, "src", "a.txt"), "alpha changed\n"));
	const patchB = await lanePatch(source, (clone) => writeFile(join(clone, "src", "b.txt"), "beta changed\n"));
	// A context-corrupted patch passes its digest check and fails at git apply.
	const corrupted = patchB.replaceAll("beta", "gamma");
	const receiptA = await childReceipt(value, { runId: randomUUID(), changedPaths: ["src/a.txt"], patch: patchA, baseCommit: source.baseCommit });
	const receiptB = await childReceipt(value, { runId: randomUUID(), changedPaths: ["src/b.txt"], patch: corrupted, baseCommit: "f".repeat(40) });
	await persistHerd(value, [
		{ laneId: "lane-a", receipt: receiptA },
		{ laneId: "lane-b", receipt: receiptB },
	]);
	const id = value.allocation.orchestrationId;

	const mixed = await integrate(value, ["apply", id, "--lane", "lane-a", "--lane", "lane-b", "--repo", source.cwd, "--no-check"]);
	assert.equal(mixed.code, 1);
	assert.match(mixed.stderr, /share one recorded base commit/);

	// Repair the recorded base so the corrupted patch reaches git apply.
	const repaired = { ...receiptB, patchBaseCommit: source.baseCommit };
	await writeFile(join(value.stateRoot, "runs", receiptB.runId, "receipt.json"), JSON.stringify(repaired));
	const applied = await integrate(value, ["apply", id, "--lane", "lane-a", "--lane", "lane-b", "--repo", source.cwd, "--no-check"]);
	assert.equal(applied.code, 1);
	const outcome = JSON.parse(applied.stdout);
	assert.equal(outcome.status, "apply-failed");
	assert.deepEqual(outcome.applied.map((item) => item.laneId), ["lane-a"]);
	assert.equal(outcome.applyFailure.laneId, "lane-b");
	assert.deepEqual(outcome.checks, []);
});
