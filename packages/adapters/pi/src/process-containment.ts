import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

import { piCredentialClientSource } from "./credential-broker.js";

const DARWIN_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const DARWIN_SYSTEM_PROFILE = "/System/Library/Sandbox/Profiles/system.sb";
export const PI_DARWIN_SEATBELT_SHA256 = "8290e4be7387a0df83cd1559e86afd880464f269450573d012795761fe298f16";
export const PI_DARWIN_SYSTEM_PROFILE_SHA256 = "1b2c4487f32fba48f29ba871bd1fec4f8d74af9543074c8805c3bc7094b9846f";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PACKAGE_TREE_ENTRIES = 50_000;
const MAX_PACKAGE_TREE_BYTES = 512 * 1024 * 1024;
const MAX_PACKAGE_FILE_BYTES = 64 * 1024 * 1024;

export interface PiProcessContainmentInspection {
	available: boolean;
	kind?: "darwin-seatbelt";
	command?: string;
	boundarySha256?: string;
	systemProfilePath?: string;
	systemProfileSha256?: string;
	mechanismSha256?: string;
	notice: string;
}

interface CanonicalDirectory {
	realpath: string;
	device: string;
	inode: string;
}

interface CanonicalReadPath {
	policyPath: string;
	realpath: string;
	type: "directory" | "file" | "symlink";
	device: string;
	inode: string;
}

export interface PiPackageTreeLinkEvidence {
	path: string;
	linkText: string;
	resolvedTargetPath: string;
	resolvedTargetType: "directory" | "file";
	resolvedTargetSha256: string;
}

export interface PiPackageTreeInspection {
	rootPath: string;
	rootDevice: string;
	rootInode: string;
	rootMode: number;
	sha256: string;
	entries: number;
	bytes: number;
	links: readonly PiPackageTreeLinkEvidence[];
}

interface PiPackageTreeStaging {
	source: Readonly<PiPackageTreeInspection>;
	staged: Readonly<PiPackageTreeInspection>;
	executableRelativePath: string;
	executablePath: string;
	executableSha256: string;
}

export interface PiProcessContainmentLaunch {
	version: 1;
	kind: "darwin-seatbelt";
	command: string;
	argsPrefix: readonly string[];
	mechanismSha256: string;
	boundarySha256: string;
	systemProfilePath: string;
	systemProfileSha256: string;
	profilePath: string;
	profileSha256: string;
	evidencePath: string;
	evidenceSha256: string;
	workspace: CanonicalDirectory;
	excludedPaths: readonly string[];
	controllerRoot: CanonicalDirectory;
	writableRuntime: CanonicalDirectory;
	readPaths: readonly CanonicalReadPath[];
	executablePath: string;
	executableSha256: string;
	sourceExecutableSha256: string;
	protectedRouterPath: string;
	protectedRouterSha256: string;
	sourceProtectedRouterSha256: string;
	routeEnforcementSha256: string;
	packageTree?: Readonly<PiPackageTreeStaging>;
	credentialBroker?: Readonly<{
		contractSha256: string;
		socketPath: string;
		socketDirectory: string;
		socketDirectoryDevice: string;
		socketDirectoryInode: string;
		socketDevice: string;
		socketInode: string;
		credentialSourcePath: string;
		credentialSourceSha256: string;
		stagedCredentialSourcePath: string;
		stagedCredentialSourceSha256: string;
		clientPath: string;
		clientSha256: string;
		agentDirectory: string;
		settingsPath: string;
		settingsSourceSha256: string;
		settingsSha256: string;
		modelsPath: string;
		modelsSourceSha256: string;
		modelsSha256: string;
		grepPath: string;
		grepSourceSha256: string;
		grepSha256: string;
		findPath: string;
		findSourceSha256: string;
		findSha256: string;
	}>;
}

export interface PiCredentialBrokerStaging {
	contractSha256: string;
	socketPath: string;
	socketDirectory: string;
	socketDirectoryDevice: string;
	socketDirectoryInode: string;
	socketDevice: string;
	socketInode: string;
	credentialHelper: string;
	credentialHelperReference: string;
	credentialHelperSha256: string;
	stagedCredentialHelper: string;
	stagedCredentialHelperSha256: string;
	nodeInterpreter: string;
	harnessExecutable: string;
	harnessExecutableSha256: string;
	harnessPackageRoot: string;
	harnessPackageRootDevice: string;
	harnessPackageRootInode: string;
	harnessPackageTreeSha256: string;
	harnessPackageTreeEntries: number;
	harnessPackageTreeBytes: number;
	agentSettings: string;
	agentSettingsSha256: string;
	agentModels: string;
	agentModelsSha256: string;
	provider: string;
	model: string;
	reasoning: string;
	grepExecutable: string;
	grepExecutableSha256: string;
	findExecutable: string;
	findExecutableSha256: string;
}

export interface PiProcessContainmentProvider {
	inspect(): Promise<Readonly<PiProcessContainmentInspection>>;
	create(input: {
		inspection: Readonly<PiProcessContainmentInspection>;
		workspaceRoot: string;
		excludedPaths: readonly string[];
		controllerRoot: string;
		writableRuntime: string;
		readPaths: readonly string[];
		executable: string;
		executableSha256: string;
		protectedRouter: string;
		protectedRouterSha256: string;
		routeEnforcementSha256: string;
		credentialBroker?: Readonly<PiCredentialBrokerStaging>;
	}): Promise<Readonly<PiProcessContainmentLaunch>>;
	verify(launch: Readonly<PiProcessContainmentLaunch>): Promise<void>;
}

function stableMetadata(before: BigIntStats, after: BigIntStats): boolean {
	return before.dev === after.dev
		&& before.ino === after.ino
		&& before.mode === after.mode
		&& before.size === after.size
		&& before.mtimeNs === after.mtimeNs
		&& before.ctimeNs === after.ctimeNs;
}

function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function mechanismSha256(boundarySha256: string, systemProfileSha256: string): string {
	return createHash("sha256")
		.update("pi-darwin-seatbelt-process-boundary-v1\0")
		.update(boundarySha256)
		.update("\0")
		.update(systemProfileSha256)
		.digest("hex");
}

export function piDispatchEnforcementSha256(routeEnforcementSha256: string, containmentSha256: string): string {
	if (!SHA256_PATTERN.test(routeEnforcementSha256) || !SHA256_PATTERN.test(containmentSha256)) {
		throw new Error("Pi dispatch enforcement digest evidence is invalid");
	}
	return createHash("sha256")
		.update("pi-read-only-dispatch-enforcement-v2\0")
		.update(routeEnforcementSha256)
		.update("\0")
		.update(containmentSha256)
		.digest("hex");
}

async function sha256StableRegularFile(path: string): Promise<string> {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const handle = await open(path, constants.O_RDONLY | noFollow);
	try {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile()) throw new Error(`Pi containment evidence is not a regular file: ${path}`);
		const hash = createHash("sha256");
		await new Promise<void>((resolveHash, rejectHash) => {
			const stream = handle.createReadStream({ autoClose: false });
			stream.on("data", chunk => hash.update(chunk));
			stream.once("error", rejectHash);
			stream.once("end", resolveHash);
		});
		const [afterHandle, afterPath] = await Promise.all([
			handle.stat({ bigint: true }),
			lstat(path, { bigint: true }),
		]);
		if (!stableMetadata(before, afterHandle) || !stableMetadata(before, afterPath) || afterPath.isSymbolicLink()) {
			throw new Error(`Pi containment evidence changed while it was hashed: ${path}`);
		}
		return hash.digest("hex");
	} finally {
		await handle.close();
	}
}

type PiPackageTreeBaseEntry =
	| { path: string; type: "directory"; mode: number }
	| { path: string; type: "file"; mode: number; bytes: number; sha256: string }
	| { path: string; type: "symlink"; linkText: string; resolvedTargetPath: string; resolvedTargetType: "directory" | "file" };

interface PiPackageTreeLimits {
	maxEntries?: number;
	maxBytes?: number;
	maxFileBytes?: number;
}

