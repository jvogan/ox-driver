import { createHash } from "node:crypto";
import { join } from "node:path";

import type { StoredOrchestrationReceipt } from "./orchestration-store.js";
import type { RunStore } from "./store.js";
import type { RunReceipt } from "./types.js";

const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_REPORT_ERROR_BYTES = 4 * 1024;
const MAX_ACCEPTANCE_STREAM_PREVIEW_BYTES = 32 * 1024;
const ACCEPTANCE_TRUNCATION_MARKER = "\n... Ox Driver bounded the middle of this acceptance stream ...\n";

export interface OrchestrationReportWorker extends Record<string, unknown> {
	index: number;
	workerPath: string;
	role: string;
	status: string;
	runId?: string;
	runIdSource?: "summary" | "observed" | "requested";
	runReceiptPath?: string;
	finalOutput?: string;
	finalOutputPreview?: string;
	finalOutputEvidence?: Record<string, unknown>;
	costReport?: RunReceipt["costReport"];
	usage?: RunReceipt["usage"];
	configuredRoute?: RunReceipt["configuredRoute"];
	agentIdentity?: RunReceipt["agentIdentity"];
	delegationArtifact?: { path: string };
	eventsPath?: string;
	eventsSha256?: string;
	checks?: unknown[];
	changedPaths?: string[];
	unownedChangedPaths?: string[];
	error?: { stage: "child-run-receipt"; message: string };
}

export interface OrchestrationReport extends Record<string, unknown> {
	version: 1;
	kind: "orchestration-report";
	orchestrationId: string;
	orchestrationKind: StoredOrchestrationReceipt["kind"];
	status: StoredOrchestrationReceipt["status"];
	objective: string;
	receiptPath: string;
	reportStatus: "complete" | "partial";
	childReceiptsComplete: boolean;
	aggregateCostUsdMicros: number | null;
	workers: OrchestrationReportWorker[];
}

interface ChildRunResolution {
	runId?: string;
	runIdSource?: "summary" | "observed" | "requested";
	runReceiptPath?: string;
	receipt?: RunReceipt;
	error?: OrchestrationReportWorker["error"];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function immutable<T>(value: T): T {
	const clone = structuredClone(value);
	const pending: unknown[] = [clone];
	const seen = new WeakSet<object>();
	while (pending.length > 0) {
		const item = pending.pop();
		if (!item || typeof item !== "object" || seen.has(item)) continue;
		seen.add(item);
		pending.push(...Object.values(item));
		Object.freeze(item);
	}
	return clone;
}

function boundedError(error: unknown): string {
	const value = error instanceof Error ? error.message : String(error);
	const bytes = Buffer.from(value, "utf8");
	let end = Math.min(bytes.length, MAX_REPORT_ERROR_BYTES);
	while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
	return bytes.subarray(0, end).toString("utf8");
}

function validRunId(value: string): boolean {
	return value.length <= 128 && value !== "." && value !== ".." && RUN_ID_PATTERN.test(value);
}

function boundedAcceptanceStream(value: string): { preview: string; evidence: Record<string, unknown> } {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= MAX_ACCEPTANCE_STREAM_PREVIEW_BYTES) {
		return {
			preview: value,
			evidence: { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), previewBytes: bytes.length, truncated: false },
		};
	}
	const marker = Buffer.from(ACCEPTANCE_TRUNCATION_MARKER, "utf8");
	const contentBudget = MAX_ACCEPTANCE_STREAM_PREVIEW_BYTES - marker.length;
	let headEnd = Math.floor(contentBudget / 2);
	while (headEnd > 0 && (bytes[headEnd]! & 0xc0) === 0x80) headEnd -= 1;
	let tailStart = bytes.length - (contentBudget - headEnd);
	while (tailStart < bytes.length && (bytes[tailStart]! & 0xc0) === 0x80) tailStart += 1;
	const preview = Buffer.concat([bytes.subarray(0, headEnd), marker, bytes.subarray(tailStart)]).toString("utf8");
	return {
		preview,
		evidence: {
			bytes: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			previewBytes: Buffer.byteLength(preview, "utf8"),
			truncated: true,
		},
	};
}

function boundedAcceptance(value: RunReceipt["acceptance"]): Array<Record<string, unknown>> {
	return value.map((check) => {
		const stdout = boundedAcceptanceStream(typeof check.stdout === "string" ? check.stdout : "");
		const stderr = boundedAcceptanceStream(typeof check.stderr === "string" ? check.stderr : "");
		return {
			command: check.command,
			passed: check.passed,
			durationMs: check.durationMs,
			timedOut: check.timedOut,
			exitCode: check.exitCode,
			stdout: stdout.preview,
			stderr: stderr.preview,
			stdoutEvidence: stdout.evidence,
			stderrEvidence: stderr.evidence,
			stdoutTruncated: check.stdoutTruncated,
			stderrTruncated: check.stderrTruncated,
			backgroundProcessesDetected: check.backgroundProcessesDetected,
			processTreeReaped: check.processTreeReaped,
			terminationEscalated: check.terminationEscalated,
		};
	});
}

