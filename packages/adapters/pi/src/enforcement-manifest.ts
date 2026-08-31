import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ROLE_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_CANDIDATE_ENTRIES = 250_000;
const MAX_CANDIDATE_FILE_BYTES = 512 * 1024 * 1024;

export type PiEnforcementObjectType = "directory" | "file" | "symlink";

export interface PiEnforcementArtifactV2 {
	role: string;
	path: string;
	type: PiEnforcementObjectType;
}

export interface PiEnforcementEntryV2 {
	path: string;
	type: PiEnforcementObjectType;
	mode: number;
	byteLength: number;
	sha256?: string;
	linkTarget?: string;
}

export interface PiEnforcementManifestV2 {
	version: 2;
	algorithm: "sha256";
	artifacts: readonly PiEnforcementArtifactV2[];
	entries: readonly PiEnforcementEntryV2[];
}

export interface PiEnforcementManifestEnvelopeV2 {
	manifest: Readonly<PiEnforcementManifestV2>;
	manifestSha256: string;
}

export interface PiEnforcementVerificationV2 {
	manifestSha256: string;
	entryCount: number;
	candidateRoot: string;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object).sort(compareText).map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function normalizeRelativePath(value: string, label: string): string {
	if (!value || value.includes("\0") || value.includes("\\") || posix.isAbsolute(value)) {
		throw new Error(`${label} must be a canonical relative POSIX path`);
	}
	const normalized = posix.normalize(value);
	if (normalized !== value || normalized === ".." || normalized.startsWith("../")) {
		throw new Error(`${label} must be a canonical relative POSIX path`);
	}
	return normalized;
}

