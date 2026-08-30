import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	realpath,
	rename,
	unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WORKTREE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RECORD_BYTES = 16 * 1024;
const GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

export type ManagedWorktreeStatus = "ready" | "dirty" | "advanced" | "drifted" | "missing" | "unregistered" | "removed";

interface ManagedWorktreeRecord {
	version: 1;
	id: string;
	source: string;
	path: string;
	baseCommit: string;
	createdAt: string;
}

export interface ManagedWorktreeInfo extends ManagedWorktreeRecord {
	status: ManagedWorktreeStatus;
	currentCommit?: string;
}

export interface CreateManagedWorktreeOptions {
	ref?: string;
	id?: string;
}

export interface RemoveManagedWorktreeOptions {
	discard?: boolean;
}

export interface ManagedWorktreeRemoval extends ManagedWorktreeInfo {
	discarded: boolean;
	discardedChangedPaths: string[];
	discardedCommits: string[];
}

function defaultStateRoot(): string {
	const configured = process.env.OX_DRIVER_WORKSPACE_STATE_DIR?.trim();
	if (configured) {
		if (!isAbsolute(configured)) throw new Error("OX_DRIVER_WORKSPACE_STATE_DIR must be absolute");
		return resolve(configured);
	}
	return join(homedir(), ".local", "state", "ox-driver", "managed-worktrees");
}

function gitEnvironment(stateRoot: string): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH?.trim() || "/usr/bin:/bin:/usr/sbin:/sbin",
		HOME: join(stateRoot, "git-home"),
		LANG: "C",
		LC_ALL: "C",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
	};
}

async function runGit(stateRoot: string, cwd: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", [
		"-c", "core.fsmonitor=false",
		"-c", "core.hooksPath=/dev/null",
		"-C", cwd,
		...args,
	], {
		env: gitEnvironment(stateRoot),
		maxBuffer: GIT_OUTPUT_BYTES,
	});
	return result.stdout;
}

async function ensurePrivateDirectory(path: string): Promise<string> {
	try {
		await mkdir(path, { recursive: true, mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const status = await lstat(path);
	const owner = process.getuid?.();
	if (!status.isDirectory() || status.isSymbolicLink()
		|| (owner !== undefined && status.uid !== owner)
		|| (status.mode & 0o077) !== 0) {
		throw new Error(`managed-worktree state directory must be private and owned by the current user: ${path}`);
	}
	const canonical = await realpath(path);
	if (canonical !== resolve(path)) throw new Error(`managed-worktree state directory must not traverse symlinks: ${path}`);
	return canonical;
}

function validateId(id: string): void {
	if (!WORKTREE_ID.test(id)) throw new Error("managed-worktree id must be a canonical UUID");
}

function validateRef(ref: string): void {
	if (!ref.trim() || ref.startsWith("-") || ref.includes("\0") || Buffer.byteLength(ref, "utf8") > 1024) {
		throw new Error("managed-worktree ref must be a bounded Git revision without a leading option marker");
	}
}

function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) throw new Error(`managed-worktree record has unsupported fields: ${unknown.join(", ")}`);
}

function validateRecord(value: unknown): ManagedWorktreeRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("managed-worktree record must be an object");
	const record = value as Record<string, unknown>;
	exactKeys(record, ["version", "id", "source", "path", "baseCommit", "createdAt"]);
	if (record.version !== 1 || typeof record.id !== "string") throw new Error("managed-worktree record identity is invalid");
	validateId(record.id);
	for (const field of ["source", "path", "baseCommit", "createdAt"] as const) {
		if (typeof record[field] !== "string" || !record[field].trim()) throw new Error(`managed-worktree record ${field} is invalid`);
	}
	if (!/^[0-9a-f]{40,64}$/.test(record.baseCommit as string)) throw new Error("managed-worktree base commit is invalid");
	if (!isAbsolute(record.source as string) || !isAbsolute(record.path as string)) throw new Error("managed-worktree record paths must be absolute");
	return record as unknown as ManagedWorktreeRecord;
}

