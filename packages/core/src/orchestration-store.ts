import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { captureProcessIdentity, processIdentityStatus } from "./process.js";
import type { DurableProcessIdentity, ProcessIdentityStatus } from "./process.js";
import { validateEffectiveRetryPlan, validateEffectiveRetryPlanSha256 } from "./retry-plan.js";

const ORCHESTRATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MAX_ORCHESTRATION_RECEIPT_BYTES = 16 * 1024 * 1024;
export const MAX_ORCHESTRATION_WORKER_SUMMARY_BYTES = 512 * 1024;
export const MAX_IN_FLIGHT_RECORD_BYTES = 256 * 1024;
const MAX_OBJECTIVE_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT_OBJECTIVE_BYTES = 16 * 1024;
const MAX_IN_FLIGHT_ERROR_BYTES = 8 * 1024;
const IN_FLIGHT_DIRECTORY = "running";
const ABANDONED_TEMPORARY_MILLISECONDS = 60 * 60 * 1000;
const KINDS = new Set(["task", "handoff", "pair", "herd", "retry"]);
const STATUSES = new Set(["completed", "failed", "cancelled"]);
const WORKER_STATUSES = new Set(["completed", "failed", "blocked", "cancelled", "unknown"]);
const WORKSPACE_STATUSES = new Set(["ready", "dirty", "advanced", "drifted", "missing", "unregistered", "removed"]);
const IN_FLIGHT_LANE_STATUSES = new Set(["pending", "running", "finished"]);
const IN_FLIGHT_PHASES = new Set(["running", "aborted"]);

export interface OrchestrationAllocation {
	orchestrationId: string;
	receiptPath: string;
}

export interface OrchestrationListing {
	receipts: StoredOrchestrationReceipt[];
	unreadable: Array<{ orchestrationId: string; receiptPath: string; error: string }>;
}

export interface InFlightLaneInput {
	laneId: string;
	role: string;
	workerPath: string;
	worktreeId?: string;
	baseCommit?: string;
}

export interface InFlightLane extends InFlightLaneInput {
	status: "pending" | "running" | "finished";
	runId?: string;
}

export interface InFlightOrchestration extends Record<string, unknown> {
	version: 1;
	kind: StoredOrchestrationReceipt["kind"];
	orchestrationId: string;
	receiptPath: string;
	objective: string;
	startedAt: string;
	updatedAt: string;
	phase: "running" | "aborted";
	errorPreview?: string;
	controller: DurableProcessIdentity;
	lanes: InFlightLane[];
}

export interface InFlightInspection {
	record: InFlightOrchestration;
	controllerStatus: ProcessIdentityStatus;
	stale: boolean;
}

export interface InFlightListing {
	running: InFlightInspection[];
	unreadable: Array<{ orchestrationId: string; recordPath: string; error: string }>;
}

export interface StoredOrchestrationReceipt extends Record<string, unknown> {
	version: 1;
	kind: "task" | "handoff" | "pair" | "herd" | "retry";
	orchestrationId: string;
	receiptPath: string;
	objective: string;
	status: "completed" | "failed" | "cancelled";
	workers: Array<Record<string, unknown>>;
	autoMerged: false;
}

function defaultRoot(): string {
	const explicit = process.env.OX_DRIVER_ORCHESTRATION_STATE_DIR?.trim();
	if (explicit) {
		if (!isAbsolute(explicit)) throw new Error("OX_DRIVER_ORCHESTRATION_STATE_DIR must be absolute");
		return resolve(explicit);
	}
	const xdg = process.env.XDG_STATE_HOME?.trim();
	if (xdg && !isAbsolute(xdg)) throw new Error("XDG_STATE_HOME must be absolute");
	return join(xdg || join(homedir(), ".local", "state"), "ox-driver", "orchestrations");
}

function validateId(id: string): void {
	if (!ORCHESTRATION_ID.test(id)) throw new Error("orchestration id must be a canonical UUID");
}

async function privateRoot(path: string): Promise<string> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const status = await lstat(path);
	const owner = process.getuid?.();
	if (!status.isDirectory() || status.isSymbolicLink()
		|| (owner !== undefined && status.uid !== owner)
		|| (status.mode & 0o077) !== 0) {
		throw new Error(`orchestration state directory must be private and owned by the current user: ${path}`);
	}
	const canonical = await realpath(path);
	if (canonical !== resolve(path)) throw new Error(`orchestration state directory must not traverse symlinks: ${path}`);
	return canonical;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximum) {
		throw new Error(`${label} must be a non-empty bounded string`);
	}
	return value;
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

