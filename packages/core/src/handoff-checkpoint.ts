import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const CHECKPOINT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHECKPOINT_LIMIT = 2 * 1024 * 1024;
const STAGE_STATUSES = new Set(["pending", "running", "completed", "failed", "cancelled"]);

export interface HandoffCheckpointLease {
	checkpointId: string;
	ownerId: string;
	release(): Promise<void>;
}

export interface HandoffCheckpointStage {
	runId: string;
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	receiptPath?: string;
	workspaceSha256?: string;
}

export interface HandoffCheckpoint extends Record<string, unknown> {
	version: 1;
	kind: "handoff-checkpoint";
	checkpointId: string;
	createdAt: string;
	updatedAt: string;
	plan: Record<string, unknown>;
	planSha256: string;
	orchestrationAttempts: string[];
	builder: HandoffCheckpointStage;
	reviewerAttempts: HandoffCheckpointStage[];
	terminalOrchestrationId?: string;
}

function validateId(value: unknown, label: string): string {
	if (typeof value !== "string" || !CHECKPOINT_ID.test(value)) throw new Error(`${label} must be a canonical UUID`);
	return value;
}

function planSha256(plan: Record<string, unknown>): string {
	return createHash("sha256").update("ox-driver-handoff-plan-v1\0").update(JSON.stringify(plan)).digest("hex");
}

function validateStage(value: unknown, label: string): HandoffCheckpointStage {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	const stage = value as Record<string, unknown>;
	const runId = validateId(stage.runId, `${label}.runId`);
	if (!STAGE_STATUSES.has(String(stage.status))) throw new Error(`${label}.status is invalid`);
	if (stage.receiptPath !== undefined && (typeof stage.receiptPath !== "string" || !isAbsolute(stage.receiptPath))) {
		throw new Error(`${label}.receiptPath must be absolute`);
	}
	if (stage.workspaceSha256 !== undefined && (typeof stage.workspaceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(stage.workspaceSha256))) {
		throw new Error(`${label}.workspaceSha256 must be a lowercase SHA-256 digest`);
	}
	return {
		runId,
		status: stage.status as HandoffCheckpointStage["status"],
		...(stage.receiptPath !== undefined ? { receiptPath: stage.receiptPath } : {}),
		...(stage.workspaceSha256 !== undefined ? { workspaceSha256: stage.workspaceSha256 } : {}),
	};
}

function validateCheckpoint(value: unknown, expectedId?: string): HandoffCheckpoint {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("handoff checkpoint must be an object");
	const raw = value as Record<string, unknown>;
	if (raw.version !== 1 || raw.kind !== "handoff-checkpoint") throw new Error("handoff checkpoint version or kind is unsupported");
	const checkpointId = validateId(raw.checkpointId, "handoff checkpoint id");
	if (expectedId !== undefined && checkpointId !== expectedId) throw new Error("handoff checkpoint identity does not match its path");
	if (typeof raw.createdAt !== "string" || typeof raw.updatedAt !== "string") throw new Error("handoff checkpoint timestamps are invalid");
	if (!raw.plan || typeof raw.plan !== "object" || Array.isArray(raw.plan)) throw new Error("handoff checkpoint plan must be an object");
	const plan = raw.plan as Record<string, unknown>;
	const expectedPlanSha256 = planSha256(plan);
	if (raw.planSha256 !== expectedPlanSha256) throw new Error("handoff checkpoint plan digest does not match its plan");
	if (!Array.isArray(raw.orchestrationAttempts) || raw.orchestrationAttempts.length === 0) {
		throw new Error("handoff checkpoint orchestration attempts must be a non-empty array");
	}
	const orchestrationAttempts = raw.orchestrationAttempts.map((id, index) => validateId(id, `handoff orchestration attempt ${index}`));
	if (new Set(orchestrationAttempts).size !== orchestrationAttempts.length) throw new Error("handoff orchestration attempt identities must be unique");
	if (!Array.isArray(raw.reviewerAttempts) || raw.reviewerAttempts.length === 0) {
		throw new Error("handoff checkpoint reviewer attempts must be a non-empty array");
	}
	const terminalOrchestrationId = raw.terminalOrchestrationId === undefined
		? undefined
		: validateId(raw.terminalOrchestrationId, "handoff checkpoint terminal orchestration id");
	if (terminalOrchestrationId && !orchestrationAttempts.includes(terminalOrchestrationId)) {
		throw new Error("handoff checkpoint terminal orchestration must name a recorded attempt");
	}
	return {
		version: 1,
		kind: "handoff-checkpoint",
		checkpointId,
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt,
		plan,
		planSha256: expectedPlanSha256,
		orchestrationAttempts,
		builder: validateStage(raw.builder, "handoff checkpoint builder"),
		reviewerAttempts: raw.reviewerAttempts.map((stage, index) => validateStage(stage, `handoff checkpoint reviewer attempt ${index}`)),
		...(terminalOrchestrationId ? { terminalOrchestrationId } : {}),
	};
}

