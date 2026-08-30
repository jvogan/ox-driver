#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
	buildOrchestrationReport,
	OrchestrationReceiptStore,
	RunStore,
} from "../packages/core/dist/index.js";
import { retryOrchestration } from "./orchestration-retry.mjs";

function fail(message) {
	throw new Error(message);
}

function runStore() {
	const explicit = process.env.OX_DRIVER_STATE_DIR?.trim();
	return explicit ? new RunStore(explicit) : new RunStore();
}

const ARCHIVE_FILES = ["spec.json", "receipt.json", "status.json", "admission.json", "budget-ledger.json", "events.jsonl", "artifacts/harness.patch", "artifacts/opencode-delegation.json"];
const MAX_ARCHIVE_FILE_BYTES = 32 * 1024 * 1024;

async function stableRead(path) {
	const before = await lstat(path);
	if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_ARCHIVE_FILE_BYTES) throw new Error(`archive source is not a bounded regular file: ${path}`);
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	let bytes;
	try { bytes = await handle.readFile(); } finally { await handle.close(); }
	const after = await lstat(path);
	if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) {
		throw new Error(`archive source changed while reading: ${path}`);
	}
	return bytes;
}

async function writePrivate(path, bytes) {
	const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
	try { await handle.writeFile(bytes); } finally { await handle.close(); }
	await chmod(path, 0o600);
}