function manifestDigest(manifest: Readonly<PiEnforcementManifestV2>): string {
	return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

function filesystemPath(root: string, relativePath: string): string {
	return relativePath === "." ? root : join(root, ...relativePath.split("/"));
}

function stableMetadata(
	before: BigIntStats,
	after: BigIntStats,
): boolean {
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

async function openStableRegularFile(path: string, maxBytes: number): Promise<{
	handle: Awaited<ReturnType<typeof open>>;
	before: BigIntStats;
}> {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const handle = await open(path, constants.O_RDONLY | noFollow);
	try {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile()) throw new Error(`Pi enforcement candidate is not a regular file: ${path}`);
		if (before.size > BigInt(maxBytes)) throw new Error(`Pi enforcement candidate file exceeds ${maxBytes} bytes: ${path}`);
		return { handle, before };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function verifyStablePath(path: string, before: BigIntStats, handle: Awaited<ReturnType<typeof open>>): Promise<void> {
	const [afterHandle, afterPath] = await Promise.all([
		handle.stat({ bigint: true }),
		lstat(path, { bigint: true }),
	]);
	if (!stableMetadata(before, afterHandle) || !stableMetadata(before, afterPath) || afterPath.isSymbolicLink()) {
		throw new Error(`Pi enforcement candidate changed while it was read: ${path}`);
	}
}

async function sha256StableFile(path: string): Promise<string> {
	const { handle, before } = await openStableRegularFile(path, MAX_CANDIDATE_FILE_BYTES);
	try {
		const hash = createHash("sha256");
		await new Promise<void>((resolveHash, rejectHash) => {
			const stream = handle.createReadStream({ autoClose: false });
			stream.on("data", chunk => hash.update(chunk));
			stream.once("error", rejectHash);
			stream.once("end", resolveHash);
		});
		await verifyStablePath(path, before, handle);
		return hash.digest("hex");
	} finally {
		await handle.close();
	}
}

async function readStableRegularFile(path: string, maxBytes: number): Promise<Buffer> {
	const { handle, before } = await openStableRegularFile(path, maxBytes);
	try {
		const bytes = await handle.readFile();
		await verifyStablePath(path, before, handle);
		return bytes;
	} finally {
		await handle.close();
	}
}

async function scanCandidate(candidateRoot: string): Promise<{ root: string; entries: PiEnforcementEntryV2[] }> {
	const rootStatus = await lstat(candidateRoot, { bigint: true });
	if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
		throw new Error("Pi enforcement candidate root must be a non-symlink directory");
	}
	const root = await realpath(candidateRoot);
	const resolvedRootStatus = await lstat(root, { bigint: true });
	if (!stableMetadata(rootStatus, resolvedRootStatus) || await realpath(candidateRoot) !== root) {
		throw new Error("Pi enforcement candidate root changed while it was resolved");
	}
	const entries: PiEnforcementEntryV2[] = [];
	const symlinks: Array<{ path: string; filesystemPath: string; linkTarget: string }> = [];

	const inspect = async (relativePath: string): Promise<void> => {
		if (entries.length >= MAX_CANDIDATE_ENTRIES) {
			throw new Error(`Pi enforcement candidate exceeds ${MAX_CANDIDATE_ENTRIES} entries`);
		}
		const path = filesystemPath(root, relativePath);
		const before = await lstat(path, { bigint: true });
		const mode = Number(before.mode & 0o7777n);
		if (before.isDirectory()) {
			entries.push({ path: relativePath, type: "directory", mode, byteLength: 0 });
			const names = (await readdir(path)).sort(compareText);
			for (const name of names) {
				const child = relativePath === "." ? name : `${relativePath}/${name}`;
				await inspect(child);
			}
		} else if (before.isFile()) {
			if (before.size > BigInt(MAX_CANDIDATE_FILE_BYTES)) {
				throw new Error(`Pi enforcement candidate file exceeds ${MAX_CANDIDATE_FILE_BYTES} bytes: ${relativePath}`);
			}
			entries.push({
				path: relativePath,
				type: "file",
				mode,
				byteLength: Number(before.size),
				sha256: await sha256StableFile(path),
			});
		} else if (before.isSymbolicLink()) {
			const linkTarget = await readlink(path);
			if (!linkTarget || linkTarget.includes("\0") || linkTarget.includes("\\") || isAbsolute(linkTarget)) {
				throw new Error(`Pi enforcement candidate symlink target must be relative: ${relativePath}`);
			}
			const lexicalTarget = resolve(dirname(path), linkTarget);
			if (!isWithin(root, lexicalTarget)) {
				throw new Error(`Pi enforcement candidate symlink escapes the reviewed tree: ${relativePath}`);
			}
			entries.push({
				path: relativePath,
				type: "symlink",
				mode,
				byteLength: Number(before.size),
				linkTarget,
			});
			symlinks.push({ path: relativePath, filesystemPath: path, linkTarget });
		} else {
			throw new Error(`Pi enforcement candidate contains a special file: ${relativePath}`);
		}
		const after = await lstat(path, { bigint: true });
		if (!stableMetadata(before, after)) {
			throw new Error(`Pi enforcement candidate changed while it was scanned: ${relativePath}`);
		}
	};

	await inspect(".");
	for (const symlink of symlinks) {
		let target: string;
		try {
			target = await realpath(symlink.filesystemPath);
		} catch {
			throw new Error(`Pi enforcement candidate symlink target is missing: ${symlink.path}`);
		}
		if (!isWithin(root, target)) {
			throw new Error(`Pi enforcement candidate symlink resolves outside the reviewed tree: ${symlink.path}`);
		}
	}
	return { root, entries };
}

function validateArtifacts(value: unknown): PiEnforcementArtifactV2[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
		throw new Error("Pi enforcement manifest must declare 1 to 256 required artifacts");
	}
	const roles = new Set<string>();
	const paths = new Set<string>();
	const artifacts = value.map<PiEnforcementArtifactV2>((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error(`Pi enforcement artifact ${index} is invalid`);
		}
		const raw = item as Record<string, unknown>;
		if (typeof raw.role !== "string" || !ROLE_PATTERN.test(raw.role)) {
			throw new Error(`Pi enforcement artifact ${index} has an invalid role`);
		}
		if (typeof raw.path !== "string") throw new Error(`Pi enforcement artifact ${raw.role} has an invalid path`);
		const path = normalizeRelativePath(raw.path, `Pi enforcement artifact ${raw.role}`);
		if (raw.type !== "directory" && raw.type !== "file" && raw.type !== "symlink") {
			throw new Error(`Pi enforcement artifact ${raw.role} has an invalid object type`);
		}
		const type = raw.type as PiEnforcementObjectType;
		if (roles.has(raw.role)) throw new Error(`Pi enforcement artifact role is duplicated: ${raw.role}`);
		if (paths.has(path)) throw new Error(`Pi enforcement artifact path is duplicated: ${path}`);
		roles.add(raw.role);
		paths.add(path);
		return { role: raw.role, path, type };
	});
	return artifacts.sort((left, right) => compareText(left.role, right.role));
}

