import { createHash } from "node:crypto";

import { MAX_ORCHESTRATION_WORKER_SUMMARY_BYTES } from "./orchestration-store.js";

const STATUSES = new Set(["completed", "failed", "blocked", "cancelled", "unknown"]);
const MAX_PATH_PREVIEW_ITEMS = 32;
const MAX_PATH_PREVIEW_BYTES = 256;
const MAX_ACCEPTANCE_PREVIEW_ITEMS = 8;
const MAX_ACCEPTANCE_COMMAND_PREVIEW_BYTES = 512;
const MAX_CONTROLLER_ERROR_PREVIEW_BYTES = 4 * 1024;
const MAX_FINAL_OUTPUT_PREVIEW_BYTES = 16 * 1024;
const MAX_ROLE_PREVIEW_BYTES = 1024;
const MAX_RUN_ID_BYTES = 256;
const HARNESSES = new Set(["opencode"]);

interface TextEvidence {
	redacted?: true;
	bytes: number;
	sha256: string;
	previewBytes?: number;
	truncated?: boolean;
	captureTruncated?: true;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

export function orchestrationTextEvidence(value: string, options: { redacted?: boolean; captureTruncated?: boolean } = {}): TextEvidence {
	const bytes = Buffer.from(value, "utf8");
	return {
		...(options.redacted === true ? { redacted: true as const } : {}),
		bytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		...(options.captureTruncated === true ? { captureTruncated: true as const } : {}),
	};
}

export function compactOrchestrationError(value: unknown): Record<string, unknown> {
	const text = value instanceof Error ? value.message : String(value);
	const result = utf8Preview(text, MAX_CONTROLLER_ERROR_PREVIEW_BYTES);
	return { message: result.preview, messageEvidence: result.evidence };
}

function utf8Preview(value: string, maximumBytes: number): { preview: string; evidence: TextEvidence } {
	const bytes = Buffer.from(value, "utf8");
	let end = Math.min(bytes.length, maximumBytes);
	if (end < bytes.length) {
		while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
	}
	const preview = bytes.subarray(0, end).toString("utf8");
	return {
		preview,
		evidence: {
			...orchestrationTextEvidence(value),
			previewBytes: Buffer.byteLength(preview, "utf8"),
			truncated: end < bytes.length,
		},
	};
}

function compactStringList(values: string[]): { values: string[]; evidence: Record<string, unknown> } {
	const preview = values.slice(0, MAX_PATH_PREVIEW_ITEMS).map((value) => utf8Preview(value, MAX_PATH_PREVIEW_BYTES).preview);
	return {
		values: preview,
		evidence: {
			...orchestrationTextEvidence(JSON.stringify(values), { redacted: true }),
			entries: values.length,
			previewEntries: preview.length,
			truncated: preview.length < values.length || preview.some((value, index) => value !== values[index]),
		},
	};
}

function compactAcceptanceEntry(value: unknown, index: number): Record<string, unknown> {
	const evidence = orchestrationTextEvidence(JSON.stringify(value), { redacted: true });
	const entry = record(value);
	if (!entry) return { index, evidence };
	const result: Record<string, unknown> = { index, evidence };
	if (typeof entry.command === "string") {
		const command = utf8Preview(entry.command, MAX_ACCEPTANCE_COMMAND_PREVIEW_BYTES);
		result.command = command.preview;
		result.commandEvidence = command.evidence;
	}
	for (const field of ["passed", "timedOut", "stdoutTruncated", "stderrTruncated", "backgroundProcessesDetected", "processTreeReaped", "terminationEscalated"]) {
		if (typeof entry[field] === "boolean") result[field] = entry[field];
	}
	for (const field of ["durationMs", "exitCode"]) {
		if (entry[field] === null || Number.isSafeInteger(entry[field])) result[field] = entry[field];
	}
	if (typeof entry.stdout === "string") result.stdoutEvidence = orchestrationTextEvidence(entry.stdout, { redacted: true });
	if (typeof entry.stderr === "string") result.stderrEvidence = orchestrationTextEvidence(entry.stderr, { redacted: true });
	return result;
}

function compactAcceptance(values: unknown[]): { values: Record<string, unknown>[]; evidence: Record<string, unknown> } {
	const preview = values.slice(0, MAX_ACCEPTANCE_PREVIEW_ITEMS).map(compactAcceptanceEntry);
	return {
		values: preview,
		evidence: {
			...orchestrationTextEvidence(JSON.stringify(values), { redacted: true }),
			entries: values.length,
			previewEntries: preview.length,
			truncated: preview.length < values.length,
		},
	};
}

function compactWorkerSummary(summary: Record<string, unknown>): Record<string, unknown> {
	const serialized = JSON.stringify(summary);
	if (Buffer.byteLength(serialized, "utf8") <= MAX_ORCHESTRATION_WORKER_SUMMARY_BYTES) return summary;
	const role = utf8Preview(String(summary.role ?? "worker"), MAX_ROLE_PREVIEW_BYTES);
	return {
		workerPath: summary.workerPath,
		role: role.preview,
		roleEvidence: role.evidence,
		status: summary.status,
		...(typeof summary.harness === "string" ? { harness: summary.harness } : {}),
		...(typeof summary.expectedHarness === "string" ? { expectedHarness: summary.expectedHarness } : {}),
		...(typeof summary.runId === "string" ? { runId: summary.runId } : {}),
		changedPaths: [],
		unownedChangedPaths: [],
		summaryTruncated: true,
		summaryEvidence: orchestrationTextEvidence(serialized, { redacted: true }),
	};
}

export function compactWorkerReceipt(value: unknown, workerPath: string, role: string): Record<string, unknown> {
	const receipt = record(value);
	const changedValues = receipt ? stringArray(receipt.changedPaths) : undefined;
	const unownedValues = receipt ? stringArray(receipt.unownedChangedPaths) : undefined;
	if (!receipt
		|| typeof receipt.runId !== "string" || !receipt.runId || Buffer.byteLength(receipt.runId, "utf8") > MAX_RUN_ID_BYTES
		|| typeof receipt.harness !== "string" || !HARNESSES.has(receipt.harness)
		|| !STATUSES.has(String(receipt.status))
		|| changedValues === undefined
		|| unownedValues === undefined
		|| !Array.isArray(receipt.acceptance)) {
		throw new Error("runner did not return a valid Ox receipt");
	}
	const costReport = record(receipt.costReport);
	const observedCost = costReport?.observedUsdMicros;
	if (observedCost !== undefined && (!Number.isSafeInteger(observedCost) || Number(observedCost) < 0)) {
		throw new Error("runner returned invalid cost telemetry");
	}
	const changedPaths = compactStringList(changedValues);
	const unownedChangedPaths = compactStringList(unownedValues);
	const acceptance = compactAcceptance(receipt.acceptance);
	const compactRole = utf8Preview(role, MAX_ROLE_PREVIEW_BYTES);
	const summary: Record<string, unknown> = {
		workerPath,
		role: compactRole.preview,
		roleEvidence: compactRole.evidence,
		runId: receipt.runId,
		status: receipt.status,
		harness: receipt.harness,
		...(observedCost === undefined ? {} : { observedCostUsdMicros: observedCost }),
		changedPaths: changedPaths.values,
		changedPathsEvidence: changedPaths.evidence,
		unownedChangedPaths: unownedChangedPaths.values,
		unownedChangedPathsEvidence: unownedChangedPaths.evidence,
		acceptance: acceptance.values,
		acceptanceEvidence: acceptance.evidence,
	};
	for (const field of ["requestedRouteProfile", "routeProfileSha256"] as const) {
		if (typeof receipt[field] === "string") summary[field] = receipt[field];
	}
	for (const field of ["configuredRoute", "agentIdentity", "effectivePower"] as const) {
		const evidence = record(receipt[field]);
		if (evidence) summary[field] = evidence;
	}
	if (typeof receipt.finalOutput === "string") {
		const finalOutput = utf8Preview(receipt.finalOutput, MAX_FINAL_OUTPUT_PREVIEW_BYTES);
		summary.finalOutputPreview = finalOutput.preview;
		summary.finalOutputEvidence = { ...finalOutput.evidence, redacted: true };
	}
	return compactWorkerSummary(summary);
}

export function compactWorkerFailure(
	workerPath: string,
	role: string,
	message: string,
	execution: Record<string, unknown> = {},
): Record<string, unknown> {
	const controllerError = utf8Preview(message, MAX_CONTROLLER_ERROR_PREVIEW_BYTES);
	const compactRole = utf8Preview(role, MAX_ROLE_PREVIEW_BYTES);
	return compactWorkerSummary({
		workerPath,
		role: compactRole.preview,
		roleEvidence: compactRole.evidence,
		status: "failed",
		controllerError: controllerError.preview,
		controllerErrorEvidence: controllerError.evidence,
		...(typeof execution.requestedRunId === "string" ? { requestedRunId: execution.requestedRunId } : {}),
		...(typeof execution.observedRunId === "string" ? { observedRunId: execution.observedRunId } : {}),
		...(typeof execution.expectedHarness === "string" ? { expectedHarness: execution.expectedHarness } : {}),
		...(typeof execution.observedHarness === "string" ? { observedHarness: execution.observedHarness } : {}),
		...(Number.isInteger(execution.exitCode) ? { runnerExitCode: execution.exitCode } : {}),
		...(typeof execution.signal === "string" ? { runnerSignal: execution.signal } : {}),
		...(record(execution.stderrEvidence) ? { runnerStderrEvidence: execution.stderrEvidence } : {}),
	});
}
