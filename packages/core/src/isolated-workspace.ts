import { isUtf8 } from "node:buffer";
import { constants, type BigIntStats } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	opendir,
	readlink,
	realpath,
	symlink,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { platform } from "node:process";

const EVIDENCE_DIRECTORY_NAME = "evidence";
const WORKSPACE_DIRECTORY_NAME = "workspace";

export interface IsolatedWorkspaceLimits {
	maxEntries: number;
	maxFileBytes: number;
	maxTotalFileBytes: number;
	maxDepth: number;
}

export const DEFAULT_ISOLATED_WORKSPACE_LIMITS: Readonly<IsolatedWorkspaceLimits> = Object.freeze({
	maxEntries: 20_000,
	maxFileBytes: 64 * 1024 * 1024,
	maxTotalFileBytes: 512 * 1024 * 1024,
	maxDepth: 64,
});

/**
 * This primitive supports Darwin and Linux local filesystems. It preserves
 * regular-file bytes, safe symlink text, and POSIX permission bits. It does
 * not preserve ACLs, extended attributes, file flags, ownership, or times.
 * The outer controller-private directory is the confidentiality boundary for
 * metadata that becomes less restrictive when copied without those features.
 */
export const ISOLATED_WORKSPACE_PLATFORM_SCOPE = Object.freeze({
	supportedPlatforms: Object.freeze(["darwin", "linux"] as const),
	preserved: Object.freeze(["regular-file-bytes", "safe-relative-symlink-text", "posix-permission-bits"] as const),
	notPreserved: Object.freeze(["acls", "extended-attributes", "file-flags", "ownership", "timestamps"] as const),
	residuals: Object.freeze([
		"Node does not expose openat directory enumeration; every path boundary is inode-checked before and after operations, and detected changes fail closed, but callers must keep the controller root private.",
		"Capture requires a controller-supplied process-bound quiescence assertion before and after copying.",
		"Recoverable snapshots are sealed with POSIX read-only modes, not a filesystem immutable flag.",
	] as const),
});

export interface IsolatedWorkspaceDirectoryEntry {
	path: string;
	type: "directory";
	mode: number;
}

export interface IsolatedWorkspaceFileEntry {
	path: string;
	type: "file";
	mode: number;
	byteLength: number;
	sha256: string;
}

export interface IsolatedWorkspaceSymlinkEntry {
	path: string;
	type: "symlink";
	mode: number;
	byteLength: number;
	sha256: string;
	linkTarget: string;
}

export type IsolatedWorkspaceManifestEntry =
	| IsolatedWorkspaceDirectoryEntry
	| IsolatedWorkspaceFileEntry
	| IsolatedWorkspaceSymlinkEntry;

export interface IsolatedWorkspaceManifestV1 {
	version: 1;
	algorithm: "sha256";
	entries: IsolatedWorkspaceManifestEntry[];
	totalFileBytes: number;
}

export interface IsolatedWorkspaceManifestEnvelopeV1 {
	manifest: IsolatedWorkspaceManifestV1;
	manifestSha256: string;
}

interface FilesystemIdentity {
	device: string;
	inode: string;
}

export interface IsolatedWriterWorkspaceHandle {
	version: 1;
	readonly artifactDirectory: string;
	readonly workspaceDirectory: string;
	readonly evidenceDirectory: string;
	readonly beforeManifestPath: string;
	readonly beforeManifest: Readonly<IsolatedWorkspaceManifestV1>;
	readonly beforeManifestSha256: string;
}

export type IsolatedWorkspaceChangeKind =
	| "created"
	| "deleted"
	| "type"
	| "mode"
	| "content"
	| "symlink-target";

export interface IsolatedWorkspaceChange {
	path: string;
	kind: IsolatedWorkspaceChangeKind;
	beforeType?: IsolatedWorkspaceManifestEntry["type"];
	afterType?: IsolatedWorkspaceManifestEntry["type"];
}

export interface IsolatedWorkspaceChangeEvidenceV1 {
	version: 1;
	beforeManifestSha256: string;
	afterManifestSha256: string;
	changes: IsolatedWorkspaceChange[];
}

export interface IsolatedWorkspaceChangeResult {
	artifactDirectory: string;
	workspaceDirectory: string;
	recoverableArtifactDirectory: string;
	recoverableArtifactManifestPath: string;
	recoverableArtifactManifestSha256: string;
	afterManifestPath: string;
	diffPath: string;
	afterManifest: IsolatedWorkspaceManifestV1;
	afterManifestSha256: string;
	changes: IsolatedWorkspaceChange[];
	diffSha256: string;
	recoverableArtifactRetained: string;
}

export interface CaptureIsolatedWriterWorkspaceOptions {
	/**
	 * Must fail unless the admitted writer and all of its descendants are
	 * stopped. It is invoked before and after the snapshot copy. The controller
	 * remains responsible for supplying a process-bound assertion.
	 */
	assertQuiescent: () => void | Promise<void>;
}

export interface CreateIsolatedWriterWorkspaceOptions {
	sourceDirectory: string;
	controllerRoot: string;
	destinationName?: string;
	limits?: Partial<IsolatedWorkspaceLimits>;
}

interface ScanBudget {
	entries: number;
	totalFileBytes: number;
}

interface CopyContext {
	sourceRoot: string;
	limits: IsolatedWorkspaceLimits;
	budget: ScanBudget;
	entries: IsolatedWorkspaceManifestEntry[];
	excludeGitControlPaths: boolean;
}