function validateEntries(value: unknown): PiEnforcementEntryV2[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CANDIDATE_ENTRIES) {
		throw new Error("Pi enforcement manifest has an invalid entry count");
	}
	const paths = new Set<string>();
	const entries = value.map<PiEnforcementEntryV2>((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error(`Pi enforcement entry ${index} is invalid`);
		}
		const raw = item as Record<string, unknown>;
		if (typeof raw.path !== "string") throw new Error(`Pi enforcement entry ${index} has an invalid path`);
		const path = normalizeRelativePath(raw.path, `Pi enforcement entry ${index}`);
		if (paths.has(path)) throw new Error(`Pi enforcement manifest duplicates path: ${path}`);
		paths.add(path);
		if (raw.type !== "directory" && raw.type !== "file" && raw.type !== "symlink") {
			throw new Error(`Pi enforcement entry ${path} has an invalid object type`);
		}
		const type = raw.type as PiEnforcementObjectType;
		if (!Number.isSafeInteger(raw.mode) || Number(raw.mode) < 0 || Number(raw.mode) > 0o7777) {
			throw new Error(`Pi enforcement entry ${path} has an invalid mode`);
		}
		if (!Number.isSafeInteger(raw.byteLength) || Number(raw.byteLength) < 0) {
			throw new Error(`Pi enforcement entry ${path} has an invalid byte length`);
		}
		if (type === "file") {
			if (typeof raw.sha256 !== "string" || !SHA256_PATTERN.test(raw.sha256) || raw.linkTarget !== undefined) {
				throw new Error(`Pi enforcement file entry ${path} has invalid content evidence`);
			}
			return { path, type, mode: Number(raw.mode), byteLength: Number(raw.byteLength), sha256: raw.sha256 };
		}
		if (type === "symlink") {
			if (typeof raw.linkTarget !== "string" || raw.linkTarget.includes("\0") || raw.sha256 !== undefined) {
				throw new Error(`Pi enforcement symlink entry ${path} has invalid target evidence`);
			}
			return { path, type, mode: Number(raw.mode), byteLength: Number(raw.byteLength), linkTarget: raw.linkTarget };
		}
		if (Number(raw.byteLength) !== 0 || raw.sha256 !== undefined || raw.linkTarget !== undefined) {
			throw new Error(`Pi enforcement directory entry ${path} has invalid content evidence`);
		}
		return { path, type, mode: Number(raw.mode), byteLength: 0 };
	});
	entries.sort((left, right) => compareText(left.path, right.path));
	if (entries[0]?.path !== "." || entries[0].type !== "directory") {
		throw new Error("Pi enforcement manifest must include the candidate root directory as '.'");
	}
	return entries;
}