function boundedPackageLimit(value: number | undefined, fallback: number, label: string): number {
	const selected = value ?? fallback;
	if (!Number.isSafeInteger(selected) || selected < 1 || selected > fallback) {
		throw new Error(`Pi package tree ${label} must be a positive integer no greater than ${fallback}`);
	}
	return selected;
}

function packageRelativePath(root: string, candidate: string): string {
	const path = relative(root, candidate).split(sep).join("/");
	if (!path || path === ".." || path.startsWith("../") || isAbsolute(path)) {
		throw new Error("Pi package tree target must stay strictly inside its canonical root");
	}
	return path;
}

function packageSubtreeSha256(entries: readonly PiPackageTreeBaseEntry[], target: string): string {
	const subtree = entries.filter(entry => entry.path === target || entry.path.startsWith(`${target}/`));
	if (subtree.length === 0) throw new Error("Pi package symlink target is absent from the inspected tree");
	return createHash("sha256")
		.update("pi-package-subtree-v1\0")
		.update(JSON.stringify(subtree))
		.digest("hex");
}

export async function inspectPiPackageTree(
	rootPath: string,
	limits: Readonly<PiPackageTreeLimits> = {},
): Promise<Readonly<PiPackageTreeInspection>> {
	const maxEntries = boundedPackageLimit(limits.maxEntries, MAX_PACKAGE_TREE_ENTRIES, "entry limit");
	const maxBytes = boundedPackageLimit(limits.maxBytes, MAX_PACKAGE_TREE_BYTES, "byte limit");
	const maxFileBytes = boundedPackageLimit(limits.maxFileBytes, MAX_PACKAGE_FILE_BYTES, "file-byte limit");
	if (typeof constants.O_NOFOLLOW !== "number") throw new Error("Pi package staging requires O_NOFOLLOW support");
	const requestedRoot = resolve(rootPath);
	const rootBefore = await lstat(requestedRoot, { bigint: true });
	const expectedUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : rootBefore.uid;
	if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory() || rootBefore.uid !== expectedUid
		|| (rootBefore.mode & 0o022n) !== 0n) {
		throw new Error("Pi package root must be a caller-owned non-writable-by-others directory");
	}
	const root = await realpath(requestedRoot);
	const rootCanonical = await lstat(root, { bigint: true });
	if (!stableMetadata(rootBefore, rootCanonical) || await realpath(requestedRoot) !== root) {
		throw new Error("Pi package root changed while it was resolved");
	}

	const baseEntries: PiPackageTreeBaseEntry[] = [];
	let entryCount = 0;
	let totalBytes = 0;
	const admitEntry = (): void => {
		entryCount += 1;
		if (entryCount > maxEntries) throw new Error("Pi package tree exceeds its entry limit");
	};
	const walk = async (directory: string, prefix: string): Promise<void> => {
		const directoryBefore = await lstat(directory, { bigint: true });
		if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory() || directoryBefore.uid !== expectedUid
			|| (directoryBefore.mode & 0o022n) !== 0n) {
			throw new Error("Pi package tree contains an unsafe directory");
		}
		const children = (await readdir(directory, { withFileTypes: true }))
			.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
		for (const child of children) {
			const path = join(directory, child.name);
			const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
			admitEntry();
			const before = await lstat(path, { bigint: true });
			if (before.uid !== expectedUid) throw new Error("Pi package tree entry ownership differs from the controller user");
			if (before.isDirectory()) {
				if ((before.mode & 0o022n) !== 0n) throw new Error("Pi package tree contains a directory writable by another principal");
				baseEntries.push({ path: relativePath, type: "directory", mode: Number(before.mode & 0o7777n) });
				await walk(path, relativePath);
				const after = await lstat(path, { bigint: true });
				if (!stableMetadata(before, after)) throw new Error("Pi package directory changed while it was inspected");
				continue;
			}
			if (before.isFile()) {
				if ((before.mode & 0o022n) !== 0n) throw new Error("Pi package tree contains a file writable by another principal");
				if (before.size > BigInt(maxFileBytes)) throw new Error("Pi package tree contains an oversized file");
				const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
				try {
					const opened = await handle.stat({ bigint: true });
					if (!opened.isFile() || !stableMetadata(before, opened)) {
						throw new Error("Pi package file changed before its no-follow open");
					}
					const bytes = await handle.readFile();
					totalBytes += bytes.length;
					if (totalBytes > maxBytes) {
						bytes.fill(0);
						throw new Error("Pi package tree exceeds its byte limit");
					}
					const [afterHandle, afterPath] = await Promise.all([
						handle.stat({ bigint: true }),
						lstat(path, { bigint: true }),
					]);
					if (!stableMetadata(opened, afterHandle) || !stableMetadata(opened, afterPath) || afterPath.isSymbolicLink()) {
						bytes.fill(0);
						throw new Error("Pi package file changed while it was inspected");
					}
					const fileSha256 = createHash("sha256").update(bytes).digest("hex");
					bytes.fill(0);
					baseEntries.push({
						path: relativePath,
						type: "file",
						mode: Number(opened.mode & 0o7777n),
						bytes: Number(opened.size),
						sha256: fileSha256,
					});
				} finally {
					await handle.close();
				}
				continue;
			}
			if (before.isSymbolicLink()) {
				const linkText = await readlink(path);
				const afterLink = await lstat(path, { bigint: true });
				if (!stableMetadata(before, afterLink)) throw new Error("Pi package symlink changed while it was inspected");
				if (!linkText || linkText.includes("\0") || isAbsolute(linkText)) {
					throw new Error("Pi package symlinks must use nonempty relative targets");
				}
				const lexicalTarget = resolve(dirname(path), linkText);
				packageRelativePath(root, lexicalTarget);
				let resolvedTarget: string;
				try {
					resolvedTarget = await realpath(path);
				} catch {
					throw new Error("Pi package tree contains a dangling symlink");
				}
				const resolvedTargetPath = packageRelativePath(root, resolvedTarget);
				const targetStatus = await lstat(resolvedTarget, { bigint: true });
				if (targetStatus.uid !== expectedUid || (!targetStatus.isDirectory() && !targetStatus.isFile())) {
					throw new Error("Pi package symlink does not resolve to an owned regular file or directory");
				}
				baseEntries.push({
					path: relativePath,
					type: "symlink",
					linkText,
					resolvedTargetPath,
					resolvedTargetType: targetStatus.isDirectory() ? "directory" : "file",
				});
				continue;
			}
			throw new Error("Pi package tree contains a special file");
		}
		const directoryAfter = await lstat(directory, { bigint: true });
		if (!stableMetadata(directoryBefore, directoryAfter)) {
			throw new Error("Pi package directory changed during deterministic traversal");
		}
	};
	await walk(root, "");
	const rootAfter = await lstat(root, { bigint: true });
	if (!stableMetadata(rootCanonical, rootAfter) || await realpath(requestedRoot) !== root) {
		throw new Error("Pi package root changed during deterministic traversal");
	}
	const entryByPath = new Map(baseEntries.map(entry => [entry.path, entry]));
	const links = baseEntries.flatMap((entry): PiPackageTreeLinkEvidence[] => {
		if (entry.type !== "symlink") return [];
		const target = entryByPath.get(entry.resolvedTargetPath);
		if (!target || target.type !== entry.resolvedTargetType) {
			throw new Error("Pi package symlink target was not represented by the deterministic tree walk");
		}
		return [{
			path: entry.path,
			linkText: entry.linkText,
			resolvedTargetPath: entry.resolvedTargetPath,
			resolvedTargetType: entry.resolvedTargetType,
			resolvedTargetSha256: target.type === "file"
				? target.sha256
				: packageSubtreeSha256(baseEntries, target.path),
		}];
	});
	const linkedEntries = baseEntries.map(entry => entry.type !== "symlink"
		? entry
		: { ...entry, resolvedTargetSha256: links.find(link => link.path === entry.path)?.resolvedTargetSha256 });
	const treeSha256 = createHash("sha256")
		.update("pi-package-tree-v1\0")
		.update(JSON.stringify(linkedEntries))
		.digest("hex");
	return Object.freeze({
		rootPath: root,
		rootDevice: String(rootCanonical.dev),
		rootInode: String(rootCanonical.ino),
		rootMode: Number(rootCanonical.mode & 0o7777n),
		sha256: treeSha256,
		entries: entryCount,
		bytes: totalBytes,
		links: Object.freeze(links.map(link => Object.freeze(link))),
	});
}

