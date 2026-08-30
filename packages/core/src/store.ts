import { constants, renameSync, unlinkSync, watch, writeFileSync } from "node:fs";
import {
	access,
	appendFile,
	chmod,
	lstat,
	mkdir,
	open,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type { BudgetLedgerSnapshot } from "./budget.js";
import {
	captureProcessIdentity,
	processIdentityStatus,
	terminateProcessIdentity,
} from "./process.js";
import type {
	DurableProcessIdentity,
	ProcessIdentityStatus,
	ProcessTerminationResult,
} from "./process.js";
import type { RunEvent, RunPhase, RunReceipt, RunSpec, RunStatus } from "./types.js";

const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const EVENT_LOG_LIMIT = 16 * 1024 * 1024;
const EVENT_LINE_LIMIT = 256 * 1024;
const EVENT_COUNT_LIMIT = 10_000;

export interface StoredRunStatus {
	version: 1;
	runId: string;
	status: "preflight" | "running" | RunStatus;
	updatedAt: string;
}

interface WorkspaceLeaseOwner {
	version: 2;
	leaseId: string;
	runId: string;
	cwd: string;
	controller: DurableProcessIdentity;
	createdAt: string;
	recoveryHold?: {
		runId: string;
		reason: string;
		setAt: string;
	};
}

export interface WorkspaceLeaseHandle {
	release(): Promise<void>;
	holdForRecovery(reason: string): Promise<void>;
}

export interface StoredHarnessProcessAdmission {
	version: 1;
	admissionId: string;
	label: string;
	detachedProcessGroup: boolean;
	status: "admitted" | "running" | "exited";
	admittedAt: string;
	identity?: DurableProcessIdentity;
	boundAt?: string;
	completedAt?: string;
	exitCode?: number | null;
	terminationSignal?: string;
}

export interface StoredRunAdmissionState {
	version: 1;
	runId: string;
	adapterId: string;
	harness: string;
	workspaceRoot: string;
	phase: RunPhase;
	startedAt: string;
	updatedAt: string;
	controller: DurableProcessIdentity;
	budgetLedger: BudgetLedgerSnapshot;
	processes: StoredHarnessProcessAdmission[];
}

export interface RunRecoveryProcess {
	admissionId: string;
	status: StoredHarnessProcessAdmission["status"];
	identityStatus: ProcessIdentityStatus | "not-bound";
}

export interface RunRecoveryState {
	version: 1;
	runId: string;
	phase: RunPhase;
	orphaned: boolean;
	controllerIdentityStatus: ProcessIdentityStatus;
	processes: RunRecoveryProcess[];
}

export interface OrphanCancellationResult {
	recovery: RunRecoveryState;
	terminations: Array<{ admissionId: string; result: ProcessTerminationResult }>;
}

export interface RunProcessCleanupResult {
	terminations: Array<{ admissionId: string; result: ProcessTerminationResult }>;
	unresolvedAdmissionIds: string[];
}

function defaultStateRoot(): string {
	const stateHome = process.env.XDG_STATE_HOME;
	return join(stateHome && stateHome.trim() !== "" ? stateHome : join(homedir(), ".local", "state"), "ox-driver");
}

function defaultLeaseRoot(): string {
	return join(homedir(), ".local", "state", "ox-driver", "workspace-leases");
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const status = await lstat(path);
	if (!status.isDirectory() || status.isSymbolicLink()) {
		throw new Error(`state path is not a private directory: ${path}`);
	}
	await chmod(path, 0o700);
}

async function atomicWrite(path: string, content: string): Promise<void> {
	await ensurePrivateDirectory(dirname(path));
	const temporary = `${path}.tmp-${randomUUID()}`;
	await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
	await rename(temporary, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function isDurableProcessIdentity(value: unknown): value is DurableProcessIdentity {
	if (!isRecord(value)) return false;
	const platform = value.platform;
	const processGroupValid = platform === "win32"
		? value.processGroupId === null
		: Number.isSafeInteger(value.processGroupId) && Number(value.processGroupId) > 0;
	return value.version === 1
		&& Number.isSafeInteger(value.pid)
		&& Number(value.pid) > 0
		&& isNonEmptyString(platform)
		&& processGroupValid
		&& typeof value.birthMarkerSha256 === "string"
		&& /^[0-9a-f]{64}$/.test(value.birthMarkerSha256)
		&& isNonEmptyString(value.observedAt);
}

function isWorkspaceLeaseOwner(value: unknown): value is WorkspaceLeaseOwner {
	if (!isRecord(value) || value.version !== 2
		|| !isNonEmptyString(value.leaseId)
		|| !isNonEmptyString(value.runId)
		|| !isNonEmptyString(value.cwd)
		|| !isNonEmptyString(value.createdAt)
		|| !isDurableProcessIdentity(value.controller)) return false;
	if (value.recoveryHold === undefined) return true;
	return isRecord(value.recoveryHold)
		&& isNonEmptyString(value.recoveryHold.runId)
		&& isNonEmptyString(value.recoveryHold.reason)
		&& isNonEmptyString(value.recoveryHold.setAt);
}

async function readWorkspaceLeaseOwner(path: string): Promise<WorkspaceLeaseOwner | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		return isWorkspaceLeaseOwner(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function isLeasePublicationCollision(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "EEXIST" || code === "ENOTEMPTY";
}

async function publishWorkspaceLease(
	leaseRoot: string,
	key: string,
	directory: string,
	owner: WorkspaceLeaseOwner,
): Promise<void> {
	const pending = join(leaseRoot, `${key}.pending-${owner.leaseId}`);
	let published = false;
	await mkdir(pending, { mode: 0o700 });
	try {
		const ownerHandle = await open(
			join(pending, "owner.json"),
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
			0o600,
		);
		try {
			await ownerHandle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, "utf8");
			await ownerHandle.sync();
		} finally {
			await ownerHandle.close();
		}
		const pendingHandle = await open(pending, constants.O_RDONLY);
		try {
			await pendingHandle.sync();
		} finally {
			await pendingHandle.close();
		}
		await rename(pending, directory);
		const leaseRootHandle = await open(leaseRoot, constants.O_RDONLY);
		try {
			await leaseRootHandle.sync();
		} finally {
			await leaseRootHandle.close();
		}
		published = true;
	} finally {
		if (!published) await rm(pending, { recursive: true, force: true }).catch(() => undefined);
	}
}

export class RunStore {
	readonly root: string;
	readonly leaseRoot: string;
	readonly #eventUsage = new Map<string, { bytes: number; count: number; truncated: boolean }>();
	readonly #admissionStateWrites = new Map<string, Promise<unknown>>();

	constructor(root = defaultStateRoot(), leaseRoot = defaultLeaseRoot()) {
		this.root = root;
		this.leaseRoot = leaseRoot;
	}

	runDirectory(runId: string): string {
		if (runId.length > 128 || !RUN_ID_PATTERN.test(runId) || runId === "." || runId === "..") {
			throw new Error(`invalid run id: ${runId}`);
		}
		return join(this.root, "runs", runId);
	}

	async create(runId: string, spec: RunSpec): Promise<string> {
		const runs = join(this.root, "runs");
		await ensurePrivateDirectory(this.root);
		await ensurePrivateDirectory(runs);
		const directory = this.runDirectory(runId);
		try {
			await mkdir(directory, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`run already exists: ${runId}`);
			throw error;
		}
		await mkdir(join(directory, "artifacts"), { mode: 0o700 });
		await chmod(directory, 0o700);
		await this.writeJson(runId, "spec.json", spec);
		await this.writeStatus(runId, "preflight");
		return directory;
	}

	async acquireWorkspaceLease(cwd: string, runId: string): Promise<WorkspaceLeaseHandle> {
		const canonicalCwd = await realpath(cwd);
		const leaseRoot = this.leaseRoot;
		await ensurePrivateDirectory(this.root);
		await ensurePrivateDirectory(leaseRoot);
		const key = createHash("sha256").update(canonicalCwd).digest("hex");
		const directory = join(leaseRoot, key);
		const leaseId = randomUUID();
		const owner: WorkspaceLeaseOwner = {
			version: 2,
			leaseId,
			runId,
			cwd: canonicalCwd,
			controller: await captureProcessIdentity(process.pid),
			createdAt: new Date().toISOString(),
		};

		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				await publishWorkspaceLease(leaseRoot, key, directory, owner);
				const release = async (): Promise<void> => {
					const current = await readWorkspaceLeaseOwner(join(directory, "owner.json"));
					if (!current || current.leaseId !== leaseId) return;
					const released = join(leaseRoot, `${key}.released-${leaseId}`);
					await rename(directory, released);
					await rm(released, { recursive: true });
				};
				return {
					release,
					holdForRecovery: async (reason: string) => {
						if (!reason.trim() || Buffer.byteLength(reason, "utf8") > 256) {
							throw new Error("workspace recovery hold requires a bounded non-empty reason");
						}
						const current = await readWorkspaceLeaseOwner(join(directory, "owner.json"));
						if (!current || current.leaseId !== leaseId) {
							throw new Error(`workspace lease ownership changed before recovery hold: ${canonicalCwd}`);
						}
						await atomicWrite(join(directory, "owner.json"), `${JSON.stringify({
							...current,
							recoveryHold: { runId, reason, setAt: new Date().toISOString() },
						}, null, 2)}\n`);
					},
				};
			} catch (error) {
				if (!isLeasePublicationCollision(error)) throw error;
			}

			const existing = await readWorkspaceLeaseOwner(join(directory, "owner.json"));
			if (!existing || existing.cwd !== canonicalCwd) {
				throw new Error(`workspace lease state is malformed or unsupported and requires explicit recovery: ${canonicalCwd}`);
			}
			if (existing.recoveryHold) {
				throw new Error(`workspace is held for unresolved run ${existing.recoveryHold.runId}: ${canonicalCwd}`);
			}
			const identityStatus = await processIdentityStatus(existing.controller);
			if (identityStatus === "unverifiable") {
				throw new Error(`workspace lease owner identity is unverifiable: ${canonicalCwd}`);
			}
			const active = identityStatus === "same";
			if (active) {
				throw new Error(`workspace is leased by run ${existing.runId} (pid ${existing.controller.pid}): ${canonicalCwd}`);
			}
			const stale = join(leaseRoot, `${key}.stale-${existing.leaseId || randomUUID()}`);
			try {
				await rename(directory, stale);
				await rm(stale, { recursive: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		throw new Error(`could not acquire workspace lease: ${canonicalCwd}`);
	}

	async initializeAdmissionState(input: {
		runId: string;
		adapterId: string;
		harness: string;
		workspaceRoot: string;
		startedAt: string;
		controller: DurableProcessIdentity;
		budgetLedger: BudgetLedgerSnapshot;
	}): Promise<StoredRunAdmissionState> {
		const state: StoredRunAdmissionState = {
			version: 1,
			runId: input.runId,
			adapterId: input.adapterId,
			harness: input.harness,
			workspaceRoot: input.workspaceRoot,
			phase: "starting",
			startedAt: input.startedAt,
			updatedAt: new Date().toISOString(),
			controller: structuredClone(input.controller),
			budgetLedger: structuredClone(input.budgetLedger),
			processes: [],
		};
		await this.writeJson(input.runId, "admission.json", state);
		this.writeBudgetSnapshotSync(input.runId, input.budgetLedger);
		return structuredClone(state);
	}

	async releaseRecoveryWorkspaceLease(cwd: string, runId: string): Promise<boolean> {
		const canonicalCwd = await realpath(cwd);
		const key = createHash("sha256").update(canonicalCwd).digest("hex");
		const directory = join(this.leaseRoot, key);
		const owner = await readWorkspaceLeaseOwner(join(directory, "owner.json"));
		if (!owner || owner.cwd !== canonicalCwd || owner.recoveryHold?.runId !== runId) return false;
		const released = join(this.leaseRoot, `${key}.recovered-${owner.leaseId}`);
		await rename(directory, released);
		await rm(released, { recursive: true });
		return true;
	}

	writeBudgetSnapshotSync(runId: string, budgetLedger: BudgetLedgerSnapshot): void {
		const target = join(this.runDirectory(runId), "budget-ledger.json");
		const temporary = `${target}.tmp-${randomUUID()}`;
		try {
			writeFileSync(temporary, `${JSON.stringify(budgetLedger, null, 2)}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			renameSync(temporary, target);
		} catch (error) {
			try {
				unlinkSync(temporary);
			} catch {
				// The temporary file may not have been created.
			}
			throw error;
		}
	}

	async readBudgetSnapshot(runId: string): Promise<BudgetLedgerSnapshot> {
		try {
			return await this.readJson<BudgetLedgerSnapshot>(runId, "budget-ledger.json");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return (await this.readAdmissionState(runId)).budgetLedger;
		}
	}

	async #mutateAdmissionState(
		runId: string,
		mutate: (state: StoredRunAdmissionState) => void,
	): Promise<StoredRunAdmissionState> {
		const previous = this.#admissionStateWrites.get(runId) ?? Promise.resolve();
		const operation = previous.catch(() => undefined).then(async () => {
			const state = await this.readAdmissionState(runId);
			mutate(state);
			state.updatedAt = new Date().toISOString();
			await this.writeJson(runId, "admission.json", state);
			return structuredClone(state);
		});
		this.#admissionStateWrites.set(runId, operation);
		try {
			return await operation;
		} finally {
			if (this.#admissionStateWrites.get(runId) === operation) this.#admissionStateWrites.delete(runId);
		}
	}

	async readAdmissionState(runId: string): Promise<StoredRunAdmissionState> {
		return this.readJson<StoredRunAdmissionState>(runId, "admission.json");
	}

	async advancePhase(runId: string, phase: RunPhase, budgetLedger: BudgetLedgerSnapshot): Promise<StoredRunAdmissionState> {
		return this.#mutateAdmissionState(runId, (state) => {
			state.phase = phase;
			state.budgetLedger = structuredClone(budgetLedger);
		});
	}

	async admitHarnessProcess(
		runId: string,
		input: { label: string; detachedProcessGroup: boolean },
		budgetLedger: BudgetLedgerSnapshot,
	): Promise<StoredHarnessProcessAdmission> {
		if (typeof input.label !== "string" || !input.label.trim() || Buffer.byteLength(input.label, "utf8") > 256) {
			throw new Error("harness process admission requires a bounded non-empty label");
		}
		if (typeof input.detachedProcessGroup !== "boolean") {
			throw new Error("harness process admission requires an explicit detached-process-group policy");
		}
		const admission: StoredHarnessProcessAdmission = {
			version: 1,
			admissionId: randomUUID(),
			label: input.label,
			detachedProcessGroup: input.detachedProcessGroup,
			status: "admitted",
			admittedAt: new Date().toISOString(),
		};
		await this.#mutateAdmissionState(runId, (state) => {
			if (state.phase !== "adapter-running") throw new Error(`cannot admit a harness process during ${state.phase}`);
			state.budgetLedger = structuredClone(budgetLedger);
			state.processes.push(admission);
		});
		return structuredClone(admission);
	}

	async bindHarnessProcess(runId: string, admissionId: string, pid: number): Promise<DurableProcessIdentity> {
		const identity = await captureProcessIdentity(pid);
		await this.#mutateAdmissionState(runId, (state) => {
			const admission = state.processes.find((item) => item.admissionId === admissionId);
			if (!admission) throw new Error(`unknown harness process admission: ${admissionId}`);
			if (admission.status !== "admitted" || admission.identity) {
				throw new Error(`harness process admission ${admissionId} is already bound`);
			}
			if (admission.detachedProcessGroup && identity.processGroupId !== identity.pid) {
				throw new Error(`harness process ${pid} is not the leader of its admitted detached process group`);
			}
			admission.status = "running";
			admission.identity = structuredClone(identity);
			admission.boundAt = new Date().toISOString();
		});
		return structuredClone(identity);
	}

	async abandonHarnessProcess(runId: string, admissionId: string, reason: string): Promise<void> {
		if (typeof reason !== "string" || !reason.trim() || Buffer.byteLength(reason, "utf8") > 64) {
			throw new Error("harness process abandonment requires a bounded non-empty reason");
		}
		await this.#mutateAdmissionState(runId, (state) => {
			const admission = state.processes.find((item) => item.admissionId === admissionId);
			if (!admission) throw new Error(`unknown harness process admission: ${admissionId}`);
			if (admission.status !== "admitted" || admission.identity) {
				throw new Error(`harness process admission ${admissionId} cannot be abandoned after binding`);
			}
			admission.status = "exited";
			admission.exitCode = null;
			admission.terminationSignal = reason;
			admission.completedAt = new Date().toISOString();
		});
	}

	async completeHarnessProcess(
		runId: string,
		admissionId: string,
		result: { exitCode: number | null; terminationSignal?: string },
	): Promise<void> {
		if (result.exitCode !== null && (!Number.isSafeInteger(result.exitCode) || result.exitCode < 0)) {
			throw new Error("harness process completion exit code must be null or a non-negative integer");
		}
		await this.#mutateAdmissionState(runId, (state) => {
			const admission = state.processes.find((item) => item.admissionId === admissionId);
			if (!admission) throw new Error(`unknown harness process admission: ${admissionId}`);
			if (admission.status !== "running" || !admission.identity) {
				throw new Error(`harness process admission ${admissionId} is not running`);
			}
			admission.status = "exited";
			admission.exitCode = result.exitCode;
			admission.completedAt = new Date().toISOString();
			if (result.terminationSignal) admission.terminationSignal = result.terminationSignal;
		});
	}

	async reconcileRun(runId: string): Promise<RunRecoveryState> {
		const state = await this.readAdmissionState(runId);
		const controllerIdentityStatus = await processIdentityStatus(state.controller);
		const processes = await Promise.all(state.processes.map(async (admission): Promise<RunRecoveryProcess> => ({
			admissionId: admission.admissionId,
			status: admission.status,
			identityStatus: admission.identity ? await processIdentityStatus(admission.identity) : "not-bound",
		})));
		return {
			version: 1,
			runId,
			phase: state.phase,
			orphaned: state.phase !== "terminal"
				&& (controllerIdentityStatus === "missing" || controllerIdentityStatus === "reused"),
			controllerIdentityStatus,
			processes,
		};
	}

	async terminateAdmittedProcesses(runId: string, reason: string): Promise<RunProcessCleanupResult> {
		const state = await this.readAdmissionState(runId);
		const terminations: RunProcessCleanupResult["terminations"] = [];
		const unresolvedAdmissionIds: string[] = [];
		for (const admission of state.processes) {
			if (admission.status === "exited") continue;
			if (admission.status === "admitted" || !admission.identity) {
				unresolvedAdmissionIds.push(admission.admissionId);
				continue;
			}
			const result = await terminateProcessIdentity(admission.identity, {
				detachedProcessGroup: admission.detachedProcessGroup,
			});
			terminations.push({ admissionId: admission.admissionId, result });
			if (result.status === "terminated" || result.status === "already-exited" || result.status === "identity-mismatch") {
				await this.#mutateAdmissionState(runId, (current) => {
					const stored = current.processes.find((item) => item.admissionId === admission.admissionId);
					if (!stored || stored.status !== "running") return;
					stored.status = "exited";
					stored.exitCode = null;
					stored.terminationSignal = result.status === "identity-mismatch" ? "identity-replaced" : reason;
					stored.completedAt = new Date().toISOString();
				});
			} else {
				unresolvedAdmissionIds.push(admission.admissionId);
			}
		}
		return { terminations, unresolvedAdmissionIds };
	}

	async cancelOrphanProcesses(runId: string): Promise<OrphanCancellationResult> {
		const recovery = await this.reconcileRun(runId);
		if (!recovery.orphaned) return { recovery, terminations: [] };
		const cleanup = await this.terminateAdmittedProcesses(runId, "controller-recovery");
		return { recovery, terminations: cleanup.terminations };
	}

	async writeStatus(runId: string, status: StoredRunStatus["status"]): Promise<void> {
		await this.writeJson(runId, "status.json", {
			version: 1,
			runId,
			status,
			updatedAt: new Date().toISOString(),
		} satisfies StoredRunStatus);
	}

	async readStatus(runId: string): Promise<StoredRunStatus> {
		try {
			const receipt = await this.readJson<RunReceipt>(runId, "receipt.json");
			return {
				version: 1,
				runId,
				status: receipt.status,
				updatedAt: receipt.finishedAt,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return this.readJson<StoredRunStatus>(runId, "status.json");
	}

	async writeReceipt(receipt: RunReceipt): Promise<void> {
		await this.writeJson(receipt.runId, "receipt.json", receipt);
	}

	async readReceipt(runId: string): Promise<RunReceipt> {
		return this.readJson<RunReceipt>(runId, "receipt.json");
	}

	async appendEvent(runId: string, event: RunEvent): Promise<void> {
		const path = join(this.runDirectory(runId), "events.jsonl");
		const usage = this.#eventUsage.get(runId) ?? { bytes: 0, count: 0, truncated: false };
		const authoritativeTerminal = event.type === "run.finished";
		if (!authoritativeTerminal && usage.truncated && (usage.bytes >= EVENT_LOG_LIMIT - EVENT_LINE_LIMIT || usage.count >= EVENT_COUNT_LIMIT - 1)) return;
		let storedEvent = event;
		let line = `${JSON.stringify(storedEvent)}\n`;
		let bytes = Buffer.byteLength(line, "utf8");
		if (bytes > EVENT_LINE_LIMIT) {
			storedEvent = {
				...event,
				type: "controller.event.truncated",
				data: {
					originalType: event.type,
					originalBytes: bytes,
					sha256: createHash("sha256").update(line).digest("hex"),
				},
			};
			line = `${JSON.stringify(storedEvent)}\n`;
			bytes = Buffer.byteLength(line, "utf8");
			usage.truncated = true;
		}
		const countLimit = authoritativeTerminal ? EVENT_COUNT_LIMIT : EVENT_COUNT_LIMIT - 1;
		const byteLimit = authoritativeTerminal ? EVENT_LOG_LIMIT : EVENT_LOG_LIMIT - EVENT_LINE_LIMIT;
		if (usage.count >= countLimit || usage.bytes + bytes > byteLimit) {
			usage.truncated = true;
			this.#eventUsage.set(runId, usage);
			if (authoritativeTerminal) throw new Error("authoritative terminal event could not be persisted");
			return;
		}
		await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
		usage.bytes += bytes;
		usage.count += 1;
		this.#eventUsage.set(runId, usage);
	}

	eventsWereTruncated(runId: string): boolean {
		return this.#eventUsage.get(runId)?.truncated ?? false;
	}

	// Bounded tail read of the normalized event log: at most maxBytes are read
	// from the end of the file and at most maxEvents parsed lines return, so a
	// full 16 MiB log never enters memory for a status check.
	async readRecentEvents(
		runId: string,
		options: { maxEvents?: number; maxBytes?: number } = {},
	): Promise<{ events: RunEvent[]; eventsSkipped: number; tailOnly: boolean }> {
		const maxEvents = options.maxEvents ?? 20;
		const maxBytes = options.maxBytes ?? 512 * 1024;
		if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > EVENT_COUNT_LIMIT) {
			throw new Error("readRecentEvents maxEvents must be a positive bounded integer");
		}
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > EVENT_LOG_LIMIT) {
			throw new Error("readRecentEvents maxBytes must be a positive bounded integer");
		}
		const path = join(this.runDirectory(runId), "events.jsonl");
		const handle = await open(path, "r");
		let text: string;
		let tailOnly: boolean;
		try {
			const size = (await handle.stat()).size;
			const offset = Math.max(0, size - maxBytes);
			tailOnly = offset > 0;
			const buffer = Buffer.alloc(Math.min(size, maxBytes));
			await handle.read(buffer, 0, buffer.length, offset);
			text = buffer.toString("utf8");
		} finally {
			await handle.close();
		}
		const lines = text.split("\n");
		// A tail read almost always starts mid-line; drop the partial first line.
		if (tailOnly) lines.shift();
		let eventsSkipped = 0;
		const events: RunEvent[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				events.push(JSON.parse(line) as RunEvent);
			} catch {
				eventsSkipped += 1;
			}
		}
		if (events.length > maxEvents) {
			eventsSkipped += events.length - maxEvents;
			events.splice(0, events.length - maxEvents);
		}
		return { events, eventsSkipped, tailOnly };
	}

	async requestCancellation(runId: string): Promise<void> {
		const status = await this.readStatus(runId);
		if (status.status !== "running") {
			throw new Error(`run ${runId} is ${status.status}, not running`);
		}
		await atomicWrite(
			join(this.runDirectory(runId), "cancel.request"),
			`${JSON.stringify({ requestedAt: new Date().toISOString() })}\n`,
		);
	}

	async watchCancellation(runId: string, cancel: () => void): Promise<() => void> {
		const directory = this.runDirectory(runId);
		const target = join(directory, "cancel.request");
		const check = async (): Promise<void> => {
			try {
				await access(target, constants.F_OK);
				cancel();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") cancel();
			}
		};
		const watcher = watch(directory, (_event, filename) => {
			if (filename === "cancel.request") void check();
		});
		await check();
		return () => watcher.close();
	}

	async writeJson(runId: string, name: string, value: unknown): Promise<void> {
		await atomicWrite(join(this.runDirectory(runId), name), `${JSON.stringify(value, null, 2)}\n`);
	}

	async readJson<T>(runId: string, name: string): Promise<T> {
		const text = await readFile(join(this.runDirectory(runId), name), "utf8");
		return JSON.parse(text) as T;
	}
}
