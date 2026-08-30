#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
	compactWorkerFailure,
	compactWorkerReceipt,
	effectiveRetryPlanSha256,
	ManagedWorktreeStore,
	OrchestrationReceiptStore,
	summarizeOrchestrationCosts,
	validateEffectiveRetryPlan,
	validateOrchestrationPlan,
} from "../packages/core/dist/index.js";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RUNNER = resolve(ROOT, "scripts", "ox_opencode.mjs");
const CONTROL_CLI = resolve(ROOT, "packages", "opencode-cli", "dist", "main.js");
const MAX_CHILD_OUTPUT_BYTES = 32 * 1024 * 1024;
const RUN_ID_MARKER = /(?:^|\n)OX_DRIVER_RUN_ID=([0-9a-f-]{36})(?=\r?\n|$)/i;
const WORKTREE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fail(message) {
	throw new Error(message);
}

export async function discoverWorkerIdentity(workerPath) {
	const identity = {};
	try {
		const result = await execFileAsync("git", ["-C", workerPath, "rev-parse", "--verify", "HEAD^{commit}"], { maxBuffer: 1024 * 1024 });
		const baseCommit = result.stdout.trim();
		if (/^[0-9a-f]{40,64}$/.test(baseCommit)) identity.baseCommit = baseCommit;
	} catch { /* fixture and non-Git worker directories remain supported */ }
	const candidateId = basename(workerPath);
	if (WORKTREE_ID.test(candidateId)) {
		try {
			const workspace = await new ManagedWorktreeStore().inspect(candidateId);
			if (workspace.path === workerPath) identity.worktreeId = workspace.id;
		} catch { /* a UUID-shaped external directory is not a managed worktree */ }
	}
	return identity;
}

export async function resolveRunnerIdentity(runner, source = "bundled") {
	if (!isAbsolute(runner)) fail("runner path must be absolute");
	const path = await realpath(runner);
	const bytes = await readFile(path);
	return { path, sha256: createHash("sha256").update(bytes).digest("hex"), source };
}

async function runnerIdentityMatches(identity) {
	try {
		const current = await resolveRunnerIdentity(identity.path, identity.source);
		return current.path === identity.path && current.sha256 === identity.sha256;
	} catch {
		return false;
	}
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
	let noCheck = false;
	let failurePolicy = "collect";
	let timeoutSeconds = 3_600;
	let ceilingUsdMicros = 100_000;
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
		else if (argument === "--timeout") {
			timeoutSeconds = Number(args[++index]);
			if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) fail("--timeout must be an integer from 1 to 86400 seconds");
		} else if (argument === "--cost-ceiling") {
			const dollars = Number(args[++index]);
			const micros = Math.round(dollars * 1_000_000);
			if (!Number.isFinite(dollars) || dollars < 0 || !Number.isSafeInteger(micros)) fail("--cost-ceiling must be a non-negative dollar amount representable in integer micros");
			ceilingUsdMicros = micros;
		} else if (argument === "--failure-policy") {
			failurePolicy = args[++index]?.trim();
			if (failurePolicy !== "collect" && failurePolicy !== "fail-fast") fail("--failure-policy must be collect or fail-fast");
		} else if (argument?.startsWith("--")) fail(`unknown option: ${argument}`);
		else positional.push(argument);
	}
	if (workers.length !== 2) fail("ox_pair.mjs requires exactly two --worker paths");
	if (workers.some((path) => !isAbsolute(path))) fail("--worker paths must be absolute");
	if (roles.length > 0 && roles.length !== 2) fail("give exactly two --role values or omit roles");
	if (new Set(roles).size !== roles.length) fail("pair roles must be distinct");
	if (checks.length === 0 && !noCheck) fail("pair requires at least one --check or explicit --no-check");
	if (checks.length > 0 && noCheck) fail("--check and --no-check are mutually exclusive");
	if (childAgents.length > 0 && !agent) fail("--child-agent requires an explicit delegation-capable --agent primary");
	if (positional.length === 0) fail("usage: ox_pair.mjs <objective...> --worker PATH --worker PATH [--role NAME --role NAME] [--check COMMAND] [--route ID] [--agent PROFILE] [--cost-ceiling DOLLARS]");
	return { workers, roles, checks, noCheck, failurePolicy, ownedPaths, excludedPaths, route, profileDirectory, agent, childAgents, timeoutSeconds, ceilingUsdMicros, objective: positional.join(" ") };
}

function textEvidence(value, options = {}) {
	const bytes = Buffer.from(value, "utf8");
	return {
		...(options.redacted === true ? { redacted: true } : {}),
		bytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		...(options.captureTruncated === true ? { captureTruncated: true } : {}),
	};
}

