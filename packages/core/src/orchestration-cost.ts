export interface OrchestrationWorkerCost {
	laneId?: unknown;
	role?: unknown;
	observedCostUsdMicros?: unknown;
}

export interface OrchestrationCostSummary {
	aggregateCostUsdMicros: number | null;
	knownCostUsdMicros: number;
	costEvidence: "complete" | "partial" | "unavailable";
	unavailableCostLaneIds: string[];
	costStatus: "within-ceiling" | "exceeded" | "partial" | "unavailable";
}

function laneIdentity(worker: OrchestrationWorkerCost, index: number): string {
	for (const candidate of [worker.laneId, worker.role]) {
		if (typeof candidate === "string" && candidate.trim()) return candidate;
	}
	return `worker-${index + 1}`;
}

export function summarizeOrchestrationCosts(
	workers: readonly OrchestrationWorkerCost[],
	reportOnlyCeilingUsdMicros: number,
): OrchestrationCostSummary {
	if (!Number.isSafeInteger(reportOnlyCeilingUsdMicros) || reportOnlyCeilingUsdMicros < 0) {
		throw new Error("orchestration cost ceiling must be a non-negative integer in USD micros");
	}
	let knownCostUsdMicros = 0;
	const unavailableCostLaneIds: string[] = [];
	for (const [index, worker] of workers.entries()) {
		const cost = worker.observedCostUsdMicros;
		if (Number.isSafeInteger(cost) && Number(cost) >= 0) knownCostUsdMicros += Number(cost);
		else unavailableCostLaneIds.push(laneIdentity(worker, index));
	}
	if (!Number.isSafeInteger(knownCostUsdMicros)) throw new Error("orchestration known cost exceeds integer precision");
	const costEvidence = unavailableCostLaneIds.length === 0
		? "complete"
		: unavailableCostLaneIds.length === workers.length ? "unavailable" : "partial";
	const aggregateCostUsdMicros = costEvidence === "complete" ? knownCostUsdMicros : null;
	const costStatus = knownCostUsdMicros > reportOnlyCeilingUsdMicros
		? "exceeded"
		: costEvidence === "complete" ? "within-ceiling" : costEvidence;
	return { aggregateCostUsdMicros, knownCostUsdMicros, costEvidence, unavailableCostLaneIds, costStatus };
}