function digest(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

async function createArchive(receipt, report, runs, destination) {
	if (!isAbsolute(destination)) fail("archive --out must be an absolute fresh directory");
	const root = resolve(destination);
	await mkdir(root, { mode: 0o700 });
	await chmod(root, 0o700);
	const files = [];
	const omissions = [];
	const addBytes = async (name, bytes) => {
		const target = join(root, name);
		const relativeName = relative(root, target);
		if (!relativeName || relativeName.startsWith("..")) fail(`archive path escaped its root: ${name}`);
		await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
		await writePrivate(target, bytes);
		files.push({ path: relativeName, bytes: bytes.length, sha256: digest(bytes) });
	};
	await addBytes("orchestration-receipt.json", await stableRead(receipt.receiptPath));
	await addBytes("orchestration-report.json", Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8"));
	const archivedRunIds = [];
	for (const worker of report.workers) {
		if (typeof worker.runId !== "string") {
			omissions.push({ laneId: worker.laneId ?? worker.role, reason: "worker has no durable run id" });
			continue;
		}
		const runDirectory = runs.runDirectory(worker.runId);
		const requiresDelegationArtifact = worker.delegationArtifact?.path === "artifacts/opencode-delegation.json";
		let archivedAny = false;
		let delegationBytes;
		let eventsBytes;
		for (const name of ARCHIVE_FILES) {
			try {
				const bytes = await stableRead(join(runDirectory, name));
				await addBytes(`runs/${worker.runId}/${name}`, bytes);
				if (name === "events.jsonl") eventsBytes = bytes;
				if (name === "artifacts/opencode-delegation.json") delegationBytes = bytes;
				archivedAny = true;
			} catch (error) {
				if (error?.code !== "ENOENT" || (requiresDelegationArtifact && (name === "events.jsonl" || name === "artifacts/opencode-delegation.json"))) {
					omissions.push({ runId: worker.runId, path: name, reason: error instanceof Error ? error.message : String(error) });
				}
			}
		}
		if (requiresDelegationArtifact && delegationBytes && eventsBytes) {
			let lineage;
			try {
				lineage = eventsBytes.toString("utf8").split("\n").filter(Boolean)
					.map((line) => JSON.parse(line))
					.find((event) => event?.type === "adapter.child-lineage");
			} catch {
				lineage = undefined;
			}
			const artifact = lineage?.data?.artifact;
			if (typeof worker.eventsSha256 !== "string" || digest(eventsBytes) !== worker.eventsSha256) {
				omissions.push({ runId: worker.runId, path: "events.jsonl", reason: "events digest does not match the child run receipt" });
			} else if (artifact?.path !== "artifacts/opencode-delegation.json"
				|| artifact?.sha256 !== digest(delegationBytes)
				|| artifact?.bytes !== delegationBytes.length) {
				omissions.push({ runId: worker.runId, path: "artifacts/opencode-delegation.json", reason: "delegation artifact is not bound to its child-lineage event" });
			}
		}
		if (archivedAny) archivedRunIds.push(worker.runId);
		else omissions.push({ runId: worker.runId, reason: "no durable run files were available" });
	}
	files.sort((left, right) => left.path.localeCompare(right.path));
	// A genuine ENOENT is optional-file semantics and is never recorded, so any
	// recorded omission is a non-ENOENT read/verification error (item.path) or a
	// worker with no durable run evidence at all; either leaves the archive
	// partial instead of presenting incomplete evidence as complete.
	const status = report.childReceiptsComplete && omissions.length === 0 ? "complete" : "partial";
	const manifest = { version: 1, kind: "ox-driver-evidence-archive", orchestrationId: receipt.orchestrationId, status, archivedRunIds, files, omissions };
	const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	await writePrivate(join(root, "manifest.json"), manifestBytes);
	return { ...manifest, path: root, manifestSha256: digest(manifestBytes) };
}

async function verifyArchive(path) {
	if (!isAbsolute(path)) fail("archive verification path must be absolute");
	const root = resolve(path);
	const manifestBytes = await stableRead(join(root, "manifest.json"));
	const manifest = JSON.parse(manifestBytes.toString("utf8"));
	if (manifest?.version !== 1 || manifest?.kind !== "ox-driver-evidence-archive" || !Array.isArray(manifest.files)) fail("archive manifest is invalid");
	for (const entry of manifest.files) {
		if (!entry || typeof entry.path !== "string" || entry.path.startsWith("/") || entry.path.split(/[\\/]+/).includes("..")) fail("archive manifest contains an unsafe path");
		const bytes = await stableRead(join(root, entry.path));
		if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) fail(`archive evidence mismatch: ${entry.path}`);
	}
	return { verified: true, path: root, orchestrationId: manifest.orchestrationId, status: manifest.status, manifestSha256: digest(manifestBytes), files: manifest.files.length };
}

async function main() {
	const [command, ...arguments_] = process.argv.slice(2);
	const [argument, extra] = arguments_;
	const store = new OrchestrationReceiptStore();
	if (command === "list") {
		if (extra !== undefined) fail(`unexpected argument: ${extra}`);
		if (argument !== undefined) fail("usage: ox_orchestration.mjs list");
		const listing = await store.list();
		const inFlight = await store.listInFlight();
		process.stdout.write(`${JSON.stringify({
			running: inFlight.running.map((item) => ({
				orchestrationId: item.record.orchestrationId,
				kind: item.record.kind,
				phase: item.record.phase,
				objective: item.record.objective,
				startedAt: item.record.startedAt,
				updatedAt: item.record.updatedAt,
				workerCount: item.record.lanes.length,
				lanes: item.record.lanes.map((lane) => ({
					laneId: lane.laneId,
					status: lane.status,
					...(lane.runId ? { runId: lane.runId } : {}),
				})),
				controller: { pid: item.record.controller?.pid, status: item.controllerStatus },
				stale: item.stale,
			})),
			runningUnreadable: inFlight.unreadable,
			orchestrations: listing.receipts.map((receipt) => ({
				orchestrationId: receipt.orchestrationId,
				kind: receipt.kind,
				status: receipt.status,
				objective: receipt.objective,
				workerCount: receipt.workers.length,
				receiptPath: receipt.receiptPath,
			})),
			unreadable: listing.unreadable,
		}, null, 2)}\n`);
		// Running and stale entries are advisory; only unreadable terminal
		// receipts change the exit code.
		if (listing.unreadable.length > 0) process.exitCode = 2;
		return;
	}
	if (command === "inspect") {
		if (extra !== undefined) fail(`unexpected argument: ${extra}`);
		if (!argument) fail("usage: ox_orchestration.mjs inspect ID");
		try {
			process.stdout.write(`${JSON.stringify(await store.inspect(argument), null, 2)}\n`);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			const live = await store.inspectInFlight(argument).catch(() => undefined);
			if (!live) throw error;
			process.stdout.write(`${JSON.stringify({ inFlight: true, ...live }, null, 2)}\n`);
		}
		return;
	}
	if (command === "report") {
		if (extra !== undefined) fail(`unexpected argument: ${extra}`);
		if (!argument) fail("usage: ox_orchestration.mjs report ID");
		const receipt = await store.inspect(argument);
		const report = await buildOrchestrationReport(receipt, runStore());
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		if (!report.childReceiptsComplete) process.exitCode = 2;
		return;
	}
	if (command === "archive") {
		if (!argument) fail("usage: ox_orchestration.mjs archive ID --out /absolute/fresh-directory");
		if (arguments_[1] !== "--out" || !arguments_[2] || arguments_.length !== 3) fail("usage: ox_orchestration.mjs archive ID --out /absolute/fresh-directory");
		const receipt = await store.inspect(argument);
		const runs = runStore();
		const report = await buildOrchestrationReport(receipt, runs);
		const archive = await createArchive(receipt, report, runs, arguments_[2]);
		process.stdout.write(`${JSON.stringify(archive, null, 2)}\n`);
		if (archive.status !== "complete") process.exitCode = 2;
		return;
	}
	if (command === "verify-archive") {
		if (!argument || extra !== undefined) fail("usage: ox_orchestration.mjs verify-archive /absolute/archive-directory");
		process.stdout.write(`${JSON.stringify(await verifyArchive(argument), null, 2)}\n`);
		return;
	}
	if (command === "retry") {
		if (!argument) fail("usage: ox_orchestration.mjs retry ID (--lane LANE_ID ... | --failed) [--objective TEXT] [--concurrency N]");
		const laneIds = [];
		let failed = false;
		let instruction;
		let concurrency;
		for (let index = 1; index < arguments_.length; index += 1) {
			const item = arguments_[index];
			if (item === "--lane") laneIds.push(arguments_[++index]?.trim() || fail("--lane requires a lane id"));
			else if (item === "--failed") failed = true;
			else if (item === "--objective") instruction = arguments_[++index]?.trim() || fail("--objective requires retry guidance");
			else if (item === "--concurrency") {
				concurrency = Number(arguments_[++index]);
				if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) fail("--concurrency must be an integer from 1 to 32");
			} else fail(`unknown retry option: ${item}`);
		}
		const receipt = await retryOrchestration({ sourceId: argument, laneIds, failed, instruction, concurrency });
		process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
		if (receipt.status !== "completed") process.exitCode = 1;
		return;
	}
	fail("usage: ox_orchestration.mjs <list|inspect|report|archive|verify-archive|retry> [ID]");
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