async function copyPiPackageTree(sourceRoot: string, targetRoot: string): Promise<void> {
	if (typeof constants.O_NOFOLLOW !== "number") throw new Error("Pi package staging requires O_NOFOLLOW support");
	const expectedUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : (await lstat(sourceRoot, { bigint: true })).uid;
	let entries = 0;
	let totalBytes = 0;
	const copyDirectory = async (source: string, target: string, isRoot = false): Promise<void> => {
		const sourceBefore = await lstat(source, { bigint: true });
		if (sourceBefore.isSymbolicLink() || !sourceBefore.isDirectory() || sourceBefore.uid !== expectedUid
			|| (sourceBefore.mode & 0o022n) !== 0n) {
			throw new Error("Pi package source directory changed before staging");
		}
		await mkdir(target, { mode: 0o700 });
		const children = (await readdir(source, { withFileTypes: true }))
			.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
		for (const child of children) {
			entries += 1;
			if (entries > MAX_PACKAGE_TREE_ENTRIES) throw new Error("Pi package tree exceeds its staging entry limit");
			const sourcePath = join(source, child.name);
			const targetPath = join(target, child.name);
			const before = await lstat(sourcePath, { bigint: true });
			if (before.uid !== expectedUid) throw new Error("Pi package entry ownership changed before staging");
			if (before.isDirectory()) {
				await copyDirectory(sourcePath, targetPath);
				continue;
			}
			if (before.isFile()) {
				if ((before.mode & 0o022n) !== 0n || before.size > BigInt(MAX_PACKAGE_FILE_BYTES)) {
					throw new Error("Pi package file mode or size is outside the staging contract");
				}
				const sourceHandle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
				let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
				let bytes: Buffer | undefined;
				try {
					const opened = await sourceHandle.stat({ bigint: true });
					if (!opened.isFile() || !stableMetadata(before, opened)) throw new Error("Pi package file changed before staging open");
					bytes = await sourceHandle.readFile();
					totalBytes += bytes.length;
					if (totalBytes > MAX_PACKAGE_TREE_BYTES) throw new Error("Pi package tree exceeds its staging byte limit");
					targetHandle = await open(
						targetPath,
						constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
						0o600,
					);
					await targetHandle.writeFile(bytes);
					await targetHandle.sync();
					const [afterHandle, afterPath] = await Promise.all([
						sourceHandle.stat({ bigint: true }),
						lstat(sourcePath, { bigint: true }),
					]);
					if (!stableMetadata(opened, afterHandle) || !stableMetadata(opened, afterPath) || afterPath.isSymbolicLink()) {
						throw new Error("Pi package file changed while it was staged");
					}
				} finally {
					bytes?.fill(0);
					await targetHandle?.close();
					await sourceHandle.close();
				}
				await chmod(targetPath, Number(before.mode & 0o7777n));
				continue;
			}
			if (before.isSymbolicLink()) {
				const linkText = await readlink(sourcePath);
				if (!linkText || linkText.includes("\0") || isAbsolute(linkText)) {
					throw new Error("Pi package symlink changed outside the staging contract");
				}
				packageRelativePath(sourceRoot, resolve(dirname(sourcePath), linkText));
				let resolvedTarget: string;
				try {
					resolvedTarget = await realpath(sourcePath);
				} catch {
					throw new Error("Pi package symlink became dangling during staging");
				}
				packageRelativePath(sourceRoot, resolvedTarget);
				await symlink(linkText, targetPath);
				const [afterSource, stagedText] = await Promise.all([
					lstat(sourcePath, { bigint: true }),
					readlink(targetPath),
				]);
				if (!stableMetadata(before, afterSource) || stagedText !== linkText) {
					throw new Error("Pi package symlink changed while it was staged");
				}
				continue;
			}
			throw new Error("Pi package tree contains a special file during staging");
		}
		const sourceAfter = await lstat(source, { bigint: true });
		if (!stableMetadata(sourceBefore, sourceAfter)) throw new Error("Pi package directory changed while it was staged");
		await chmod(target, isRoot ? 0o500 : Number(sourceBefore.mode & 0o7777n));
	};
	await copyDirectory(sourceRoot, targetRoot, true);
}

async function stagePiPackageTree(input: {
	sourceRoot: string;
	expectedRootDevice: string;
	expectedRootInode: string;
	expectedSha256: string;
	expectedEntries: number;
	expectedBytes: number;
	sourceExecutable: string;
	expectedExecutableSha256: string;
	controllerRoot: string;
}): Promise<Readonly<PiPackageTreeStaging>> {
	if (!SHA256_PATTERN.test(input.expectedSha256) || !SHA256_PATTERN.test(input.expectedExecutableSha256)) {
		throw new Error("Pi package staging digest evidence is invalid");
	}
	const source = await inspectPiPackageTree(input.sourceRoot);
	if (source.rootDevice !== input.expectedRootDevice || source.rootInode !== input.expectedRootInode
		|| source.sha256 !== input.expectedSha256 || source.entries !== input.expectedEntries || source.bytes !== input.expectedBytes) {
		throw new Error("Pi package source changed after controller preflight");
	}
	const executable = await realpath(input.sourceExecutable);
	const executableRelativePath = packageRelativePath(source.rootPath, executable);
	if (await sha256StableRegularFile(executable) !== input.expectedExecutableSha256) {
		throw new Error("Pi package executable changed before immutable staging");
	}
	const target = join(input.controllerRoot, "pi-package");
	if (isWithin(source.rootPath, target) || isWithin(target, source.rootPath)) {
		throw new Error("Pi package source and staged roots must be disjoint");
	}
	await copyPiPackageTree(source.rootPath, target);
	const [sourceAfter, staged] = await Promise.all([
		inspectPiPackageTree(source.rootPath),
		inspectPiPackageTree(target),
	]);
	if (sourceAfter.rootDevice !== source.rootDevice || sourceAfter.rootInode !== source.rootInode
		|| sourceAfter.sha256 !== source.sha256 || sourceAfter.entries !== source.entries || sourceAfter.bytes !== source.bytes
		|| staged.sha256 !== source.sha256 || staged.entries !== source.entries || staged.bytes !== source.bytes
		|| JSON.stringify(staged.links) !== JSON.stringify(source.links)) {
		throw new Error("Pi package source and immutable staged tree differ after copy");
	}
	const stagedExecutable = join(staged.rootPath, ...executableRelativePath.split("/"));
	if (await realpath(stagedExecutable) !== stagedExecutable
		|| await sha256StableRegularFile(stagedExecutable) !== input.expectedExecutableSha256) {
		throw new Error("Pi staged package executable identity differs from the reviewed PI_BIN");
	}
	return Object.freeze({
		source: sourceAfter,
		staged,
		executableRelativePath,
		executablePath: stagedExecutable,
		executableSha256: input.expectedExecutableSha256,
	});
}

async function canonicalPrivateDirectory(path: string, label: string): Promise<CanonicalDirectory> {
	const before = await lstat(path, { bigint: true });
	const expectedUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : before.uid;
	if (before.isSymbolicLink() || !before.isDirectory() || before.uid !== expectedUid || (before.mode & 0o077n) !== 0n) {
		throw new Error(`Pi containment ${label} must be a private caller-owned non-symlink directory`);
	}
	const canonical = await realpath(path);
	const after = await lstat(canonical, { bigint: true });
	if (!stableMetadata(before, after) || await realpath(path) !== canonical) {
		throw new Error(`Pi containment ${label} changed while it was resolved`);
	}
	return { realpath: canonical, device: String(before.dev), inode: String(before.ino) };
}