async function readRecord(path: string): Promise<ManagedWorktreeRecord> {
	const lexical = await lstat(path, { bigint: true });
	if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.size > BigInt(MAX_RECORD_BYTES)) {
		throw new Error("managed-worktree record must be a bounded non-symlink file");
	}
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile() || before.dev !== lexical.dev || before.ino !== lexical.ino) throw new Error("managed-worktree record changed before opening");
		const bytes = await handle.readFile();
		const after = await handle.stat({ bigint: true });
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
			|| before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
			throw new Error("managed-worktree record changed while reading");
		}
		return validateRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
	} finally {
		await handle.close();
	}
}

async function writeRecord(path: string, record: ManagedWorktreeRecord): Promise<void> {
	const temporary = `${path}.pending-${randomUUID()}`;
	const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporary, path);
	await chmod(path, 0o600);
}

function registeredWorktrees(output: string): Map<string, string> {
	const result = new Map<string, string>();
	let path: string | undefined;
	let head: string | undefined;
	for (const line of `${output}\n`.split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
		else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
		else if (line === "" && path) {
			result.set(resolve(path), head ?? "");
			path = undefined;
			head = undefined;
		}
	}
	return result;
}

function gitVisibleChangedPaths(output: string): string[] {
	const paths = new Set<string>();
	const records = output.split("\0");
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (!record || record.length < 4 || record[2] !== " ") continue;
		const status = record.slice(0, 2);
		paths.add(record.slice(3));
		const secondPath = records[index + 1];
		if ((status.includes("R") || status.includes("C")) && secondPath) {
			paths.add(secondPath);
			index += 1;
		}
	}
	return [...paths].sort();
}

export class ManagedWorktreeStore {
	readonly root: string;

	constructor(root = defaultStateRoot()) {
		if (!isAbsolute(root)) throw new Error("managed-worktree state root must be absolute");
		this.root = resolve(root);
	}