function assertLegalStageTransition(previous: HandoffCheckpointStage, next: HandoffCheckpointStage, label: string): void {
	if (previous.runId !== next.runId) throw new Error(`${label} run identity is immutable`);
	if (previous.status === "completed" && next.status !== "completed") throw new Error(`${label} cannot leave completed state`);
	if ((previous.status === "failed" || previous.status === "cancelled") && next.status !== previous.status) {
		throw new Error(`${label} terminal attempt state is immutable`);
	}
	if (previous.receiptPath !== undefined && previous.receiptPath !== next.receiptPath) throw new Error(`${label} receipt path is immutable`);
	if (previous.workspaceSha256 !== undefined && previous.workspaceSha256 !== next.workspaceSha256) throw new Error(`${label} workspace digest is immutable`);
}

function assertLegalCheckpointTransition(previous: HandoffCheckpoint, next: HandoffCheckpoint): void {
	if (previous.checkpointId !== next.checkpointId || previous.createdAt !== next.createdAt
		|| previous.planSha256 !== next.planSha256 || JSON.stringify(previous.plan) !== JSON.stringify(next.plan)) {
		throw new Error("handoff checkpoint identity and plan are immutable");
	}
	if (next.orchestrationAttempts.length < previous.orchestrationAttempts.length
		|| previous.orchestrationAttempts.some((id, index) => next.orchestrationAttempts[index] !== id)) {
		throw new Error("handoff orchestration attempt lineage is append-only");
	}
	assertLegalStageTransition(previous.builder, next.builder, "handoff builder stage");
	if (next.reviewerAttempts.length < previous.reviewerAttempts.length) throw new Error("handoff reviewer attempts cannot be removed");
	for (let index = 0; index < previous.reviewerAttempts.length; index += 1) {
		assertLegalStageTransition(previous.reviewerAttempts[index]!, next.reviewerAttempts[index]!, `handoff reviewer attempt ${index}`);
	}
	const newIds = next.reviewerAttempts.map((attempt) => attempt.runId);
	if (new Set(newIds).size !== newIds.length) throw new Error("handoff reviewer attempt identities must be unique");
	if (previous.terminalOrchestrationId !== undefined && next.terminalOrchestrationId !== previous.terminalOrchestrationId) {
		throw new Error("handoff terminal orchestration identity is immutable");
	}
}

