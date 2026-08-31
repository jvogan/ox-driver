import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
	compactWorkerReceipt,
	effectiveRetryPlanSha256,
	ManagedWorktreeStore,
	OrchestrationReceiptStore,
	RunStore,
	validateEffectiveRetryPlan,
} from "../../packages/core/dist/index.js";
import { trackedMkdtemp } from "./helpers/tracked-temp.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
	return execFileAsync("git", ["-c", "user.name=Ox Retry Test", "-c", "user.email=ox-retry@example.invalid", "-C", cwd, ...args]);
}

async function fixture({ docsFailed = false, docsDependsOnBuild = false } = {}) {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-retry-fixture-"));
	const source = join(root, "source");
	await mkdir(source);
	await git(source, "init", "-q");
	await writeFile(join(source, "result.txt"), "initial\n");
	await git(source, "add", "result.txt");
	await git(source, "commit", "-qm", "initial");
	const stateHome = join(root, "state-home");
	const stateRoot = join(stateHome, "ox-driver");
	const workspaceState = join(root, "workspace-state");
	const workspaceStore = new ManagedWorktreeStore(workspaceState);
	const brokenWorkspace = await workspaceStore.create(source);
	const completedWorkspace = await workspaceStore.create(source);
	const docsWorkspace = docsDependsOnBuild ? brokenWorkspace : completedWorkspace;
	await writeFile(join(brokenWorkspace.path, "result.txt"), "broken\n");
	const runStore = new RunStore(stateRoot, join(stateRoot, "leases"));
	const brokenRunId = randomUUID();
	const completedRunId = randomUUID();
	const failedCheckOutput = "AssertionError: expected repaired but received broken\n";
	const brokenRun = {
		version: 1,
		runId: brokenRunId,
		harness: "opencode",
		status: "failed",
		routeProfileSha256: "b".repeat(64),
		finalWorkspaceSha256: "a".repeat(64),
		acceptance: [{
			command: "node --test",
			passed: false,
			durationMs: 10,
			timedOut: false,
			exitCode: 1,
			stdout: failedCheckOutput,
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			backgroundProcessesDetected: false,
			processTreeReaped: true,
			terminationEscalated: false,
		}],
		changedPaths: ["result.txt"],
		unownedChangedPaths: [],
	};
	const completedRun = {
		version: 1,
		runId: completedRunId,
		harness: "opencode",
		status: docsFailed ? "failed" : "completed",
		acceptance: [],
		changedPaths: [],
		unownedChangedPaths: [],
	};
	for (const receipt of [brokenRun, completedRun]) {
		await runStore.create(receipt.runId, {});
		await runStore.writeReceipt(receipt);
	}
	const workers = [
		{ ...compactWorkerReceipt(brokenRun, brokenWorkspace.path, "builder"), expectedHarness: "opencode", laneId: "build", worktreeId: brokenWorkspace.id, baseCommit: brokenWorkspace.baseCommit },
		{ ...compactWorkerReceipt(completedRun, docsWorkspace.path, "docs"), expectedHarness: "opencode", laneId: "docs", worktreeId: docsWorkspace.id, baseCommit: docsWorkspace.baseCommit },
	];
	const effectivePlan = validateEffectiveRetryPlan({ version: 1, lanes: [
		{
			id: "build", role: "builder", objective: "Produce a repaired result", workerPath: brokenWorkspace.path,
			route: "fixture-route", agent: "fixture-agent", childAgents: ["fixture-researcher"], ownedPaths: ["result.txt"], excludedPaths: [".env"],
			checks: ["node --test"], timeoutSeconds: 3600, reportOnlyCostUsdMicros: 50_000,
			worktreeId: brokenWorkspace.id, baseCommit: brokenWorkspace.baseCommit,
		},
		{
			id: "docs", role: "docs", objective: "Document the result", workerPath: docsWorkspace.path,
			...(docsDependsOnBuild ? { dependsOn: ["build"] } : {}),
			route: "fixture-route", ownedPaths: ["README.md"], excludedPaths: [".env"], checks: ["node --test"],
			timeoutSeconds: 3600, reportOnlyCostUsdMicros: 50_000,
			worktreeId: docsWorkspace.id, baseCommit: docsWorkspace.baseCommit,
		},
	] });
	const orchestrationStore = new OrchestrationReceiptStore(join(stateRoot, "orchestrations"));
	const allocation = await orchestrationStore.allocate();
	const sourceReceipt = await orchestrationStore.persist({
		version: 1,
		kind: "herd",
		orchestrationId: allocation.orchestrationId,
		receiptPath: allocation.receiptPath,
		objective: "Build and document",
		status: "failed",
		effectivePlan,
		effectivePlanSha256: effectiveRetryPlanSha256(effectivePlan),
		workers,
		autoMerged: false,
	});
	const runner = join(root, "runner.mjs");
	await writeFile(runner, `
import { mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const workerPath = process.argv[2];
const objective = process.argv[3];
const flags = process.argv.slice(4);
const value = (name) => { const index = flags.indexOf(name); return index < 0 ? null : flags[index + 1]; };
const values = (name) => flags.flatMap((item, index) => item === name ? [flags[index + 1]] : []);
const status = process.env.OX_RETRY_RESULT_STATUS || "completed";
mkdirSync(process.env.OX_RETRY_ECHO_DIR, { recursive: true });
writeFileSync(process.env.OX_RETRY_ECHO_DIR + "/" + basename(workerPath) + ".json", JSON.stringify({
  workerPath, objective, route: value("--route"), agent: value("--agent"), childAgents: values("--child-agent"),
  expectedWorkspaceSha256: value("--expected-workspace-sha256"),
  expectedRouteProfileSha256: value("--expected-route-profile-sha256"),
  checks: flags.flatMap((item, index) => item === "--check" ? [flags[index + 1]] : []),
}));
process.stdout.write(JSON.stringify({
  version: 1, runId: process.env.OX_DRIVER_REQUESTED_RUN_ID, harness: "opencode", status,
  costReport: { observedUsdMicros: 1234 }, acceptance: [{ command: "node --test", passed: status === "completed" }],
  changedPaths: ["result.txt"], unownedChangedPaths: [], finalWorkspaceSha256: "c".repeat(64), finalOutput: "repair completed",
}));
if (status !== "completed") process.exitCode = 1;
`, { mode: 0o700 });
	await chmod(runner, 0o700);
	return {
		root, stateHome, stateRoot, workspaceState, sourceReceipt, brokenWorkspace, completedWorkspace,
		runner, echoDir: join(root, "echo"), failedCheckOutput,
	};
}