async function resolveChildRunReceipt(runStore: RunStore, worker: Record<string, unknown>): Promise<ChildRunResolution> {
	const candidates: Array<{ id: string; source: NonNullable<ChildRunResolution["runIdSource"]> }> = [];
	for (const [field, source] of [
		["runId", "summary"],
		["observedRunId", "observed"],
		["requestedRunId", "requested"],
	] as const) {
		const id = worker[field];
		if (typeof id === "string" && id && !candidates.some((candidate) => candidate.id === id)) {
			candidates.push({ id, source });
		}
	}
	if (candidates.length === 0) {
		return { error: { stage: "child-run-receipt", message: "worker summary does not reference a run id" } };
	}
	let lastError = "worker summary does not reference a usable run id";
	for (const candidate of candidates) {
		if (!validRunId(candidate.id)) {
			lastError = `worker summary references an invalid run id: ${candidate.id}`;
			continue;
		}
		const runReceiptPath = join(runStore.runDirectory(candidate.id), "receipt.json");
		try {
			const receipt = await runStore.readReceipt(candidate.id);
			if (receipt.runId !== candidate.id || typeof receipt.status !== "string"
				|| typeof receipt.harness !== "string"
				|| !Array.isArray(receipt.acceptance) || !Array.isArray(receipt.changedPaths)
				|| !Array.isArray(receipt.unownedChangedPaths)) {
				return {
					runId: candidate.id,
					runIdSource: candidate.source,
					runReceiptPath,
					error: { stage: "child-run-receipt", message: `child run receipt for ${candidate.id} is malformed` },
				};
			}
			const expectedHarness = typeof worker.expectedHarness === "string" ? worker.expectedHarness : worker.harness;
			if (typeof expectedHarness === "string" && receipt.harness !== expectedHarness) {
				return {
					runId: candidate.id,
					runIdSource: candidate.source,
					runReceiptPath,
					error: { stage: "child-run-receipt", message: `child run receipt harness ${receipt.harness} does not match aggregate harness ${expectedHarness}` },
				};
			}
			return { runId: candidate.id, runIdSource: candidate.source, runReceiptPath, receipt };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				lastError = `child run receipt is missing: ${runReceiptPath}`;
				continue;
			}
			return {
				runId: candidate.id,
				runIdSource: candidate.source,
				runReceiptPath,
				error: { stage: "child-run-receipt", message: boundedError(error) },
			};
		}
	}
	const first = candidates[0]!;
	return {
		runId: first.id,
		runIdSource: first.source,
		...(validRunId(first.id) ? { runReceiptPath: join(runStore.runDirectory(first.id), "receipt.json") } : {}),
		error: { stage: "child-run-receipt", message: lastError },
	};
}

function workerReport(index: number, worker: Record<string, unknown>, resolution: ChildRunResolution): OrchestrationReportWorker {
	const result: OrchestrationReportWorker = {
		index,
		workerPath: String(worker.workerPath ?? ""),
		role: String(worker.role ?? ""),
		status: String(worker.status ?? "unknown"),
		aggregateSummary: worker,
		...(typeof worker.laneId === "string" ? { laneId: worker.laneId } : {}),
		...(typeof worker.worktreeId === "string" ? { worktreeId: worker.worktreeId } : {}),
		...(typeof worker.baseCommit === "string" ? { baseCommit: worker.baseCommit } : {}),
	};
	if (typeof worker.finalOutputPreview === "string") result.finalOutputPreview = worker.finalOutputPreview;
	if (record(worker.finalOutputEvidence)) result.finalOutputEvidence = worker.finalOutputEvidence as Record<string, unknown>;
	for (const field of ["previousRunId", "previousOrchestrationId", "previousReceiptPath", "previousStatus", "workspaceStateLink", "continuationContextPreview"] as const) {
		if (typeof worker[field] === "string") result[field] = worker[field];
	}
	if (Number.isSafeInteger(worker.attemptNumber)) result.attemptNumber = worker.attemptNumber;
	if (record(worker.continuationContextEvidence)) result.continuationContextEvidence = worker.continuationContextEvidence;
	if (resolution.runId) result.runId = resolution.runId;
	if (resolution.runIdSource) result.runIdSource = resolution.runIdSource;
	if (resolution.runReceiptPath) result.runReceiptPath = resolution.runReceiptPath;
	if (resolution.receipt) {
		const receipt = resolution.receipt;
		result.status = receipt.status;
		if (receipt.effectivePower) result.effectivePower = receipt.effectivePower;
		if (receipt.costReport) result.costReport = receipt.costReport;
		if (receipt.usage) result.usage = receipt.usage;
		if (receipt.configuredRoute) result.configuredRoute = receipt.configuredRoute;
		if (receipt.agentIdentity) result.agentIdentity = receipt.agentIdentity;
		if (receipt.harness === "opencode" && receipt.usage?.principals?.length) {
			result.delegationArtifact = { path: "artifacts/opencode-delegation.json" };
		}
		result.eventsPath = receipt.eventsPath;
		result.eventsSha256 = receipt.eventsSha256;
		if (typeof receipt.finalOutput === "string") result.finalOutput = receipt.finalOutput;
		result.checks = boundedAcceptance(receipt.acceptance);
		result.changedPaths = [...receipt.changedPaths];
		result.unownedChangedPaths = [...receipt.unownedChangedPaths];
	} else {
		if (Array.isArray(worker.acceptance)) result.checks = worker.acceptance;
		if (Array.isArray(worker.changedPaths)) result.changedPaths = worker.changedPaths as string[];
		if (Array.isArray(worker.unownedChangedPaths)) result.unownedChangedPaths = worker.unownedChangedPaths as string[];
		result.error = resolution.error ?? { stage: "child-run-receipt", message: "child run receipt is unavailable" };
	}
	return result;
}