	async #roots(): Promise<{ root: string; records: string; worktrees: string }> {
		const root = await ensurePrivateDirectory(this.root);
		const records = await ensurePrivateDirectory(join(root, "records"));
		const worktrees = await ensurePrivateDirectory(join(root, "worktrees"));
		await ensurePrivateDirectory(join(root, "git-home"));
		return { root, records, worktrees };
	}

	async create(sourceInput: string, options: CreateManagedWorktreeOptions = {}): Promise<ManagedWorktreeInfo> {
		const roots = await this.#roots();
		const sourceInputCanonical = await realpath(sourceInput);
		const source = await realpath((await runGit(roots.root, sourceInputCanonical, ["rev-parse", "--show-toplevel"])).trim());
		const ref = options.ref ?? "HEAD";
		validateRef(ref);
		const baseCommit = (await runGit(roots.root, source, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
		if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) throw new Error("Git did not resolve the requested ref to a commit");
		const id = options.id ?? randomUUID();
		validateId(id);
		const path = join(roots.worktrees, id);
		const recordPath = join(roots.records, `${id}.json`);
		if (!isWithin(roots.worktrees, path) || !isWithin(roots.records, recordPath)) throw new Error("managed-worktree allocation escaped controller state");
		const record: ManagedWorktreeRecord = {
			version: 1,
			id,
			source,
			path,
			baseCommit,
			createdAt: new Date().toISOString(),
		};
		try {
			await writeRecord(recordPath, record);
			await runGit(roots.root, source, ["worktree", "add", "--detach", path, baseCommit]);
		} catch (error) {
			await runGit(roots.root, source, ["worktree", "remove", "--force", path]).catch(() => undefined);
			await unlink(recordPath).catch(() => undefined);
			throw error;
		}
		return { ...record, status: "ready", currentCommit: baseCommit };
	}

	async inspect(id: string): Promise<ManagedWorktreeInfo> {
		validateId(id);
		const roots = await this.#roots();
		const record = await readRecord(join(roots.records, `${id}.json`));
		const expectedPath = join(roots.worktrees, id);
		if (record.id !== id || record.path !== expectedPath || !isWithin(roots.worktrees, record.path)) {
			throw new Error("managed-worktree record does not match its controller-owned path");
		}
		try {
			const canonicalPath = await realpath(record.path);
			if (canonicalPath !== record.path) throw new Error("managed-worktree path changed identity");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...record, status: "missing" };
			throw error;
		}
		let registrations: Map<string, string>;
		try {
			registrations = registeredWorktrees(await runGit(roots.root, record.source, ["worktree", "list", "--porcelain"]));
		} catch {
			return { ...record, status: "unregistered" };
		}
		if (!registrations.has(record.path)) return { ...record, status: "unregistered" };
		const root = await realpath((await runGit(roots.root, record.path, ["rev-parse", "--show-toplevel"])).trim());
		if (root !== record.path) return { ...record, status: "unregistered" };
		const currentCommit = (await runGit(roots.root, record.path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
		if (registrations.get(record.path) !== currentCommit) {
			return { ...record, status: "drifted", currentCommit };
		}
		if (currentCommit !== record.baseCommit) {
			try {
				await runGit(roots.root, record.path, ["merge-base", "--is-ancestor", record.baseCommit, currentCommit]);
				return { ...record, status: "advanced", currentCommit };
			} catch {
				return { ...record, status: "drifted", currentCommit };
			}
		}
		const status = await runGit(roots.root, record.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
		return { ...record, status: status.length === 0 ? "ready" : "dirty", currentCommit };
	}

	async list(): Promise<ManagedWorktreeInfo[]> {
		const roots = await this.#roots();
		const ids = (await readdir(roots.records, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"))
			.map((entry) => entry.name.slice(0, -5))
			.sort();
		return Promise.all(ids.map((id) => this.inspect(id)));
	}

	async remove(id: string, options: RemoveManagedWorktreeOptions = {}): Promise<ManagedWorktreeRemoval> {
		const info = await this.inspect(id);
		const discard = options.discard === true;
		if (discard && info.status === "missing") {
			const roots = await this.#roots();
			const registrations = registeredWorktrees(await runGit(roots.root, info.source, ["worktree", "list", "--porcelain"]));
			if (registrations.has(info.path)) throw new Error("refusing to discard a missing worktree that remains registered");
			await unlink(join(roots.records, `${id}.json`));
			return { ...info, status: "removed", discarded: true, discardedChangedPaths: [], discardedCommits: [] };
		}
		if ((!discard && info.status !== "ready")
			|| (discard && info.status !== "ready" && info.status !== "dirty" && info.status !== "advanced")) {
			throw new Error(`refusing to ${discard ? "discard" : "remove"} managed worktree ${id} with status ${info.status}`);
		}
		const roots = await this.#roots();
		const registrations = registeredWorktrees(await runGit(roots.root, info.source, ["worktree", "list", "--porcelain"]));
		if (registrations.get(info.path) !== info.currentCommit) throw new Error("refusing to remove a worktree whose Git registration changed");
		const uncommittedPaths = discard
			? gitVisibleChangedPaths(await runGit(roots.root, info.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
			: [];
		const committedPaths = discard && info.status === "advanced"
			? (await runGit(roots.root, info.path, ["diff", "--name-only", "-z", info.baseCommit, info.currentCommit!])).split("\0").filter(Boolean)
			: [];
		const discardedChangedPaths = [...new Set([...uncommittedPaths, ...committedPaths])].sort();
		const discardedCommits = discard && info.status === "advanced"
			? (await runGit(roots.root, info.path, ["rev-list", "--reverse", `${info.baseCommit}..${info.currentCommit!}`])).split("\n").filter(Boolean)
			: [];
		await runGit(roots.root, info.source, ["worktree", "remove", ...(discard ? ["--force"] : []), info.path]);
		try {
			await lstat(info.path);
			throw new Error("Git reported removal but the managed worktree path still exists");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await unlink(join(roots.records, `${id}.json`));
		return { ...info, status: "removed", discarded: discard, discardedChangedPaths, discardedCommits };
	}
}
