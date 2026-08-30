#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createWorkerSupervisor, discoverWorkerIdentity, resolveRunnerIdentity, runWorker } from "./ox_pair.mjs";
import { retryOrchestration } from "./orchestration-retry.mjs";
import {
	effectiveRetryPlanSha256,
	MICROS_PER_USD,
	summarizeOrchestrationCosts,
	validateEffectiveRetryPlan,
	validateOrchestrationPlan,
} from "../packages/core/dist/index.js";
import { OrchestrationReceiptStore } from "../packages/core/dist/orchestration-store.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RUNNER = resolve(ROOT, "scripts", "ox_opencode.mjs");
const MAX_WORKERS = 32;

function fail(message) {
	throw new Error(message);
}

function relativeScope(value, flag) {
	if (!value || isAbsolute(value) || value.includes("\0") || value.split(/[\\/]+/).includes("..")) {
		fail(`${flag} must be a relative path that stays inside each worker repository`);
	}
	return value;
}

function parse(args) {
	const workers = [];
	const roles = [];
	const checks = [];
	const ownedPaths = [];
	const excludedPaths = [];
	const positional = [];
	const childAgents = [];
	let route;
	let profileDirectory;
	let agent;
	let laneSpec;
	let noCheck = false;
	let failurePolicy = "collect";
	let timeoutSeconds = 3_600;
	let ceilingUsdMicros = 250_000;
	let concurrency;
	let sawTimeout = false;
	let sawCeiling = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--worker") workers.push(args[++index]?.trim() || fail("--worker requires an absolute worktree path"));
		else if (argument === "--role") roles.push(args[++index]?.trim() || fail("--role requires a name"));
		else if (argument === "--check") checks.push(args[++index]?.trim() || fail("--check requires a command"));
		else if (argument === "--no-check") noCheck = true;
		else if (argument === "--owned") ownedPaths.push(relativeScope(args[++index], "--owned"));
		else if (argument === "--exclude") excludedPaths.push(relativeScope(args[++index], "--exclude"));
		else if (argument === "--route") route = args[++index]?.trim() || fail("--route requires a profile id");
		else if (argument === "--profile-dir") {
			profileDirectory = args[++index]?.trim() || fail("--profile-dir requires an absolute directory");
			if (!isAbsolute(profileDirectory)) fail("--profile-dir requires an absolute directory");
		} else if (argument === "--agent") agent = args[++index]?.trim() || fail("--agent requires a profile");
		else if (argument === "--child-agent") {
			const child = args[++index]?.trim() || fail("--child-agent requires a profile");
			if (childAgents.includes(child)) fail("--child-agent must not repeat a profile");
			childAgents.push(child);
		}
		else if (argument === "--lane-spec") laneSpec = args[++index]?.trim() || fail("--lane-spec requires a JSON plan file");
		else if (argument === "--timeout") {
			sawTimeout = true;
			timeoutSeconds = Number(args[++index]);
			if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) fail("--timeout must be an integer from 1 to 86400 seconds");
		} else if (argument === "--cost-ceiling") {
			sawCeiling = true;
			const dollars = Number(args[++index]);
			const micros = Math.round(dollars * 1_000_000);
			if (!Number.isFinite(dollars) || dollars < 0 || !Number.isSafeInteger(micros)) fail("--cost-ceiling must be a non-negative dollar amount representable in integer micros");
			ceilingUsdMicros = micros;
		} else if (argument === "--concurrency") {
			concurrency = Number(args[++index]);
			if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_WORKERS) fail(`--concurrency must be an integer from 1 to ${MAX_WORKERS}`);
		} else if (argument === "--failure-policy") {
			failurePolicy = args[++index]?.trim();
			if (failurePolicy !== "collect" && failurePolicy !== "fail-fast") fail("--failure-policy must be collect or fail-fast");
		} else if (argument?.startsWith("--")) fail(`unknown option: ${argument}`);
		else positional.push(argument);
	}
	if (laneSpec) {
		for (const [flag, present] of [
			["--worker", workers.length > 0],
			["--role", roles.length > 0],
			["--route", route !== undefined],
			["--agent", agent !== undefined],
			["--child-agent", childAgents.length > 0],
			["--owned", ownedPaths.length > 0],
			["--exclude", excludedPaths.length > 0],
			["--timeout", sawTimeout],
			["--cost-ceiling", sawCeiling],
		]) {
			if (present) fail(`${flag} cannot be combined with --lane-spec; declare it per lane in the plan file`);
		}
		if (positional.length > 0) fail("positional objectives cannot be combined with --lane-spec; each lane declares its own objective");
	} else {
		if (workers.length < 2 || workers.length > MAX_WORKERS) fail(`ox_herd.mjs requires from two to ${MAX_WORKERS} --worker paths`);
		if (workers.some((path) => !isAbsolute(path))) fail("--worker paths must be absolute");
		if (roles.length > 0 && roles.length !== workers.length) fail("give one --role for every worker or omit roles");
		if (new Set(roles).size !== roles.length) fail("herd roles must be distinct");
		if (childAgents.length > 0 && !agent) fail("--child-agent requires an explicit delegation-capable --agent primary");
		if (positional.length === 0) fail("usage: ox_herd.mjs <objective...> --worker PATH --worker PATH [--worker PATH ...] [--role NAME ...] | ox_herd.mjs --lane-spec FILE [--check COMMAND] [--concurrency N]");
	}
	if (checks.length > 0 && noCheck) fail("--check and --no-check are mutually exclusive");
	if (!laneSpec && checks.length === 0 && !noCheck) fail("herd requires at least one --check or explicit --no-check");
	return {
		workers,
		roles,
		checks,
		noCheck,
		failurePolicy,
		ownedPaths,
		excludedPaths,
		route,
		profileDirectory,
		agent,
		childAgents,
		laneSpec,
		timeoutSeconds,
		ceilingUsdMicros,
		concurrency,
		objective: positional.join(" "),
	};
}

