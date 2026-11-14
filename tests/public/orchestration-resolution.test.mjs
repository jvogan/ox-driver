import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { effectiveRetryPlanSha256, OrchestrationReceiptStore, resolveOrchestrationReceipt, RunStore, validateEffectiveRetryPlan } from "../../packages/core/dist/index.js";

const execFileAsync = promisify(execFile);

async function fixture(t, { costs = [10, 20], duplicateRun = false } = {}) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "ox-resolution-")));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const orchestrationStore = new OrchestrationReceiptStore(join(directory, "orchestrations"));
	const runStore = new RunStore(join(directory, "runs"));
	const rootPlan = validateEffectiveRetryPlan({ version: 1, lanes: ["build", "docs"].map((id) => ({
		id, role: id, objective: `Complete ${id}`, workerPath: join(directory, id), route: "fixture-route",
		ownedPaths: ["result.txt"], excludedPaths: [], checks: [], timeoutSeconds: 60, reportOnlyCostUsdMicros: 100,
	})) });
	async function persistRun(id, status, cost) {
		await runStore.create(id, {});
		await runStore.writeReceipt({ version: 1, runId: id, harness: "opencode", status,
			acceptance: [], changedPaths: [], unownedChangedPaths: [],
			...(cost === undefined ? {} : { costReport: { mode: "report-only", ceilingUsdMicros: 100, observedUsdMicros: cost, status: "within-ceiling" } }) });
	}
	const firstRunId = randomUUID();
	const workers = [];
	for (const [index, lane] of rootPlan.lanes.entries()) {
		const id = duplicateRun ? firstRunId : randomUUID();
		if (!duplicateRun || index === 0) await persistRun(id, index === 0 ? "failed" : "completed", costs[index]);
		workers.push({ laneId: lane.id, role: lane.role, workerPath: lane.workerPath, harness: "opencode", runId: id, status: index === 0 ? "failed" : "completed" });
	}
	const root = await orchestrationStore.persist({ version: 1, kind: "herd", ...await orchestrationStore.allocate(),
		objective: "Complete both fixture lanes", status: "failed", workers, autoMerged: false,
		effectivePlan: rootPlan, effectivePlanSha256: effectiveRetryPlanSha256(rootPlan) });
	async function retry(parent, { laneIds = ["build"], status = "completed", cost = 30, overrides = {} } = {}) {
		const allocation = await orchestrationStore.allocate();
		const states = parent.kind === "retry" ? structuredClone(parent.laneStates) : parent.workers.map((worker) => ({
			laneId: worker.laneId, latestOrchestrationId: parent.orchestrationId, latestRunId: worker.runId, status: worker.status, attemptNumber: 1,
		}));
		const retryWorkers = [];
		for (const laneId of laneIds) {
			const prior = states.find((state) => state.laneId === laneId);
			const previous = await orchestrationStore.inspect(prior.latestOrchestrationId);
			const previousWorker = previous.workers.find((worker) => worker.laneId === laneId);
			const id = randomUUID();
			await persistRun(id, status, cost);
			const worker = { ...previousWorker, runId: id, status, previousRunId: prior.latestRunId,
				previousOrchestrationId: prior.latestOrchestrationId, previousReceiptPath: previous.receiptPath,
				previousStatus: prior.status, attemptNumber: prior.attemptNumber + 1 };
			retryWorkers.push(worker);
			Object.assign(prior, { latestOrchestrationId: allocation.orchestrationId, latestRunId: id, status, attemptNumber: worker.attemptNumber });
		}
		const plan = validateEffectiveRetryPlan({ version: 1, lanes: laneIds.map((id) => rootPlan.lanes.find((lane) => lane.id === id)) });
		const remainingUnsuccessfulLaneIds = states.filter((state) => state.status !== "completed").map((state) => state.laneId);
		return orchestrationStore.persist({ version: 1, kind: "retry", ...allocation, objective: "Continue selected lanes", status,
			lineage: { parentOrchestrationId: parent.orchestrationId, rootOrchestrationId: root.orchestrationId, attemptNumber: (parent.lineage?.attemptNumber ?? 1) + 1 },
			selection: { mode: "lanes", laneIds }, workers: retryWorkers, autoMerged: false,
			effectivePlan: plan, effectivePlanSha256: effectiveRetryPlanSha256(plan), rootEffectivePlanSha256: root.effectivePlanSha256,
			laneStates: states, remainingUnsuccessfulLaneIds, resolutionStatus: status === "completed" ? "resolved" : "failed", ...overrides });
	}
	return { directory, orchestrationStore, runStore, root, retry };
}

