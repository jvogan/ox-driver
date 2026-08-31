import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
	compactWorkerReceipt,
	OrchestrationReceiptStore,
	RunStore,
} from "../../packages/core/dist/index.js";
import { trackedMkdtemp } from "./helpers/tracked-temp.mjs";

const execFileAsync = promisify(execFile);

async function fixture() {
	const stateHome = await trackedMkdtemp(join(tmpdir(), "ox-orchestration-report-"));
	const stateRoot = join(stateHome, "ox-driver");
	const orchestrationStore = new OrchestrationReceiptStore(join(stateRoot, "orchestrations"));
	const runStore = new RunStore(stateRoot, join(stateRoot, "leases"));
	const workerRoot = join(stateHome, "workers");
	await mkdir(workerRoot);
	const allocation = await orchestrationStore.allocate();
	return { stateHome, stateRoot, orchestrationStore, runStore, workerRoot, allocation };
}

async function childReceipt(runStore, runId, finalOutput) {
	await runStore.create(runId, {});
	const receipt = {
		version: 1,
		runId,
		harness: "opencode",
		status: "completed",
		finishedAt: new Date().toISOString(),
		costReport: { observedUsdMicros: 1234 },
		changedPaths: ["src/result.txt"],
		unownedChangedPaths: [],
		acceptance: [{ command: "node --test", passed: true }],
		finalOutput,
	};
	await runStore.writeReceipt(receipt);
	return receipt;
}

async function persistPair(value, runIds) {
	const workers = [];
	for (const [index, runId] of runIds.entries()) {
		const workerPath = join(value.workerRoot, `lane-${index + 1}`);
		await mkdir(workerPath);
		const receipt = await childReceipt(value.runStore, runId, `useful output ${index + 1} 🐂`);
		workers.push(compactWorkerReceipt(receipt, workerPath, `lane-${index + 1}`));
	}
	return value.orchestrationStore.persist({
		version: 1,
		kind: "pair",
		orchestrationId: value.allocation.orchestrationId,
		receiptPath: value.allocation.receiptPath,
		objective: "Produce two useful answers",
		status: "completed",
		workers,
		autoMerged: false,
	});
}

test("report rehydrates full child outputs and evidence from durable receipts", async () => {
	const value = await fixture();
	const runIds = [randomUUID(), randomUUID()];
	const aggregate = await persistPair(value, runIds);
	const result = await execFileAsync(process.execPath, [
		"scripts/ox_orchestration.mjs", "report", aggregate.orchestrationId,
	], { cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: value.stateHome } });
	const report = JSON.parse(result.stdout);
	assert.equal(report.reportStatus, "complete");
	assert.equal(report.workers.length, 2);
	assert.deepEqual(report.workers.map((worker) => worker.finalOutput), [
		"useful output 1 🐂",
		"useful output 2 🐂",
	]);
	assert.deepEqual(report.workers[0].changedPaths, ["src/result.txt"]);
	assert.equal(report.workers[0].checks[0].passed, true);
	assert.equal(report.workers[0].costReport.observedUsdMicros, 1234);
	assert.match(report.workers[0].runReceiptPath, new RegExp(`${runIds[0]}/receipt\\.json$`));
});

test("report remains machine-readable and marks a missing child receipt partial", async () => {
	const value = await fixture();
	const runIds = [randomUUID(), randomUUID()];
	const aggregate = await persistPair(value, runIds);
	await value.runStore.writeJson(runIds[1], "receipt.json", {
		...(await value.runStore.readReceipt(runIds[1])),
		runId: "mismatched-run-id",
	});
	let error;
	try {
		await execFileAsync(process.execPath, [
			"scripts/ox_orchestration.mjs", "report", aggregate.orchestrationId,
		], { cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: value.stateHome } });
	} catch (caught) {
		error = caught;
	}
	assert.equal(error?.code, 2);
	const report = JSON.parse(error.stdout);
	assert.equal(report.reportStatus, "partial");
	assert.equal(report.workers[0].error, undefined);
	assert.match(report.workers[1].error.message, /malformed/);
	assert.equal(report.orchestrationId, aggregate.orchestrationId);
});

test("report bounds acceptance streams while retaining head, tail, hash, and child receipt", async () => {
	const value = await fixture();
	const runIds = [randomUUID(), randomUUID()];
	const aggregate = await persistPair(value, runIds);
	const receipt = await value.runStore.readReceipt(runIds[0]);
	const stdout = `HEAD-${"x".repeat(80 * 1024)}-TAIL`;
	await value.runStore.writeJson(runIds[0], "receipt.json", {
		...receipt,
		acceptance: [{
			command: "large-check",
			passed: false,
			durationMs: 12,
			timedOut: false,
			exitCode: 1,
			stdout,
			stderr: "small error",
			stdoutTruncated: false,
			stderrTruncated: false,
			backgroundProcessesDetected: false,
			processTreeReaped: true,
			terminationEscalated: false,
		}],
	});
	const result = await execFileAsync(process.execPath, [
		"scripts/ox_orchestration.mjs", "report", aggregate.orchestrationId,
	], { cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: value.stateHome } });
	const report = JSON.parse(result.stdout);
	const check = report.workers[0].checks[0];
	assert.equal(check.stdoutEvidence.bytes, Buffer.byteLength(stdout));
	assert.equal(check.stdoutEvidence.truncated, true);
	assert.ok(Buffer.byteLength(check.stdout, "utf8") <= 32 * 1024);
	assert.match(check.stdout, /^HEAD-/);
	assert.match(check.stdout, /-TAIL$/);
	assert.match(check.stdout, /bounded the middle/);
	assert.equal(check.stderr, "small error");
	assert.match(report.workers[0].runReceiptPath, new RegExp(`${runIds[0]}/receipt\\.json$`));
});