function workspaceSummary(receipt: StoredOrchestrationReceipt): Record<string, unknown> | undefined {
	const workspace = record(receipt.workspace);
	if (!workspace) return undefined;
	const result: Record<string, unknown> = {};
	for (const field of ["id", "path", "baseCommit", "status"] as const) {
		if (typeof workspace[field] === "string") result[field] = workspace[field];
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

export async function buildOrchestrationReport(
	receipt: StoredOrchestrationReceipt,
	runStore: RunStore,
): Promise<OrchestrationReport> {
	const workers: OrchestrationReportWorker[] = [];
	const historical = Array.isArray(receipt.historicalReviewerWorkers)
		? receipt.historicalReviewerWorkers.map((value) => record(value)).filter((value): value is Record<string, unknown> => value !== undefined)
		: [];
	const aggregateWorkers = [...receipt.workers, ...historical];
	for (const [index, value] of aggregateWorkers.entries()) {
		workers.push(workerReport(index, value, await resolveChildRunReceipt(runStore, value)));
	}
	const childReceiptsComplete = workers.every((worker) => worker.error === undefined);
	const observedCosts = workers.map((worker) => record(worker.costReport)?.observedUsdMicros);
	const reportedAggregate = receipt.aggregateCostUsdMicros;
	const aggregateCostUsdMicros: number | null = typeof reportedAggregate === "number"
		&& Number.isSafeInteger(reportedAggregate) && reportedAggregate >= 0
		? reportedAggregate
		: observedCosts.length > 0 && observedCosts.every((cost) => Number.isSafeInteger(cost) && Number(cost) >= 0)
			? observedCosts.reduce<number>((sum, cost) => sum + Number(cost), 0)
			: null;
	const workspace = workspaceSummary(receipt);
	const retryFields = receipt.kind === "retry" ? {
		lineage: receipt.lineage,
		selection: receipt.selection,
		resolutionStatus: receipt.resolutionStatus,
		laneStates: receipt.laneStates,
		remainingUnsuccessfulLaneIds: receipt.remainingUnsuccessfulLaneIds,
	} : {};
	return immutable({
		version: 1,
		kind: "orchestration-report",
		orchestrationId: receipt.orchestrationId,
		orchestrationKind: receipt.kind,
		status: receipt.status,
		objective: receipt.objective,
		receiptPath: receipt.receiptPath,
		reportStatus: childReceiptsComplete ? "complete" : "partial",
		childReceiptsComplete,
		aggregateCostUsdMicros,
		...(Number.isSafeInteger(receipt.knownCostUsdMicros) ? { knownCostUsdMicros: receipt.knownCostUsdMicros } : {}),
		...(typeof receipt.costEvidence === "string" ? { costEvidence: receipt.costEvidence } : {}),
		...(Array.isArray(receipt.unavailableCostLaneIds) ? { unavailableCostLaneIds: receipt.unavailableCostLaneIds } : {}),
		...(typeof receipt.costStatus === "string" ? { costStatus: receipt.costStatus } : {}),
		...(typeof receipt.checkpointId === "string" ? { checkpointId: receipt.checkpointId } : {}),
		...(typeof receipt.planSha256 === "string" ? { planSha256: receipt.planSha256 } : {}),
		...(typeof receipt.resumed === "boolean" ? { resumed: receipt.resumed } : {}),
		...(Array.isArray(receipt.reusedStages) ? { reusedStages: receipt.reusedStages } : {}),
		...(Array.isArray(receipt.reviewerAttempts) ? { reviewerAttempts: receipt.reviewerAttempts } : {}),
		...(Array.isArray(receipt.orchestrationAttempts) ? { orchestrationAttempts: receipt.orchestrationAttempts } : {}),
		...retryFields,
		...(workspace ? { workspace } : {}),
		workers,
	});
}