test("resolved retry retains untouched root success, selected ancestry, complete history, and original bytes", async (t) => {
	const f = await fixture(t);
	const selected = await f.retry(f.root);
	await f.retry(f.root, { cost: 99 });
	const before = await readFile(selected.receiptPath, "utf8");
	const result = await resolveOrchestrationReceipt(selected, f.orchestrationStore, f.runStore);
	assert.equal(result.status, "completed");
	assert.equal(result.workers.length, 2);
	assert.equal(result.workers[0].runId, selected.workers[0].runId);
	assert.equal(result.workers[1].runId, f.root.workers[1].runId);
	assert.equal(result.workers[1].sourceOrchestrationId, f.root.orchestrationId);
	assert.deepEqual(result.resolution.chain.map((item) => item.orchestrationId), [f.root.orchestrationId, selected.orchestrationId]);
	assert.equal(result.resolution.lanes[0].history.length, 2);
	assert.equal(result.resolution.lanes[1].history.length, 1);
	assert.equal(result.aggregateCostUsdMicros, 60);
	assert.equal(await readFile(selected.receiptPath, "utf8"), before);
	assert.equal(Object.isFrozen(result.workers[0]), true);
});

test("multiple retry generations select the newest attempt even when an older attempt succeeded", async (t) => {
	const f = await fixture(t);
	const repaired = await f.retry(f.root);
	const newerFailure = await f.retry(repaired, { status: "failed", cost: 40 });
	const result = await resolveOrchestrationReceipt(newerFailure, f.orchestrationStore, f.runStore);
	assert.equal(result.status, "failed");
	assert.equal(result.workers[0].status, "failed");
	assert.equal(result.workers[0].runId, newerFailure.workers[0].runId);
	assert.equal(result.workers[0].attemptNumber, 3);
	assert.deepEqual(result.resolution.lanes[0].history.map((attempt) => attempt.status), ["failed", "completed", "failed"]);
	assert.equal(result.aggregateCostUsdMicros, 100);
});

test("resolution rejects missing parents, cycles, root hash drift, and changed effective snapshots", async (t) => {
	for (const failure of ["missing", "cycle", "root-id", "root-hash", "plan-hash", "lane-snapshot", "previous-run", "lane-state", "attempt-number"]) {
		const f = await fixture(t);
		const selected = await f.retry(f.root);
		const altered = JSON.parse(await readFile(selected.receiptPath, "utf8"));
		if (failure === "missing") await unlink(f.root.receiptPath);
		if (failure === "cycle") altered.lineage.parentOrchestrationId = altered.orchestrationId;
		if (failure === "root-hash") altered.rootEffectivePlanSha256 = "f".repeat(64);
		if (failure === "root-id") altered.lineage.rootOrchestrationId = randomUUID();
		if (failure === "attempt-number") altered.lineage.attemptNumber = 3;
		if (failure === "previous-run") altered.workers[0].previousRunId = randomUUID();
		if (failure === "lane-state") altered.laneStates[0].latestRunId = randomUUID();
		if (failure === "plan-hash") altered.effectivePlanSha256 = "e".repeat(64);
		if (failure === "lane-snapshot") {
			altered.effectivePlan.lanes[0].timeoutSeconds = 61;
			altered.effectivePlanSha256 = effectiveRetryPlanSha256(validateEffectiveRetryPlan(altered.effectivePlan));
		}
		await writeFile(selected.receiptPath, JSON.stringify(altered));
		await assert.rejects(resolveOrchestrationReceipt(selected, f.orchestrationStore, f.runStore), failure === "missing" ? { code: "ENOENT" } : /cycle|hash|SHA-256|snapshot|inconsistent|ancestor/, failure);
	}
});

