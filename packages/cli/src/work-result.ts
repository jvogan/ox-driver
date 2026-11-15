import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { buildOrchestrationReport, OrchestrationReceiptStore, RunStore } from "@ox-driver/core";
import type { OrchestrationReport, StoredOrchestrationReceipt } from "@ox-driver/core";

export interface WorkResult {
	version: 1;
	kind: "work-result";
	report: OrchestrationReport;
	failure?: Record<string, unknown>;
}
export interface ResultStores {
	orchestrationStore?: OrchestrationReceiptStore;
	runStore?: RunStore;
}

function defaultRunStore(): RunStore {
	const root = process.env.OX_DRIVER_STATE_DIR?.trim();
	return root ? new RunStore(root) : new RunStore();
}

export async function buildWorkResult(
	receipt: StoredOrchestrationReceipt,
	runStore = defaultRunStore(),
): Promise<WorkResult> {
	const failure = receipt.failure;
	return {
		version: 1,
		kind: "work-result",
		report: await buildOrchestrationReport(receipt, runStore),
		...(failure && typeof failure === "object" && !Array.isArray(failure)
			? { failure: structuredClone(failure as Record<string, unknown>) }
			: {}),
	};
}
export async function getWorkResult(id: string, stores: ResultStores = {}): Promise<WorkResult> {
	const orchestrationStore = stores.orchestrationStore ?? new OrchestrationReceiptStore();
	// inspect creates the state directory if missing; a read-only command must not.
	await lstat(orchestrationStore.root);
	return buildWorkResult(await orchestrationStore.inspect(id), stores.runStore);
}