async function canonicalReadPath(path: string): Promise<CanonicalReadPath> {
	const policyPath = resolve(path);
	const policyStatus = await lstat(policyPath, { bigint: true });
	const canonical = await realpath(path);
	const status = await lstat(canonical, { bigint: true });
	if (!status.isDirectory() && !status.isFile()) {
		throw new Error(`Pi containment read path is not a regular file or directory: ${path}`);
	}
	return {
		policyPath,
		realpath: canonical,
		type: policyStatus.isSymbolicLink() ? "symlink" : status.isDirectory() ? "directory" : "file",
		device: String(status.dev),
		inode: String(status.ino),
	};
}

function seatbeltString(path: string): string {
	if (!isAbsolute(path) || path.includes("\0")) throw new Error("Pi Seatbelt paths must be absolute and NUL-free");
	return JSON.stringify(path);
}

function normalizedExcludedPaths(workspace: string, values: readonly string[]): string[] {
	const unique = new Set<string>();
	for (const value of values) {
		if (!value || value.includes("\0") || value.includes("\\") || isAbsolute(value)) {
			throw new Error("Pi containment exclusions must be canonical relative POSIX paths");
		}
		const target = resolve(workspace, value);
		if (!isWithin(workspace, target) || target === workspace || relative(workspace, target).split(sep).join("/") !== value) {
			throw new Error("Pi containment exclusion escapes the canonical workspace");
		}
		unique.add(value);
	}
	const ordered = [...unique].sort();
	return ordered.filter((path, index) => !ordered.some((parent, parentIndex) =>
		parentIndex !== index && path.startsWith(`${parent}/`)));
}