function receiptDocuments(output) {
	const values = [];
	let start = -1;
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < output.length; index += 1) {
		const character = output[index];
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') quoted = true;
		else if (character === "{") {
			if (depth === 0) start = index;
			depth += 1;
		} else if (character === "}" && depth > 0) {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				try { values.push(JSON.parse(output.slice(start, index + 1))); } catch { /* keep looking */ }
				start = -1;
			}
		}
	}
	return values;
}

function collectWorker(runner, args, requestedRunId, controls = {}) {
	return new Promise((resolveExecution) => {
		const child = spawn(process.execPath, args, {
			cwd: ROOT,
			env: { ...process.env, OX_DRIVER_REQUESTED_RUN_ID: requestedRunId },
			stdio: ["ignore", "pipe", "pipe"],
		});
		controls.onStart?.(child);
		controls.onRunId?.(child, requestedRunId);
		let stdout = "";
		let stderrBytes = 0;
		const stderrHash = createHash("sha256");
		let stderrMarkerWindow = "";
		let stderrEvidence;
		let overflowed = false;
		let observedRunId;
		const finalizeStderrEvidence = () => {
			stderrEvidence ??= {
				redacted: true,
				bytes: stderrBytes,
				sha256: stderrHash.digest("hex"),
				...(overflowed ? { captureTruncated: true } : {}),
			};
			return stderrEvidence;
		};
		const append = (target, chunk) => {
			const next = target + chunk;
			if (Buffer.byteLength(next) > MAX_CHILD_OUTPUT_BYTES) {
				overflowed = true;
				child.kill("SIGTERM");
				return target;
			}
			return next;
		};
		child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk.toString("utf8")); });
		child.stderr.on("data", (chunk) => {
			stderrBytes += chunk.length;
			stderrHash.update(chunk);
			const markerText = `${stderrMarkerWindow}${chunk.toString("utf8")}`;
			const marker = markerText.match(RUN_ID_MARKER)?.[1];
			stderrMarkerWindow = markerText.slice(-512);
			if (marker && marker !== observedRunId) {
				observedRunId = marker;
				if (marker === requestedRunId) controls.onRunId?.(child, marker);
			}
		});
		child.once("error", (error) => {
			controls.onDone?.(child);
			resolveExecution({ stdout, stderrEvidence: finalizeStderrEvidence(), requestedRunId, observedRunId, overflowed, spawnError: error.message });
		});
		child.once("close", (exitCode, signal) => {
			controls.onDone?.(child);
			resolveExecution({ stdout, stderrEvidence: finalizeStderrEvidence(), requestedRunId, observedRunId, overflowed, exitCode, signal });
		});
	});
}

async function recoverDurableReceipt(runId, options, workerPath, role, laneCeilingUsdMicros) {
	try {
		const result = await execFileAsync(process.execPath, [CONTROL_CLI, "inspect", runId], {
			cwd: ROOT,
			env: {
				...process.env,
				...(options.profileDirectory ? { OX_DRIVER_ROUTE_PROFILE_DIR: options.profileDirectory } : {}),
			},
			maxBuffer: 32 * 1024 * 1024,
		});
		const inspected = JSON.parse(result.stdout);
		if (!inspected?.receipt || inspected.receipt.runId !== runId) return undefined;
		const summary = compactWorkerReceipt(inspected.receipt, workerPath, role);
		if (summary.harness !== options.expectedHarness) return undefined;
		return {
			...summary,
			expectedHarness: options.expectedHarness,
			reportOnlyCeilingUsdMicros: laneCeilingUsdMicros,
			recoveredFromDurableState: true,
		};
	} catch {
		return undefined;
	}
}