function boundedPreview(value: string, maximum: number): string {
	if (Buffer.byteLength(value, "utf8") <= maximum) return value;
	let sliced = value.slice(0, maximum);
	while (Buffer.byteLength(sliced, "utf8") > maximum) sliced = sliced.slice(0, -1);
	return sliced;
}

async function writeInFlightRecord(directory: string, orchestrationId: string, value: InFlightOrchestration): Promise<void> {
	const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
	if (bytes.length > MAX_IN_FLIGHT_RECORD_BYTES) throw new Error("in-flight orchestration record exceeds the bounded record limit");
	const temporaryPath = join(directory, `.${orchestrationId}.${randomUUID()}.tmp`);
	const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
	try {
		await handle.writeFile(bytes);
	} finally {
		await handle.close();
	}
	// Same-directory rename is atomic, so readers see a whole record or none.
	await rename(temporaryPath, join(directory, `${orchestrationId}.json`)).catch(async (error) => {
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	});
}

function validateInFlight(value: unknown, id: string): InFlightOrchestration {
	const raw = record(value, "in-flight orchestration record");
	if (raw.version !== 1 || !KINDS.has(String(raw.kind))) throw new Error("in-flight record version or kind is unsupported");
	if (raw.orchestrationId !== id) throw new Error("in-flight record identity does not match its record path");
	const receiptPath = boundedString(raw.receiptPath, "in-flight receipt path", 16 * 1024);
	if (!isAbsolute(receiptPath)) throw new Error("in-flight receipt path must be absolute");
	boundedString(raw.objective, "in-flight objective", MAX_IN_FLIGHT_OBJECTIVE_BYTES);
	boundedString(raw.startedAt, "in-flight start time", 128);
	boundedString(raw.updatedAt, "in-flight update time", 128);
	if (!IN_FLIGHT_PHASES.has(String(raw.phase))) throw new Error("in-flight record phase is invalid");
	if (raw.errorPreview !== undefined) boundedString(raw.errorPreview, "in-flight error preview", MAX_IN_FLIGHT_ERROR_BYTES);
	record(raw.controller, "in-flight controller identity");
	if (!Array.isArray(raw.lanes) || raw.lanes.length === 0 || raw.lanes.length > 32) throw new Error("in-flight record has an invalid lane set");
	for (const [index, valueLane] of raw.lanes.entries()) {
		const lane = record(valueLane, `in-flight lane ${index}`);
		boundedString(lane.laneId, `in-flight lane ${index} id`, 1024);
		boundedString(lane.role, `in-flight lane ${index} role`, 1024);
		const workerPath = boundedString(lane.workerPath, `in-flight lane ${index} worker path`, 16 * 1024);
		if (!isAbsolute(workerPath)) throw new Error(`in-flight lane ${index} worker path must be absolute`);
		if (!IN_FLIGHT_LANE_STATUSES.has(String(lane.status))) throw new Error(`in-flight lane ${index} status is invalid`);
		if (lane.runId !== undefined) validateId(boundedString(lane.runId, `in-flight lane ${index} run id`, 128));
		if (lane.worktreeId !== undefined) validateId(boundedString(lane.worktreeId, `in-flight lane ${index} worktree id`, 128));
		if (lane.baseCommit !== undefined
			&& !/^[0-9a-f]{40,64}$/.test(boundedString(lane.baseCommit, `in-flight lane ${index} base commit`, 128))) {
			throw new Error(`in-flight lane ${index} base commit is invalid`);
		}
	}
	return raw as InFlightOrchestration;
}

// Live view of one orchestration between allocate() and persist(). The record
// is advisory: after the first write, update failures never interrupt the
// orchestration, and staleness detection covers a controller that dies without
// cleaning up.
export class InFlightOrchestrationHandle {
	readonly orchestrationId: string;
	readonly #directory: string;
	readonly #record: InFlightOrchestration;
	#queue: Promise<void> = Promise.resolve();

	constructor(directory: string, value: InFlightOrchestration) {
		this.orchestrationId = value.orchestrationId;
		this.#directory = directory;
		this.#record = value;
	}

	#enqueueWrite(): void {
		this.#queue = this.#queue.then(() =>
			writeInFlightRecord(this.#directory, this.orchestrationId, this.#record).catch(() => undefined));
	}