interface HiddenWorkspaceState {
	artifactDirectory: string;
	workspaceDirectory: string;
	evidenceDirectory: string;
	beforeManifestPath: string;
	beforeManifest: IsolatedWorkspaceManifestV1;
	beforeManifestSha256: string;
	limits: IsolatedWorkspaceLimits;
	artifactIdentity: FilesystemIdentity;
	workspaceIdentity: FilesystemIdentity;
	evidenceIdentity: FilesystemIdentity;
	beforeGenerationDirectory: string;
	beforeGenerationIdentity: FilesystemIdentity;
	beforeManifestIdentity: FilesystemIdentity;
}

const WORKSPACE_HANDLES = new WeakMap<object, HiddenWorkspaceState>();

export class IsolatedWorkspaceArtifactRetainedError extends Error {
	readonly artifactDirectory: string;
	readonly failureMarkerPath: string | undefined;

	constructor(message: string, artifactDirectory: string, failureMarkerPath?: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "IsolatedWorkspaceArtifactRetainedError";
		this.artifactDirectory = artifactDirectory;
		this.failureMarkerPath = failureMarkerPath;
	}
}

function codeUnitCompare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function asciiCaseFold(value: string): string {
	return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}

function isGitControlComponent(value: string): boolean {
	return asciiCaseFold(value) === ".git";
}

function modeOf(status: BigIntStats): number {
	return Number(status.mode & 0o7777n);
}

function identityOf(status: BigIntStats): FilesystemIdentity {
	return { device: status.dev.toString(), inode: status.ino.toString() };
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameStableMetadata(left: BigIntStats, right: BigIntStats): boolean {
	return sameIdentity(left, right)
		&& left.mode === right.mode
		&& left.nlink === right.nlink
		&& left.size === right.size
		&& left.mtimeNs === right.mtimeNs
		&& left.ctimeNs === right.ctimeNs;
}

function assertWithin(root: string, candidate: string, label: string): void {
	const pathFromRoot = relative(root, candidate);
	if (pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))) return;
	throw new Error(`${label} escapes its admitted root`);
}

function containsGitControlPath(pathFromRoot: string): boolean {
	return pathFromRoot.split(sep).some(isGitControlComponent);
}

function safeRelativePath(root: string, absolutePath: string): string {
	assertWithin(root, absolutePath, "workspace path");
	const value = relative(root, absolutePath);
	return value === "" ? "." : value.split(sep).join("/");
}

function validateLimits(overrides: Partial<IsolatedWorkspaceLimits> | undefined): IsolatedWorkspaceLimits {
	const limits = { ...DEFAULT_ISOLATED_WORKSPACE_LIMITS, ...overrides };
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`isolated workspace ${name} must be a positive safe integer`);
	}
	if (limits.maxFileBytes > limits.maxTotalFileBytes) {
		throw new Error("isolated workspace maxFileBytes cannot exceed maxTotalFileBytes");
	}
	return limits;
}

function assertSupportedPlatform(): void {
	if (platform !== "darwin" && platform !== "linux") {
		throw new Error(`isolated workspaces are not supported on platform ${platform}`);
	}
}

function validateDestinationName(value: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === "." || value === "..") {
		throw new Error("isolated workspace destinationName must be a single conservative path component");
	}
}

async function bigintLstat(path: string): Promise<BigIntStats> {
	return lstat(path, { bigint: true });
}

async function verifyIdentity(path: string, expected: FilesystemIdentity, label: string): Promise<BigIntStats> {
	const status = await bigintLstat(path);
	if (status.isSymbolicLink() || status.dev.toString() !== expected.device || status.ino.toString() !== expected.inode) {
		throw new Error(`${label} identity changed`);
	}
	return status;
}

async function canonicalDirectory(path: string, label: string): Promise<{ path: string; status: BigIntStats }> {
	const lexicalStatus = await bigintLstat(path);
	if (lexicalStatus.isSymbolicLink() || !lexicalStatus.isDirectory()) {
		throw new Error(`${label} must be an existing non-symlink directory`);
	}
	const canonical = await realpath(path);
	const status = await bigintLstat(canonical);
	if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`${label} must resolve to a directory`);
	if (!sameIdentity(lexicalStatus, status)) throw new Error(`${label} changed during canonicalization`);
	return { path: canonical, status };
}

function addEntry(budget: ScanBudget, limits: IsolatedWorkspaceLimits, fileBytes = 0): void {
	budget.entries += 1;
	if (budget.entries > limits.maxEntries) throw new Error(`isolated workspace exceeds the ${limits.maxEntries}-entry limit`);
	budget.totalFileBytes += fileBytes;
	if (budget.totalFileBytes > limits.maxTotalFileBytes) {
		throw new Error(`isolated workspace exceeds the ${limits.maxTotalFileBytes}-byte total file limit`);
	}
}

function reserveRegularFile(
	budget: ScanBudget,
	limits: IsolatedWorkspaceLimits,
	status: BigIntStats,
	relativePath: string,
): number {
	if (status.size > BigInt(limits.maxFileBytes)) {
		throw new Error(`isolated workspace file exceeds the ${limits.maxFileBytes}-byte limit: ${relativePath}`);
	}
	const byteLength = Number(status.size);
	addEntry(budget, limits, byteLength);
	return byteLength;
}

async function directoryNames(path: string, maximumNames: number): Promise<string[]> {
	if (!Number.isSafeInteger(maximumNames) || maximumNames < 0) throw new Error("invalid bounded directory enumeration limit");
	const names: string[] = [];
	// Node supports Buffer directory names at runtime, but @types/node currently
	// omits "buffer" from the opendir encoding overload.
	const directory = await opendir(path, { encoding: "buffer" } as never);
	for await (const entry of directory) {
		if (names.length >= maximumNames) {
			throw new Error(`isolated workspace directory exceeds its remaining ${maximumNames}-entry allowance`);
		}
		const encoded = entry.name as unknown as Buffer;
		if (!isUtf8(encoded)) throw new Error("isolated workspace filenames must be valid UTF-8");
		names.push(encoded.toString("utf8"));
	}
	return names.sort(codeUnitCompare);
}

