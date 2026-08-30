import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcessTreeCleanup {
	backgroundProcessesDetected: boolean;
	processTreeReaped: boolean;
	terminationEscalated: boolean;
}

export interface DurableProcessIdentity {
	version: 1;
	pid: number;
	processGroupId: number | null;
	platform: NodeJS.Platform;
	birthMarkerSha256: string;
	observedAt: string;
}

export type ProcessIdentityStatus = "same" | "missing" | "reused" | "unverifiable";

export interface ProcessTerminationResult {
	status: "terminated" | "already-exited" | "identity-mismatch" | "unverifiable";
	processTreeReaped: boolean;
	terminationEscalated: boolean;
}

function positivePid(pid: number): void {
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("process identity requires a positive integer pid");
}

function processMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ESRCH"
		|| (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function linuxBirthRecord(pid: number): Promise<{ processGroupId: number; marker: string }> {
	const [stat, bootId] = await Promise.all([
		readFile(`/proc/${pid}/stat`, "utf8"),
		readFile("/proc/sys/kernel/random/boot_id", "utf8"),
	]);
	const commandEnd = stat.lastIndexOf(")");
	if (commandEnd < 0) throw new Error(`cannot parse process identity for pid ${pid}`);
	const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
	const processGroupId = Number(fields[2]);
	const startTimeTicks = fields[19];
	if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0 || !startTimeTicks || !/^\d+$/.test(startTimeTicks)) {
		throw new Error(`cannot parse process identity for pid ${pid}`);
	}
	return {
		processGroupId,
		marker: `linux:${bootId.trim()}:${startTimeTicks}`,
	};
}

async function psBirthRecord(pid: number): Promise<{ processGroupId: number; marker: string }> {
	const { stdout } = await execFileAsync("ps", [
		"-o", "pid=",
		"-o", "pgid=",
		"-o", "sess=",
		"-o", "uid=",
		"-o", "lstart=",
		"-p", String(pid),
	], {
		encoding: "utf8",
		maxBuffer: 16 * 1024,
	});
	const normalized = stdout.trim().replace(/\s+/g, " ");
	const match = normalized.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
	if (!match || Number(match[1]) !== pid) throw Object.assign(new Error(`process ${pid} does not exist`), { code: "ESRCH" });
	const processGroupId = Number(match[2]);
	if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
		throw new Error(`cannot parse process group identity for pid ${pid}`);
	}
	return {
		processGroupId,
		marker: `${process.platform}:session=${match[3]}:uid=${match[4]}:started=${match[5]}`,
	};
}

/**
 * Capture a process identity that survives controller restart. The birth
 * marker distinguishes a recycled PID from the originally admitted process.
 */
export async function captureProcessIdentity(pid: number): Promise<DurableProcessIdentity> {
	positivePid(pid);
	let record: { processGroupId: number; marker: string };
	try {
		record = process.platform === "linux" ? await linuxBirthRecord(pid) : await psBirthRecord(pid);
	} catch (error) {
		let missing = processMissing(error);
		if (!missing) {
			try {
				process.kill(pid, 0);
			} catch (livenessError) {
				missing = processMissing(livenessError);
			}
		}
		if (missing) throw Object.assign(new Error(`process ${pid} does not exist`), { code: "ESRCH" });
		throw error;
	}
	return {
		version: 1,
		pid,
		processGroupId: process.platform === "win32" ? null : record.processGroupId,
		platform: process.platform,
		birthMarkerSha256: createHash("sha256").update(record.marker).digest("hex"),
		observedAt: new Date().toISOString(),
	};
}

export async function processIdentityStatus(identity: DurableProcessIdentity): Promise<ProcessIdentityStatus> {
	if (identity.version !== 1 || identity.platform !== process.platform
		|| !/^[0-9a-f]{64}$/.test(identity.birthMarkerSha256)) return "unverifiable";
	try {
		const current = await captureProcessIdentity(identity.pid);
		return current.birthMarkerSha256 === identity.birthMarkerSha256
			&& current.processGroupId === identity.processGroupId
			? "same"
			: "reused";
	} catch (error) {
		return processMissing(error) ? "missing" : "unverifiable";
	}
}

async function waitForIdentityExit(
	identity: DurableProcessIdentity,
	timeoutMilliseconds: number,
): Promise<"exited" | "running" | "unverifiable"> {
	const deadline = Date.now() + timeoutMilliseconds;
	while (true) {
		const status = await processIdentityStatus(identity);
		if (status === "missing" || status === "reused") return "exited";
		if (status === "unverifiable") return "unverifiable";
		if (Date.now() >= deadline) return "running";
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
	}
}