	updateLane(laneId: string, patch: { status?: "running" | "finished"; runId?: string }): void {
		const lane = this.#record.lanes.find((item) => item.laneId === laneId);
		if (!lane) return;
		if (patch.status !== undefined) lane.status = patch.status;
		if (patch.runId !== undefined && ORCHESTRATION_ID.test(patch.runId)) lane.runId = patch.runId;
		this.#record.updatedAt = new Date().toISOString();
		this.#enqueueWrite();
	}

	async markAborted(errorPreview: string): Promise<void> {
		this.#record.phase = "aborted";
		this.#record.errorPreview = boundedPreview(errorPreview || "orchestration ended without a receipt", MAX_IN_FLIGHT_ERROR_BYTES);
		this.#record.updatedAt = new Date().toISOString();
		this.#enqueueWrite();
		await this.flush();
	}

	// Drain queued writes. Call before persist() so a late update cannot
	// recreate the record after persist() removes it.
	async flush(): Promise<void> {
		await this.#queue;
	}
}

function validateReceipt(value: unknown, id: string, receiptPath: string): StoredOrchestrationReceipt {
	const receipt = record(value, "orchestration receipt");
	if (receipt.version !== 1 || (receipt.kind !== "task" && receipt.kind !== "handoff" && receipt.kind !== "pair" && receipt.kind !== "herd" && receipt.kind !== "retry")) {
		throw new Error("orchestration receipt version or kind is unsupported");
	}
	if (receipt.orchestrationId !== id || receipt.receiptPath !== receiptPath) {
		throw new Error("orchestration receipt identity does not match its exact record path");
	}
	if (!STATUSES.has(String(receipt.status))) throw new Error("orchestration receipt status is invalid");
	boundedString(receipt.objective, "orchestration objective", MAX_OBJECTIVE_BYTES);
	if (!Array.isArray(receipt.workers)
		|| (receipt.kind === "task" && receipt.workers.length > 1)
		|| (receipt.kind === "handoff" && receipt.workers.length > 2)
		|| (receipt.kind === "herd" && receipt.workers.length < 2)
		|| (receipt.kind === "retry" && receipt.workers.length < 1)
		|| receipt.workers.length > 32
		|| (receipt.kind === "pair" && receipt.workers.length !== 2)) {
		throw new Error("orchestration receipt has an invalid worker set");
	}
	let effectivePlan: ReturnType<typeof validateEffectiveRetryPlan> | undefined;
	if (receipt.effectivePlan !== undefined || receipt.effectivePlanSha256 !== undefined) {
		effectivePlan = validateEffectiveRetryPlan(receipt.effectivePlan);
		validateEffectiveRetryPlanSha256(receipt.effectivePlanSha256, effectivePlan);
	}
	for (const [index, valueWorker] of receipt.workers.entries()) {
		const worker = record(valueWorker, `orchestration worker ${index}`);
		if (Buffer.byteLength(JSON.stringify(worker), "utf8") > MAX_ORCHESTRATION_WORKER_SUMMARY_BYTES) {
			throw new Error(`orchestration worker ${index} exceeds the bounded summary limit`);
		}
		const workerPath = boundedString(worker.workerPath, `orchestration worker ${index} path`, 16 * 1024);
		if (!isAbsolute(workerPath)) throw new Error(`orchestration worker ${index} path must be absolute`);
		boundedString(worker.role, `orchestration worker ${index} role`, 1024);
		if (worker.laneId !== undefined) boundedString(worker.laneId, `orchestration worker ${index} lane id`, 1024);
		if (!WORKER_STATUSES.has(String(worker.status))) throw new Error(`orchestration worker ${index} status is invalid`);
		if (worker.expectedHarness !== undefined && !["opencode"].includes(String(worker.expectedHarness))) {
			throw new Error(`orchestration worker ${index} expected harness is invalid`);
		}
		if (worker.worktreeId !== undefined) {
			validateId(boundedString(worker.worktreeId, `orchestration worker ${index} worktree id`, 128));
		}
		if (worker.baseCommit !== undefined
			&& !/^[0-9a-f]{40,64}$/.test(boundedString(worker.baseCommit, `orchestration worker ${index} base commit`, 128))) {
			throw new Error(`orchestration worker ${index} base commit is invalid`);
		}
	}
	if (receipt.historicalReviewerWorkers !== undefined) {
		if (!Array.isArray(receipt.historicalReviewerWorkers)) throw new Error("historical reviewer workers must be an array");
		for (const [index, valueWorker] of receipt.historicalReviewerWorkers.entries()) {
			const worker = record(valueWorker, `historical reviewer worker ${index}`);
			if (Buffer.byteLength(JSON.stringify(worker), "utf8") > MAX_ORCHESTRATION_WORKER_SUMMARY_BYTES) {
				throw new Error(`historical reviewer worker ${index} exceeds the bounded summary limit`);
			}
			const workerPath = boundedString(worker.workerPath, `historical reviewer worker ${index} path`, 16 * 1024);
			if (!isAbsolute(workerPath)) throw new Error(`historical reviewer worker ${index} path must be absolute`);
			boundedString(worker.role, `historical reviewer worker ${index} role`, 1024);
			if (worker.laneId !== undefined) boundedString(worker.laneId, `historical reviewer worker ${index} lane id`, 1024);
			if (!WORKER_STATUSES.has(String(worker.status))) throw new Error(`historical reviewer worker ${index} status is invalid`);
			if (worker.expectedHarness !== undefined && !["opencode"].includes(String(worker.expectedHarness))) {
				throw new Error(`historical reviewer worker ${index} expected harness is invalid`);
			}
			if (worker.worktreeId !== undefined) validateId(boundedString(worker.worktreeId, `historical reviewer worker ${index} worktree id`, 128));
			if (worker.baseCommit !== undefined
				&& !/^[0-9a-f]{40,64}$/.test(boundedString(worker.baseCommit, `historical reviewer worker ${index} base commit`, 128))) {
				throw new Error(`historical reviewer worker ${index} base commit is invalid`);
			}
		}
	}
	if (effectivePlan && receipt.workers.length > 0) {
		const seenLaneIds = new Set<string>();
		for (const [index, worker] of receipt.workers.entries()) {
			const laneId = boundedString(worker.laneId, `orchestration worker ${index} effective lane id`, 1024);
			if (seenLaneIds.has(laneId)) throw new Error("orchestration workers must bind unique effective lane ids");
			seenLaneIds.add(laneId);
			const lane = effectivePlan.lanes.find((candidate) => candidate.id === laneId);
			const laneHarness = lane?.harness ?? "opencode";
			// Harness identity is judged per worker: receipts written before
			// expectedHarness existed carry harness only (and only on non-OpenCode
			// lanes), so requiring it receipt-wide would strand them. A worker that
			// declares expectedHarness must match the effective lane exactly, and a
			// completed worker that declares it must also show a verified harness.
			const declaredHarness = worker.expectedHarness !== undefined;
			if (!lane || lane.workerPath !== worker.workerPath
				|| (declaredHarness && boundedString(worker.expectedHarness, `orchestration worker ${index} expected harness`, 128) !== laneHarness)
				|| (worker.harness !== undefined && worker.harness !== laneHarness)
				|| (lane.worktreeId !== undefined && lane.worktreeId !== worker.worktreeId)
				|| (lane.baseCommit !== undefined && lane.baseCommit !== worker.baseCommit)) {
				throw new Error(`orchestration worker ${index} does not match its effective lane identity`);
			}
			if (declaredHarness && worker.status === "completed" && worker.harness !== laneHarness) {
				throw new Error(`completed orchestration worker ${index} lacks verified harness identity`);
			}
		}
	}
	if (receipt.kind === "task") {
		const requestedWorktreeId = boundedString(receipt.requestedWorktreeId, "task requested worktree id", 128);
		const requestedRunId = boundedString(receipt.requestedRunId, "task requested run id", 128);
		const source = boundedString(receipt.source, "task source", 16 * 1024);
		validateId(requestedWorktreeId);
		validateId(requestedRunId);
		if (!isAbsolute(source)) throw new Error("task source must be absolute");
		boundedString(receipt.requestedRef, "task requested ref", 1024);
		boundedString(receipt.integrationRecommendation, "task integration recommendation", 1024);
		if (typeof receipt.checksDeclared !== "boolean") throw new Error("task checks declaration is invalid");
		if (receipt.status === "completed" && (receipt.workers.length !== 1 || receipt.workers[0]?.status !== "completed")) {
			throw new Error("a completed task receipt requires one completed worker");
		}
		if (receipt.workers.length === 1 && receipt.workers[0]?.runId !== requestedRunId) {
			throw new Error("task worker receipt does not match its preassigned run id");
		}
		if (receipt.workers.length === 1 && receipt.workers[0]?.worktreeId !== undefined
			&& receipt.workers[0].worktreeId !== requestedWorktreeId) {
			throw new Error("task worker receipt does not match its preassigned worktree id");
		}
		if (receipt.workspace !== undefined) {
			const workspace = record(receipt.workspace, "task workspace");
			const workspaceId = boundedString(workspace.id, "task workspace id", 128);
			validateId(workspaceId);
			if (workspaceId !== requestedWorktreeId) throw new Error("task workspace does not match its preassigned id");
			const workspacePath = boundedString(workspace.path, "task workspace path", 16 * 1024);
			if (!isAbsolute(workspacePath)) throw new Error("task workspace path must be absolute");
			const workspaceSource = boundedString(workspace.source, "task workspace source", 16 * 1024);
			if (!isAbsolute(workspaceSource)) throw new Error("task workspace source must be absolute");
			if (workspaceSource !== source) throw new Error("task workspace source does not match the task source");
			const baseCommit = boundedString(workspace.baseCommit, "task workspace base commit", 128);
			if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) throw new Error("task workspace base commit is invalid");
			const workspaceStatus = boundedString(workspace.status, "task workspace status", 64);
			if (!WORKSPACE_STATUSES.has(workspaceStatus)) throw new Error("task workspace status is invalid");
			if (receipt.status === "completed" && workspaceStatus !== "ready" && workspaceStatus !== "dirty" && workspaceStatus !== "advanced") {
				throw new Error("a completed task receipt requires an intact managed worktree");
			}
		}
		if (receipt.status === "completed" && receipt.workspace === undefined) {
			throw new Error("a completed task receipt requires managed-worktree evidence");
		}
	}
	if (receipt.kind === "handoff") {
		const requestedWorktreeId = boundedString(receipt.requestedWorktreeId, "handoff requested worktree id", 128);
		const requestedBuilderRunId = boundedString(receipt.requestedBuilderRunId, "handoff requested builder run id", 128);
		const requestedReviewerRunId = boundedString(receipt.requestedReviewerRunId, "handoff requested reviewer run id", 128);
		const source = boundedString(receipt.source, "handoff source", 16 * 1024);
		validateId(requestedWorktreeId);
		validateId(requestedBuilderRunId);
		validateId(requestedReviewerRunId);
		if (!isAbsolute(source)) throw new Error("handoff source must be absolute");
		boundedString(receipt.requestedRef, "handoff requested ref", 1024);
		boundedString(receipt.integrationRecommendation, "handoff integration recommendation", 1024);
		if (typeof receipt.checksDeclared !== "boolean") throw new Error("handoff checks declaration is invalid");
		const evidence = record(receipt.evidence, "handoff evidence");
		for (const field of [
			"reviewerReceivedExactBuilderState",
			"reviewerChangedWorkspace",
			"acceptancePassed",
			"acceptanceChangedWorkspace",
		] as const) {
			if (typeof evidence[field] !== "boolean") throw new Error(`handoff evidence ${field} is invalid`);
		}
		if (receipt.workers[0] !== undefined) {
			if (receipt.workers[0].role !== "builder" || receipt.workers[0].runId !== requestedBuilderRunId) {
				throw new Error("handoff builder receipt does not match its preassigned identity");
			}
		}
		if (receipt.workers[1] !== undefined) {
			if (receipt.workers[1].role !== "reviewer" || receipt.workers[1].runId !== requestedReviewerRunId) {
				throw new Error("handoff reviewer receipt does not match its preassigned identity");
			}
		}
		if (receipt.workspace !== undefined) {
			const workspace = record(receipt.workspace, "handoff workspace");
			const workspaceId = boundedString(workspace.id, "handoff workspace id", 128);
			validateId(workspaceId);
			if (workspaceId !== requestedWorktreeId) throw new Error("handoff workspace does not match its preassigned id");
			const workspacePath = boundedString(workspace.path, "handoff workspace path", 16 * 1024);
			if (!isAbsolute(workspacePath)) throw new Error("handoff workspace path must be absolute");
			const workspaceSource = boundedString(workspace.source, "handoff workspace source", 16 * 1024);
			if (!isAbsolute(workspaceSource) || workspaceSource !== source) throw new Error("handoff workspace source is invalid");
			if (!/^[0-9a-f]{40,64}$/.test(boundedString(workspace.baseCommit, "handoff workspace base commit", 128))) {
				throw new Error("handoff workspace base commit is invalid");
			}
			const workspaceStatus = boundedString(workspace.status, "handoff workspace status", 64);
			if (!WORKSPACE_STATUSES.has(workspaceStatus)) throw new Error("handoff workspace status is invalid");
			if (receipt.status === "completed" && workspaceStatus !== "ready" && workspaceStatus !== "dirty" && workspaceStatus !== "advanced") {
				throw new Error("a completed handoff receipt requires an intact managed worktree");
			}
		}
		if (receipt.status === "completed") {
			if (receipt.workspace === undefined || receipt.workers.length !== 2
				|| receipt.workers.some((worker) => worker.status !== "completed")
				|| evidence.reviewerReceivedExactBuilderState !== true
				|| evidence.reviewerChangedWorkspace !== false
				|| evidence.acceptancePassed !== true
				|| evidence.acceptanceChangedWorkspace !== false) {
				throw new Error("a completed handoff receipt requires complete sequential evidence");
			}
		}
	}
	if (receipt.kind === "retry") {
		if (!effectivePlan || effectivePlan.lanes.length !== receipt.workers.length) {
			throw new Error("a retry receipt requires one effective lane for every retry worker");
		}
		const lineage = record(receipt.lineage, "retry lineage");
		const rootOrchestrationId = boundedString(lineage.rootOrchestrationId, "retry root orchestration id", 128);
		const parentOrchestrationId = boundedString(lineage.parentOrchestrationId, "retry parent orchestration id", 128);
		validateId(rootOrchestrationId);
		validateId(parentOrchestrationId);
		if (!Number.isSafeInteger(lineage.attemptNumber) || Number(lineage.attemptNumber) < 2) {
			throw new Error("retry lineage attempt number must be an integer of at least 2");
		}
		const selection = record(receipt.selection, "retry selection");
		if (selection.mode !== "lanes" && selection.mode !== "failed") throw new Error("retry selection mode is invalid");
		if (!Array.isArray(selection.laneIds) || selection.laneIds.length !== receipt.workers.length
			|| selection.laneIds.some((value) => typeof value !== "string" || !value.trim())
			|| new Set(selection.laneIds).size !== selection.laneIds.length) {
			throw new Error("retry selection lane ids are invalid");
		}
		const plannedLaneIds = effectivePlan.lanes.map((lane) => lane.id);
		if (JSON.stringify(selection.laneIds) !== JSON.stringify(plannedLaneIds)) {
			throw new Error("retry selection does not match its effective plan");
		}
		if (!new Set(["resolved", "partial", "failed", "cancelled"]).has(String(receipt.resolutionStatus))) {
			throw new Error("retry resolution status is invalid");
		}
		if (!Array.isArray(receipt.remainingUnsuccessfulLaneIds)
			|| receipt.remainingUnsuccessfulLaneIds.some((value) => typeof value !== "string" || !value.trim())
			|| new Set(receipt.remainingUnsuccessfulLaneIds).size !== receipt.remainingUnsuccessfulLaneIds.length) {
			throw new Error("retry remaining unsuccessful lane ids are invalid");
		}
		if (!Array.isArray(receipt.laneStates) || receipt.laneStates.length < receipt.workers.length || receipt.laneStates.length > 32) {
			throw new Error("retry lane states are invalid");
		}
		const laneStateIds = new Set<string>();
		for (const [index, valueState] of receipt.laneStates.entries()) {
			const state = record(valueState, `retry lane state ${index}`);
			const laneId = boundedString(state.laneId, `retry lane state ${index} lane id`, 1024);
			if (laneStateIds.has(laneId)) throw new Error("retry lane state ids must be unique");
			laneStateIds.add(laneId);
			if (!Number.isSafeInteger(state.attemptNumber) || Number(state.attemptNumber) < 1) throw new Error(`retry lane state ${index} attempt number is invalid`);
			validateId(boundedString(state.latestOrchestrationId, `retry lane state ${index} latest orchestration id`, 128));
			validateId(boundedString(state.latestRunId, `retry lane state ${index} latest run id`, 128));
			if (!WORKER_STATUSES.has(String(state.status))) throw new Error(`retry lane state ${index} status is invalid`);
		}
		if (receipt.remainingUnsuccessfulLaneIds.some((laneId) => !laneStateIds.has(laneId))) {
			throw new Error("retry remaining unsuccessful lane ids do not match its lane states");
		}
		for (const [index, worker] of receipt.workers.entries()) {
			if (worker.laneId !== plannedLaneIds[index]) throw new Error(`retry worker ${index} does not match its selected lane`);
			const previousRunId = boundedString(worker.previousRunId, `retry worker ${index} previous run id`, 128);
			validateId(previousRunId);
			// Receipts written before these per-worker back-references existed stay
			// readable; lineage.parentOrchestrationId carries the same linkage.
			if (worker.previousOrchestrationId !== undefined) {
				validateId(boundedString(worker.previousOrchestrationId, `retry worker ${index} previous orchestration id`, 128));
			}
			if (worker.previousReceiptPath !== undefined
				&& !isAbsolute(boundedString(worker.previousReceiptPath, `retry worker ${index} previous receipt path`, 16 * 1024))) {
				throw new Error(`retry worker ${index} previous receipt path must be absolute`);
			}
			if (!WORKER_STATUSES.has(String(worker.previousStatus))) throw new Error(`retry worker ${index} previous status is invalid`);
			if (!Number.isSafeInteger(worker.attemptNumber) || Number(worker.attemptNumber) < 2) throw new Error(`retry worker ${index} attempt number is invalid`);
		}
	}
	if (receipt.autoMerged !== false) throw new Error("orchestration receipt must preserve explicit host integration");
	return receipt as StoredOrchestrationReceipt;
}

