import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OrchestrationReceiptStore } from "../../packages/core/dist/orchestration-store.js";
import { captureProcessIdentity } from "../../packages/core/dist/process.js";
import { effectiveRetryPlanSha256, validateEffectiveRetryPlan } from "../../packages/core/dist/retry-plan.js";
import { trackedMkdtemp } from "./helpers/tracked-temp.mjs";

function receipt(allocation, workerRoot, overrides = {}) {
	return {
		version: 1,
		kind: "pair",
		orchestrationId: allocation.orchestrationId,
		receiptPath: allocation.receiptPath,
		objective: "Compare two implementations",
		status: "completed",
		workers: ["builder", "reviewer"].map((role) => ({
			workerPath: join(workerRoot, role),
			role,
			status: "completed",
			changedPaths: [],
			unownedChangedPaths: [],
			acceptance: [],
		})),
		autoMerged: false,
		...overrides,
	};
}

test("atomically persists, lists, and inspects an immutable orchestration receipt", async () => {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-orchestration-store-"));
	const workerRoot = await trackedMkdtemp(join(tmpdir(), "ox-orchestration-workers-"));
	const store = new OrchestrationReceiptStore(root);
	const allocation = await store.allocate();
	const stored = await store.persist(receipt(allocation, workerRoot));
	assert.equal(stored.orchestrationId, allocation.orchestrationId);
	assert.equal(stored.receiptPath, allocation.receiptPath);
	assert.equal(Object.isFrozen(stored), true);
	assert.equal(Object.isFrozen(stored.workers), true);
	const listing = await store.list();
	assert.deepEqual(listing.receipts.map((item) => item.orchestrationId), [allocation.orchestrationId]);
	assert.deepEqual(listing.unreadable, []);
	assert.deepEqual(await store.inspect(allocation.orchestrationId), stored);
	await assert.rejects(store.persist(receipt(allocation, workerRoot)), /EEXIST/);
});

test("refuses symlinked, malformed, and path-drifted orchestration records", async () => {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-orchestration-hostile-"));
	const workerRoot = await trackedMkdtemp(join(tmpdir(), "ox-orchestration-hostile-workers-"));
	const outside = await trackedMkdtemp(join(tmpdir(), "ox-orchestration-outside-"));
	const store = new OrchestrationReceiptStore(root);

	const linked = await store.allocate();
	const outsideRecord = join(outside, "receipt.json");
	await writeFile(outsideRecord, "{}\n");
	await symlink(outsideRecord, linked.receiptPath);
	await assert.rejects(store.persist(receipt(linked, workerRoot)), /EEXIST/);
	await assert.rejects(store.inspect(linked.orchestrationId), /non-symlink/);

	const malformed = await store.allocate();
	await writeFile(malformed.receiptPath, "{ malformed\n", { mode: 0o600, flag: "wx" });
	await assert.rejects(store.inspect(malformed.orchestrationId), /not valid UTF-8 JSON/);

	const healthy = await store.allocate();
	await store.persist(receipt(healthy, workerRoot));
	const listing = await store.list();
	assert.deepEqual(listing.receipts.map((item) => item.orchestrationId), [healthy.orchestrationId]);
	assert.deepEqual(
		listing.unreadable.map((item) => item.orchestrationId).sort(),
		[linked.orchestrationId, malformed.orchestrationId].sort(),
	);
	for (const item of listing.unreadable) {
		assert.match(item.error, /non-symlink|not a regular file|not valid UTF-8 JSON/);
	}

	const drifted = await store.allocate();
	await assert.rejects(
		store.persist(receipt(drifted, workerRoot, { receiptPath: join(outside, `${drifted.orchestrationId}.json`) })),
		/identity does not match/,
	);
});

