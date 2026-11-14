import type { OrchestrationReceiptStore, StoredOrchestrationReceipt } from "./orchestration-store.js";
import { effectiveRetryPlanSha256, validateEffectiveRetryPlan, validateEffectiveRetryPlanSha256 } from "./retry-plan.js";
import type { EffectiveRetryPlan } from "./retry-plan.js";
import type { RunStore } from "./store.js";

export interface ResolvedOrchestrationAttempt {
	laneId: string;
	sourceOrchestrationId: string;
	sourceReceiptPath: string;
	attemptNumber: number;
	status: string;
	runId?: string;
	worker: Record<string, unknown>;
}

export interface OrchestrationResolutionMetadata {
	version: 1;
	selectedOrchestrationId: string;
	rootOrchestrationId: string;
	rootEffectivePlanSha256: string;
	chain: Array<{ orchestrationId: string; receiptPath: string; attemptNumber: number; effectivePlanSha256: string }>;
	lanes: Array<{ laneId: string; sourceOrchestrationId: string; sourceReceiptPath: string; attemptNumber: number; runId?: string; history: ResolvedOrchestrationAttempt[] }>;
	costs: {
		aggregateCostUsdMicros: number | null;
		knownCostUsdMicros: number;
		costEvidence: "complete" | "partial" | "unavailable";
		runs: Array<{ runId: string; observedCostUsdMicros?: number; costEvidence: "complete" | "partial" | "unavailable"; error?: string }>;
		unknownRunIds: string[];
		unknownAttempts: Array<{ laneId: string; sourceOrchestrationId: string; attemptNumber: number }>;
	};
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function runId(worker: Record<string, unknown>): string | undefined {
	for (const field of ["runId", "observedRunId", "requestedRunId"]) {
		if (typeof worker[field] === "string" && worker[field]) return worker[field];
	}
	return undefined;
}

function planFor(receipt: StoredOrchestrationReceipt): EffectiveRetryPlan {
	if (receipt.effectivePlan === undefined || receipt.effectivePlanSha256 === undefined) throw new Error(`orchestration ${receipt.orchestrationId} lacks an effective plan snapshot`);
	const plan = validateEffectiveRetryPlan(receipt.effectivePlan);
	validateEffectiveRetryPlanSha256(receipt.effectivePlanSha256, plan);
	return plan;
}

function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

async function runCost(worker: Record<string, unknown>, store: RunStore): Promise<{ runId?: string; observedCostUsdMicros?: number; costEvidence: "complete" | "partial" | "unavailable"; error?: string }> {
	const candidates = [...new Set([worker.runId, worker.observedRunId, worker.requestedRunId]
		.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9._-]+$/.test(id) && id !== "." && id !== ".."))];
	for (const id of candidates) {
		try {
			const receipt = await store.readReceipt(id);
			if (receipt.runId !== id || typeof receipt.status !== "string" || typeof receipt.harness !== "string"
				|| !Array.isArray(receipt.acceptance) || !Array.isArray(receipt.changedPaths) || !Array.isArray(receipt.unownedChangedPaths)) {
				return { runId: id, costEvidence: "unavailable", error: "child run receipt is malformed or has inconsistent identity" };
			}
			const expectedHarness = worker.expectedHarness ?? worker.harness;
			if (typeof expectedHarness === "string" && receipt.harness !== expectedHarness) return { runId: id, costEvidence: "unavailable", error: "child run receipt harness does not match its worker" };
			const cost = receipt.costReport?.observedUsdMicros;
			if (!Number.isSafeInteger(cost) || Number(cost) < 0) return { runId: id, costEvidence: "unavailable", error: "child run receipt has no available reported cost" };
			const complete = receipt.costReport?.status === "within-ceiling" || receipt.costReport?.status === "exceeded";
			return { runId: id, observedCostUsdMicros: Number(cost), costEvidence: complete ? "complete" : "partial",
				...(complete ? {} : { error: "child run reported cost is incomplete" }) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { runId: id, costEvidence: "unavailable", error: "child run receipt is unreadable" };
		}
	}
	return candidates.length > 0 ? { runId: candidates[0]!, costEvidence: "unavailable", error: "child run receipt is missing" } : { costEvidence: "unavailable", error: "worker has no usable run id" };
}