async function assertSafeSymlink(root: string, linkPath: string, linkTarget: string): Promise<void> {
	if (isAbsolute(linkTarget)) throw new Error(`absolute symlink target is not admitted: ${safeRelativePath(root, linkPath)}`);
	const lexicalTarget = resolve(dirname(linkPath), linkTarget);
	assertWithin(root, lexicalTarget, `symlink ${safeRelativePath(root, linkPath)}`);
	const targetFromRoot = relative(root, lexicalTarget);
	if (containsGitControlPath(targetFromRoot)) {
		throw new Error(`symlink targets excluded .git control data: ${safeRelativePath(root, linkPath)}`);
	}
	// Never call realpath/open/stat on the link. Existing target components are
	// inspected with lstat only, and a symlink anywhere in the target chain is
	// rejected rather than followed. Missing in-root leaves remain safe dangling
	// links because their text cannot escape the copied workspace.
	const components = targetFromRoot.split(sep).filter(Boolean);
	let current = root;
	for (const [index, component] of components.entries()) {
		current = join(current, component);
		try {
			const status = await bigintLstat(current);
			if (status.isSymbolicLink()) {
				throw new Error(`symlink target chain is not admitted: ${safeRelativePath(root, linkPath)}`);
			}
			if (index < components.length - 1 && !status.isDirectory()) {
				throw new Error(`symlink has a non-directory target prefix: ${safeRelativePath(root, linkPath)}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
			throw error;
		}
	}
}

async function openStableRegularFile(path: string, initial: BigIntStats, label: string) {
	if (initial.nlink > 1n) throw new Error(`hard-linked regular file is not admitted: ${label}`);
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile() || !sameStableMetadata(initial, opened)) {
			throw new Error(`source path changed while opening: ${label}`);
		}
		return { handle, opened };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function copyRegularFile(
	sourcePath: string,
	destinationPath: string,
	initial: BigIntStats,
	relativePath: string,
	limits: IsolatedWorkspaceLimits,
): Promise<IsolatedWorkspaceFileEntry> {
	if (initial.size > BigInt(limits.maxFileBytes)) {
		throw new Error(`isolated workspace file exceeds the ${limits.maxFileBytes}-byte limit: ${relativePath}`);
	}
	const { handle: source, opened } = await openStableRegularFile(sourcePath, initial, relativePath);
	let destination;
	try {
		destination = await open(
			destinationPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			modeOf(initial),
		);
		const digest = createHash("sha256");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let position = 0;
		const admittedByteLength = Number(opened.size);
		while (position < admittedByteLength) {
			const requestedBytes = Math.min(buffer.length, admittedByteLength - position);
			const { bytesRead } = await source.read(buffer, 0, requestedBytes, position);
			if (bytesRead === 0) throw new Error(`source file ended before its admitted size: ${relativePath}`);
			digest.update(buffer.subarray(0, bytesRead));
			let written = 0;
			while (written < bytesRead) {
				const result = await destination.write(buffer, written, bytesRead - written, position + written);
				if (result.bytesWritten === 0) throw new Error(`zero-byte destination write: ${relativePath}`);
				written += result.bytesWritten;
			}
			position += bytesRead;
		}
		const growthProbe = Buffer.allocUnsafe(1);
		const { bytesRead: bytesBeyondAdmission } = await source.read(growthProbe, 0, 1, admittedByteLength);
		if (bytesBeyondAdmission !== 0) throw new Error(`source file grew beyond its admitted size: ${relativePath}`);
		await destination.sync();
		const sourceAfter = await source.stat({ bigint: true });
		if (!sameStableMetadata(opened, sourceAfter) || BigInt(position) !== opened.size) {
			throw new Error(`source file changed while copying: ${relativePath}`);
		}
		const destinationAfter = await destination.stat({ bigint: true });
		if (!destinationAfter.isFile() || destinationAfter.nlink !== 1n || destinationAfter.size !== opened.size) {
			throw new Error(`destination file changed while copying: ${relativePath}`);
		}
		await destination.chmod(modeOf(initial));
		const lexicalDestination = await bigintLstat(destinationPath);
		const finalDestination = await destination.stat({ bigint: true });
		if (!sameIdentity(lexicalDestination, finalDestination)) {
			throw new Error(`destination file identity changed before finalization: ${relativePath}`);
		}
		return {
			path: relativePath,
			type: "file",
			mode: modeOf(initial),
			byteLength: position,
			sha256: digest.digest("hex"),
		};
	} finally {
		await source.close();
		if (destination) await destination.close();
	}
}

async function copyDirectory(context: CopyContext, sourcePath: string, destinationPath: string, depth: number): Promise<void> {
	if (depth > context.limits.maxDepth) {
		throw new Error(`isolated workspace exceeds the ${context.limits.maxDepth}-level depth limit`);
	}
	const initial = await bigintLstat(sourcePath);
	if (!initial.isDirectory() || initial.isSymbolicLink()) {
		throw new Error(`source directory changed type while copying: ${safeRelativePath(context.sourceRoot, sourcePath)}`);
	}
	const directoryHandle = await open(sourcePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	let destinationDirectoryHandle;
	try {
		const opened = await directoryHandle.stat({ bigint: true });
		if (!opened.isDirectory() || !sameStableMetadata(initial, opened)) {
			throw new Error(`source directory changed while opening: ${safeRelativePath(context.sourceRoot, sourcePath)}`);
		}
		const relativeDirectory = safeRelativePath(context.sourceRoot, sourcePath);
		addEntry(context.budget, context.limits);
		context.entries.push({ path: relativeDirectory, type: "directory", mode: modeOf(initial) });
		if (depth > 0) await mkdir(destinationPath, { mode: 0o700 });
		destinationDirectoryHandle = await open(
			destinationPath,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);

		for (const name of await directoryNames(sourcePath, context.limits.maxEntries - context.budget.entries)) {
			// Git control data is excluded without inspecting its type or contents.
			if (context.excludeGitControlPaths && isGitControlComponent(name)) continue;
			const sourceChild = join(sourcePath, name);
			const destinationChild = join(destinationPath, name);
			const status = await bigintLstat(sourceChild);
			const relativeChild = safeRelativePath(context.sourceRoot, sourceChild);
			if (status.isDirectory()) {
				await copyDirectory(context, sourceChild, destinationChild, depth + 1);
			} else if (status.isFile()) {
				reserveRegularFile(context.budget, context.limits, status, relativeChild);
				const entry = await copyRegularFile(sourceChild, destinationChild, status, relativeChild, context.limits);
				context.entries.push(entry);
			} else if (status.isSymbolicLink()) {
				addEntry(context.budget, context.limits);
				const encodedTarget = await readlink(sourceChild, { encoding: "buffer" });
				if (!isUtf8(encodedTarget)) throw new Error(`symlink target must be valid UTF-8: ${relativeChild}`);
				const target = encodedTarget.toString("utf8");
				await assertSafeSymlink(context.sourceRoot, sourceChild, target);
				const afterRead = await bigintLstat(sourceChild);
				if (!afterRead.isSymbolicLink() || !sameStableMetadata(status, afterRead)) {
					throw new Error(`source symlink changed while copying: ${relativeChild}`);
				}
				await symlink(target, destinationChild);
				const targetBytes = Buffer.from(target, "utf8");
				context.entries.push({
					path: relativeChild,
					type: "symlink",
					mode: modeOf(status),
					byteLength: targetBytes.byteLength,
					sha256: createHash("sha256").update(targetBytes).digest("hex"),
					linkTarget: target,
				});
			} else {
				throw new Error(`special filesystem entry is not admitted: ${relativeChild}`);
			}
		}
		const after = await bigintLstat(sourcePath);
		const openedAfter = await directoryHandle.stat({ bigint: true });
		if (!sameStableMetadata(initial, after) || !sameStableMetadata(initial, openedAfter)) {
			throw new Error(`source directory changed while copying: ${relativeDirectory}`);
		}
		await destinationDirectoryHandle.chmod(modeOf(initial));
		const lexicalDestination = await bigintLstat(destinationPath);
		const finalDestination = await destinationDirectoryHandle.stat({ bigint: true });
		if (!sameIdentity(lexicalDestination, finalDestination)) {
			throw new Error(`destination directory identity changed before finalization: ${relativeDirectory}`);
		}
	} finally {
		await directoryHandle.close();
		if (destinationDirectoryHandle) await destinationDirectoryHandle.close();
	}
}

function manifestFromEntries(entries: IsolatedWorkspaceManifestEntry[], totalFileBytes: number): IsolatedWorkspaceManifestV1 {
	entries.sort((left, right) => codeUnitCompare(left.path, right.path));
	return { version: 1, algorithm: "sha256", entries, totalFileBytes };
}

export function serializeIsolatedWorkspaceManifest(manifest: IsolatedWorkspaceManifestV1): string {
	return `${JSON.stringify(manifest)}\n`;
}

export function isolatedWorkspaceManifestDigest(manifest: IsolatedWorkspaceManifestV1): string {
	return createHash("sha256").update(serializeIsolatedWorkspaceManifest(manifest)).digest("hex");
}

async function scanRegularFile(
	path: string,
	status: BigIntStats,
	relativePath: string,
	limits: IsolatedWorkspaceLimits,
): Promise<IsolatedWorkspaceFileEntry> {
	if (status.size > BigInt(limits.maxFileBytes)) {
		throw new Error(`isolated workspace file exceeds the ${limits.maxFileBytes}-byte limit: ${relativePath}`);
	}
	const { handle, opened } = await openStableRegularFile(path, status, relativePath);
	try {
		const digest = createHash("sha256");
		let byteLength = 0;
		const admittedByteLength = Number(opened.size);
		const buffer = Buffer.allocUnsafe(64 * 1024);
		while (byteLength < admittedByteLength) {
			const requestedBytes = Math.min(buffer.length, admittedByteLength - byteLength);
			const { bytesRead } = await handle.read(buffer, 0, requestedBytes, byteLength);
			if (bytesRead === 0) throw new Error(`file ended before its admitted size: ${relativePath}`);
			digest.update(buffer.subarray(0, bytesRead));
			byteLength += bytesRead;
		}
		const growthProbe = Buffer.allocUnsafe(1);
		const { bytesRead: bytesBeyondAdmission } = await handle.read(growthProbe, 0, 1, admittedByteLength);
		if (bytesBeyondAdmission !== 0) throw new Error(`file grew beyond its admitted size: ${relativePath}`);
		const after = await handle.stat({ bigint: true });
		if (!sameStableMetadata(opened, after) || BigInt(byteLength) !== opened.size) {
			throw new Error(`file changed while hashing: ${relativePath}`);
		}
		return { path: relativePath, type: "file", mode: modeOf(status), byteLength, sha256: digest.digest("hex") };
	} finally {
		await handle.close();
	}
}

async function scanTree(
	root: string,
	limits: IsolatedWorkspaceLimits,
	options: { excludeGitControlPaths?: boolean } = {},
): Promise<IsolatedWorkspaceManifestV1> {
	const entries: IsolatedWorkspaceManifestEntry[] = [];
	const budget: ScanBudget = { entries: 0, totalFileBytes: 0 };

	async function visit(path: string, depth: number): Promise<void> {
		if (depth > limits.maxDepth) throw new Error(`isolated workspace exceeds the ${limits.maxDepth}-level depth limit`);
		const initial = await bigintLstat(path);
		if (!initial.isDirectory() || initial.isSymbolicLink()) {
			throw new Error(`workspace directory changed type while scanning: ${safeRelativePath(root, path)}`);
		}
		const directoryHandle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			const opened = await directoryHandle.stat({ bigint: true });
			if (!sameStableMetadata(initial, opened)) throw new Error(`directory changed while opening: ${safeRelativePath(root, path)}`);
			addEntry(budget, limits);
			entries.push({ path: safeRelativePath(root, path), type: "directory", mode: modeOf(initial) });
			for (const name of await directoryNames(path, limits.maxEntries - budget.entries)) {
				if (options.excludeGitControlPaths === true && isGitControlComponent(name)) continue;
				const child = join(path, name);
				const status = await bigintLstat(child);
				const relativeChild = safeRelativePath(root, child);
				if (status.isDirectory()) {
					await visit(child, depth + 1);
				} else if (status.isFile()) {
					reserveRegularFile(budget, limits, status, relativeChild);
					const entry = await scanRegularFile(child, status, relativeChild, limits);
					entries.push(entry);
				} else if (status.isSymbolicLink()) {
					addEntry(budget, limits);
					const encodedTarget = await readlink(child, { encoding: "buffer" });
					if (!isUtf8(encodedTarget)) throw new Error(`symlink target must be valid UTF-8: ${relativeChild}`);
					const target = encodedTarget.toString("utf8");
					await assertSafeSymlink(root, child, target);
					const afterRead = await bigintLstat(child);
					if (!afterRead.isSymbolicLink() || !sameStableMetadata(status, afterRead)) {
						throw new Error(`symlink changed while scanning: ${relativeChild}`);
					}
					const targetBytes = Buffer.from(target, "utf8");
					entries.push({
						path: relativeChild,
						type: "symlink",
						mode: modeOf(status),
						byteLength: targetBytes.byteLength,
						sha256: createHash("sha256").update(targetBytes).digest("hex"),
						linkTarget: target,
					});
				} else {
					throw new Error(`special filesystem entry is not admitted: ${relativeChild}`);
				}
			}
			const after = await bigintLstat(path);
			const openedAfter = await directoryHandle.stat({ bigint: true });
			if (!sameStableMetadata(initial, after) || !sameStableMetadata(initial, openedAfter)) {
				throw new Error(`directory changed while scanning: ${safeRelativePath(root, path)}`);
			}
		} finally {
			await directoryHandle.close();
		}
	}

	await visit(root, 0);
	return manifestFromEntries(entries, budget.totalFileBytes);
}

function manifestsEqual(left: IsolatedWorkspaceManifestV1, right: IsolatedWorkspaceManifestV1): boolean {
	return serializeIsolatedWorkspaceManifest(left) === serializeIsolatedWorkspaceManifest(right);
}

async function writeCreateOnlyJson(path: string, value: unknown): Promise<FilesystemIdentity> {
	const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
	try {
		await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
		await handle.sync();
		await handle.chmod(0o400);
		const opened = await handle.stat({ bigint: true });
		const lexical = await bigintLstat(path);
		if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(opened, lexical)) {
			throw new Error("create-only evidence identity changed during publication");
		}
		return identityOf(opened);
	} finally {
		await handle.close();
	}
}

async function createPrivateDirectory(path: string): Promise<FilesystemIdentity> {
	await mkdir(path, { mode: 0o700 });
	const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		await handle.chmod(0o700);
		const opened = await handle.stat({ bigint: true });
		const lexical = await bigintLstat(path);
		if (!opened.isDirectory() || !sameIdentity(opened, lexical)) {
			throw new Error("private directory identity changed during creation");
		}
		return identityOf(opened);
	} finally {
		await handle.close();
	}
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

function errorText(error: unknown): string {
	const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return value.slice(0, 2_000);
}

async function publishFailureMarker(
	directory: string,
	phase: "creation" | "capture",
	error: unknown,
): Promise<{ path: string; identity: FilesystemIdentity }> {
	const marker = join(directory, `${phase}-failure-${randomUUID()}.json`);
	const identity = await writeCreateOnlyJson(marker, {
		version: 1,
		phase,
		status: "failed-artifact-retained",
		error: errorText(error),
	});
	return { path: marker, identity };
}

async function readNoFollow(path: string, maxBytes: number): Promise<Buffer> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const status = await handle.stat({ bigint: true });
		if (!status.isFile() || status.nlink !== 1n || status.size > BigInt(maxBytes)) {
			throw new Error("isolated workspace evidence must be a bounded, singly-linked regular file");
		}
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

export async function createIsolatedWriterWorkspace(
	options: CreateIsolatedWriterWorkspaceOptions,
): Promise<IsolatedWriterWorkspaceHandle> {
	assertSupportedPlatform();
	const limits = deepFreeze(validateLimits(options.limits));
	const source = await canonicalDirectory(options.sourceDirectory, "sourceDirectory");
	const controller = await canonicalDirectory(options.controllerRoot, "controllerRoot");
	const controllerFromSource = relative(source.path, controller.path);
	if (controllerFromSource === "" || (!controllerFromSource.startsWith(`..${sep}`) && controllerFromSource !== ".." && !isAbsolute(controllerFromSource))) {
		throw new Error("controllerRoot must not be inside sourceDirectory");
	}
	const destinationName = options.destinationName ?? `writer-${randomUUID()}`;
	validateDestinationName(destinationName);
	const artifactDirectory = join(controller.path, destinationName);
	const workspaceDirectory = join(artifactDirectory, WORKSPACE_DIRECTORY_NAME);
	const evidenceDirectory = join(artifactDirectory, EVIDENCE_DIRECTORY_NAME);
	let artifactCreated = false;
	let artifactIdentity: FilesystemIdentity | undefined;
	try {
		artifactIdentity = await createPrivateDirectory(artifactDirectory);
		artifactCreated = true;
		const controllerAfterCreate = await bigintLstat(controller.path);
		if (!sameIdentity(controller.status, controllerAfterCreate)) throw new Error("controllerRoot identity changed during destination creation");
		const artifactStatus = await bigintLstat(artifactDirectory);
		if (!artifactStatus.isDirectory() || artifactStatus.isSymbolicLink()) throw new Error("isolated workspace destination is not a new directory");
		if (await realpath(artifactDirectory) !== artifactDirectory) throw new Error("isolated workspace destination changed during creation");
		if (artifactStatus.dev.toString() !== artifactIdentity.device || artifactStatus.ino.toString() !== artifactIdentity.inode) {
			throw new Error("isolated workspace destination identity changed during creation");
		}
		const workspaceIdentity = await createPrivateDirectory(workspaceDirectory);
		const evidenceIdentity = await createPrivateDirectory(evidenceDirectory);
		const beforeGenerationDirectory = join(evidenceDirectory, `before-${randomUUID()}`);
		const beforeGenerationIdentity = await createPrivateDirectory(beforeGenerationDirectory);

		const copyContext: CopyContext = {
			sourceRoot: source.path,
			limits,
			budget: { entries: 0, totalFileBytes: 0 },
			entries: [],
			excludeGitControlPaths: true,
		};
		await copyDirectory(copyContext, source.path, workspaceDirectory, 0);
		const copiedManifest = manifestFromEntries(copyContext.entries, copyContext.budget.totalFileBytes);
		const stableSourceManifest = await scanTree(source.path, limits, { excludeGitControlPaths: true });
		if (!manifestsEqual(copiedManifest, stableSourceManifest)) {
			throw new Error("sourceDirectory changed while constructing the isolated workspace");
		}
		const destinationManifest = await scanTree(workspaceDirectory, limits);
		if (!manifestsEqual(copiedManifest, destinationManifest)) {
			throw new Error("isolated workspace copy does not match the stable source manifest");
		}
		const sourceAfter = await bigintLstat(source.path);
		if (!sameStableMetadata(source.status, sourceAfter)) throw new Error("sourceDirectory identity or metadata changed during copy");

		const frozenBeforeManifest = deepFreeze(destinationManifest);
		const beforeManifestSha256 = isolatedWorkspaceManifestDigest(frozenBeforeManifest);
		const beforeManifestPath = join(beforeGenerationDirectory, "before-manifest.json");
		await verifyIdentity(artifactDirectory, artifactIdentity, "isolated artifact directory");
		await verifyIdentity(workspaceDirectory, workspaceIdentity, "isolated workspace directory");
		await verifyIdentity(evidenceDirectory, evidenceIdentity, "isolated evidence directory");
		await verifyIdentity(beforeGenerationDirectory, beforeGenerationIdentity, "before evidence generation");
		const beforeManifestIdentity = await writeCreateOnlyJson(beforeManifestPath, {
			manifest: frozenBeforeManifest,
			manifestSha256: beforeManifestSha256,
		} satisfies IsolatedWorkspaceManifestEnvelopeV1);
		await verifyIdentity(artifactDirectory, artifactIdentity, "isolated artifact directory");
		await verifyIdentity(workspaceDirectory, workspaceIdentity, "isolated workspace directory");
		await verifyIdentity(evidenceDirectory, evidenceIdentity, "isolated evidence directory");
		await verifyIdentity(beforeGenerationDirectory, beforeGenerationIdentity, "before evidence generation");
		await verifyIdentity(beforeManifestPath, beforeManifestIdentity, "before manifest");

		const handle = deepFreeze<IsolatedWriterWorkspaceHandle>({
			version: 1,
			artifactDirectory,
			workspaceDirectory,
			evidenceDirectory,
			beforeManifestPath,
			beforeManifest: frozenBeforeManifest,
			beforeManifestSha256,
		});
		WORKSPACE_HANDLES.set(handle, {
			artifactDirectory,
			workspaceDirectory,
			evidenceDirectory,
			beforeManifestPath,
			beforeManifest: frozenBeforeManifest,
			beforeManifestSha256,
			limits,
			artifactIdentity,
			workspaceIdentity,
			evidenceIdentity,
			beforeGenerationDirectory,
			beforeGenerationIdentity,
			beforeManifestIdentity,
		});
		return handle;
	} catch (error) {
		if (!artifactCreated) throw error;
		const failureMarkerPath = await (async () => {
			if (!artifactIdentity) return undefined;
			const controllerNow = await bigintLstat(controller.path);
			if (!sameIdentity(controller.status, controllerNow)) return undefined;
			await verifyIdentity(artifactDirectory, artifactIdentity, "isolated artifact directory");
			const marker = await publishFailureMarker(artifactDirectory, "creation", error);
			await verifyIdentity(artifactDirectory, artifactIdentity, "isolated artifact directory");
			await verifyIdentity(marker.path, marker.identity, "creation failure marker");
			return marker.path;
		})().catch(() => undefined);
		throw new IsolatedWorkspaceArtifactRetainedError(
			`isolated workspace creation failed; private partial artifact retained at ${artifactDirectory}: ${errorText(error)}`,
			artifactDirectory,
			failureMarkerPath,
			{ cause: error },
		);
	}
}

function buildChanges(
	before: IsolatedWorkspaceManifestV1,
	after: IsolatedWorkspaceManifestV1,
): IsolatedWorkspaceChange[] {
	const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
	const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
	const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort(codeUnitCompare);
	const changes: IsolatedWorkspaceChange[] = [];
	for (const path of paths) {
		const beforeEntry = beforeByPath.get(path);
		const afterEntry = afterByPath.get(path);
		if (!beforeEntry && afterEntry) {
			changes.push({ path, kind: "created", afterType: afterEntry.type });
			continue;
		}
		if (beforeEntry && !afterEntry) {
			changes.push({ path, kind: "deleted", beforeType: beforeEntry.type });
			continue;
		}
		if (!beforeEntry || !afterEntry) continue;
		if (beforeEntry.type !== afterEntry.type) {
			changes.push({ path, kind: "type", beforeType: beforeEntry.type, afterType: afterEntry.type });
			continue;
		}
		if (beforeEntry.mode !== afterEntry.mode) {
			changes.push({ path, kind: "mode", beforeType: beforeEntry.type, afterType: afterEntry.type });
		}
		if (beforeEntry.type === "file" && afterEntry.type === "file"
			&& (beforeEntry.byteLength !== afterEntry.byteLength || beforeEntry.sha256 !== afterEntry.sha256)) {
			changes.push({ path, kind: "content", beforeType: "file", afterType: "file" });
		}
		if (beforeEntry.type === "symlink" && afterEntry.type === "symlink"
			&& (beforeEntry.linkTarget !== afterEntry.linkTarget
				|| beforeEntry.byteLength !== afterEntry.byteLength
				|| beforeEntry.sha256 !== afterEntry.sha256)) {
			changes.push({ path, kind: "symlink-target", beforeType: "symlink", afterType: "symlink" });
		}
	}
	return changes;
}

async function verifyHiddenBoundary(state: HiddenWorkspaceState): Promise<void> {
	await verifyIdentity(state.artifactDirectory, state.artifactIdentity, "isolated artifact directory");
	await verifyIdentity(state.workspaceDirectory, state.workspaceIdentity, "isolated workspace directory");
	await verifyIdentity(state.evidenceDirectory, state.evidenceIdentity, "isolated evidence directory");
	await verifyIdentity(state.beforeGenerationDirectory, state.beforeGenerationIdentity, "before evidence generation");
	await verifyIdentity(state.beforeManifestPath, state.beforeManifestIdentity, "before manifest");
	const expectedEnvelope = `${JSON.stringify({
		manifest: state.beforeManifest,
		manifestSha256: state.beforeManifestSha256,
	} satisfies IsolatedWorkspaceManifestEnvelopeV1)}\n`;
	const storedEnvelope = await readNoFollow(state.beforeManifestPath, Math.max(Buffer.byteLength(expectedEnvelope), 1));
	if (!storedEnvelope.equals(Buffer.from(expectedEnvelope))) throw new Error("stored before manifest evidence changed");
	await verifyIdentity(state.artifactDirectory, state.artifactIdentity, "isolated artifact directory");
	await verifyIdentity(state.workspaceDirectory, state.workspaceIdentity, "isolated workspace directory");
	await verifyIdentity(state.evidenceDirectory, state.evidenceIdentity, "isolated evidence directory");
	await verifyIdentity(state.beforeGenerationDirectory, state.beforeGenerationIdentity, "before evidence generation");
	await verifyIdentity(state.beforeManifestPath, state.beforeManifestIdentity, "before manifest");
}

async function makeSnapshotReadOnly(root: string, limits: IsolatedWorkspaceLimits): Promise<void> {
	async function visit(path: string): Promise<void> {
		const status = await bigintLstat(path);
		if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("snapshot directory changed before sealing");
		const directoryHandle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			const opened = await directoryHandle.stat({ bigint: true });
			if (!sameIdentity(status, opened)) throw new Error("snapshot directory identity changed before sealing");
			for (const name of await directoryNames(path, limits.maxEntries)) {
				const child = join(path, name);
				const childStatus = await bigintLstat(child);
				if (childStatus.isDirectory()) {
					await visit(child);
				} else if (childStatus.isFile()) {
					if (childStatus.nlink !== 1n) throw new Error("snapshot hard link appeared before sealing");
					const handle = await open(child, constants.O_RDONLY | constants.O_NOFOLLOW);
					try {
						const openedChild = await handle.stat({ bigint: true });
						if (!sameIdentity(childStatus, openedChild)) throw new Error("snapshot file identity changed before sealing");
						await handle.chmod(0o400);
						const lexicalChild = await bigintLstat(child);
						if (!sameIdentity(lexicalChild, openedChild)) throw new Error("snapshot file identity changed while sealing");
					} finally {
						await handle.close();
					}
				} else if (!childStatus.isSymbolicLink()) {
					throw new Error("snapshot special entry appeared before sealing");
				}
			}
			await directoryHandle.chmod(0o500);
			const lexical = await bigintLstat(path);
			if (!sameIdentity(lexical, opened)) throw new Error("snapshot directory identity changed while sealing");
		} finally {
			await directoryHandle.close();
		}
	}
	await visit(root);
}

export async function captureIsolatedWriterWorkspaceChanges(
	workspace: IsolatedWriterWorkspaceHandle,
	options: CaptureIsolatedWriterWorkspaceOptions,
): Promise<IsolatedWorkspaceChangeResult> {
	const state = WORKSPACE_HANDLES.get(workspace as object);
	if (!state || workspace.version !== 1) throw new Error("foreign or forged isolated writer workspace handle");
	if (!options || typeof options.assertQuiescent !== "function") {
		throw new Error("capture requires an explicit writer quiescence assertion");
	}
	let generationDirectory: string | undefined;
	let generationIdentity: FilesystemIdentity | undefined;
	try {
		await verifyHiddenBoundary(state);
		await options.assertQuiescent();
		await verifyHiddenBoundary(state);

		generationDirectory = join(state.evidenceDirectory, `capture-${randomUUID()}`);
		generationIdentity = await createPrivateDirectory(generationDirectory);
		await verifyHiddenBoundary(state);
		await verifyIdentity(generationDirectory, generationIdentity, "capture evidence generation");

		const snapshotDirectory = join(generationDirectory, "snapshot");
		const snapshotIdentity = await createPrivateDirectory(snapshotDirectory);
		const copyContext: CopyContext = {
			sourceRoot: state.workspaceDirectory,
			limits: state.limits,
			budget: { entries: 0, totalFileBytes: 0 },
			entries: [],
			excludeGitControlPaths: false,
		};
		await copyDirectory(copyContext, state.workspaceDirectory, snapshotDirectory, 0);
		const afterManifest = manifestFromEntries(copyContext.entries, copyContext.budget.totalFileBytes);
		const stableWorkspaceManifest = await scanTree(state.workspaceDirectory, state.limits);
		if (!manifestsEqual(afterManifest, stableWorkspaceManifest)) {
			throw new Error("writer workspace changed while constructing the recoverable snapshot");
		}
		const preservedSnapshotManifest = await scanTree(snapshotDirectory, state.limits);
		if (!manifestsEqual(afterManifest, preservedSnapshotManifest)) {
			throw new Error("recoverable snapshot does not match the quiescent writer workspace");
		}
		await options.assertQuiescent();
		await verifyHiddenBoundary(state);
		await verifyIdentity(generationDirectory, generationIdentity, "capture evidence generation");
		await verifyIdentity(snapshotDirectory, snapshotIdentity, "recoverable snapshot directory");

		await makeSnapshotReadOnly(snapshotDirectory, state.limits);
		const recoverableArtifactManifest = await scanTree(snapshotDirectory, state.limits);
		const recoverableArtifactManifestSha256 = isolatedWorkspaceManifestDigest(recoverableArtifactManifest);
		const afterManifestSha256 = isolatedWorkspaceManifestDigest(afterManifest);
		const changes = buildChanges(state.beforeManifest, afterManifest);
		const changeEvidence: IsolatedWorkspaceChangeEvidenceV1 = {
			version: 1,
			beforeManifestSha256: state.beforeManifestSha256,
			afterManifestSha256,
			changes,
		};
		const diffSha256 = createHash("sha256").update(`${JSON.stringify(changeEvidence)}\n`).digest("hex");
		const afterManifestPath = join(generationDirectory, "after-manifest.json");
		const recoverableArtifactManifestPath = join(generationDirectory, "snapshot-manifest.json");
		const diffPath = join(generationDirectory, "diff.json");

		for (const publication of [
			{
				path: afterManifestPath,
				value: { manifest: afterManifest, manifestSha256: afterManifestSha256 },
			},
			{
				path: recoverableArtifactManifestPath,
				value: { manifest: recoverableArtifactManifest, manifestSha256: recoverableArtifactManifestSha256 },
			},
			{
				path: diffPath,
				value: { evidence: changeEvidence, diffSha256 },
			},
		] as const) {
			await verifyHiddenBoundary(state);
			await verifyIdentity(generationDirectory, generationIdentity, "capture evidence generation");
			await verifyIdentity(snapshotDirectory, snapshotIdentity, "recoverable snapshot directory");
			const publishedIdentity = await writeCreateOnlyJson(publication.path, publication.value);
			await verifyHiddenBoundary(state);
			await verifyIdentity(generationDirectory, generationIdentity, "capture evidence generation");
			await verifyIdentity(snapshotDirectory, snapshotIdentity, "recoverable snapshot directory");
			await verifyIdentity(publication.path, publishedIdentity, "capture evidence file");
		}

		return deepFreeze({
			artifactDirectory: state.artifactDirectory,
			workspaceDirectory: state.workspaceDirectory,
			recoverableArtifactDirectory: snapshotDirectory,
			recoverableArtifactManifestPath,
			recoverableArtifactManifestSha256,
			afterManifestPath,
			diffPath,
			afterManifest,
			afterManifestSha256,
			changes,
			diffSha256,
			recoverableArtifactRetained: snapshotDirectory,
		});
	} catch (error) {
		let failureMarkerPath: string | undefined;
		if (generationDirectory && generationIdentity) {
			failureMarkerPath = await (async () => {
				await verifyHiddenBoundary(state);
				await verifyIdentity(generationDirectory as string, generationIdentity as FilesystemIdentity, "capture evidence generation");
				const marker = await publishFailureMarker(generationDirectory as string, "capture", error);
				await verifyHiddenBoundary(state);
				await verifyIdentity(generationDirectory as string, generationIdentity as FilesystemIdentity, "capture evidence generation");
				await verifyIdentity(marker.path, marker.identity, "capture failure marker");
				return marker.path;
			})().catch(() => undefined);
		}
		throw new IsolatedWorkspaceArtifactRetainedError(
			`isolated workspace capture failed; private artifact retained at ${state.artifactDirectory}: ${errorText(error)}`,
			state.artifactDirectory,
			failureMarkerPath,
			{ cause: error },
		);
	}
}