export class OrchestrationReceiptStore {
	readonly root: string;

	constructor(root = defaultRoot()) {
		if (!isAbsolute(root)) throw new Error("orchestration state root must be absolute");
		this.root = resolve(root);
	}

	async allocate(): Promise<OrchestrationAllocation> {
		const root = await privateRoot(this.root);
		const orchestrationId = randomUUID();
		return { orchestrationId, receiptPath: join(root, `${orchestrationId}.json`) };
	}

	async persist(value: unknown): Promise<StoredOrchestrationReceipt> {
		const root = await privateRoot(this.root);
		const raw = record(value, "orchestration receipt");
		const id = boundedString(raw.orchestrationId, "orchestration id", 128);
		validateId(id);
		const receiptPath = join(root, `${id}.json`);
		const receipt = validateReceipt(raw, id, receiptPath);
		const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
		if (bytes.length > MAX_ORCHESTRATION_RECEIPT_BYTES) throw new Error("orchestration receipt exceeds the bounded record limit");
		const temporaryPath = join(root, `.${id}.${randomUUID()}.pending`);
		const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await link(temporaryPath, receiptPath);
			await chmod(receiptPath, 0o600);
		} finally {
			await unlink(temporaryPath).catch(() => undefined);
		}
		// The terminal receipt supersedes the advisory in-flight record for every
		// orchestration kind, including kinds that never wrote one.
		await unlink(join(root, IN_FLIGHT_DIRECTORY, `${id}.json`)).catch(() => undefined);
		return immutable(receipt);
	}

	async beginInFlight(
		allocation: OrchestrationAllocation,
		input: { kind: StoredOrchestrationReceipt["kind"]; objective: string; lanes: InFlightLaneInput[] },
	): Promise<InFlightOrchestrationHandle> {
		validateId(allocation.orchestrationId);
		if (!KINDS.has(input.kind)) throw new Error("in-flight orchestration kind is unsupported");
		if (!Array.isArray(input.lanes) || input.lanes.length === 0 || input.lanes.length > 32) {
			throw new Error("in-flight orchestration lanes must be a non-empty bounded set");
		}
		const root = await privateRoot(this.root);
		const directory = await privateRoot(join(root, IN_FLIGHT_DIRECTORY));
		await this.#sweepStale(root, directory);
		const now = new Date().toISOString();
		const value: InFlightOrchestration = {
			version: 1,
			kind: input.kind,
			orchestrationId: allocation.orchestrationId,
			receiptPath: allocation.receiptPath,
			objective: boundedPreview(boundedString(input.objective, "in-flight objective", MAX_OBJECTIVE_BYTES), MAX_IN_FLIGHT_OBJECTIVE_BYTES),
			startedAt: now,
			updatedAt: now,
			phase: "running",
			controller: await captureProcessIdentity(process.pid),
			lanes: input.lanes.map((lane, index) => ({
				laneId: boundedString(lane.laneId, `in-flight lane ${index} id`, 1024),
				role: boundedString(lane.role, `in-flight lane ${index} role`, 1024),
				workerPath: boundedString(lane.workerPath, `in-flight lane ${index} worker path`, 16 * 1024),
				status: "pending",
				...(lane.worktreeId !== undefined ? { worktreeId: lane.worktreeId } : {}),
				...(lane.baseCommit !== undefined ? { baseCommit: lane.baseCommit } : {}),
			})),
		};
		// The first write surfaces misconfiguration; later updates are advisory.
		await writeInFlightRecord(directory, allocation.orchestrationId, value);
		return new InFlightOrchestrationHandle(directory, value);
	}

	async listInFlight(): Promise<InFlightListing> {
		const root = await privateRoot(this.root);
		const directory = await privateRoot(join(root, IN_FLIGHT_DIRECTORY));
		const running: InFlightInspection[] = [];
		const unreadable: InFlightListing["unreadable"] = [];
		for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith(".") || !entry.name.endsWith(".json")) continue;
			const id = entry.name.slice(0, -5);
			const recordPath = join(directory, entry.name);
			try {
				validateId(id);
				if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("in-flight record is not a regular file");
				running.push(await this.#readInFlight(root, directory, id));
			} catch (error) {
				unreadable.push({ orchestrationId: id, recordPath, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return { running, unreadable };
	}

	async inspectInFlight(id: string): Promise<InFlightInspection> {
		validateId(id);
		const root = await privateRoot(this.root);
		const directory = await privateRoot(join(root, IN_FLIGHT_DIRECTORY));
		return this.#readInFlight(root, directory, id);
	}

	async #readInFlight(root: string, directory: string, id: string): Promise<InFlightInspection> {
		const recordPath = join(directory, `${id}.json`);
		const lexical = await lstat(recordPath, { bigint: true });
		if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.size < 2n || lexical.size > BigInt(MAX_IN_FLIGHT_RECORD_BYTES)) {
			throw new Error("in-flight record must be a bounded non-symlink file");
		}
		const handle = await open(recordPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		let bytes: Buffer;
		try {
			bytes = await handle.readFile();
		} finally {
			await handle.close();
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		} catch (error) {
			throw new Error(`in-flight record is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		const value = validateInFlight(parsed, id);
		const controllerStatus = await processIdentityStatus(value.controller);
		// A terminal receipt supersedes the in-flight record even when its
		// controller process is still alive.
		const receiptExists = await lstat(join(root, `${id}.json`)).then(() => true, () => false);
		const stale = receiptExists || controllerStatus === "missing" || controllerStatus === "reused";
		return { record: immutable(value), controllerStatus, stale };
	}

	// Only the next writer sweeps, so read commands stay side-effect-free.
	// Removal is limited to records whose controller is provably gone or whose
	// terminal receipt exists; "unverifiable" and unreadable records stay.
	async #sweepStale(root: string, directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const entryPath = join(directory, entry.name);
			if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) {
				const status = await lstat(entryPath).catch(() => undefined);
				if (status && Date.now() - status.mtimeMs > ABANDONED_TEMPORARY_MILLISECONDS) {
					await unlink(entryPath).catch(() => undefined);
				}
				continue;
			}
			if (entry.name.startsWith(".") || !entry.name.endsWith(".json")) continue;
			const id = entry.name.slice(0, -5);
			if (!ORCHESTRATION_ID.test(id)) continue;
			try {
				const inspection = await this.#readInFlight(root, directory, id);
				if (inspection.stale) await unlink(entryPath).catch(() => undefined);
			} catch { /* unreadable records stay visible through listInFlight */ }
		}
	}

	async inspect(id: string): Promise<StoredOrchestrationReceipt> {
		validateId(id);
		const root = await privateRoot(this.root);
		const receiptPath = join(root, `${id}.json`);
		const lexical = await lstat(receiptPath, { bigint: true });
		if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.size < 2n || lexical.size > BigInt(MAX_ORCHESTRATION_RECEIPT_BYTES)) {
			throw new Error("orchestration receipt must be a bounded non-symlink file");
		}
		const handle = await open(receiptPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const before = await handle.stat({ bigint: true });
			if (!before.isFile() || before.dev !== lexical.dev || before.ino !== lexical.ino) {
				throw new Error("orchestration receipt changed before opening");
			}
			const bytes = await handle.readFile();
			const after = await handle.stat({ bigint: true });
			if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
				|| before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || bytes.length !== Number(after.size)) {
				throw new Error("orchestration receipt changed while reading");
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
			} catch (error) {
				throw new Error(`orchestration receipt is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
			}
			return immutable(validateReceipt(parsed, id, receiptPath));
		} finally {
			await handle.close();
		}
	}

	async list(): Promise<OrchestrationListing> {
		const root = await privateRoot(this.root);
		const receipts: StoredOrchestrationReceipt[] = [];
		const unreadable: OrchestrationListing["unreadable"] = [];
		// One damaged or unsupported record must not hide every other receipt.
		for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith(".") && entry.name.endsWith(".pending")) continue;
			if (!entry.name.endsWith(".json")) continue;
			const id = entry.name.slice(0, -5);
			const receiptPath = join(root, entry.name);
			try {
				validateId(id);
				if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("orchestration record is not a regular file");
				receipts.push(await this.inspect(id));
			} catch (error) {
				unreadable.push({ orchestrationId: id, receiptPath, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return { receipts, unreadable };
	}
}