/**
 * Terminate only the process whose birth marker matches the durable
 * admission. A different birth marker fails closed and is never signalled.
 */
export async function terminateProcessIdentity(
	identity: DurableProcessIdentity,
	options: { detachedProcessGroup?: boolean; graceMilliseconds?: number } = {},
): Promise<ProcessTerminationResult> {
	const initial = await processIdentityStatus(identity);
	if (initial === "missing") {
		return { status: "already-exited", processTreeReaped: true, terminationEscalated: false };
	}
	if (initial === "reused") {
		return { status: "identity-mismatch", processTreeReaped: false, terminationEscalated: false };
	}
	if (initial !== "same") {
		return { status: "unverifiable", processTreeReaped: false, terminationEscalated: false };
	}
	const detached = options.detachedProcessGroup === true;
	if (detached && (process.platform === "win32" || identity.processGroupId !== identity.pid)) {
		return { status: "unverifiable", processTreeReaped: false, terminationEscalated: false };
	}
	const target = detached ? -identity.pid : identity.pid;
	try {
		process.kill(target, "SIGTERM");
	} catch (error) {
		if (processMissing(error)) {
			return { status: "already-exited", processTreeReaped: true, terminationEscalated: false };
		}
		return { status: "unverifiable", processTreeReaped: false, terminationEscalated: false };
	}
	const gracefulExit = await waitForIdentityExit(identity, options.graceMilliseconds ?? 500);
	if (gracefulExit === "unverifiable") {
		return { status: "unverifiable", processTreeReaped: false, terminationEscalated: false };
	}
	if (gracefulExit === "exited") {
		const groupReaped = !detached || !processGroupExists(identity.pid)
			? true
			: await waitForProcessGroupExit(identity.pid, options.graceMilliseconds ?? 500);
		return { status: "terminated", processTreeReaped: groupReaped, terminationEscalated: false };
	}
	const beforeEscalation = await processIdentityStatus(identity);
	if (beforeEscalation === "missing" || beforeEscalation === "reused") {
		return { status: "terminated", processTreeReaped: !detached || !processGroupExists(identity.pid), terminationEscalated: false };
	}
	if (beforeEscalation !== "same") {
		return { status: "unverifiable", processTreeReaped: false, terminationEscalated: false };
	}
	try {
		process.kill(target, "SIGKILL");
	} catch (error) {
		if (!processMissing(error)) {
			return { status: "unverifiable", processTreeReaped: false, terminationEscalated: true };
		}
	}
	const processExited = await waitForIdentityExit(identity, 2_000);
	const groupExited = !detached || await waitForProcessGroupExit(identity.pid, 2_000);
	return {
		status: processExited === "unverifiable" ? "unverifiable" : "terminated",
		processTreeReaped: processExited === "exited" && groupExited,
		terminationEscalated: true,
	};
}

function processGroupExists(processGroupId: number): boolean {
	if (process.platform === "win32") return false;
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMilliseconds: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMilliseconds;
	while (processGroupExists(processGroupId)) {
		if (Date.now() >= deadline) return false;
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
	}
	return true;
}

/**
 * Verify that a detached POSIX process group is empty after its leader exits.
 * Any surviving descendants are terminated and reported to the caller so a
 * nominally successful harness run can be failed closed.
 */
export async function reapDetachedProcessGroup(processGroupId: number | undefined): Promise<ProcessTreeCleanup> {
	if (processGroupId === undefined || process.platform === "win32" || !processGroupExists(processGroupId)) {
		return { backgroundProcessesDetected: false, processTreeReaped: true, terminationEscalated: false };
	}
	try {
		process.kill(-processGroupId, "SIGTERM");
	} catch {
		// The detached group exited between the existence check and termination.
	}
	if (await waitForProcessGroupExit(processGroupId, 500)) {
		return { backgroundProcessesDetected: true, processTreeReaped: true, terminationEscalated: false };
	}
	try {
		process.kill(-processGroupId, "SIGKILL");
	} catch {
		// The detached group exited before escalation.
	}
	return {
		backgroundProcessesDetected: true,
		processTreeReaped: await waitForProcessGroupExit(processGroupId, 2_000),
		terminationEscalated: true,
	};
}