export async function inspectPiProcessContainment(
	expectedBoundarySha256: string = PI_DARWIN_SEATBELT_SHA256,
	expectedSystemProfileSha256: string = PI_DARWIN_SYSTEM_PROFILE_SHA256,
): Promise<Readonly<PiProcessContainmentInspection>> {
	if (process.platform !== "darwin") {
		return Object.freeze({
			available: false,
			notice: "Pi process containment is unavailable: Linux remains blocked until a pinned OS boundary passes the same hostile tests",
		});
	}
	try {
		const boundaryStatus = await lstat(DARWIN_SANDBOX_EXEC, { bigint: true });
		if (boundaryStatus.isSymbolicLink() || !boundaryStatus.isFile() || boundaryStatus.uid !== 0n
			|| (boundaryStatus.mode & 0o022n) !== 0n || await realpath(DARWIN_SANDBOX_EXEC) !== DARWIN_SANDBOX_EXEC) {
			throw new Error("sandbox-exec is not the canonical root-owned non-writable regular file");
		}
		const systemStatus = await lstat(DARWIN_SYSTEM_PROFILE, { bigint: true });
		if (systemStatus.isSymbolicLink() || !systemStatus.isFile() || systemStatus.uid !== 0n
			|| (systemStatus.mode & 0o022n) !== 0n || await realpath(DARWIN_SYSTEM_PROFILE) !== DARWIN_SYSTEM_PROFILE) {
			throw new Error("system.sb is not the canonical root-owned non-writable regular file");
		}
		const [boundarySha256, systemProfileSha256] = await Promise.all([
			sha256StableRegularFile(DARWIN_SANDBOX_EXEC),
			sha256StableRegularFile(DARWIN_SYSTEM_PROFILE),
		]);
		if (!SHA256_PATTERN.test(expectedBoundarySha256) || boundarySha256 !== expectedBoundarySha256) {
			throw new Error(`sandbox-exec digest drifted from the reviewed mechanism: ${boundarySha256}`);
		}
		if (!SHA256_PATTERN.test(expectedSystemProfileSha256) || systemProfileSha256 !== expectedSystemProfileSha256) {
			throw new Error(`system.sb digest drifted from the reviewed mechanism: ${systemProfileSha256}`);
		}
		return Object.freeze({
			available: true,
			kind: "darwin-seatbelt" as const,
			command: DARWIN_SANDBOX_EXEC,
			boundarySha256,
			systemProfilePath: DARWIN_SYSTEM_PROFILE,
			systemProfileSha256,
			mechanismSha256: mechanismSha256(boundarySha256, systemProfileSha256),
			notice: "macOS Seatbelt is available through the exact reviewed root-owned sandbox-exec and system.sb mechanism",
		});
	} catch (error) {
		return Object.freeze({
			available: false,
			notice: `Pi process containment is unavailable: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
}

export async function ensurePiGuardRuntimeDirectory(controllerRoot: string): Promise<string> {
	const controller = await canonicalPrivateDirectory(controllerRoot, "controller root");
	const path = join(controller.realpath, "pi-guard-runtime");
	try {
		await mkdir(path, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	await chmod(path, 0o700);
	return (await canonicalPrivateDirectory(path, "guard runtime")).realpath;
}

export async function validatePiContainmentScope(
	workspaceRoot: string,
	excludedPaths: readonly string[],
): Promise<{ workspace: CanonicalDirectory; excludedPaths: readonly string[] }> {
	const before = await lstat(workspaceRoot, { bigint: true });
	if (before.isSymbolicLink() || !before.isDirectory()) throw new Error("Pi containment workspace must be a non-symlink directory");
	const workspace = await realpath(workspaceRoot);
	const after = await lstat(workspace, { bigint: true });
	if (!stableMetadata(before, after) || await realpath(workspaceRoot) !== workspace) {
		throw new Error("Pi containment workspace changed while it was resolved");
	}
	return {
		workspace: { realpath: workspace, device: String(before.dev), inode: String(before.ino) },
		excludedPaths: Object.freeze(normalizedExcludedPaths(workspace, excludedPaths)),
	};
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function replaceStaticAssignment(source: string, name: string, value: string): string {
	const pattern = new RegExp(`^(export\\s+)?${name}=[^\\n]+$`, "gm");
	const matches = source.match(pattern) ?? [];
	if (matches.length !== 1) throw new Error(`Pi guard script must define ${name} exactly once for per-run staging`);
	const exportPrefix = matches[0]?.startsWith("export ") ? "export " : "";
	return source.replace(pattern, `${exportPrefix}${name}=${shellQuote(value)}`);
}

function rewriteGuardRuntime(source: string, runtime: string): string {
	const assignments = source.match(/^PI_RUNTIME_TMP=[^\n]+$/gm) ?? [];
	const reviewed = 'PI_RUNTIME_TMP="/tmp/pi-runtime-$(id -u)"';
	if (assignments.length !== 1 || assignments[0] !== reviewed) {
		throw new Error("Pi guard script PI_RUNTIME_TMP source pattern drifted from the reviewed assignment");
	}
	return source.replace(reviewed, `PI_RUNTIME_TMP=${shellQuote(runtime)}`);
}

function rewriteGuardHereStrings(source: string): string {
	const simpleVariableHereString = /<<<"\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))"/g;
	const staged = source.replace(simpleVariableHereString, (_match, braced: string | undefined, plain: string | undefined) => {
		const name = braced ?? plain;
		return `< <(printf '%s\\n' "$\{${name}}")`;
	});
	if (staged.includes("<<<")) {
		throw new Error("Pi protected router contains an unhandled here-string that could write in the task workspace");
	}
	return staged;
}

function rewritePiBinHandoffs(source: string, nodeInterpreter: string): string {
	if (!isAbsolute(nodeInterpreter) || /^PI_NODE=/m.test(source)) {
		throw new Error("Pi protected router Node interpreter handoff anchors drifted from the reviewed source");
	}
	const piBinAssignments = source.match(/^PI_BIN=[^\n]+$/gm) ?? [];
	if (piBinAssignments.length !== 1) throw new Error("Pi protected router must define PI_BIN exactly once before interpreter staging");
	const execPattern = /^(\s*)exec "\$PI_BIN"(.*)$/gm;
	const execLines = source.match(execPattern) ?? [];
	if (execLines.length < 1) throw new Error("Pi protected router has no reviewed PI_BIN exec handoff");
	let staged = source.replace(
		piBinAssignments[0] as string,
		`${piBinAssignments[0]}\nPI_NODE=${shellQuote(nodeInterpreter)}`,
	);
	let rewritten = 0;
	staged = staged.replace(execPattern, (_line, indentation: string, suffix: string) => {
		rewritten += 1;
		return `${indentation}exec "$PI_NODE" "$PI_BIN"${suffix}`;
	});
	if (rewritten !== execLines.length) throw new Error("Pi protected router PI_BIN interpreter handoff rewrite was incomplete");
	return staged;
}

async function stageGuardScript(
	sourcePath: string,
	controllerRoot: string,
	targetName: string,
	expectedSha256: string,
	transform: (source: string) => string,
): Promise<{ path: string; sha256: string }> {
	const source = await realpath(sourcePath);
	const target = join(controllerRoot, targetName);
	const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
	let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const before = await sourceHandle.stat({ bigint: true });
		if (!before.isFile() || before.size > 1024n * 1024n) throw new Error("Pi guard script is not a bounded regular file");
		const sourceBytes = await sourceHandle.readFile();
		if (createHash("sha256").update(sourceBytes).digest("hex") !== expectedSha256) {
			throw new Error("Pi guard script digest changed before staging");
		}
		const stagedBytes = Buffer.from(transform(sourceBytes.toString("utf8")), "utf8");
		targetHandle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o500);
		await targetHandle.writeFile(stagedBytes);
		await targetHandle.sync();
		const [afterHandle, afterPath] = await Promise.all([
			sourceHandle.stat({ bigint: true }),
			lstat(source, { bigint: true }),
		]);
		if (!stableMetadata(before, afterHandle) || !stableMetadata(before, afterPath)
			|| afterPath.isSymbolicLink()) {
			throw new Error("Pi guard script changed while it was staged");
		}
	} finally {
		await targetHandle?.close();
		await sourceHandle.close();
	}
	await chmod(target, 0o500);
	const sha256 = await sha256StableRegularFile(target);
	return { path: await realpath(target), sha256 };
}

async function readStableBoundedFile(path: string, expectedSha256: string, maxBytes: bigint): Promise<Buffer> {
	const source = await realpath(path);
	if (source !== path) throw new Error("Pi staged artifact source must use its canonical path");
	const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile() || before.size > maxBytes) throw new Error("Pi staged artifact is not a bounded regular file");
		const bytes = await handle.readFile();
		if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
			bytes.fill(0);
			throw new Error("Pi staged artifact source digest changed");
		}
		const [afterHandle, afterPath] = await Promise.all([
			handle.stat({ bigint: true }),
			lstat(source, { bigint: true }),
		]);
		if (!stableMetadata(before, afterHandle) || !stableMetadata(before, afterPath) || afterPath.isSymbolicLink()) {
			bytes.fill(0);
			throw new Error("Pi staged artifact changed while it was read");
		}
		return bytes;
	} finally {
		await handle.close();
	}
}

async function writeCreateOnlyArtifact(path: string, bytes: Uint8Array, mode: number): Promise<{ path: string; sha256: string }> {
	const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await chmod(path, mode);
	return { path: await realpath(path), sha256: await sha256StableRegularFile(path) };
}

function rewriteCredentialHelper(source: string, sourceHelper: string, stagedHelper: string): string {
	const occurrences = source.split(sourceHelper).length - 1;
	if (occurrences !== 2) {
		throw new Error("Pi protected router credential-helper source pattern must occur exactly twice");
	}
	return source.split(sourceHelper).join(shellQuote(stagedHelper));
}

function minimalSettings(sourceBytes: Buffer, input: PiCredentialBrokerStaging): Buffer {
	let source: Record<string, unknown>;
	try {
		source = JSON.parse(sourceBytes.toString("utf8")) as Record<string, unknown>;
	} catch {
		throw new Error("Pi source settings are not valid JSON");
	}
	if (source.defaultProvider !== input.provider || source.defaultModel !== input.model
		|| source.defaultThinkingLevel !== input.reasoning
		|| source.enableInstallTelemetry !== false || source.enableAnalytics !== false) {
		throw new Error("Pi source settings route, reasoning, or telemetry anchors drifted");
	}
	const staged = {
		defaultProvider: input.provider,
		defaultModel: input.model,
		defaultThinkingLevel: input.reasoning,
		defaultProjectTrust: false,
		enableInstallTelemetry: false,
		enableAnalytics: false,
		defaultTools: ["read", "grep", "find", "ls"],
		enabledModels: [`${input.provider}/${input.model}:${input.reasoning}`],
		extensions: [],
		packages: [],
		compaction: { enabled: false },
		retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
		terminal: { showImages: false },
	};
	return Buffer.from(`${JSON.stringify(staged, null, 2)}\n`, "utf8");
}

function minimalModels(sourceBytes: Buffer, input: PiCredentialBrokerStaging, stagedHelper: string): Buffer {
	let source: { providers?: Record<string, Record<string, unknown>> };
	try {
		source = JSON.parse(sourceBytes.toString("utf8")) as { providers?: Record<string, Record<string, unknown>> };
	} catch {
		throw new Error("Pi source models are not valid JSON");
	}
	const provider = source.providers?.[input.provider];
	if (!provider || provider.apiKey !== `!${input.credentialHelperReference}`) {
		throw new Error("Pi protected provider must contain exactly the reviewed credential-helper reference");
	}
	const models = Array.isArray(provider.models) ? provider.models as Array<Record<string, unknown>> : [];
	if (models.length !== 1 || models[0]?.id !== input.model) {
		throw new Error("Pi protected provider model catalog must contain exactly the reviewed route");
	}
	const serializedProvider = JSON.stringify(provider);
	if (serializedProvider.split(`!${input.credentialHelperReference}`).length - 1 !== 1) {
		throw new Error("Pi protected provider credential-helper anchor must occur exactly once");
	}
	const stagedProvider = structuredClone(provider);
	stagedProvider.apiKey = `!${shellQuote(stagedHelper)}`;
	return Buffer.from(`${JSON.stringify({ providers: { [input.provider]: stagedProvider } }, null, 2)}\n`, "utf8");
}

async function stageCredentialBrokerArtifacts(
	controllerRoot: string,
	input: PiCredentialBrokerStaging,
): Promise<NonNullable<PiProcessContainmentLaunch["credentialBroker"]>> {
	for (const digest of [
		input.contractSha256,
		input.credentialHelperSha256,
		input.harnessExecutableSha256,
		input.agentSettingsSha256,
		input.agentModelsSha256,
		input.grepExecutableSha256,
		input.findExecutableSha256,
	]) {
		if (!SHA256_PATTERN.test(digest)) throw new Error("Pi credential-broker staging digest evidence is invalid");
	}
	const client = await writeCreateOnlyArtifact(
		join(controllerRoot, "pi-credential-client.mjs"),
		Buffer.from(piCredentialClientSource(input.nodeInterpreter), "utf8"),
		0o500,
	);
	const agentDirectory = join(controllerRoot, "pi-agent");
	const binDirectory = join(agentDirectory, "bin");
	await mkdir(agentDirectory, { mode: 0o700 });
	await mkdir(binDirectory, { mode: 0o700 });
	const [settingsSource, modelsSource, grepSource, findSource] = await Promise.all([
		readStableBoundedFile(input.agentSettings, input.agentSettingsSha256, 1024n * 1024n),
		readStableBoundedFile(input.agentModels, input.agentModelsSha256, 4n * 1024n * 1024n),
		readStableBoundedFile(input.grepExecutable, input.grepExecutableSha256, 64n * 1024n * 1024n),
		readStableBoundedFile(input.findExecutable, input.findExecutableSha256, 64n * 1024n * 1024n),
	]);
	try {
		const settingsBytes = minimalSettings(settingsSource, input);
		const modelsBytes = minimalModels(modelsSource, input, client.path);
		try {
			const [settings, models, grep, find] = await Promise.all([
				writeCreateOnlyArtifact(join(agentDirectory, "settings.json"), settingsBytes, 0o400),
				writeCreateOnlyArtifact(join(agentDirectory, "models.json"), modelsBytes, 0o400),
				writeCreateOnlyArtifact(join(binDirectory, "rg"), grepSource, 0o500),
				writeCreateOnlyArtifact(join(binDirectory, "fd"), findSource, 0o500),
			]);
			await chmod(binDirectory, 0o500);
			await chmod(agentDirectory, 0o500);
			return Object.freeze({
				contractSha256: input.contractSha256,
				socketPath: input.socketPath,
				socketDirectory: input.socketDirectory,
				socketDirectoryDevice: input.socketDirectoryDevice,
				socketDirectoryInode: input.socketDirectoryInode,
				socketDevice: input.socketDevice,
				socketInode: input.socketInode,
				credentialSourcePath: input.credentialHelper,
				credentialSourceSha256: input.credentialHelperSha256,
				stagedCredentialSourcePath: input.stagedCredentialHelper,
				stagedCredentialSourceSha256: input.stagedCredentialHelperSha256,
				clientPath: client.path,
				clientSha256: client.sha256,
				agentDirectory: await realpath(agentDirectory),
				settingsPath: settings.path,
				settingsSourceSha256: input.agentSettingsSha256,
				settingsSha256: settings.sha256,
				modelsPath: models.path,
				modelsSourceSha256: input.agentModelsSha256,
				modelsSha256: models.sha256,
				grepPath: grep.path,
				grepSourceSha256: input.grepExecutableSha256,
				grepSha256: grep.sha256,
				findPath: find.path,
				findSourceSha256: input.findExecutableSha256,
				findSha256: find.sha256,
			});
		} finally {
			settingsBytes.fill(0);
			modelsBytes.fill(0);
		}
	} finally {
		settingsSource.fill(0);
		modelsSource.fill(0);
		grepSource.fill(0);
		findSource.fill(0);
	}
}

function seatbeltProfile(input: {
	workspace: string;
	excludedPaths: readonly string[];
	controllerRoot: string;
	writableRuntime: string;
	readPaths: readonly CanonicalReadPath[];
	executableSha256: string;
	routeEnforcementSha256: string;
	mechanismSha256: string;
	boundarySha256: string;
	systemProfileSha256: string;
	credentialBroker?: NonNullable<PiProcessContainmentLaunch["credentialBroker"]>;
}): string {
	const systemReadRoots = [
		"/System", "/Library", "/usr", "/bin", "/sbin", "/dev", "/private/etc", "/private/var/db", "/private/var/select",
	];
	const reads = new Map<string, "directory" | "file" | "symlink">();
	for (const path of systemReadRoots) reads.set(path, "directory");
	reads.set(input.workspace, "directory");
	reads.set(input.controllerRoot, "directory");
	reads.set(input.writableRuntime, "directory");
	for (const path of input.readPaths) {
		reads.set(path.policyPath, path.type);
		reads.set(path.realpath, path.type);
	}
	const allowedReads = [...reads]
		.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
		.map(([path, type]) => `  (${type === "directory" ? "subpath" : "literal"} ${seatbeltString(path)})`)
		.join("\n");
	const metadataAncestors = new Set<string>();
	for (const path of reads.keys()) {
		let current = resolve(path);
		for (;;) {
			const parent = resolve(current, "..");
			if (parent === current || parent === "/") break;
			metadataAncestors.add(parent);
			current = parent;
		}
	}
	const allowedMetadata = [...metadataAncestors].sort()
		.map(path => `  (literal ${seatbeltString(path)})`).join("\n");
	const deniedReads = input.excludedPaths
		.map(path => `  (subpath ${seatbeltString(resolve(input.workspace, path))})`).join("\n");
	const credentialDenies = input.credentialBroker ? `
; Direct Keychain access stays outside the admitted Pi process. The only
; credential capability inside this boundary is the bounded controller broker.
(deny process-exec
  (literal "/usr/bin/security")
  (literal ${seatbeltString(input.credentialBroker.credentialSourcePath)})
  (literal ${seatbeltString(input.credentialBroker.stagedCredentialSourcePath)})
)
(deny mach-lookup
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.securityd")
  (global-name "com.apple.securityd.xpc")
  (global-name "com.apple.securityd.general")
  (global-name "com.apple.securityd.systemkeychain")
  (global-name "com.apple.securityd.ckks")
)
(deny file-read*
  (subpath ${seatbeltString(input.credentialBroker.socketDirectory)})
  (literal ${seatbeltString(input.credentialBroker.credentialSourcePath)})
  (subpath ${seatbeltString(join(homedir(), "Library", "Keychains"))})
  (subpath "/Library/Keychains")
)
(deny file-write*
  (subpath ${seatbeltString(input.credentialBroker.socketDirectory)})
)
` : "";
	return `(version 1)
; system.sb supplies the runtime and Mach bootstrap rules required by the
; guarded shell/Node chain. Filesystem rules below are the Ox Driver boundary.
(import "system.sb")
; ox-driver-pi-process-containment-v1
; executable-sha256 ${input.executableSha256}
; route-enforcement-sha256 ${input.routeEnforcementSha256}
; mechanism-sha256 ${input.mechanismSha256}
; boundary-sha256 ${input.boundarySha256}
; system-profile-sha256 ${input.systemProfileSha256}
(deny default)
(allow process*)
(allow signal (target self))
(allow sysctl-read)
${credentialDenies}(allow file-read*
${allowedReads}
)
${allowedMetadata ? `(allow file-read-metadata\n${allowedMetadata}\n)\n` : ""}
${deniedReads ? `(deny file-read*\n${deniedReads})\n` : ""}(allow file-write*
  (subpath ${seatbeltString(input.writableRuntime)})
)
(allow network-outbound
  (remote tcp "*:443")
  (literal "/private/var/run/mDNSResponder")
${input.credentialBroker ? `  (local unix-socket (literal ${seatbeltString(input.credentialBroker.socketPath)}))\n` : ""})
`;
}

export async function createPiProcessContainmentLaunch(input: {
	inspection: Readonly<PiProcessContainmentInspection>;
	workspaceRoot: string;
	excludedPaths: readonly string[];
	controllerRoot: string;
	writableRuntime: string;
	readPaths: readonly string[];
	executable: string;
	executableSha256: string;
	protectedRouter: string;
	protectedRouterSha256: string;
	routeEnforcementSha256: string;
	credentialBroker?: Readonly<PiCredentialBrokerStaging>;
}): Promise<Readonly<PiProcessContainmentLaunch>> {
	if (!input.inspection.available || input.inspection.kind !== "darwin-seatbelt"
		|| !input.inspection.command || !input.inspection.boundarySha256 || !input.inspection.mechanismSha256
		|| !input.inspection.systemProfilePath || !input.inspection.systemProfileSha256) {
		throw new Error("Pi process containment provider is unavailable");
	}
	if (!SHA256_PATTERN.test(input.executableSha256) || !SHA256_PATTERN.test(input.protectedRouterSha256)
		|| !SHA256_PATTERN.test(input.routeEnforcementSha256)) {
		throw new Error("Pi containment digest evidence is invalid");
	}
	const scope = await validatePiContainmentScope(input.workspaceRoot, input.excludedPaths);
	const controllerRoot = await canonicalPrivateDirectory(input.controllerRoot, "controller root");
	const writableRuntime = await canonicalPrivateDirectory(input.writableRuntime, "guard runtime");
	if (isWithin(scope.workspace.realpath, controllerRoot.realpath) || isWithin(controllerRoot.realpath, scope.workspace.realpath)
		|| isWithin(scope.workspace.realpath, writableRuntime.realpath) || isWithin(writableRuntime.realpath, scope.workspace.realpath)
		|| writableRuntime.realpath === controllerRoot.realpath || !isWithin(controllerRoot.realpath, writableRuntime.realpath)) {
		throw new Error("Pi containment workspace must be disjoint and guard runtime must be a child of the controller root");
	}
	const readPaths = await Promise.all([...new Set(input.readPaths)].map(canonicalReadPath));
	let stagedBroker: NonNullable<PiProcessContainmentLaunch["credentialBroker"]> | undefined;
	let stagedPackage: Readonly<PiPackageTreeStaging> | undefined;
	if (input.credentialBroker) {
		const brokerDirectory = await canonicalPrivateDirectory(input.credentialBroker.socketDirectory, "credential broker socket directory");
		const socketStatus = await lstat(input.credentialBroker.socketPath, { bigint: true });
		const expectedUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : socketStatus.uid;
		if (!socketStatus.isSocket() || socketStatus.isSymbolicLink() || socketStatus.uid !== expectedUid
			|| (socketStatus.mode & 0o177n) !== 0n
			|| dirname(input.credentialBroker.socketPath) !== brokerDirectory.realpath
			|| brokerDirectory.device !== input.credentialBroker.socketDirectoryDevice
			|| brokerDirectory.inode !== input.credentialBroker.socketDirectoryInode
			|| String(socketStatus.dev) !== input.credentialBroker.socketDevice
			|| String(socketStatus.ino) !== input.credentialBroker.socketInode
			|| isWithin(writableRuntime.realpath, brokerDirectory.realpath)
			|| isWithin(scope.workspace.realpath, brokerDirectory.realpath)
			|| isWithin(controllerRoot.realpath, brokerDirectory.realpath)) {
			throw new Error("Pi credential broker socket is not an immutable controller-root capability");
		}
		stagedPackage = await stagePiPackageTree({
			sourceRoot: input.credentialBroker.harnessPackageRoot,
			expectedRootDevice: input.credentialBroker.harnessPackageRootDevice,
			expectedRootInode: input.credentialBroker.harnessPackageRootInode,
			expectedSha256: input.credentialBroker.harnessPackageTreeSha256,
			expectedEntries: input.credentialBroker.harnessPackageTreeEntries,
			expectedBytes: input.credentialBroker.harnessPackageTreeBytes,
			sourceExecutable: input.credentialBroker.harnessExecutable,
			expectedExecutableSha256: input.credentialBroker.harnessExecutableSha256,
			controllerRoot: controllerRoot.realpath,
		});
		stagedBroker = await stageCredentialBrokerArtifacts(controllerRoot.realpath, input.credentialBroker);
	}
	const stagedRouter = await stageGuardScript(
		input.protectedRouter,
		controllerRoot.realpath,
		"pi-protected-router",
		input.protectedRouterSha256,
			source => {
				let runtimeStaged = rewriteGuardHereStrings(rewriteGuardRuntime(source, writableRuntime.realpath));
				if (stagedBroker && stagedPackage && input.credentialBroker) {
					runtimeStaged = replaceStaticAssignment(runtimeStaged, "PI_CODING_AGENT_DIR", stagedBroker.agentDirectory);
					runtimeStaged = replaceStaticAssignment(runtimeStaged, "PI_BIN", stagedPackage.executablePath);
					runtimeStaged = rewritePiBinHandoffs(runtimeStaged, input.credentialBroker.nodeInterpreter);
				}
			return stagedBroker && input.credentialBroker
				? rewriteCredentialHelper(runtimeStaged, input.credentialBroker.credentialHelperReference, stagedBroker.clientPath)
				: runtimeStaged;
		},
	);
	const stagedLauncher = await stageGuardScript(
		input.executable,
		controllerRoot.realpath,
		"pi-launcher",
		input.executableSha256,
		source => {
			let staged = replaceStaticAssignment(
				rewriteGuardRuntime(source, writableRuntime.realpath),
				"PI_PROTECTED",
				stagedRouter.path,
			);
			if (stagedBroker) staged = replaceStaticAssignment(staged, "PI_CODING_AGENT_DIR", stagedBroker.agentDirectory);
			return staged;
		},
	);
	const executablePath = stagedLauncher.path;
	const profile = seatbeltProfile({
		workspace: scope.workspace.realpath,
		excludedPaths: scope.excludedPaths,
		controllerRoot: controllerRoot.realpath,
		writableRuntime: writableRuntime.realpath,
		readPaths,
		executableSha256: stagedLauncher.sha256,
		routeEnforcementSha256: input.routeEnforcementSha256,
		mechanismSha256: input.inspection.mechanismSha256,
		boundarySha256: input.inspection.boundarySha256,
		systemProfileSha256: input.inspection.systemProfileSha256,
		...(stagedBroker ? { credentialBroker: stagedBroker } : {}),
	});
	const profilePath = join(controllerRoot.realpath, "pi-seatbelt.sb");
	await writeFile(profilePath, profile, { encoding: "utf8", flag: "wx", mode: 0o400 });
	await chmod(profilePath, 0o400);
	const profileSha256 = createHash("sha256").update(profile).digest("hex");
	const evidence = {
		version: 1,
		kind: "darwin-seatbelt",
		mechanism: {
			sha256: input.inspection.mechanismSha256,
			boundary: { path: input.inspection.command, sha256: input.inspection.boundarySha256 },
			systemProfile: { path: input.inspection.systemProfilePath, sha256: input.inspection.systemProfileSha256 },
		},
		profile: { path: profilePath, sha256: profileSha256 },
		workspace: scope.workspace,
		excludedPaths: scope.excludedPaths,
		controllerRoot,
		writableRuntime,
		readPaths,
		executable: {
			sourcePath: await realpath(input.executable),
			sourceSha256: input.executableSha256,
			path: executablePath,
			sha256: stagedLauncher.sha256,
			staged: true,
			transform: stagedBroker
				? "PI_RUNTIME_TMP -> per-run private child; PI_PROTECTED -> staged reviewed router; PI_CODING_AGENT_DIR -> staged minimal agent directory"
				: "PI_RUNTIME_TMP -> per-run private child; PI_PROTECTED -> staged reviewed router",
		},
		protectedRouter: {
			sourcePath: await realpath(input.protectedRouter),
			sourceSha256: input.protectedRouterSha256,
			path: stagedRouter.path,
			sha256: stagedRouter.sha256,
			staged: true,
			transform: stagedBroker
				? "PI_RUNTIME_TMP -> per-run private child; simple variable here-strings -> pipe-backed process substitutions; PI_CODING_AGENT_DIR -> staged minimal agent directory; PI_BIN -> immutable staged package executable invoked by its exact enforcement-hashed Node interpreter; exactly two credential-helper anchors -> staged broker client"
				: "PI_RUNTIME_TMP -> per-run private child",
		},
		...(stagedPackage ? {
			packageTree: {
				source: stagedPackage.source,
				staged: stagedPackage.staged,
				executable: {
					relativePath: stagedPackage.executableRelativePath,
					sourcePath: input.credentialBroker?.harnessExecutable,
					sourceSha256: input.credentialBroker?.harnessExecutableSha256,
					stagedPath: stagedPackage.executablePath,
					stagedSha256: stagedPackage.executableSha256,
					interpreter: input.credentialBroker?.nodeInterpreter,
				},
			},
		} : {}),
		...(stagedBroker ? {
			credentialBroker: {
				contractSha256: stagedBroker.contractSha256,
				socketPolicy: "private-broker-socket-connect-only; directory and content reads denied; no capability token or credential persisted",
				credentialSource: {
					path: stagedBroker.credentialSourcePath,
					sha256: stagedBroker.credentialSourceSha256,
					stagedPath: stagedBroker.stagedCredentialSourcePath,
					stagedSha256: stagedBroker.stagedCredentialSourceSha256,
					invocation: "trusted-controller-once-before-contained-spawn",
				},
				client: { path: stagedBroker.clientPath, sha256: stagedBroker.clientSha256 },
				agentDirectory: {
					path: stagedBroker.agentDirectory,
					settings: {
						path: stagedBroker.settingsPath,
						sourceSha256: stagedBroker.settingsSourceSha256,
						sha256: stagedBroker.settingsSha256,
					},
					models: {
						path: stagedBroker.modelsPath,
						sourceSha256: stagedBroker.modelsSourceSha256,
						sha256: stagedBroker.modelsSha256,
					},
					tools: {
						grep: { path: stagedBroker.grepPath, sourceSha256: stagedBroker.grepSourceSha256, sha256: stagedBroker.grepSha256 },
						find: { path: stagedBroker.findPath, sourceSha256: stagedBroker.findSourceSha256, sha256: stagedBroker.findSha256 },
					},
				},
				keySecrecy: "not-claimed-for-admitted-harness; broker prevents access to unrelated Keychain items",
			},
		} : {}),
		routeEnforcementSha256: input.routeEnforcementSha256,
		networkPolicy: "configured-https-443-and-dns-plus-exact-credential-broker-socket",
		writerPolicy: "workspace-and-host-write-denied-except-private-per-run-guard-runtime",
		processPolicy: "process-exec-open-within-readable-runtime-roots",
	};
	const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
	const evidencePath = join(controllerRoot.realpath, "pi-containment.json");
	await writeFile(evidencePath, evidenceText, { encoding: "utf8", flag: "wx", mode: 0o400 });
	await chmod(evidencePath, 0o400);
	return Object.freeze({
		version: 1 as const,
		kind: "darwin-seatbelt" as const,
		command: input.inspection.command,
		argsPrefix: Object.freeze(["-f", profilePath]),
		mechanismSha256: input.inspection.mechanismSha256,
		boundarySha256: input.inspection.boundarySha256,
		systemProfilePath: input.inspection.systemProfilePath,
		systemProfileSha256: input.inspection.systemProfileSha256,
		profilePath,
		profileSha256,
		evidencePath,
		evidenceSha256: createHash("sha256").update(evidenceText).digest("hex"),
		workspace: Object.freeze(scope.workspace),
		excludedPaths: Object.freeze([...scope.excludedPaths]),
		controllerRoot: Object.freeze(controllerRoot),
		writableRuntime: Object.freeze(writableRuntime),
		readPaths: Object.freeze(readPaths.map(path => Object.freeze(path))),
		executablePath,
		executableSha256: stagedLauncher.sha256,
		sourceExecutableSha256: input.executableSha256,
		protectedRouterPath: stagedRouter.path,
		protectedRouterSha256: stagedRouter.sha256,
		sourceProtectedRouterSha256: input.protectedRouterSha256,
		routeEnforcementSha256: input.routeEnforcementSha256,
		...(stagedPackage ? { packageTree: stagedPackage } : {}),
		...(stagedBroker ? { credentialBroker: stagedBroker } : {}),
	});
}

export async function verifyPiProcessContainmentLaunch(launch: Readonly<PiProcessContainmentLaunch>): Promise<void> {
	const inspection = await inspectPiProcessContainment();
	if (!inspection.available || inspection.command !== launch.command
		|| inspection.mechanismSha256 !== launch.mechanismSha256
		|| inspection.boundarySha256 !== launch.boundarySha256
		|| inspection.systemProfilePath !== launch.systemProfilePath
		|| inspection.systemProfileSha256 !== launch.systemProfileSha256) {
		throw new Error("Pi containment mechanism changed during the run");
	}
	for (const [path, digest, label] of [
		[launch.profilePath, launch.profileSha256, "profile"],
		[launch.evidencePath, launch.evidenceSha256, "evidence"],
		[launch.executablePath, launch.executableSha256, "staged launcher"],
		[launch.protectedRouterPath, launch.protectedRouterSha256, "staged protected router"],
	] as const) {
		if (await sha256StableRegularFile(path) !== digest) throw new Error(`Pi containment ${label} changed during the run`);
	}
	if (launch.packageTree) {
		const [source, staged] = await Promise.all([
			inspectPiPackageTree(launch.packageTree.source.rootPath),
			inspectPiPackageTree(launch.packageTree.staged.rootPath),
		]);
		for (const [observed, expected, label] of [
			[source, launch.packageTree.source, "source"],
			[staged, launch.packageTree.staged, "staged"],
		] as const) {
			if (observed.rootPath !== expected.rootPath || observed.rootDevice !== expected.rootDevice
				|| observed.rootInode !== expected.rootInode || observed.rootMode !== expected.rootMode
				|| observed.sha256 !== expected.sha256 || observed.entries !== expected.entries
				|| observed.bytes !== expected.bytes || JSON.stringify(observed.links) !== JSON.stringify(expected.links)) {
				throw new Error(`Pi containment ${label} package tree changed during the run`);
			}
		}
		if (source.sha256 !== staged.sha256 || source.entries !== staged.entries || source.bytes !== staged.bytes
			|| JSON.stringify(source.links) !== JSON.stringify(staged.links)) {
			throw new Error("Pi containment source and staged package trees diverged during the run");
		}
		const expectedExecutable = join(staged.rootPath, ...launch.packageTree.executableRelativePath.split("/"));
		if (expectedExecutable !== launch.packageTree.executablePath
			|| await realpath(expectedExecutable) !== expectedExecutable
			|| await sha256StableRegularFile(expectedExecutable) !== launch.packageTree.executableSha256) {
			throw new Error("Pi containment staged package executable changed during the run");
		}
	}
	if (launch.credentialBroker) {
		for (const [path, digest, label] of [
			[launch.credentialBroker.stagedCredentialSourcePath, launch.credentialBroker.stagedCredentialSourceSha256, "staged credential source"],
			[launch.credentialBroker.clientPath, launch.credentialBroker.clientSha256, "credential client"],
			[launch.credentialBroker.settingsPath, launch.credentialBroker.settingsSha256, "staged settings"],
			[launch.credentialBroker.modelsPath, launch.credentialBroker.modelsSha256, "staged models"],
			[launch.credentialBroker.grepPath, launch.credentialBroker.grepSha256, "staged grep"],
			[launch.credentialBroker.findPath, launch.credentialBroker.findSha256, "staged find"],
		] as const) {
			if (await sha256StableRegularFile(path) !== digest) throw new Error(`Pi containment ${label} changed during the run`);
		}
		const brokerDirectory = await canonicalPrivateDirectory(
			launch.credentialBroker.socketDirectory,
			"credential broker socket directory",
		);
		if (brokerDirectory.device !== launch.credentialBroker.socketDirectoryDevice
			|| brokerDirectory.inode !== launch.credentialBroker.socketDirectoryInode) {
			throw new Error("Pi containment credential broker directory identity changed during the run");
		}
		const socket = await lstat(launch.credentialBroker.socketPath, { bigint: true });
		if (!socket.isSocket() || socket.isSymbolicLink() || (socket.mode & 0o177n) !== 0n
			|| String(socket.dev) !== launch.credentialBroker.socketDevice
			|| String(socket.ino) !== launch.credentialBroker.socketInode) {
			throw new Error("Pi containment credential broker socket identity changed during the run");
		}
	}
	const controllerRoot = await canonicalPrivateDirectory(launch.controllerRoot.realpath, "controller root");
	const writableRuntime = await canonicalPrivateDirectory(launch.writableRuntime.realpath, "guard runtime");
	if (controllerRoot.device !== launch.controllerRoot.device || controllerRoot.inode !== launch.controllerRoot.inode
		|| writableRuntime.device !== launch.writableRuntime.device || writableRuntime.inode !== launch.writableRuntime.inode) {
		throw new Error("Pi containment writable or controller directory identity changed during the run");
	}
	const scope = await validatePiContainmentScope(launch.workspace.realpath, launch.excludedPaths);
	if (scope.workspace.device !== launch.workspace.device || scope.workspace.inode !== launch.workspace.inode) {
		throw new Error("Pi containment workspace identity changed during the run");
	}
	for (const expected of launch.readPaths) {
		const observed = await canonicalReadPath(expected.policyPath);
		if (observed.device !== expected.device || observed.inode !== expected.inode || observed.type !== expected.type) {
			throw new Error("Pi containment runtime read path identity changed during the run");
		}
	}
}

export const systemPiProcessContainmentProvider: Readonly<PiProcessContainmentProvider> = Object.freeze({
	inspect: inspectPiProcessContainment,
	create: createPiProcessContainmentLaunch,
	verify: verifyPiProcessContainmentLaunch,
});
