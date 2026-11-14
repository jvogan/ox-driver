import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { OrchestrationReceiptStore } from "./orchestration-store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_BYTES = 16 * 1024 * 1024;

export interface StoredIntegrationReceipt extends Record<string, unknown> {
	version: 1;
	kind: "integration";
	integrationId: string;
	orchestrationId: string;
	receiptPath: string;
	receiptSha256: string;
	status: "integrated" | "checks-failed" | "apply-failed" | "evidence-failed";
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("integration receipt must be an object");
	return value as Record<string, unknown>;
}

function validate(value: unknown, id: string, path: string): Record<string, unknown> {
	const result = record(value);
	if (result.version !== 1 || result.kind !== "integration" || result.integrationId !== id || result.receiptPath !== path
		|| !UUID.test(String(result.orchestrationId)) || !["integrated", "checks-failed", "apply-failed", "evidence-failed"].includes(String(result.status))) {
		throw new Error("integration receipt identity or status is invalid");
	}
	const workspace = record(result.workspace);
	if (!UUID.test(String(workspace.id)) || !/^[0-9a-f]{40,64}$/.test(String(workspace.baseCommit))
		|| ![workspace.path, workspace.source].every((value) => typeof value === "string" && isAbsolute(value))) {
		throw new Error("integration receipt workspace is invalid");
	}
	if ((result.status === "evidence-failed"
		? result.finalWorkspaceSha256 !== null || typeof result.evidenceError !== "string" || !result.evidenceError
		: !DIGEST.test(String(result.finalWorkspaceSha256))) || !Array.isArray(result.applied)
		|| !Array.isArray(result.selectedLanes) || result.selectedLanes.length === 0 || !Array.isArray(result.checks)
		|| !Array.isArray(result.declaredChecks) || result.declaredChecks.some((value) => typeof value !== "string" || !value.trim())
		|| result.checksDeclared !== (result.declaredChecks.length > 0) || typeof result.createdAt !== "string" || !Number.isFinite(Date.parse(result.createdAt))) {
		throw new Error("integration receipt evidence is invalid");
	}
	const laneIds = new Set<string>();
	for (const value of result.selectedLanes) {
		const lane = record(value);
		if (typeof lane.laneId !== "string" || !lane.laneId || !DIGEST.test(String(lane.patchSha256))
			|| laneIds.has(lane.laneId) || (lane.runId !== undefined && !UUID.test(String(lane.runId)))) throw new Error("integration receipt selected lane is invalid");
		laneIds.add(lane.laneId);
	}
	if (result.applied.length > result.selectedLanes.length || result.checks.length > result.declaredChecks.length) throw new Error("integration receipt contains excess results");
	for (const [index, value] of result.applied.entries()) {
		const applied = record(value);
		const selected = record(result.selectedLanes[index]);
		if (applied.laneId !== selected.laneId || applied.patchSha256 !== selected.patchSha256) throw new Error("integration receipt applied lanes differ from selection");
	}
	for (const [index, value] of result.checks.entries()) {
		const check = record(value);
		if (check.command !== result.declaredChecks[index] || typeof check.passed !== "boolean" || typeof check.timedOut !== "boolean"
			|| typeof check.backgroundProcessesDetected !== "boolean" || typeof check.processTreeReaped !== "boolean"
			|| typeof check.terminationEscalated !== "boolean") throw new Error("integration receipt check is invalid");
		if (check.passed && (check.exitCode !== 0 || check.timedOut || check.backgroundProcessesDetected || !check.processTreeReaped)) {
			throw new Error("integration receipt check contradicts its cleanup evidence");
		}
	}
	const allApplied = result.applied.length === result.selectedLanes.length;
	const checksPassed = result.checks.length === result.declaredChecks.length && result.checks.every((value) => record(value).passed === true);
	if ((result.status === "integrated" && (!allApplied || !checksPassed || result.applyFailure !== undefined))
		|| (result.status === "checks-failed" && (!allApplied || checksPassed || result.applyFailure !== undefined))
		|| (result.status === "apply-failed" && (allApplied || !result.applyFailure || result.checks.length !== 0))) {
		throw new Error("integration receipt status contradicts its results");
	}
	return result;
}

export class IntegrationReceiptStore {
	readonly root: string;

	constructor(root = join(new OrchestrationReceiptStore().root, "integrations")) {
		if (!isAbsolute(root)) throw new Error("integration state root must be absolute");
		this.root = resolve(root);
	}

	async #directory(create = false): Promise<void> {
		if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
		const status = await lstat(this.root);
		if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o077) !== 0
			|| (process.getuid && status.uid !== process.getuid()) || await realpath(this.root) !== this.root) {
			throw new Error("integration state directory must be private, owned, and free of symlinks");
		}
	}

	async persist(value: Record<string, unknown>): Promise<StoredIntegrationReceipt> {
		await this.#directory(true);
		const integrationId = randomUUID();
		const receiptPath = join(this.root, `${integrationId}.json`);
		const receipt = validate({ ...structuredClone(value), version: 1, kind: "integration", integrationId, receiptPath, createdAt: new Date().toISOString() }, integrationId, receiptPath);
		const receiptSha256 = digest(receipt);
		const bytes = Buffer.from(`${JSON.stringify({ receipt, receiptSha256 }, null, 2)}\n`);
		if (bytes.length > MAX_BYTES) throw new Error("integration receipt exceeds the record limit");
		const pending = join(this.root, `.${integrationId}.pending`);
		const handle = await open(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
		try {
			try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
			await link(pending, receiptPath);
		} finally {
			await unlink(pending).catch(() => undefined);
		}
		return Object.freeze({ ...receipt, receiptSha256 }) as StoredIntegrationReceipt;
	}

	async prepare(): Promise<void> {
		await this.#directory(true);
	}

	async inspect(id: string, expectedSha256?: string): Promise<StoredIntegrationReceipt> {
		if (!UUID.test(id)) throw new Error("integration id must be a canonical UUID");
		if (expectedSha256 !== undefined && !DIGEST.test(expectedSha256)) throw new Error("expected integration digest must be a lowercase SHA-256 digest");
		await this.#directory();
		const path = join(this.root, `${id}.json`);
		const before = await lstat(path, { bigint: true });
		if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_BYTES)
			|| (before.mode & 0o077n) !== 0n) throw new Error("integration receipt must be a private bounded regular file");
		const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		let bytes: Buffer;
		try {
			const opened = await handle.stat({ bigint: true });
			if (before.dev !== opened.dev || before.ino !== opened.ino) throw new Error("integration receipt changed before opening");
			bytes = await handle.readFile();
			const after = await handle.stat({ bigint: true });
			if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(bytes.length) !== before.size) {
				throw new Error("integration receipt changed while reading");
			}
		} finally { await handle.close(); }
		const envelope = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
		const receipt = validate(envelope.receipt, id, path);
		const receiptSha256 = digest(receipt);
		if (receiptSha256 !== envelope.receiptSha256 || (expectedSha256 !== undefined && receiptSha256 !== expectedSha256)) {
			throw new Error("integration receipt digest mismatch");
		}
		return Object.freeze({ ...receipt, receiptSha256 }) as StoredIntegrationReceipt;
	}
}