test("archive copies bounded durable evidence and detects later tampering", async () => {
	const value = await fixture();
	const runIds = [randomUUID(), randomUUID()];
	const aggregate = await persistPair(value, runIds);
	const archivePath = join(value.stateHome, "portable-evidence");
	const archived = JSON.parse((await execFileAsync(process.execPath, [
		"scripts/ox_orchestration.mjs", "archive", aggregate.orchestrationId, "--out", archivePath,
	], { cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: value.stateHome } })).stdout);
	assert.equal(archived.status, "complete");
	assert.deepEqual(archived.archivedRunIds, runIds);
	assert.ok(archived.files.some((entry) => entry.path === "orchestration-receipt.json"));
	assert.ok(archived.files.some((entry) => entry.path === `runs/${runIds[0]}/receipt.json`));
	const verified = JSON.parse((await execFileAsync(process.execPath, [
		"scripts/ox_orchestration.mjs", "verify-archive", archivePath,
	], { cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: value.stateHome } })).stdout);
	assert.equal(verified.verified, true);
	const target = join(archivePath, `runs/${runIds[0]}/receipt.json`);
	await writeFile(target, `${await readFile(target, "utf8")}tampered`);
	await assert.rejects(execFileAsync(process.execPath, [
		"scripts/ox_orchestration.mjs", "verify-archive", archivePath,
	], { cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: value.stateHome } }), /archive evidence mismatch/);
});

test("delegated reports surface principal usage and archives require receipt-bound lineage evidence", async () => {
	const value = await fixture();
	const runId = randomUUID();
	const workerPath = join(value.workerRoot, "delegated");
	await mkdir(workerPath);
	await value.runStore.create(runId, {});
	const artifact = Buffer.from(`${JSON.stringify({ version: 1, source: "opencode-db-v1", sessions: [] })}\n`);
	await writeFile(join(value.runStore.runDirectory(runId), "artifacts", "opencode-delegation.json"), artifact);
	const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
	const events = Buffer.from(`${JSON.stringify({ version: 1, type: "adapter.child-lineage", data: { artifact: { path: "artifacts/opencode-delegation.json", bytes: artifact.length, sha256: artifactSha256 } } })}\n`);
	await writeFile(join(value.runStore.runDirectory(runId), "events.jsonl"), events);
	const receipt = {
		version: 1, runId, harness: "opencode", status: "completed",
		configuredRoute: { provider: "provider", model: "model", reasoning: "max" },
		agentIdentity: { role: "primary", configuredProfile: "builder", observedProfile: "builder", runtimeObservation: { status: "observed" } },
		usage: {
			providerRequests: 2, toolCalls: 1, childrenStarted: 1, reportedCostUsdMicros: 1000, complete: true, sources: ["harness"],
			principals: [
				{ id: "primary", role: "primary", providerRequests: 1, toolCalls: 1, childrenStarted: 1, reportedCostUsdMicros: 600 },
				{ id: "child", role: "child", parentId: "primary", providerRequests: 1, toolCalls: 0, childrenStarted: 0, reportedCostUsdMicros: 400 },
			],
		},
		eventsPath: `runs/${runId}/events.jsonl`,
		eventsSha256: createHash("sha256").update(events).digest("hex"),
		acceptance: [], changedPaths: [], unownedChangedPaths: [],
	};
	await value.runStore.writeReceipt(receipt);
	const siblingRunId = randomUUID();
	const siblingPath = join(value.workerRoot, "sibling");
	await mkdir(siblingPath);
	const sibling = await childReceipt(value.runStore, siblingRunId, "sibling output");
	const aggregate = await value.orchestrationStore.persist({
		version: 1, kind: "pair", orchestrationId: value.allocation.orchestrationId, receiptPath: value.allocation.receiptPath,
		objective: "delegated task", status: "completed", workers: [compactWorkerReceipt(receipt, workerPath, "builder"), compactWorkerReceipt(sibling, siblingPath, "sibling")], autoMerged: false,
	});
	const env = { ...process.env, XDG_STATE_HOME: value.stateHome };
	const report = JSON.parse((await execFileAsync(process.execPath, ["scripts/ox_orchestration.mjs", "report", aggregate.orchestrationId], { cwd: process.cwd(), env })).stdout);
	assert.equal(report.workers[0].usage.principals.length, 2);
	assert.deepEqual(report.workers[0].delegationArtifact, { path: "artifacts/opencode-delegation.json" });
	const archive = JSON.parse((await execFileAsync(process.execPath, ["scripts/ox_orchestration.mjs", "archive", aggregate.orchestrationId, "--out", join(value.stateHome, "delegated-archive")], { cwd: process.cwd(), env })).stdout);
	assert.equal(archive.status, "complete");
	await writeFile(join(value.runStore.runDirectory(runId), "events.jsonl"), Buffer.from(`${events.toString("utf8")}tampered\n`));
	let error;
	try {
		await execFileAsync(process.execPath, ["scripts/ox_orchestration.mjs", "archive", aggregate.orchestrationId, "--out", join(value.stateHome, "delegated-tampered")], { cwd: process.cwd(), env });
	} catch (caught) { error = caught; }
	assert.equal(error?.code, 2);
	const partial = JSON.parse(error.stdout);
	assert.equal(partial.status, "partial");
	assert.ok(partial.omissions.some((item) => item.path === "events.jsonl" && item.reason.includes("digest")));
});