export async function runWorker(runner, options, workerPath, role, controls = {}) {
	const runnerIdentity = options.runnerIdentity ?? await resolveRunnerIdentity(runner, "direct");
	if (runnerIdentity.path !== await realpath(runner) || !await runnerIdentityMatches(runnerIdentity)) {
		return compactWorkerFailure(workerPath, role, "runner identity changed before execution", { expectedHarness: options.expectedHarness });
	}
	const objective = `${options.lanePrefix ?? `Pair lane ${role}`}: ${options.objective}`;
	const laneCeilingUsdMicros = options.laneCeilingUsdMicros ?? options.ceilingUsdMicros;
	const args = [runner, workerPath, objective,
		"--timeout", String(options.timeoutSeconds),
		"--cost-ceiling", String(laneCeilingUsdMicros / 1_000_000),
		...(options.route ? ["--route", options.route] : []),
		...(options.profileDirectory ? ["--profile-dir", options.profileDirectory] : []),
		...(options.expectedWorkspaceSha256 ? ["--expected-workspace-sha256", options.expectedWorkspaceSha256] : []),
		...(options.expectedRouteProfileSha256 ? ["--expected-route-profile-sha256", options.expectedRouteProfileSha256] : []),
		...(options.agent ? ["--agent", options.agent] : []),
		...(options.childAgents ?? []).flatMap((profile) => ["--child-agent", profile]),
		...options.checks.flatMap((command) => ["--check", command]),
		...(options.ownedPaths ?? []).flatMap((path) => ["--owned", path]),
		...(options.excludedPaths ?? []).flatMap((path) => ["--exclude", path]),
	];
	const requestedRunId = options.requestedRunId ?? randomUUID();
	const execution = await collectWorker(runner, args, requestedRunId, controls);
	const expectedHarness = options.expectedHarness ?? "opencode";
	const failureEvidence = { ...execution, expectedHarness };
	if (!await runnerIdentityMatches(runnerIdentity)) {
		return compactWorkerFailure(workerPath, role, "runner identity changed during execution", failureEvidence);
	}
	if (execution.overflowed) return compactWorkerFailure(workerPath, role, "runner output exceeded 32 MiB and was terminated", failureEvidence);
	if (execution.spawnError) return compactWorkerFailure(workerPath, role, `runner could not start: ${execution.spawnError}`, failureEvidence);
	if (execution.observedRunId && execution.observedRunId !== requestedRunId) {
		return compactWorkerFailure(workerPath, role, "runner emitted a run id different from the preassigned id", failureEvidence);
	}
	const documents = receiptDocuments(execution.stdout);
	for (let index = documents.length - 1; index >= 0; index -= 1) {
		try {
			const summary = compactWorkerReceipt(documents[index], workerPath, role);
			if (summary.runId !== requestedRunId) continue;
			if (summary.harness !== expectedHarness) {
				return compactWorkerFailure(workerPath, role, `runner receipt harness ${summary.harness} does not match expected harness ${expectedHarness}`, {
					...failureEvidence,
					observedHarness: summary.harness,
				});
			}
			return { ...summary, expectedHarness, reportOnlyCeilingUsdMicros: laneCeilingUsdMicros };
		} catch { /* a banner may contain unrelated JSON */ }
	}
	const recovered = await recoverDurableReceipt(requestedRunId, options, workerPath, role, laneCeilingUsdMicros);
	if (recovered) return recovered;
	return compactWorkerFailure(workerPath, role, "runner did not return a valid Ox receipt with the preassigned run id and expected harness", failureEvidence);
}