// Harness output is evidence, not trusted terminal markup or controller advice.
function safe(value: unknown): string {
	return String(value ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}
function shell(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}
function obj(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
export function formatWorkResult(result: WorkResult): string {
	const r = result.report;
	const lines = [`Work ${safe(r.status)}: ${safe(r.orchestrationId)}`, `Objective: ${safe(r.objective)}`];
	if (result.failure) {
		const failure = result.failure;
		lines.push(
			`Failure${typeof failure.stage === "string" ? ` (${safe(failure.stage)})` : ""}: ${safe(failure.message ?? "details unavailable")}`,
		);
	}
	for (const worker of r.workers) {
		lines.push(`\n${safe(worker.role || "worker")} (${safe(worker.status)}):`);
		const output = worker.finalOutput ?? worker.finalOutputPreview;
		if (output)
			lines.push(
				`${/review/i.test(worker.role) ? "Reviewer findings (advisory)" : "Worker output (untrusted)"}:\n${safe(output)}`,
			);
		if (worker.error) lines.push(`Evidence unavailable: ${safe(worker.error.message)}`);
		if (worker.changedPaths?.length)
			lines.push(`Changed paths:\n${worker.changedPaths.map((p) => `  ${safe(p)}`).join("\n")}`);
		else lines.push(worker.changedPaths ? "Changed paths: none recorded" : "Changed paths: unavailable");
		if (worker.checks?.length)
			for (const check of worker.checks) {
				const c = obj(check);
				lines.push(
					`Check: ${safe(c.command)} — ${c.passed === true ? "passed" : c.passed === false ? "failed" : "unknown"}`,
				);
			}
		else lines.push(worker.checks ? "Checks: none recorded" : "Checks: unavailable");
	}
	const workspace = obj(r.workspace);
	if (typeof workspace.path === "string") lines.push(`\nWorkspace: ${safe(workspace.path)}`);
	if (typeof workspace.baseCommit === "string") lines.push(`Base commit: ${safe(workspace.baseCommit)}`);
	lines.push(
		`Reported cost: ${r.aggregateCostUsdMicros === null ? "unknown" : `$${(r.aggregateCostUsdMicros / 1_000_000).toFixed(6)}`}`,
	);
	lines.push(`Receipt: ${safe(r.receiptPath)}`);
	lines.push(`Result: ox-driver result ${shell(r.orchestrationId)}`);
	if (
		typeof workspace.path === "string" &&
		safe(workspace.path) === workspace.path &&
		!/[\r\n]/.test(workspace.path) &&
		typeof workspace.baseCommit === "string" &&
		/^[0-9a-f]{40,64}$/i.test(workspace.baseCommit)
	)
		lines.push(`Tracked diff: git -C ${shell(safe(workspace.path))} diff ${shell(workspace.baseCommit)}`);
	if (typeof workspace.path === "string" && safe(workspace.path) === workspace.path && !/[\r\n]/.test(workspace.path))
		lines.push(`Status: git -C ${shell(workspace.path)} status --short`);
	if (r.orchestrationKind === "task" || r.orchestrationKind === "handoff")
		lines.push(`Patch: ox-driver patch ${shell(r.orchestrationId)} --out work.patch`);
	if (
		r.orchestrationKind === "handoff" &&
		typeof r.planSha256 === "string" &&
		typeof r.checkpointId === "string" &&
		/^[a-zA-Z0-9._-]+$/.test(r.checkpointId)
	)
		lines.push(`Resume: ox-driver handoff resume ${shell(r.checkpointId)}`);
	return lines.join("\n");
}

/** Read the unique builder's recorded artifact without running a harness. */
export async function exportWorkPatch(id: string, out?: string, stores: ResultStores = {}): Promise<Buffer> {
	const orchestrationStore = stores.orchestrationStore ?? new OrchestrationReceiptStore();
	const runStore = stores.runStore ?? defaultRunStore();
	await lstat(orchestrationStore.root);
	const receipt = await orchestrationStore.inspect(id);
	if (receipt.kind !== "task" && receipt.kind !== "handoff")
		throw new Error("patch export supports task and handoff receipts only");
	const candidates = receipt.kind === "handoff" ? receipt.workers.filter((w) => w.role === "builder") : receipt.workers;
	if (candidates.length !== 1) throw new Error("patch export requires exactly one builder");
	const worker = candidates[0]!;
	const ids = [worker.runId, worker.observedRunId, worker.requestedRunId].filter(
		(v): v is string => typeof v === "string" && v.length > 0,
	);
	if (new Set(ids).size !== 1) throw new Error("builder run evidence is missing or ambiguous");
	const runId = ids[0]!;
	const root = resolve(runStore.root);
	const runDirectory = resolve(runStore.runDirectory(runId));
	if ((await realpath(root)) !== root) throw new Error("run state root traverses a symlink");
	for (const part of [join(root, "runs"), runDirectory]) {
		const stat = await lstat(part);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("run receipt parent is not a directory");
	}
	const receiptPath = join(runDirectory, "receipt.json");
	const lexicalReceipt = await lstat(receiptPath, { bigint: true });
	if (!lexicalReceipt.isFile() || lexicalReceipt.isSymbolicLink() || lexicalReceipt.size > 16n * 1024n * 1024n)
		throw new Error("run receipt is not a bounded regular file");
	const receiptHandle = await open(receiptPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	let run: Awaited<ReturnType<RunStore["readReceipt"]>>;
	try {
		const before = await receiptHandle.stat({ bigint: true });
		if (!before.isFile() || before.dev !== lexicalReceipt.dev || before.ino !== lexicalReceipt.ino)
			throw new Error("run receipt changed before opening");
		const bytes = await receiptHandle.readFile();
		const after = await receiptHandle.stat({ bigint: true });
		if (
			before.size !== after.size ||
			before.mtimeNs !== after.mtimeNs ||
			before.ctimeNs !== after.ctimeNs ||
			BigInt(bytes.length) !== after.size ||
			(await realpath(receiptPath)) !== receiptPath
		)
			throw new Error("run receipt changed while reading");
		run = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Awaited<
			ReturnType<RunStore["readReceipt"]>
		>;
	} finally {
		await receiptHandle.close();
	}
	if (
		run.runId !== runId ||
		typeof run.patchPath !== "string" ||
		typeof run.patchSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(run.patchSha256)
	)
		throw new Error("builder patch evidence is unavailable");
	const expected = join("runs", runId, "artifacts", "harness.patch");
	if (isAbsolute(run.patchPath) || run.patchPath !== expected)
		throw new Error("builder patch path is outside its recorded artifact location");
	const path = resolve(root, expected);
	if (!path.startsWith(root + sep)) throw new Error("builder patch path escapes state root");
	// Refuse symlinked parents and final files, and compare the opened file's identity.
	if ((await realpath(root)) !== root) throw new Error("run state root traverses a symlink");
	for (const part of [join(root, "runs"), join(root, "runs", runId), join(root, "runs", runId, "artifacts")]) {
		const s = await lstat(part);
		if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("patch artifact parent is not a directory");
	}
	const lexical = await lstat(path, { bigint: true });
	if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.size > 64n * 1024n * 1024n)
		throw new Error("patch artifact is not a bounded regular file");
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	let bytes: Buffer;
	try {
		const before = await handle.stat({ bigint: true });
		if (before.dev !== lexical.dev || before.ino !== lexical.ino || !before.isFile())
			throw new Error("patch artifact changed before opening");
		bytes = await handle.readFile();
		const after = await handle.stat({ bigint: true });
		if (
			before.size !== after.size ||
			before.mtimeNs !== after.mtimeNs ||
			before.ctimeNs !== after.ctimeNs ||
			BigInt(bytes.length) !== after.size ||
			(await realpath(path)) !== path
		)
			throw new Error("patch artifact changed while reading");
	} finally {
		await handle.close();
	}
	if (createHash("sha256").update(bytes).digest("hex") !== run.patchSha256)
		throw new Error("patch artifact hash mismatch");
	if (out !== undefined) {
		const destination = await open(
			out,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		try {
			await destination.writeFile(bytes);
		} finally {
			await destination.close();
		}
	}
	return bytes;
}
