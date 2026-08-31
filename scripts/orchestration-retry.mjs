import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	effectiveRetryPlanSha256,
	ManagedWorktreeStore,
	OrchestrationReceiptStore,
	RunStore,
	summarizeOrchestrationCosts,
	validateEffectiveRetryPlan,
	validateEffectiveRetryPlanSha256,
} from "../packages/core/dist/index.js";
import { createWorkerSupervisor, resolveRunnerIdentity, runWorker } from "./ox_pair.mjs";
import { OX_DRIVER_SUPPORTS_PI_LANES } from "./distribution.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_RUNNER = resolve(ROOT, "scripts", "ox_opencode.mjs");
const DEFAULT_PI_RUNNER = resolve(ROOT, "scripts", "ox_pi.mjs");
const PRIVATE_CONTROLLER_CLI = resolve(ROOT, "packages", "cli", "dist", "main.js");
const RETRYABLE_STATUSES = new Set(["failed", "blocked", "unknown"]);
const MAX_CONTEXT_BYTES = 64 * 1024;
const MAX_STREAM_BYTES = 12 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fail(message) {
	throw new Error(message);
}

function record(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
	return value;
}

function runStore() {
	const explicit = process.env.OX_DRIVER_STATE_DIR?.trim();
	return explicit ? new RunStore(explicit) : new RunStore();
}

function utf8HeadTail(value, maximumBytes) {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maximumBytes) return value;
	const marker = Buffer.from("\n... bounded retry context omitted the middle of this stream ...\n", "utf8");
	const budget = maximumBytes - marker.length;
	let headEnd = Math.floor(budget / 2);
	while (headEnd > 0 && (bytes[headEnd] & 0xc0) === 0x80) headEnd -= 1;
	let tailStart = bytes.length - (budget - headEnd);
	while (tailStart < bytes.length && (bytes[tailStart] & 0xc0) === 0x80) tailStart += 1;
	return Buffer.concat([bytes.subarray(0, headEnd), marker, bytes.subarray(tailStart)]).toString("utf8");
}

function contextFor(lane, previousWorker, previousReceipt, instruction) {
	const harness = lane.harness ?? "opencode";
	const continuation = harness === "pi"
		? "Re-run the read-only review against the existing managed worktree, inspect the current state directly, and return a complete answer to the original objective. Do not modify the workspace."
		: "Inspect the existing changes, repair the incomplete work, and finish the original objective.";
	const lines = [
		`Continue lane ${lane.id} (${lane.role}) in its existing managed worktree.`,
		`Original objective: ${lane.objective}`,
		`Previous attempt status: ${previousWorker.status}.`,
		continuation,
	];
	const failedChecks = Array.isArray(previousReceipt?.acceptance)
		? previousReceipt.acceptance.filter((check) => check?.passed !== true)
		: [];
	if (failedChecks.length > 0) {
		lines.push("Controller-owned acceptance feedback from the previous attempt:");
		for (const check of failedChecks) {
			lines.push(`Command: ${String(check.command ?? "unknown")}`);
			lines.push(`Exit: ${check.exitCode === null || check.exitCode === undefined ? "unknown" : check.exitCode}; timed out: ${check.timedOut === true}`);
			if (typeof check.stdout === "string" && check.stdout) lines.push(`stdout:\n${utf8HeadTail(check.stdout, MAX_STREAM_BYTES)}`);
			if (typeof check.stderr === "string" && check.stderr) lines.push(`stderr:\n${utf8HeadTail(check.stderr, MAX_STREAM_BYTES)}`);
		}
	} else if (Array.isArray(previousWorker.acceptance)) {
		const failed = previousWorker.acceptance.filter((check) => check?.passed !== true);
		if (failed.length > 0) lines.push(`The aggregate recorded ${failed.length} unsuccessful acceptance command(s); inspect the current worktree and rerun every declared check.`);
	}
	if (Array.isArray(previousWorker.unownedChangedPaths) && previousWorker.unownedChangedPaths.length > 0) {
		lines.push(harness === "pi"
			? `Report these previously observed out-of-scope changes without editing them: ${previousWorker.unownedChangedPaths.join(", ")}`
			: `Resolve or intentionally revert these out-of-scope changes: ${previousWorker.unownedChangedPaths.join(", ")}`);
	}
	if (instruction) lines.push(`Additional host instruction: ${instruction}`);
	const raw = lines.join("\n\n");
	const preview = utf8HeadTail(raw, MAX_CONTEXT_BYTES);
	return {
		preview,
		evidence: {
			bytes: Buffer.byteLength(raw, "utf8"),
			sha256: createHash("sha256").update(raw).digest("hex"),
			previewBytes: Buffer.byteLength(preview, "utf8"),
			truncated: preview !== raw,
		},
	};
}