async function loadPlan(options) {
	if (!options.laneSpec) {
		const roles = options.roles.length > 0 ? options.roles : options.workers.map((_path, index) => `worker-${index + 1}`);
		return validateOrchestrationPlan({
			version: 1,
			lanes: options.workers.map((workerPath, index) => ({
				id: roles[index],
				role: roles[index],
				objective: options.objective,
				workerPath,
				...(options.route ? { route: options.route } : {}),
				...(options.agent ? { agent: options.agent } : {}),
				...(options.childAgents.length > 0 ? { childAgents: options.childAgents } : {}),
				...(options.ownedPaths.length > 0 ? { ownedPaths: [...options.ownedPaths] } : {}),
				...(options.excludedPaths.length > 0 ? { excludedPaths: [...options.excludedPaths] } : {}),
				checks: [],
				timeoutSeconds: options.timeoutSeconds,
			})),
		});
	}
	let document;
	try {
		document = JSON.parse(await readFile(options.laneSpec, "utf8"));
	} catch (error) {
		fail(`--lane-spec must contain readable JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	return validateOrchestrationPlan(document);
}

function runtimeLanes(plan, options) {
	if (options.noCheck && plan.lanes.some((lane) => (lane.checks?.length ?? 0) > 0)) {
		fail("--no-check cannot be combined with plan checks; remove --no-check or clear the lane checks");
	}
	const sharedLaneCount = plan.lanes.filter((lane) => lane.costCeilingUsd === undefined).length;
	const baseLaneCeiling = sharedLaneCount > 0 ? Math.floor(options.ceilingUsdMicros / sharedLaneCount) : 0;
	const extraMicros = sharedLaneCount > 0 ? options.ceilingUsdMicros % sharedLaneCount : 0;
	let sharedIndex = 0;
	const lanes = plan.lanes.map((lane) => {
		const harness = lane.harness ?? "opencode";
		const ceilingUsdMicros = lane.costCeilingUsd === undefined
			? baseLaneCeiling + (sharedIndex < extraMicros ? 1 : 0)
			: Math.round(lane.costCeilingUsd * MICROS_PER_USD);
		if (lane.costCeilingUsd === undefined) sharedIndex += 1;
		return {
			id: lane.id,
			role: lane.role,
			objective: lane.objective,
			workerPath: lane.workerPath,
			harness,
			route: lane.route,
			agent: lane.agent,
			childAgents: [...(lane.childAgents ?? [])],
			ownedPaths: lane.ownedPaths ? [...lane.ownedPaths] : ["."],
			excludedPaths: [...new Set([".env", ".git", ...(lane.excludedPaths ?? [])])],
			checks: [...(lane.checks ?? []), ...options.checks],
			timeoutSeconds: lane.timeoutSeconds ?? options.timeoutSeconds,
			ceilingUsdMicros,
		};
	});
	if (!options.noCheck) {
		const lane = lanes.find((item) => item.checks.length === 0);
		if (lane) fail(`lane ${lane.id} requires at least one plan check, one shared --check, or explicit --no-check`);
	}
	return lanes;
}

async function boundedMap(items, concurrency, callback) {
	const results = new Array(items.length);
	let next = 0;
	async function worker() {
		while (true) {
			const index = next;
			next += 1;
			if (index >= items.length) return;
			results[index] = await callback(items[index], index);
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
	return results;
}

async function main() {
	if (process.argv[2] === "--retry-failed") {
		const sourceId = process.argv[3]?.trim() || fail("--retry-failed requires a terminal orchestration id");
		let instruction;
		let concurrency;
		for (let index = 4; index < process.argv.length; index += 1) {
			const argument = process.argv[index];
			if (argument === "--objective") instruction = process.argv[++index]?.trim() || fail("--objective requires retry guidance");
			else if (argument === "--concurrency") {
				concurrency = Number(process.argv[++index]);
				if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_WORKERS) fail(`--concurrency must be an integer from 1 to ${MAX_WORKERS}`);
			} else fail(`unknown --retry-failed option: ${argument}`);
		}
		const receipt = await retryOrchestration({
			sourceId,
			failed: true,
			instruction,
			concurrency,
			runner: process.env.OX_DRIVER_RETRY_RUNNER?.trim() || process.env.OX_DRIVER_HERD_RUNNER?.trim() || DEFAULT_RUNNER,
		});
		process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
		if (receipt.status !== "completed") process.exitCode = 1;
		return;
	}
	let guard;
	let workersStarted = false;
	let pendingSignal = false;
	const onSignal = () => {
		pendingSignal = true;
		if (workersStarted && guard) void guard.cancel();
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	const options = parse(process.argv.slice(2));
	const requestedRunner = process.env.OX_DRIVER_HERD_RUNNER?.trim() || DEFAULT_RUNNER;
	if (!isAbsolute(requestedRunner)) fail("OX_DRIVER_HERD_RUNNER must be an absolute path");
	const plan = await loadPlan(options);
	const lanes = runtimeLanes(plan, options);
	const runnerIdentity = await resolveRunnerIdentity(requestedRunner, process.env.OX_DRIVER_HERD_RUNNER?.trim() ? "environment-override" : "bundled");
	const runner = runnerIdentity.path;
	const aggregateCeilingUsdMicros = lanes.reduce((sum, lane) => sum + lane.ceilingUsdMicros, 0);
	const concurrency = options.concurrency ?? Math.min(lanes.length, 8);
	const workers = await Promise.all(lanes.map((lane) => realpath(lane.workerPath)));
	if (new Set(workers).size !== workers.length) fail("herd workers must use distinct worktrees");
	lanes.forEach((lane, index) => { lane.workerPath = workers[index]; });
	const workerIdentities = await Promise.all(workers.map(discoverWorkerIdentity));
	const effectivePlan = validateEffectiveRetryPlan({
		version: 1,
		lanes: lanes.map((lane, index) => ({
			id: lane.id,
			role: lane.role,
			objective: lane.objective,
			workerPath: lane.workerPath,
			route: lane.route ?? (process.env.OX_DRIVER_OPENCODE_PROFILE?.trim() || "opencode-default"),
			...(lane.agent ? { agent: lane.agent } : {}),
			...(lane.childAgents.length > 0 ? { childAgents: lane.childAgents } : {}),
			...(lane.harness === "opencode" && options.profileDirectory ? { profileDirectory: options.profileDirectory } : {}),
			ownedPaths: lane.ownedPaths,
			excludedPaths: lane.excludedPaths,
			checks: lane.checks,
			timeoutSeconds: lane.timeoutSeconds,
			reportOnlyCostUsdMicros: lane.ceilingUsdMicros,
			...workerIdentities[index],
		})),
	});
	const effectivePlanSha256 = effectiveRetryPlanSha256(effectivePlan);
	const orchestrationStore = new OrchestrationReceiptStore();
	const allocation = await orchestrationStore.allocate();
	process.stderr.write(`OX_DRIVER_ORCHESTRATION_ID=${allocation.orchestrationId}\n`);
	const inflight = await orchestrationStore.beginInFlight(allocation, {
		kind: "herd",
		objective: options.laneSpec
			? lanes.map((lane) => `${lane.role}: ${lane.objective}`).join(" | ")
			: options.objective,
		lanes: lanes.map((lane, index) => ({ laneId: lane.id, role: lane.role, workerPath: lane.workerPath, ...workerIdentities[index] })),
	});
	guard = createWorkerSupervisor(options);
	const laneControls = (laneId) => ({
		onStart(child) { guard.controls.onStart(child); inflight.updateLane(laneId, { status: "running" }); },
		onRunId(child, runId) { guard.controls.onRunId(child, runId); inflight.updateLane(laneId, { runId }); },
		onDone(child) { guard.controls.onDone(child); inflight.updateLane(laneId, { status: "finished" }); },
	});
	workersStarted = true;
	if (pendingSignal) void guard.cancel();
	try {
	const results = await boundedMap(lanes, concurrency, async (lane, index) => {
		if (guard.cancellationRequested) {
			return { laneId: lane.id, expectedHarness: lane.harness, workerPath: lane.workerPath, role: lane.role, status: "cancelled", controllerError: "lane was not started after orchestration cancellation", ...workerIdentities[index] };
		}
		const result = await runWorker(
			runner,
			{
				...options,
				objective: lane.objective,
				checks: lane.checks,
				ownedPaths: lane.ownedPaths,
				excludedPaths: lane.excludedPaths,
				route: lane.route,
				agent: lane.agent,
				childAgents: lane.childAgents,
				timeoutSeconds: lane.timeoutSeconds,
				laneCeilingUsdMicros: lane.ceilingUsdMicros,
				expectedHarness: lane.harness,
				runnerIdentity,
				...(options.laneSpec ? { lanePrefix: `Lane ${lane.role}` } : {}),
			},
			lane.workerPath,
			lane.role,
			laneControls(lane.id),
		);
		if (result.status !== "completed" && options.failurePolicy === "fail-fast") void guard.cancel("lane-did-not-complete");
		return { ...result, laneId: lane.id, ...workerIdentities[index] };
	});
	process.off("SIGINT", onSignal);
	process.off("SIGTERM", onSignal);
	const costSummary = summarizeOrchestrationCosts(results, aggregateCeilingUsdMicros);
	const completedWorkers = results.filter((result) => result.status === "completed").length;
	const status = guard.interrupted || (results.some((result) => result.status === "cancelled") && !results.some((result) => ["failed", "blocked", "unknown"].includes(result.status)))
		? "cancelled"
		: completedWorkers === results.length ? "completed" : "failed";
	const safeToReview = status === "completed" && results.every((result) => result.unownedChangedPaths.length === 0);
	const receipt = {
		version: 1,
		kind: "herd",
		orchestrationId: allocation.orchestrationId,
		receiptPath: allocation.receiptPath,
		objective: options.laneSpec
			? lanes.map((lane) => `${lane.role}: ${lane.objective}`).join(" | ")
			: options.objective,
		status,
		failurePolicy: options.failurePolicy,
		checksDeclared: options.checks.length > 0 || plan.lanes.some((lane) => (lane.checks?.length ?? 0) > 0),
		concurrency,
		workerCount: results.length,
		completedWorkers,
		reportOnlyCeilingUsdMicros: aggregateCeilingUsdMicros,
		...costSummary,
		effectivePlan,
		effectivePlanSha256,
		runners: [{ harness: "opencode", ...runnerIdentity }],
		workers: results,
		integrationRecommendation: safeToReview ? "review-worker-diffs-and-integrate-selected-changes" : "do-not-integrate-until-failures-are-resolved",
		autoMerged: false,
	};
	await inflight.flush();
	const persistedReceipt = await orchestrationStore.persist(receipt);
	process.stdout.write(`${JSON.stringify(persistedReceipt, null, 2)}\n`);
	if (status !== "completed") process.exitCode = 1;
	} catch (error) {
		// A receiptless death stays visible: the aborted record is removed only
		// by a later writer's stale sweep.
		await inflight.markAborted(error instanceof Error ? error.message : String(error)).catch(() => undefined);
		throw error;
	}
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