async function privateDirectory(path: string): Promise<string> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const status = await lstat(path);
	const owner = process.getuid?.();
	if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o077) !== 0
		|| (owner !== undefined && status.uid !== owner)) {
		throw new Error(`handoff checkpoint directory must be private and owned by the current user: ${path}`);
	}
	const canonical = await realpath(path);
	if (canonical !== resolve(path)) throw new Error(`handoff checkpoint directory must not traverse symlinks: ${path}`);
	return canonical;
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export class HandoffCheckpointStore {
	readonly root: string;

	constructor(orchestrationRoot: string) {
		if (!isAbsolute(orchestrationRoot)) throw new Error("orchestration state root must be absolute");
		this.root = join(resolve(orchestrationRoot), "checkpoints");
	}

	createValue(input: {
		checkpointId: string;
		plan: Record<string, unknown>;
		builderRunId: string;
		reviewerRunId: string;
	}): HandoffCheckpoint {
		const now = new Date().toISOString();
		return validateCheckpoint({
			version: 1,
			kind: "handoff-checkpoint",
			checkpointId: input.checkpointId,
			createdAt: now,
			updatedAt: now,
			plan: input.plan,
			planSha256: planSha256(input.plan),
			orchestrationAttempts: [input.checkpointId],
			builder: { runId: input.builderRunId, status: "pending" },
			reviewerAttempts: [{ runId: input.reviewerRunId, status: "pending" }],
		});
	}

	async write(value: HandoffCheckpoint, options: { create?: boolean } = {}): Promise<HandoffCheckpoint> {
		const validated = validateCheckpoint({ ...value, updatedAt: new Date().toISOString() });
		const bytes = Buffer.from(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
		if (bytes.length > CHECKPOINT_LIMIT) throw new Error("handoff checkpoint exceeds the bounded record limit");
		const directory = await privateDirectory(this.root);
		const target = join(directory, `${validated.checkpointId}.json`);
		if (options.create) {
			const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
			try {
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await syncDirectory(directory);
			return validated;
		}
		const existing = await lstat(target);
		if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("handoff checkpoint target is not a regular file");
		const previous = await this.read(validated.checkpointId);
		assertLegalCheckpointTransition(previous, validated);
		const temporary = join(directory, `.${validated.checkpointId}.${randomUUID()}.tmp`);
		const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await rename(temporary, target);
			await chmod(target, 0o600);
			await syncDirectory(directory);
		} catch (error) {
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
		return validated;
	}

	async read(checkpointId: string): Promise<HandoffCheckpoint> {
		validateId(checkpointId, "handoff checkpoint id");
		const directory = await privateDirectory(this.root);
		const path = join(directory, `${checkpointId}.json`);
		const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const status = await handle.stat({ bigint: true });
			const owner = process.getuid?.();
			if (!status.isFile() || status.size > BigInt(CHECKPOINT_LIMIT) || (owner !== undefined && status.uid !== BigInt(owner))) {
				throw new Error("handoff checkpoint is not a bounded owner-controlled regular file");
			}
			const bytes = await handle.readFile();
			const after = await handle.stat({ bigint: true });
			if (status.dev !== after.dev || status.ino !== after.ino || status.size !== after.size
				|| status.mtimeNs !== after.mtimeNs || status.ctimeNs !== after.ctimeNs || bytes.length !== Number(after.size)) {
				throw new Error("handoff checkpoint changed while reading");
			}
			return validateCheckpoint(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown, checkpointId);
		} finally {
			await handle.close();
		}
	}

	async acquireLease(checkpointId: string, ownerId: string): Promise<HandoffCheckpointLease> {
		validateId(checkpointId, "handoff checkpoint id");
		validateId(ownerId, "handoff checkpoint lease owner id");
		const directory = await privateDirectory(this.root);
		const path = join(directory, `${checkpointId}.lease`);
		const value = Buffer.from(`${JSON.stringify({ version: 1, checkpointId, ownerId, pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
		for (let attempt = 0; attempt < 4; attempt += 1) {
			try {
				const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
				try {
					await handle.writeFile(value);
					await handle.sync();
				} finally {
					await handle.close();
				}
				await syncDirectory(directory);
				return {
					checkpointId,
					ownerId,
					release: async () => {
						const current = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
						try {
							const parsed = JSON.parse(await current.readFile("utf8")) as Record<string, unknown>;
							if (parsed.ownerId !== ownerId || parsed.checkpointId !== checkpointId) {
								throw new Error("handoff checkpoint lease ownership changed");
							}
						} finally {
							await current.close();
						}
						await unlink(path);
						await syncDirectory(directory);
					},
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
				let parsed: Record<string, unknown>;
				try {
					const status = await handle.stat();
					if (!status.isFile() || status.size > 4096) throw new Error("handoff checkpoint lease is invalid");
					parsed = JSON.parse(await handle.readFile("utf8")) as Record<string, unknown>;
				} finally {
					await handle.close();
				}
				if (!Number.isSafeInteger(parsed.pid) || Number(parsed.pid) < 1) throw new Error("handoff checkpoint lease pid is invalid");
				let ownerIsAlive = true;
				try {
					process.kill(Number(parsed.pid), 0);
				} catch (probeError) {
					if ((probeError as NodeJS.ErrnoException).code === "ESRCH") ownerIsAlive = false;
					else if ((probeError as NodeJS.ErrnoException).code !== "EPERM") throw probeError;
				}
				if (ownerIsAlive) throw new Error(`handoff checkpoint is already active under orchestration ${String(parsed.ownerId)}`);
				const stale = join(directory, `.${checkpointId}.${randomUUID()}.stale-lease`);
				try {
					await rename(path, stale);
				} catch (renameError) {
					if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw renameError;
				}
				const staleHandle = await open(stale, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
				let staleValue: Record<string, unknown>;
				try {
					staleValue = JSON.parse(await staleHandle.readFile("utf8")) as Record<string, unknown>;
				} finally {
					await staleHandle.close();
				}
				if (staleValue.checkpointId !== parsed.checkpointId || staleValue.ownerId !== parsed.ownerId || staleValue.pid !== parsed.pid) {
					await rename(stale, path).catch(() => undefined);
					throw new Error("handoff checkpoint lease changed while reclaiming a stale owner");
				}
				await unlink(stale);
				await syncDirectory(directory);
			}
		}
		throw new Error("handoff checkpoint lease could not be acquired");
	}
}