test("refuses invalid ids and a state root that traverses a symlink", async () => {
	const parent = await trackedMkdtemp(join(tmpdir(), "ox-orchestration-root-parent-"));
	const actual = join(parent, "actual");
	const linked = join(parent, "linked");
	await mkdir(actual, { mode: 0o700 });
	await symlink(actual, linked);
	const store = new OrchestrationReceiptStore(linked);
	await assert.rejects(store.allocate(), /private and owned|must not traverse symlinks/);
	await assert.rejects(new OrchestrationReceiptStore(actual).inspect("../escape"), /canonical UUID/);
});

test("binds a single task summary to its preassigned worktree and run ids", async () => {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-orchestration-task-"));
	const workerRoot = await trackedMkdtemp(join(tmpdir(), "ox-orchestration-task-worker-"));
	const store = new OrchestrationReceiptStore(root);
	const allocation = await store.allocate();
	const worktreeId = randomUUID();
	const runId = randomUUID();
	const task = {
		version: 1,
		kind: "task",
		orchestrationId: allocation.orchestrationId,
		receiptPath: allocation.receiptPath,
		objective: "Implement one change",
		status: "completed",
		source: workerRoot,
		requestedRef: "HEAD",
		requestedWorktreeId: worktreeId,
		requestedRunId: runId,
		checksDeclared: true,
		workspace: {
			id: worktreeId,
			source: workerRoot,
			path: join(workerRoot, worktreeId),
			baseCommit: "a".repeat(40),
			status: "dirty",
		},
		workers: [{ workerPath: join(workerRoot, worktreeId), role: "builder", runId, status: "completed" }],
		integrationRecommendation: "inspect-worktree-diff-and-integrate-selected-changes",
		autoMerged: false,
	};
	assert.equal((await store.persist(task)).kind, "task");

	const mismatch = await store.allocate();
	await assert.rejects(store.persist({
		...task,
		orchestrationId: mismatch.orchestrationId,
		receiptPath: mismatch.receiptPath,
		requestedRunId: randomUUID(),
	}), /preassigned run id/);
});

test("accepts retry receipts written before per-worker back-references existed", async () => {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-orchestration-legacy-retry-"));
	const workerRoot = await trackedMkdtemp(join(tmpdir(), "ox-orchestration-legacy-retry-worker-"));
	const store = new OrchestrationReceiptStore(root);
	const allocation = await store.allocate();
	const workerPath = join(workerRoot, "build");
	const effectivePlan = validateEffectiveRetryPlan({ version: 1, lanes: [{
		id: "build", role: "builder", objective: "Repair the failing check", workerPath,
		route: "fixture-route", ownedPaths: ["result.txt"], excludedPaths: [".env"],
		checks: ["node --test"], timeoutSeconds: 3600, reportOnlyCostUsdMicros: 50_000,
	}] });
	const latestRunId = randomUUID();
	const parentOrchestrationId = randomUUID();
	const legacy = await store.persist({
		version: 1,
		kind: "retry",
		orchestrationId: allocation.orchestrationId,
		receiptPath: allocation.receiptPath,
		objective: "Retry the failed lane",
		status: "completed",
		effectivePlan,
		effectivePlanSha256: effectiveRetryPlanSha256(effectivePlan),
		lineage: { rootOrchestrationId: parentOrchestrationId, parentOrchestrationId, attemptNumber: 2 },
		selection: { mode: "failed", laneIds: ["build"] },
		resolutionStatus: "resolved",
		remainingUnsuccessfulLaneIds: [],
		laneStates: [{
			laneId: "build",
			attemptNumber: 2,
			latestOrchestrationId: allocation.orchestrationId,
			latestRunId,
			status: "completed",
		}],
		workers: [{
			workerPath,
			role: "builder",
			laneId: "build",
			runId: latestRunId,
			status: "completed",
			previousRunId: randomUUID(),
			previousStatus: "failed",
			attemptNumber: 2,
		}],
		autoMerged: false,
	});
	assert.equal(legacy.kind, "retry");
	assert.equal((await store.inspect(allocation.orchestrationId)).orchestrationId, allocation.orchestrationId);
	const listing = await store.list();
	assert.deepEqual(listing.receipts.map((item) => item.orchestrationId), [allocation.orchestrationId]);
	assert.deepEqual(listing.unreadable, []);
});