function latestLaneStates(source, root) {
	if (source.kind === "retry") {
		if (!Array.isArray(source.laneStates)) fail("retry receipt is missing its root lane states");
		return source.laneStates.map((value) => ({ ...record(value, "retry lane state") }));
	}
	return root.workers.map((worker) => ({
		laneId: worker.laneId,
		attemptNumber: 1,
		latestOrchestrationId: root.orchestrationId,
		latestRunId: worker.runId ?? worker.observedRunId ?? worker.requestedRunId,
		status: worker.status,
	}));
}

async function previousWorkerFor(store, state) {
	if (!UUID.test(String(state.latestOrchestrationId ?? ""))) fail(`lane ${state.laneId} has an invalid latest orchestration id`);
	const receipt = await store.inspect(state.latestOrchestrationId);
	const workers = receipt.workers.filter((worker) => worker.laneId === state.laneId);
	if (workers.length !== 1) fail(`lane ${state.laneId} does not resolve to exactly one previous worker`);
	return { receipt, worker: workers[0] };
}

async function priorRunReceipt(store, runId) {
	if (!UUID.test(String(runId ?? ""))) return undefined;
	try {
		return await store.readReceipt(runId);
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

async function boundedMap(items, concurrency, callback) {
	const results = new Array(items.length);
	let next = 0;
	async function worker() {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await callback(items[index], index);
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
	return results;
}

export async function retryOrchestration({
	sourceId,
	laneIds = [],
	failed = false,
	instruction,
	concurrency,
	runner: requestedRunner,
}) {
	if (!UUID.test(sourceId)) fail("retry source id must be a canonical UUID");
	if ((laneIds.length === 0) === !failed) fail("retry requires one or more --lane values or --failed");
	if (new Set(laneIds).size !== laneIds.length) fail("retry lane ids must be unique");
	const orchestrationStore = new OrchestrationReceiptStore();
	const source = await orchestrationStore.inspect(sourceId);
	const lineage = source.kind === "retry" ? record(source.lineage, "retry lineage") : undefined;
	const rootId = lineage?.rootOrchestrationId ?? source.orchestrationId;
	if (!UUID.test(String(rootId))) fail("retry root orchestration id is invalid");
	const root = rootId === source.orchestrationId ? source : await orchestrationStore.inspect(rootId);
	if (!root.effectivePlan || !root.effectivePlanSha256) fail("source orchestration predates effective lane snapshots and cannot be retried faithfully");
	const rootPlan = validateEffectiveRetryPlan(root.effectivePlan);
	validateEffectiveRetryPlanSha256(root.effectivePlanSha256, rootPlan);
	const states = latestLaneStates(source, root);
	const stateByLane = new Map(states.map((state) => [state.laneId, state]));
	if (stateByLane.size !== rootPlan.lanes.length || rootPlan.lanes.some((lane) => !stateByLane.has(lane.id))) {
		fail("retry lane states do not cover the root effective plan");
	}
	const selectedIds = failed
		? states.filter((state) => RETRYABLE_STATUSES.has(state.status)).map((state) => state.laneId)
		: laneIds;
	if (selectedIds.length === 0) fail("no retryable failed, blocked, or unknown lanes remain");
	const selected = [];
	const workspaceStore = new ManagedWorktreeStore();
	const durableRuns = runStore();
	for (const laneId of selectedIds) {
		const lane = rootPlan.lanes.find((candidate) => candidate.id === laneId);
		const state = stateByLane.get(laneId);
		if (!lane || !state) fail(`retry lane does not exist: ${laneId}`);
		if (lane.harness === "pi") {
			if (lane.agent !== undefined) fail(`Pi retry lane ${laneId} cannot select an OpenCode agent profile`);
			if ((lane.childAgents?.length ?? 0) > 0) fail(`Pi retry lane ${laneId} cannot select OpenCode child agents`);
		}
		if (state.status === "completed") fail(`lane ${laneId} already completed; retry only incomplete work`);
		if (failed && state.status === "cancelled") fail(`cancelled lane ${laneId} requires an explicit --lane retry`);
		if (!lane.worktreeId) fail(`lane ${laneId} lacks managed-worktree identity and cannot continue in place`);
		const workspace = await workspaceStore.inspect(lane.worktreeId);
		if (workspace.path !== lane.workerPath || workspace.baseCommit !== lane.baseCommit) fail(`lane ${laneId} managed-worktree identity differs from its effective plan`);
		if (!["ready", "dirty", "advanced"].includes(workspace.status)) fail(`lane ${laneId} managed worktree is ${workspace.status}`);
		const previous = await previousWorkerFor(orchestrationStore, state);
		const previousWorker = previous.worker;
		const previousRunId = previousWorker.runId ?? previousWorker.observedRunId ?? previousWorker.requestedRunId ?? state.latestRunId;
		if (!UUID.test(String(previousRunId ?? ""))) fail(`lane ${laneId} lacks a canonical previous run id`);
		const previousReceipt = await priorRunReceipt(durableRuns, previousRunId);
		const context = contextFor(lane, previousWorker, previousReceipt, instruction);
		selected.push({
			lane,
			state,
			workspace,
			previousWorker,
			previousOrchestration: previous.receipt,
			previousRunId,
			previousReceipt,
			context,
			workspaceStateLink: typeof previousReceipt?.finalWorkspaceSha256 === "string" ? "verified" : "unverified",
			requestedRunId: randomUUID(),
		});
	}
	const selectedPlan = validateEffectiveRetryPlan({ version: 1, lanes: selected.map((item) => item.lane) });
	const selectedPlanSha256 = effectiveRetryPlanSha256(selectedPlan);
	const requestedOpenCodeRunner = requestedRunner ?? process.env.OX_DRIVER_RETRY_RUNNER?.trim() ?? DEFAULT_RUNNER;
	if (!isAbsolute(requestedOpenCodeRunner)) fail("OX_DRIVER_RETRY_RUNNER must be an absolute path");
	const requestedPiRunner = process.env.OX_DRIVER_PI_LANE_RUNNER?.trim() || DEFAULT_PI_RUNNER;
	if (!isAbsolute(requestedPiRunner)) fail("OX_DRIVER_PI_LANE_RUNNER must be an absolute path");
	if (selected.some((item) => item.lane.harness === "pi")) {
		if (!OX_DRIVER_SUPPORTS_PI_LANES) fail("this OpenCode-only distribution cannot dispatch or retry Pi lanes");
		try {
			await Promise.all([access(requestedPiRunner), access(PRIVATE_CONTROLLER_CLI)]);
		} catch {
			fail("Pi retry support is unavailable in this installation");
		}
	}
	const usesOpenCode = selected.some((item) => (item.lane.harness ?? "opencode") === "opencode");
	const usesPi = selected.some((item) => item.lane.harness === "pi");
	const runnerIdentity = usesOpenCode
		? await resolveRunnerIdentity(requestedOpenCodeRunner, requestedRunner || process.env.OX_DRIVER_RETRY_RUNNER?.trim() ? "environment-override" : "bundled")
		: undefined;
	const piRunnerIdentity = usesPi
		? await resolveRunnerIdentity(requestedPiRunner, process.env.OX_DRIVER_PI_LANE_RUNNER?.trim() ? "environment-override" : "bundled")
		: undefined;
	const recordedRunners = Array.isArray(root.runners) ? root.runners : [];
	for (const identity of [runnerIdentity && { harness: "opencode", ...runnerIdentity }, piRunnerIdentity && { harness: "pi", ...piRunnerIdentity }].filter(Boolean)) {
		const recorded = recordedRunners.find((candidate) => candidate?.harness === identity.harness);
		if (recorded && (recorded.path !== identity.path || recorded.sha256 !== identity.sha256)) {
			fail(`${identity.harness} retry runner identity differs from the root orchestration`);
		}
	}
	const runner = runnerIdentity?.path;
	const piRunner = piRunnerIdentity?.path;
	const retryConcurrency = concurrency ?? Math.min(selected.length, 8);
	if (!Number.isSafeInteger(retryConcurrency) || retryConcurrency < 1 || retryConcurrency > 32) fail("retry concurrency must be an integer from 1 to 32");
	const allocation = await orchestrationStore.allocate();
	process.stderr.write(`OX_DRIVER_ORCHESTRATION_ID=${allocation.orchestrationId}\n`);
	// Retry lanes deliberately reuse their prior worktrees, so two records may
	// reference one worktree; the listing surfaces that instead of blocking it.
	const inflight = await orchestrationStore.beginInFlight(allocation, {
		kind: "retry",
		objective: instruction || `Repair ${selectedIds.join(", ")} from orchestration ${sourceId}`,
		lanes: selected.map((item) => ({
			laneId: item.lane.id,
			role: item.lane.role,
			workerPath: item.lane.workerPath,
			...(item.lane.worktreeId !== undefined ? { worktreeId: item.lane.worktreeId } : {}),
			...(item.lane.baseCommit !== undefined ? { baseCommit: item.lane.baseCommit } : {}),
		})),
	});
	const guard = createWorkerSupervisor({});
	const laneControls = (laneId) => ({
		onStart(child) { guard.controls.onStart(child); inflight.updateLane(laneId, { status: "running" }); },
		onRunId(child, runId) { guard.controls.onRunId(child, runId); inflight.updateLane(laneId, { runId }); },
		onDone(child) { guard.controls.onDone(child); inflight.updateLane(laneId, { status: "finished" }); },
	});
	let pendingSignal = false;
	const onSignal = () => {
		pendingSignal = true;
		void guard.cancel();
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	if (pendingSignal) void guard.cancel();
	try {
	let results;
	try {
		results = await boundedMap(selected, retryConcurrency, async (item) => {
			const result = guard.cancellationRequested ? {
				workerPath: item.lane.workerPath,
				role: item.lane.role,
				status: "cancelled",
				expectedHarness: item.lane.harness ?? "opencode",
				requestedRunId: item.requestedRunId,
				changedPaths: [],
				unownedChangedPaths: [],
				acceptance: [],
				controllerError: "retry lane was not started after orchestration cancellation",
			} : await runWorker(item.lane.harness === "pi" ? piRunner : runner, {
			objective: item.context.preview,
			checks: [...item.lane.checks],
			ownedPaths: [...item.lane.ownedPaths],
			excludedPaths: [...item.lane.excludedPaths],
			route: item.lane.route,
			agent: item.lane.agent,
			childAgents: item.lane.childAgents,
			profileDirectory: item.lane.profileDirectory,
			timeoutSeconds: item.lane.timeoutSeconds,
			laneCeilingUsdMicros: item.lane.reportOnlyCostUsdMicros,
			lanePrefix: `Retry lane ${item.lane.role}`,
			expectedWorkspaceSha256: item.previousReceipt?.finalWorkspaceSha256,
			expectedRouteProfileSha256: item.previousReceipt?.routeProfileSha256,
			requestedRunId: item.requestedRunId,
			expectedHarness: item.lane.harness ?? "opencode",
			runnerIdentity: item.lane.harness === "pi" ? piRunnerIdentity : runnerIdentity,
		}, item.lane.workerPath, item.lane.role, laneControls(item.lane.id));
		return {
			...result,
			laneId: item.lane.id,
			worktreeId: item.lane.worktreeId,
			baseCommit: item.lane.baseCommit,
			previousRunId: item.previousRunId,
			previousOrchestrationId: item.previousOrchestration.orchestrationId,
			previousReceiptPath: item.previousOrchestration.receiptPath,
			previousStatus: item.state.status,
			attemptNumber: Number(item.state.attemptNumber) + 1,
			workspaceStateLink: item.workspaceStateLink,
			continuationContextPreview: item.context.preview,
			continuationContextEvidence: { ...item.context.evidence, redacted: true },
		};
		});
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
	const laneStates = states.map((state) => {
		const result = results.find((worker) => worker.laneId === state.laneId);
		return result ? {
			laneId: state.laneId,
			attemptNumber: result.attemptNumber,
			latestOrchestrationId: allocation.orchestrationId,
			latestRunId: result.runId ?? result.observedRunId ?? result.requestedRunId,
			status: result.status,
		} : state;
	});
	const remainingUnsuccessfulLaneIds = laneStates.filter((state) => state.status !== "completed").map((state) => state.laneId);
	const cancelled = guard.interrupted || results.some((worker) => worker.status === "cancelled");
	const allCompleted = results.every((worker) => worker.status === "completed");
	const status = guard.interrupted
		? "cancelled"
		: allCompleted ? "completed" : cancelled && results.every((worker) => ["completed", "cancelled"].includes(worker.status)) ? "cancelled" : "failed";
	const resolutionStatus = status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : remainingUnsuccessfulLaneIds.length === 0 ? "resolved" : "partial";
	const reportOnlyCeilingUsdMicros = selectedPlan.lanes.reduce((sum, lane) => sum + lane.reportOnlyCostUsdMicros, 0);
	const costSummary = summarizeOrchestrationCosts(results, reportOnlyCeilingUsdMicros);
	await inflight.flush();
	const receipt = await orchestrationStore.persist({
		version: 1,
		kind: "retry",
		orchestrationId: allocation.orchestrationId,
		receiptPath: allocation.receiptPath,
		objective: instruction || `Repair ${selectedIds.join(", ")} from orchestration ${sourceId}`,
		status,
		lineage: {
			rootOrchestrationId: rootId,
			parentOrchestrationId: source.orchestrationId,
			attemptNumber: Number(lineage?.attemptNumber ?? 1) + 1,
		},
		selection: { mode: failed ? "failed" : "lanes", laneIds: selectedIds },
		effectivePlan: selectedPlan,
		effectivePlanSha256: selectedPlanSha256,
		rootEffectivePlanSha256: root.effectivePlanSha256,
		runners: [runnerIdentity && { harness: "opencode", ...runnerIdentity }, piRunnerIdentity && { harness: "pi", ...piRunnerIdentity }].filter(Boolean),
		concurrency: retryConcurrency,
		reportOnlyCeilingUsdMicros,
		...costSummary,
		workers: results,
		laneStates,
		remainingUnsuccessfulLaneIds,
		resolutionStatus,
		integrationRecommendation: resolutionStatus === "resolved"
			? "review-repaired-worktrees-and-integrate-selected-changes"
			: "continue-retrying-unsuccessful-lanes-before-integration",
		autoMerged: false,
	});
	return receipt;
	} catch (error) {
		// A receiptless death stays visible: the aborted record is removed only
		// by a later writer's stale sweep.
		await inflight.markAborted(error instanceof Error ? error.message : String(error)).catch(() => undefined);
		throw error;
	}
}