/** Build a read-only view of the selected receipt's ancestry; sibling retries are excluded. */
export async function resolveOrchestrationReceipt(
	receipt: StoredOrchestrationReceipt,
	orchestrationStore: OrchestrationReceiptStore,
	runStore: RunStore,
): Promise<StoredOrchestrationReceipt> {
	const backwards: StoredOrchestrationReceipt[] = [];
	const seen = new Set<string>();
	let current = await orchestrationStore.inspect(receipt.orchestrationId);
	while (true) {
		if (seen.has(current.orchestrationId)) throw new Error("retry ancestry contains a cycle");
		seen.add(current.orchestrationId);
		backwards.push(current);
		planFor(current);
		if (current.kind !== "retry") break;
		const lineage = object(current.lineage, "retry lineage");
		if (typeof lineage.parentOrchestrationId !== "string") throw new Error("retry ancestry has no parent identity");
		current = await orchestrationStore.inspect(lineage.parentOrchestrationId);
	}
	const chain = backwards.reverse();
	const root = chain[0]!;
	const rootPlan = planFor(root);
	const rootHash = effectiveRetryPlanSha256(rootPlan);
	const latest = new Map<string, ResolvedOrchestrationAttempt>();
	const history = new Map(rootPlan.lanes.map((lane) => [lane.id, [] as ResolvedOrchestrationAttempt[]]));
	for (const [generation, item] of chain.entries()) {
		const itemPlan = planFor(item);
		if (generation > 0) {
			const lineage = object(item.lineage, "retry lineage");
			if (item.kind !== "retry" || lineage.rootOrchestrationId !== root.orchestrationId
				|| lineage.parentOrchestrationId !== chain[generation - 1]!.orchestrationId
				|| lineage.attemptNumber !== generation + 1 || item.rootEffectivePlanSha256 !== rootHash) {
				throw new Error("retry ancestry root, parent, attempt, or root plan hash is inconsistent");
			}
			const selected = new Set(itemPlan.lanes.map((lane) => lane.id));
			const expectedPlan = validateEffectiveRetryPlan({ version: 1, lanes: itemPlan.lanes.map((lane) => {
				const original = rootPlan.lanes.find((candidate) => candidate.id === lane.id);
				if (!original) throw new Error(`retry ancestry introduces unknown lane ${lane.id}`);
				const dependsOn = (original.dependsOn ?? []).filter((id) => selected.has(id));
				return { ...original, dependsOn: dependsOn.length > 0 ? dependsOn : undefined };
			}) });
			if (effectiveRetryPlanSha256(expectedPlan) !== item.effectivePlanSha256) throw new Error("retry effective plan differs from its root lane snapshot");
		}
		if (item.workers.length !== itemPlan.lanes.length) throw new Error("retry ancestry workers do not cover their effective plan");
		const workerIds = new Set<string>();
		for (const worker of item.workers) {
			const laneId = String(worker.laneId ?? "");
			const lane = itemPlan.lanes.find((candidate) => candidate.id === laneId);
			if (!lane || !history.has(laneId) || workerIds.has(laneId) || worker.workerPath !== lane.workerPath || worker.role !== lane.role) {
				throw new Error("retry ancestry worker lane identity is inconsistent");
			}
			workerIds.add(laneId);
			const previous = latest.get(laneId);
			const attemptNumber = previous ? previous.attemptNumber + 1 : 1;
			if (generation > 0 && (!previous || worker.previousRunId !== runId(previous.worker)
				|| worker.previousStatus !== previous.status || worker.attemptNumber !== attemptNumber
				|| (worker.previousOrchestrationId !== undefined && worker.previousOrchestrationId !== previous.sourceOrchestrationId)
				|| (worker.previousReceiptPath !== undefined && worker.previousReceiptPath !== previous.sourceReceiptPath))) {
				throw new Error(`retry lane ${laneId} does not continue its latest ancestor attempt`);
			}
			const attempt: ResolvedOrchestrationAttempt = {
				laneId, sourceOrchestrationId: item.orchestrationId, sourceReceiptPath: item.receiptPath,
				attemptNumber, status: String(worker.status), ...(runId(worker) ? { runId: runId(worker)! } : {}), worker: structuredClone(worker),
			};
			latest.set(laneId, attempt);
			history.get(laneId)!.push(attempt);
		}
		if (generation > 0) {
			if (!Array.isArray(item.laneStates) || item.laneStates.length !== rootPlan.lanes.length) throw new Error("retry lane states do not cover the root plan");
			const stateIds = new Set<string>();
			for (const raw of item.laneStates) {
				const state = object(raw, "retry lane state");
				const laneId = String(state.laneId);
				const actual = latest.get(laneId);
				if (!actual || stateIds.has(laneId) || state.latestOrchestrationId !== actual.sourceOrchestrationId
					|| state.latestRunId !== runId(actual.worker) || state.status !== actual.status || state.attemptNumber !== actual.attemptNumber) {
					throw new Error("retry lane states disagree with the selected ancestor chain");
				}
				stateIds.add(laneId);
			}
			const remaining = [...latest.values()].filter((attempt) => attempt.status !== "completed").map((attempt) => attempt.laneId).sort();
			if (!Array.isArray(item.remainingUnsuccessfulLaneIds) || JSON.stringify([...item.remainingUnsuccessfulLaneIds].sort()) !== JSON.stringify(remaining)) {
				throw new Error("retry remaining lane ids disagree with the selected ancestor chain");
			}
		}
	}
	const runs = new Map<string, OrchestrationResolutionMetadata["costs"]["runs"][number]>();
	const unknownAttempts: OrchestrationResolutionMetadata["costs"]["unknownAttempts"] = [];
	const unknownLaneIds = new Set<string>();
	for (const attempts of history.values()) for (const attempt of attempts) {
		const cost = await runCost(attempt.worker, runStore);
		if (cost.runId) {
			attempt.runId = cost.runId;
			const prior = runs.get(cost.runId);
			if (prior && (prior.observedCostUsdMicros !== cost.observedCostUsdMicros || prior.costEvidence !== cost.costEvidence)) throw new Error("one run id has inconsistent reported cost evidence");
			runs.set(cost.runId, { ...cost, runId: cost.runId });
		}
		if (cost.costEvidence !== "complete") {
			unknownAttempts.push({ laneId: attempt.laneId, sourceOrchestrationId: attempt.sourceOrchestrationId, attemptNumber: attempt.attemptNumber });
			unknownLaneIds.add(attempt.laneId);
		}
	}
	const knownCosts = [...runs.values()].filter((run) => run.observedCostUsdMicros !== undefined);
	const knownCostUsdMicros = knownCosts.reduce((sum, run) => sum + run.observedCostUsdMicros!, 0);
	if (!Number.isSafeInteger(knownCostUsdMicros)) throw new Error("resolved cumulative cost exceeds integer precision");
	const costEvidence = unknownAttempts.length === 0 ? "complete" : knownCosts.length === 0 ? "unavailable" : "partial";
	const aggregateCostUsdMicros = costEvidence === "complete" ? knownCostUsdMicros : null;
	const resolution: OrchestrationResolutionMetadata = {
		version: 1, selectedOrchestrationId: receipt.orchestrationId, rootOrchestrationId: root.orchestrationId,
		rootEffectivePlanSha256: rootHash,
		chain: chain.map((item, index) => ({ orchestrationId: item.orchestrationId, receiptPath: item.receiptPath, attemptNumber: index + 1, effectivePlanSha256: String(item.effectivePlanSha256) })),
		lanes: rootPlan.lanes.map((lane) => {
			const attempt = latest.get(lane.id)!;
			return { laneId: lane.id, sourceOrchestrationId: attempt.sourceOrchestrationId, sourceReceiptPath: attempt.sourceReceiptPath,
				attemptNumber: attempt.attemptNumber, ...(attempt.runId ? { runId: attempt.runId } : {}), history: history.get(lane.id)! };
		}),
		costs: { aggregateCostUsdMicros, knownCostUsdMicros, costEvidence, runs: [...runs.values()], unknownRunIds: [...runs.values()].filter((run) => run.costEvidence !== "complete").map((run) => run.runId), unknownAttempts },
	};
	const workers: Array<Record<string, unknown>> = rootPlan.lanes.map((lane) => {
		const attempt = latest.get(lane.id)!;
		return { ...structuredClone(attempt.worker), ...(attempt.runId ? { runId: attempt.runId } : {}), sourceOrchestrationId: attempt.sourceOrchestrationId, sourceReceiptPath: attempt.sourceReceiptPath, attemptNumber: attempt.attemptNumber };
	});
	const status = workers.every((worker) => worker.status === "completed") ? "completed"
		: workers.every((worker) => worker.status === "completed" || worker.status === "cancelled") ? "cancelled" : "failed";
	const reportOnlyCeilingUsdMicros = chain.reduce((sum, item) => sum + planFor(item).lanes.reduce((cost, lane) => cost + lane.reportOnlyCostUsdMicros, 0), 0);
	if (!Number.isSafeInteger(reportOnlyCeilingUsdMicros)) throw new Error("resolved cumulative cost ceiling exceeds integer precision");
	return freeze({ ...structuredClone(chain[chain.length - 1]!), objective: root.objective, status, workers,
		reportOnlyCeilingUsdMicros,
		effectivePlan: rootPlan, effectivePlanSha256: rootHash, resolution,
		aggregateCostUsdMicros, knownCostUsdMicros, costEvidence, unavailableCostLaneIds: [...unknownLaneIds],
		costStatus: knownCostUsdMicros > reportOnlyCeilingUsdMicros ? "exceeded" : costEvidence === "complete" ? "within-ceiling" : costEvidence,
	});
}