test("binds a completed handoff to two ordered runs and complete sequential evidence", async () => {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-orchestration-handoff-"));
	const source = await trackedMkdtemp(join(tmpdir(), "ox-orchestration-handoff-source-"));
	const store = new OrchestrationReceiptStore(root);
	const allocation = await store.allocate();
	const worktreeId = randomUUID();
	const builderRunId = randomUUID();
	const reviewerRunId = randomUUID();
	const handoff = {
		version: 1,
		kind: "handoff",
		orchestrationId: allocation.orchestrationId,
		receiptPath: allocation.receiptPath,
		objective: "Build then review",
		status: "completed",
		source,
		requestedRef: "HEAD",
		requestedWorktreeId: worktreeId,
		requestedBuilderRunId: builderRunId,
		requestedReviewerRunId: reviewerRunId,
		checksDeclared: true,
		workspace: { id: worktreeId, source, path: join(source, worktreeId), baseCommit: "a".repeat(40), status: "dirty" },
		workers: [
			{ workerPath: join(source, worktreeId), role: "builder", runId: builderRunId, status: "completed" },
			{ workerPath: join(source, worktreeId), role: "reviewer", runId: reviewerRunId, status: "completed" },
		],
		evidence: {
			reviewerReceivedExactBuilderState: true,
			reviewerChangedWorkspace: false,
			acceptancePassed: true,
			acceptanceChangedWorkspace: false,
		},
		integrationRecommendation: "inspect-review-receipt-and-worktree-before-integration",
		autoMerged: false,
	};
	assert.equal((await store.persist(handoff)).kind, "handoff");

	const invalid = await store.allocate();
	await assert.rejects(store.persist({
		...handoff,
		orchestrationId: invalid.orchestrationId,
		receiptPath: invalid.receiptPath,
		evidence: { ...handoff.evidence, reviewerReceivedExactBuilderState: false },
	}), /complete sequential evidence/);
});

test("tracks an in-flight orchestration from allocation to its terminal receipt", async () => {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-orchestration-inflight-"));
	const workerRoot = await trackedMkdtemp(join(tmpdir(), "ox-orchestration-inflight-workers-"));
	const store = new OrchestrationReceiptStore(root);
	const allocation = await store.allocate();
	const inflight = await store.beginInFlight(allocation, {
		kind: "pair",
		objective: "Compare two implementations",
		lanes: ["builder", "reviewer"].map((role) => ({ laneId: role, role, workerPath: join(workerRoot, role) })),
	});

	let listing = await store.listInFlight();
	assert.equal(listing.running.length, 1);
	assert.equal(listing.running[0].record.orchestrationId, allocation.orchestrationId);
	assert.equal(listing.running[0].controllerStatus, "same");
	assert.equal(listing.running[0].stale, false);
	assert.deepEqual(listing.running[0].record.lanes.map((lane) => lane.status), ["pending", "pending"]);
	assert.deepEqual(listing.unreadable, []);

	const runId = randomUUID();
	inflight.updateLane("builder", { status: "running" });
	inflight.updateLane("builder", { runId });
	inflight.updateLane("builder", { status: "finished" });
	inflight.updateLane("missing-lane", { status: "running" });
	await inflight.flush();
	const inspected = await store.inspectInFlight(allocation.orchestrationId);
	const builder = inspected.record.lanes.find((lane) => lane.laneId === "builder");
	assert.equal(builder.status, "finished");
	assert.equal(builder.runId, runId);
	assert.equal(inspected.record.lanes.find((lane) => lane.laneId === "reviewer").status, "pending");

	await inflight.flush();
	await store.persist(receipt(allocation, workerRoot));
	listing = await store.listInFlight();
	assert.deepEqual(listing.running, []);
	await assert.rejects(store.inspectInFlight(allocation.orchestrationId), /ENOENT/);
});