function environment(value) {
	return {
		...process.env,
		XDG_STATE_HOME: value.stateHome,
		OX_DRIVER_WORKSPACE_STATE_DIR: value.workspaceState,
		OX_DRIVER_RETRY_RUNNER: value.runner,
		OX_RETRY_ECHO_DIR: value.echoDir,
	};
}

test("selected-lane retry continues the same worktree with check context and immutable lineage", async () => {
	const value = await fixture();
	const original = await readFile(value.sourceReceipt.receiptPath);
	const result = await execFileAsync(process.execPath, [
		"scripts/ox_orchestration.mjs", "retry", value.sourceReceipt.orchestrationId, "--lane", "build",
	], { cwd: process.cwd(), env: environment(value), maxBuffer: 4 * 1024 * 1024 });
	const receipt = JSON.parse(result.stdout);
	assert.equal(receipt.kind, "retry");
	assert.equal(receipt.status, "completed");
	assert.equal(receipt.resolutionStatus, "resolved");
	assert.deepEqual(receipt.remainingUnsuccessfulLaneIds, []);
	assert.deepEqual(receipt.selection, { mode: "lanes", laneIds: ["build"] });
	assert.equal(receipt.lineage.rootOrchestrationId, value.sourceReceipt.orchestrationId);
	assert.equal(receipt.lineage.parentOrchestrationId, value.sourceReceipt.orchestrationId);
	assert.equal(receipt.workers[0].previousStatus, "failed");
	assert.equal(receipt.workers[0].previousOrchestrationId, value.sourceReceipt.orchestrationId);
	assert.equal(receipt.workers[0].previousReceiptPath, value.sourceReceipt.receiptPath);
	assert.equal(receipt.workers[0].workspaceStateLink, "verified");
	assert.equal(receipt.workers[0].attemptNumber, 2);
	assert.equal(receipt.workers[0].worktreeId, value.brokenWorkspace.id);
	assert.deepEqual(await readFile(value.sourceReceipt.receiptPath), original);
	const echoes = await readdir(value.echoDir);
	assert.equal(echoes.length, 1);
	const invocation = JSON.parse(await readFile(join(value.echoDir, echoes[0]), "utf8"));
	assert.equal(invocation.workerPath, value.brokenWorkspace.path);
	assert.equal(invocation.route, "fixture-route");
	assert.equal(invocation.agent, "fixture-agent");
	assert.deepEqual(invocation.childAgents, ["fixture-researcher"]);
	assert.equal(invocation.expectedWorkspaceSha256, "a".repeat(64));
	assert.equal(invocation.expectedRouteProfileSha256, "b".repeat(64));
	assert.deepEqual(invocation.checks, ["node --test"]);
	assert.match(invocation.objective, /AssertionError: expected repaired but received broken/);
	const retryRunStore = new RunStore(value.stateRoot, join(value.stateRoot, "leases"));
	await retryRunStore.create(receipt.workers[0].runId, {});
	await retryRunStore.writeReceipt({
		version: 1,
		runId: receipt.workers[0].runId,
		harness: "opencode",
		status: "completed",
		costReport: { observedUsdMicros: 1234 },
		acceptance: [{ command: "node --test", passed: true, durationMs: 1, timedOut: false, exitCode: 0, stdout: "pass\n", stderr: "", stdoutTruncated: false, stderrTruncated: false, backgroundProcessesDetected: false, processTreeReaped: true, terminationEscalated: false }],
		changedPaths: ["result.txt"],
		unownedChangedPaths: [],
		finalOutput: "repair completed",
	});
	const report = JSON.parse((await execFileAsync(process.execPath, [
		"scripts/ox_orchestration.mjs", "report", receipt.orchestrationId,
	], { cwd: process.cwd(), env: environment(value) })).stdout);
	assert.equal(report.reportStatus, "complete");
	assert.equal(report.resolutionStatus, "resolved");
	assert.equal(report.workers[0].previousRunId, value.sourceReceipt.workers[0].runId);
	assert.equal(report.workers[0].previousReceiptPath, value.sourceReceipt.receiptPath);
	assert.equal(report.workers[0].finalOutput, "repair completed");
});