test("resolution deduplicates actual run ids and preserves unknown cost evidence", async (t) => {
	const duplicated = await fixture(t, { duplicateRun: true });
	const deduped = await resolveOrchestrationReceipt(duplicated.root, duplicated.orchestrationStore, duplicated.runStore);
	assert.equal(deduped.aggregateCostUsdMicros, 10);
	assert.equal(deduped.resolution.costs.runs.length, 1);
	const unknown = await fixture(t, { costs: [undefined, 20] });
	const selected = await unknown.retry(unknown.root);
	// An omitted cost stays unavailable even when all latest workers report known costs.
	const result = await resolveOrchestrationReceipt(selected, unknown.orchestrationStore, unknown.runStore);
	assert.equal(result.aggregateCostUsdMicros, null);
	assert.equal(result.costEvidence, "partial");
	assert.equal(result.knownCostUsdMicros, 50);
	assert.deepEqual(result.resolution.costs.unknownRunIds, [unknown.root.workers[0].runId]);
	const unavailable = await fixture(t, { costs: [undefined, undefined] });
	const noCosts = await resolveOrchestrationReceipt(unavailable.root, unavailable.orchestrationStore, unavailable.runStore);
	assert.equal(noCosts.aggregateCostUsdMicros, null);
	assert.equal(noCosts.knownCostUsdMicros, 0);
	assert.equal(noCosts.costEvidence, "unavailable");
});

test("report --resolved emits full root lanes and cumulative resolution metadata", async (t) => {
	const f = await fixture(t);
	const selected = await f.retry(f.root);
	const result = await execFileAsync(process.execPath, ["scripts/ox_orchestration.mjs", "report", selected.orchestrationId, "--resolved"], {
		env: { ...process.env, OX_DRIVER_ORCHESTRATION_STATE_DIR: f.orchestrationStore.root, OX_DRIVER_STATE_DIR: f.runStore.root },
	});
	const report = JSON.parse(result.stdout);
	assert.equal(report.workers.length, 2);
	assert.equal(report.resolution.rootOrchestrationId, f.root.orchestrationId);
	assert.equal(report.aggregateCostUsdMicros, 60);
	assert.equal(report.workers[1].sourceOrchestrationId, f.root.orchestrationId);
	const partial = await fixture(t, { costs: [undefined, 20] });
	const partialSelected = await partial.retry(partial.root);
	const partialReport = await execFileAsync(process.execPath, ["scripts/ox_orchestration.mjs", "report", partialSelected.orchestrationId, "--resolved"], {
		env: { ...process.env, OX_DRIVER_ORCHESTRATION_STATE_DIR: partial.orchestrationStore.root, OX_DRIVER_STATE_DIR: partial.runStore.root },
	});
	assert.equal(JSON.parse(partialReport.stdout).aggregateCostUsdMicros, null);
	assert.equal(JSON.parse(partialReport.stdout).costEvidence, "partial");
});


test("partial child cost remains a known lower bound with an unknown cumulative total", async (t) => {
	const f = await fixture(t);
	const runId = f.root.workers[0].runId;
	const child = await f.runStore.readReceipt(runId);
	await f.runStore.writeReceipt({ ...child, costReport: { ...child.costReport, status: "partial" } });
	const view = await resolveOrchestrationReceipt(f.root, f.orchestrationStore, f.runStore);
	assert.equal(view.knownCostUsdMicros, 30);
	assert.equal(view.aggregateCostUsdMicros, null);
	assert.equal(view.costEvidence, "partial");
	assert.deepEqual(view.resolution.costs.unknownRunIds, [runId]);
	assert.equal(view.resolution.costs.runs[0].costEvidence, "partial");
});