test("marks dead-controller and superseded records stale and sweeps only those on the next write", async () => {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-orchestration-stale-"));
	const workerRoot = await trackedMkdtemp(join(tmpdir(), "ox-orchestration-stale-workers-"));
	const store = new OrchestrationReceiptStore(root);
	const liveAllocation = await store.allocate();
	await store.beginInFlight(liveAllocation, {
		kind: "pair",
		objective: "Live orchestration",
		lanes: ["builder", "reviewer"].map((role) => ({ laneId: role, role, workerPath: join(workerRoot, role) })),
	});

	// A record whose controller process is provably gone.
	const child = spawn("sleep", ["60"]);
	const deadIdentity = await captureProcessIdentity(child.pid);
	child.kill("SIGKILL");
	await new Promise((resolve) => child.once("exit", resolve));
	const deadId = randomUUID();
	const now = new Date().toISOString();
	await writeFile(join(root, "running", `${deadId}.json`), JSON.stringify({
		version: 1,
		kind: "herd",
		orchestrationId: deadId,
		receiptPath: join(root, `${deadId}.json`),
		objective: "Dead orchestration",
		startedAt: now,
		updatedAt: now,
		phase: "running",
		controller: deadIdentity,
		lanes: [{ laneId: "builder", role: "builder", workerPath: join(workerRoot, "builder"), status: "running" }],
	}), { mode: 0o600, flag: "wx" });

	// A record whose terminal receipt already exists is stale even with a live controller.
	const superseded = await store.allocate();
	await store.persist(receipt(superseded, workerRoot));
	await writeFile(join(root, "running", `${superseded.orchestrationId}.json`), JSON.stringify({
		version: 1,
		kind: "pair",
		orchestrationId: superseded.orchestrationId,
		receiptPath: superseded.receiptPath,
		objective: "Superseded orchestration",
		startedAt: now,
		updatedAt: now,
		phase: "running",
		controller: await captureProcessIdentity(process.pid),
		lanes: [{ laneId: "builder", role: "builder", workerPath: join(workerRoot, "builder"), status: "running" }],
	}), { mode: 0o600, flag: "wx" });

	const unreadableId = randomUUID();
	await writeFile(join(root, "running", `${unreadableId}.json`), "{ malformed", { mode: 0o600, flag: "wx" });
	await writeFile(join(root, "running", `.${deadId}.${randomUUID()}.tmp`), "partial write", { mode: 0o600, flag: "wx" });

	const listing = await store.listInFlight();
	assert.equal(listing.running.find((item) => item.record.orchestrationId === deadId).stale, true);
	assert.ok(["missing", "reused"].includes(listing.running.find((item) => item.record.orchestrationId === deadId).controllerStatus));
	assert.equal(listing.running.find((item) => item.record.orchestrationId === superseded.orchestrationId).stale, true);
	assert.equal(listing.running.find((item) => item.record.orchestrationId === liveAllocation.orchestrationId).stale, false);
	assert.deepEqual(listing.unreadable.map((item) => item.orchestrationId), [unreadableId]);

	// Only the next writer sweeps; it removes provably-stale records and keeps
	// the live and unreadable ones.
	const nextAllocation = await store.allocate();
	await store.beginInFlight(nextAllocation, {
		kind: "task",
		objective: "Next orchestration",
		lanes: [{ laneId: "task", role: "task", workerPath: join(workerRoot, "task") }],
	});
	const swept = await store.listInFlight();
	const remaining = swept.running.map((item) => item.record.orchestrationId).sort();
	assert.deepEqual(remaining, [liveAllocation.orchestrationId, nextAllocation.orchestrationId].sort());
	assert.deepEqual(swept.unreadable.map((item) => item.orchestrationId), [unreadableId]);
});