test("retry-failed alias excludes completed siblings and rejects receipts without lane snapshots before spawn", async () => {
	const value = await fixture();
	const result = await execFileAsync(process.execPath, [
		"scripts/ox_herd.mjs", "--retry-failed", value.sourceReceipt.orchestrationId,
	], { cwd: process.cwd(), env: environment(value), maxBuffer: 4 * 1024 * 1024 });
	const receipt = JSON.parse(result.stdout);
	assert.deepEqual(receipt.selection, { mode: "failed", laneIds: ["build"] });
	assert.equal(receipt.workers.length, 1);
	assert.equal(receipt.workers[0].workerPath, value.brokenWorkspace.path);

	const store = new OrchestrationReceiptStore(join(value.stateHome, "ox-driver", "orchestrations"));
	const allocation = await store.allocate();
	const withoutSnapshots = await store.persist({
		version: 1, kind: "pair", orchestrationId: allocation.orchestrationId, receiptPath: allocation.receiptPath,
		objective: "prior run", status: "failed", workers: value.sourceReceipt.workers, autoMerged: false,
	});
	const sentinel = join(value.root, "sentinel");
	await assert.rejects(execFileAsync(process.execPath, [
		"scripts/ox_orchestration.mjs", "retry", withoutSnapshots.orchestrationId, "--failed",
	], { cwd: process.cwd(), env: { ...environment(value), OX_RETRY_ECHO_DIR: sentinel } }), /predates effective lane snapshots/);
	await assert.rejects(readdir(sentinel), /ENOENT/);
});

test("retry rejects unknown lanes and removed managed worktrees before worker spawn", async () => {
	const unknown = await fixture();
	await assert.rejects(execFileAsync(process.execPath, [
		"scripts/ox_orchestration.mjs", "retry", unknown.sourceReceipt.orchestrationId, "--lane", "missing",
	], { cwd: process.cwd(), env: environment(unknown) }), /retry lane does not exist: missing/);
	await assert.rejects(readdir(unknown.echoDir), /ENOENT/);

	const removed = await fixture();
	const workspaceStore = new ManagedWorktreeStore(removed.workspaceState);
	await workspaceStore.remove(removed.brokenWorkspace.id, { discard: true });
	await assert.rejects(execFileAsync(process.execPath, [
		"scripts/ox_orchestration.mjs", "retry", removed.sourceReceipt.orchestrationId, "--lane", "build",
	], { cwd: process.cwd(), env: environment(removed) }), /managed worktree|ENOENT/);
	await assert.rejects(readdir(removed.echoDir), /ENOENT/);
});