test("reports and archives historical reviewer-attempt receipts alongside terminal workers", async () => {
	const value = await fixture();
	const terminalRunIds = [randomUUID(), randomUUID()];
	const historicalRunId = randomUUID();
	const workers = [];
	for (const [index, runId] of terminalRunIds.entries()) {
		const workerPath = join(value.workerRoot, `terminal-${index + 1}`);
		await mkdir(workerPath);
		workers.push(compactWorkerReceipt(await childReceipt(value.runStore, runId, `terminal ${index + 1}`), workerPath, `terminal-${index + 1}`));
	}
	const historicalPath = join(value.workerRoot, "historical-reviewer");
	await mkdir(historicalPath);
	const historicalReceipt = await childReceipt(value.runStore, historicalRunId, "failed review");
	await value.runStore.writeJson(historicalRunId, "receipt.json", { ...historicalReceipt, status: "failed" });
	const historicalReviewerWorkers = [compactWorkerReceipt(
		await value.runStore.readReceipt(historicalRunId),
		historicalPath,
		"reviewer-attempt-1",
	)];
	const aggregate = await value.orchestrationStore.persist({
		version: 1,
		kind: "pair",
		orchestrationId: value.allocation.orchestrationId,
		receiptPath: value.allocation.receiptPath,
		objective: "retain attempt evidence",
		status: "completed",
		workers,
		historicalReviewerWorkers,
		autoMerged: false,
	});
	const report = JSON.parse((await execFileAsync(process.execPath, [
		"scripts/ox_orchestration.mjs", "report", aggregate.orchestrationId,
	], { cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: value.stateHome } })).stdout);
	assert.deepEqual(report.workers.map((worker) => worker.runId), [...terminalRunIds, historicalRunId]);
	assert.equal(report.workers[2].status, "failed");
	const archivePath = join(value.stateHome, "attempt-evidence");
	const archive = JSON.parse((await execFileAsync(process.execPath, [
		"scripts/ox_orchestration.mjs", "archive", aggregate.orchestrationId, "--out", archivePath,
	], { cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: value.stateHome } })).stdout);
	assert.deepEqual(archive.archivedRunIds, [...terminalRunIds, historicalRunId]);
	assert.ok(archive.files.some((entry) => entry.path === `runs/${historicalRunId}/receipt.json`));
});

test("archive marks non-ENOENT read errors partial and keeps genuine ENOENT optional", async () => {
	const value = await fixture();
	const runIds = [randomUUID(), randomUUID()];
	const aggregate = await persistPair(value, runIds);
	// A genuine ENOENT is optional-file semantics: no omission is recorded.
	await rm(join(value.stateRoot, "runs", runIds[1], "status.json"));
	// A symlinked evidence file is a non-ENOENT read/verification error; the
	// archive must record the omission and report a partial status.
	await rm(join(value.stateRoot, "runs", runIds[0], "spec.json"));
	await symlink(
		join(value.stateRoot, "runs", runIds[0], "status.json"),
		join(value.stateRoot, "runs", runIds[0], "spec.json"),
	);
	let error;
	try {
		await execFileAsync(process.execPath, [
			"scripts/ox_orchestration.mjs", "archive", aggregate.orchestrationId, "--out", join(value.stateHome, "portable-evidence"),
		], { cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: value.stateHome } });
	} catch (caught) {
		error = caught;
	}
	assert.equal(error?.code, 2);
	const archived = JSON.parse(error.stdout);
	assert.equal(archived.status, "partial");
	assert.equal(archived.omissions.length, 1);
	assert.equal(archived.omissions[0].runId, runIds[0]);
	assert.equal(archived.omissions[0].path, "spec.json");
	assert.match(archived.omissions[0].reason, /bounded regular file/);
	assert.ok(!archived.omissions.some((item) => item.path === "status.json"));
});