export function validatePiEnforcementManifestV2(value: unknown): Readonly<PiEnforcementManifestV2> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pi enforcement manifest must be an object");
	const raw = value as Record<string, unknown>;
	if (raw.version !== 2 || raw.algorithm !== "sha256") throw new Error("Pi enforcement manifest must use version 2 and sha256");
	const artifacts = validateArtifacts(raw.artifacts);
	const entries = validateEntries(raw.entries);
	const entriesByPath = new Map(entries.map(entry => [entry.path, entry]));
	for (const artifact of artifacts) {
		const entry = entriesByPath.get(artifact.path);
		if (!entry) throw new Error(`Pi enforcement manifest is missing required artifact ${artifact.role}: ${artifact.path}`);
		if (entry.type !== artifact.type) throw new Error(`Pi enforcement artifact ${artifact.role} has the wrong object type`);
	}
	return Object.freeze({
		version: 2 as const,
		algorithm: "sha256" as const,
		artifacts: Object.freeze(artifacts.map(artifact => Object.freeze(artifact))),
		entries: Object.freeze(entries.map(entry => Object.freeze(entry))),
	});
}

export async function buildPiEnforcementManifestV2(
	candidateRoot: string,
	requiredArtifacts: readonly PiEnforcementArtifactV2[],
): Promise<Readonly<PiEnforcementManifestEnvelopeV2>> {
	const artifacts = validateArtifacts(requiredArtifacts);
	const scanned = await scanCandidate(candidateRoot);
	const manifest = validatePiEnforcementManifestV2({
		version: 2,
		algorithm: "sha256",
		artifacts,
		entries: scanned.entries,
	});
	return Object.freeze({ manifest, manifestSha256: manifestDigest(manifest) });
}

function firstManifestDifference(
	expected: Readonly<PiEnforcementManifestV2>,
	observed: Readonly<PiEnforcementManifestV2>,
): string {
	const expectedByPath = new Map(expected.entries.map(entry => [entry.path, entry]));
	const observedByPath = new Map(observed.entries.map(entry => [entry.path, entry]));
	for (const path of [...expectedByPath.keys()].sort(compareText)) {
		const candidate = observedByPath.get(path);
		if (!candidate) return `missing manifest entry: ${path}`;
		if (canonicalJson(candidate) !== canonicalJson(expectedByPath.get(path))) return `changed manifest entry: ${path}`;
	}
	for (const path of [...observedByPath.keys()].sort(compareText)) {
		if (!expectedByPath.has(path)) return `unexpected manifest entry: ${path}`;
	}
	return "manifest metadata differs";
}

export async function verifyPiEnforcementCandidateV2(
	candidateRoot: string,
	expectedManifestValue: unknown,
	expectedManifestSha256: string,
): Promise<Readonly<PiEnforcementVerificationV2>> {
	if (!SHA256_PATTERN.test(expectedManifestSha256)) throw new Error("reviewed Pi enforcement manifest digest is invalid");
	const expected = validatePiEnforcementManifestV2(expectedManifestValue);
	const digest = manifestDigest(expected);
	if (digest !== expectedManifestSha256) throw new Error("reviewed Pi enforcement manifest digest does not match its content");
	const scanned = await scanCandidate(candidateRoot);
	const observed = validatePiEnforcementManifestV2({
		version: 2,
		algorithm: "sha256",
		artifacts: expected.artifacts,
		entries: scanned.entries,
	});
	if (canonicalJson(observed) !== canonicalJson(expected)) {
		throw new Error(`Pi enforcement candidate differs from the reviewed manifest: ${firstManifestDifference(expected, observed)}`);
	}
	return Object.freeze({ manifestSha256: digest, entryCount: observed.entries.length, candidateRoot: scanned.root });
}

export async function readPiEnforcementManifestV2(path: string): Promise<Readonly<PiEnforcementManifestV2>> {
	let bytes: Buffer;
	try {
		bytes = await readStableRegularFile(path, MAX_MANIFEST_BYTES);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
		if (code === "ELOOP") throw new Error("Pi enforcement manifest must be a regular non-symlink file");
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new Error("Pi enforcement manifest is not valid UTF-8 JSON");
	}
	return validatePiEnforcementManifestV2(value);
}

export function serializePiEnforcementManifestV2(manifestValue: unknown): string {
	const manifest = validatePiEnforcementManifestV2(manifestValue);
	return `${JSON.stringify(manifest, null, 2)}\n`;
}