export function createWorkerSupervisor(options) {
	const active = new Map();
	let interrupted = false;
	let cancellation;
	let cancellationReason;
	const cancelEntry = async ([child, entry]) => {
		if (!entry.runId) {
			child.kill("SIGTERM");
			return;
		}
		for (const delayMs of [0, 100, 200, 400, 800]) {
			if (delayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
			try {
				await execFileAsync(process.execPath, [CONTROL_CLI, "cancel", entry.runId], {
					cwd: ROOT,
					env: {
						...process.env,
						...(options.profileDirectory ? { OX_DRIVER_ROUTE_PROFILE_DIR: options.profileDirectory } : {}),
					},
					maxBuffer: 1024 * 1024,
				});
				return;
			} catch {
				if (child.exitCode !== null) return;
			}
		}
		child.kill("SIGTERM");
	};
	return {
		get interrupted() { return interrupted; },
		get cancellationRequested() { return cancellationReason !== undefined; },
		controls: {
			onStart(child) {
				const entry = {};
				active.set(child, entry);
				// A signal can arrive after allocation but before every asynchronous
				// runner launch reaches spawn. Do not let a late child escape the
				// cancellation snapshot and wait for its full lane timeout.
				if (cancellationReason !== undefined) void cancelEntry([child, entry]);
			},
			onRunId(child, runId) { if (active.has(child)) active.get(child).runId = runId; },
			onDone(child) { active.delete(child); },
		},
		cancel(reason = "operator-signal") {
			if (reason === "operator-signal") interrupted = true;
			cancellationReason ??= reason;
			if (!cancellation) cancellation = Promise.allSettled([...active.entries()].map(cancelEntry));
			return cancellation;
		},
	};
}

async function main() {
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
	const requestedRunner = process.env.OX_DRIVER_PAIR_RUNNER?.trim() || DEFAULT_RUNNER;
	if (!isAbsolute(requestedRunner)) fail("OX_DRIVER_PAIR_RUNNER must be an absolute path");
	const runnerIdentity = await resolveRunnerIdentity(requestedRunner, process.env.OX_DRIVER_PAIR_RUNNER?.trim() ? "environment-override" : "bundled");
	const runner = runnerIdentity.path;
	const roles = options.roles.length === 2 ? options.roles : ["worker-1", "worker-2"];
	validateOrchestrationPlan({
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
			checks: [...options.checks],
			timeoutSeconds: options.timeoutSeconds,
		})),
	});
	const workers = await Promise.all(options.workers.map((path) => realpath(path)));
	if (workers[0] === workers[1]) fail("pair workers must use distinct worktrees");
	const workerIdentities = await Promise.all(workers.map(discoverWorkerIdentity));
	const laneCeilings = [Math.floor(options.ceilingUsdMicros / 2), Math.ceil(options.ceilingUsdMicros / 2)];
	const effectivePlan = validateEffectiveRetryPlan({
		version: 1,
		lanes: workers.map((workerPath, index) => ({
			id: roles[index],
			role: roles[index],
			objective: options.objective,
			workerPath,
			route: options.route ?? (process.env.OX_DRIVER_OPENCODE_PROFILE?.trim() || "opencode-default"),
			...(options.agent ? { agent: options.agent } : {}),
			...(options.childAgents.length > 0 ? { childAgents: options.childAgents } : {}),
			...(options.profileDirectory ? { profileDirectory: options.profileDirectory } : {}),
			ownedPaths: options.ownedPaths.length > 0 ? options.ownedPaths : ["."],
			excludedPaths: [...new Set([".env", ".git", ...options.excludedPaths])],
			checks: options.checks,
			timeoutSeconds: options.timeoutSeconds,
			reportOnlyCostUsdMicros: laneCeilings[index],
			...workerIdentities[index],
		})),
	});
	const effectivePlanSha256 = effectiveRetryPlanSha256(effectivePlan);
	const orchestrationStore = new OrchestrationReceiptStore();
	const allocation = await orchestrationStore.allocate();
	process.stderr.write(`OX_DRIVER_ORCHESTRATION_ID=${allocation.orchestrationId}\n`);
	const inflight = await orchestrationStore.beginInFlight(allocation, {
		kind: "pair",
		objective: options.objective,
		lanes: workers.map((path, index) => ({ laneId: roles[index], role: roles[index], workerPath: path, ...workerIdentities[index] })),
	});
	guard = createWorkerSupervisor(options);
	const laneControls = (laneId) => ({
		onStart(child) { guard.controls.onStart(child); inflight.updateLane(laneId, { status: "running" }); },
		onRunId(child, runId) { guard.controls.onRunId(child, runId); inflight.updateLane(laneId, { runId }); },
		onDone(child) { guard.controls.onDone(child); inflight.updateLane(laneId, { status: "finished" }); },
	});
	try {
	const workerPromises = workers.map((path, index) => runWorker(
		runner,
		{ ...options, expectedHarness: "opencode", runnerIdentity, laneCeilingUsdMicros: laneCeilings[index] },
		path,
		roles[index],
		laneControls(roles[index]),
	).then((result) => {
		if (result.status !== "completed" && options.failurePolicy === "fail-fast") void guard.cancel("lane-did-not-complete");
		return { ...result, laneId: roles[index], ...workerIdentities[index] };
	}));
	workersStarted = true;
	if (pendingSignal) void guard.cancel();
	const results = await Promise.all(workerPromises);
	process.off("SIGINT", onSignal);
	process.off("SIGTERM", onSignal);
	const costSummary = summarizeOrchestrationCosts(results, options.ceilingUsdMicros);
	const bothCompleted = results.every((result) => result.status === "completed");
	const status = guard.interrupted || (results.some((result) => result.status === "cancelled") && !results.some((result) => ["failed", "blocked", "unknown"].includes(result.status)))
		? "cancelled"
		: bothCompleted ? "completed" : "failed";
	const integrationRecommendation = status === "completed" && results.every((result) => result.unownedChangedPaths.length === 0)
		? "review-both-diffs-and-integrate"
		: "do-not-integrate-until-failures-are-resolved";
	const pairReceipt = {
		version: 1,
		kind: "pair",
		orchestrationId: allocation.orchestrationId,
		receiptPath: allocation.receiptPath,
		objective: options.objective,
		status,
		failurePolicy: options.failurePolicy,
		checksDeclared: options.checks.length > 0,
		reportOnlyCeilingUsdMicros: options.ceilingUsdMicros,
		...costSummary,
		effectivePlan,
		effectivePlanSha256,
		runners: [{ harness: "opencode", ...runnerIdentity }],
		workers: results,
		integrationRecommendation,
		autoMerged: false,
	};
	await inflight.flush();
	const persistedReceipt = await orchestrationStore.persist(pairReceipt);
	process.stdout.write(`${JSON.stringify(persistedReceipt, null, 2)}\n`);
	if (status !== "completed") process.exitCode = 1;
	} catch (error) {
		// A receiptless death stays visible: the aborted record is removed only
		// by a later writer's stale sweep.
		await inflight.markAborted(error instanceof Error ? error.message : String(error)).catch(() => undefined);
		throw error;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