test("a failed retry can be retried again with a three-attempt immutable chain", async () => {
	const value = await fixture();
	let firstError;
	try {
		await execFileAsync(process.execPath, [
			"scripts/ox_orchestration.mjs", "retry", value.sourceReceipt.orchestrationId, "--lane", "build",
		], { cwd: process.cwd(), env: { ...environment(value), OX_RETRY_RESULT_STATUS: "failed" }, maxBuffer: 4 * 1024 * 1024 });
	} catch (error) {
		firstError = error;
	}
	assert.equal(firstError?.code, 1);
	const firstRetry = JSON.parse(firstError.stdout);
	assert.equal(firstRetry.status, "failed");
	assert.equal(firstRetry.workers[0].attemptNumber, 2);
	const firstBytes = await readFile(firstRetry.receiptPath);
	const second = await execFileAsync(process.execPath, [
		"scripts/ox_orchestration.mjs", "retry", firstRetry.orchestrationId, "--failed",
	], { cwd: process.cwd(), env: environment(value), maxBuffer: 4 * 1024 * 1024 });
	const secondRetry = JSON.parse(second.stdout);
	assert.equal(secondRetry.status, "completed");
	assert.equal(secondRetry.resolutionStatus, "resolved");
	assert.equal(secondRetry.lineage.rootOrchestrationId, value.sourceReceipt.orchestrationId);
	assert.equal(secondRetry.lineage.parentOrchestrationId, firstRetry.orchestrationId);
	assert.equal(secondRetry.lineage.attemptNumber, 3);
	assert.equal(secondRetry.workers[0].attemptNumber, 3);
	assert.equal(secondRetry.workers[0].previousRunId, firstRetry.workers[0].runId);
	assert.deepEqual(await readFile(firstRetry.receiptPath), firstBytes);
});

test("retry-failed repairs multiple incomplete lanes concurrently and preserves one root state", async () => {
	const value = await fixture({ docsFailed: true });
	const result = await execFileAsync(process.execPath, [
		"scripts/ox_herd.mjs", "--retry-failed", value.sourceReceipt.orchestrationId, "--concurrency", "2",
	], { cwd: process.cwd(), env: environment(value), maxBuffer: 4 * 1024 * 1024 });
	const receipt = JSON.parse(result.stdout);
	assert.equal(receipt.status, "completed");
	assert.equal(receipt.resolutionStatus, "resolved");
	assert.equal(receipt.concurrency, 2);
	assert.deepEqual(receipt.selection.laneIds, ["build", "docs"]);
	assert.deepEqual(receipt.workers.map((worker) => worker.laneId), ["build", "docs"]);
	assert.deepEqual(receipt.laneStates.map((state) => [state.laneId, state.status]), [["build", "completed"], ["docs", "completed"]]);
	assert.equal((await readdir(value.echoDir)).length, 2);
});

test("retry-failed orders dependent lanes and rebinds a shared-worktree reviewer", async () => {
	const value = await fixture({ docsFailed: true, docsDependsOnBuild: true });
	const result = await execFileAsync(process.execPath, [
		"scripts/ox_herd.mjs", "--retry-failed", value.sourceReceipt.orchestrationId, "--concurrency", "2",
	], { cwd: process.cwd(), env: environment(value), maxBuffer: 4 * 1024 * 1024 });
	const receipt = JSON.parse(result.stdout);
	assert.equal(receipt.status, "completed");
	assert.deepEqual(receipt.workers.map((worker) => worker.laneId), ["build", "docs"]);
	const invocationFiles = await readdir(value.echoDir);
	assert.equal(invocationFiles.length, 1);
	const reviewerInvocation = JSON.parse(await readFile(join(value.echoDir, invocationFiles[0]), "utf8"));
	assert.match(reviewerInvocation.objective, /Ox team dependency inputs/);
	assert.match(reviewerInvocation.objective, /repair completed/);
	assert.equal(reviewerInvocation.expectedWorkspaceSha256, "c".repeat(64));
});

test("effective plans without a harness field hash identically to pre-harness receipts", () => {
	const laneInput = {
		id: "lane-1",
		role: "builder",
		objective: "fixture objective",
		workerPath: "/workers/lane-1",
		route: "opencode-default",
		ownedPaths: ["."],
		excludedPaths: [".env", ".git"],
		checks: ["node --test"],
		timeoutSeconds: 600,
		reportOnlyCostUsdMicros: 10_000,
	};
	const plan = validateEffectiveRetryPlan({ version: 1, lanes: [laneInput] });
	// Pinned digest: serialization is provided-keys-only, so adding optional
	// lane fields must never change the hash of a plan that omits them.
	assert.equal(effectiveRetryPlanSha256(plan), "fb31c584ed76236d2603f4747b029862a5c5028d8a52fad6b0f868025d00d9d3");
	const withHarness = validateEffectiveRetryPlan({
		version: 1,
		lanes: [{ ...laneInput, harness: "pi", route: "pi-protected-inherited" }],
	});
	assert.equal(withHarness.lanes[0].harness, "pi");
	assert.notEqual(effectiveRetryPlanSha256(withHarness), effectiveRetryPlanSha256(plan));
	assert.throws(
		() => validateEffectiveRetryPlan({ version: 1, lanes: [{ ...laneInput, harness: "codex" }] }),
		/harness must be "opencode", "pi", or "omp"/,
	);
});
