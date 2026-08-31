import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface PiExcludedPathManifestV1 {
	version: 1;
	algorithm: "sha256";
	workspace: {
		realpath: string;
		device: string;
		inode: string;
	};
	excludedPaths: readonly string[];
}

export interface PiExcludedPathManifestEnvelopeV1 {
	manifest: Readonly<PiExcludedPathManifestV1>;
	manifestSha256: string;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function toManifestPath(root: string, candidate: string): string {
	return relative(root, candidate).split(sep).join("/") || ".";
}

function normalizedExclusions(workspaceRoot: string, values: readonly string[]): string[] {
	const unique = new Set<string>();
	for (const value of values) {
		if (!value || value.includes("\0") || value.includes("\\") || isAbsolute(value)) {
			throw new Error("Pi excluded paths must be canonical relative POSIX paths");
		}
		const target = resolve(workspaceRoot, value);
		if (!isWithin(workspaceRoot, target) || target === workspaceRoot) {
			throw new Error("Pi excluded path escapes or covers the entire workspace");
		}
		const normalized = toManifestPath(workspaceRoot, target);
		if (normalized !== value) throw new Error("Pi excluded paths must be canonical relative POSIX paths");
		unique.add(normalized);
	}
	const ordered = [...unique].sort(compareText);
	return ordered.filter((path, index) => !ordered.some((parent, parentIndex) =>
		parentIndex !== index && path.startsWith(`${parent}/`)));
}

function manifestDigest(manifest: Readonly<PiExcludedPathManifestV1>): string {
	return createHash("sha256").update(JSON.stringify({
		version: manifest.version,
		algorithm: manifest.algorithm,
		workspace: {
			realpath: manifest.workspace.realpath,
			device: manifest.workspace.device,
			inode: manifest.workspace.inode,
		},
		excludedPaths: [...manifest.excludedPaths],
	})).digest("hex");
}

export function validatePiExcludedPathManifestV1(value: unknown): Readonly<PiExcludedPathManifestV1> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pi excluded-path manifest must be an object");
	const raw = value as Record<string, unknown>;
	if (raw.version !== 1 || raw.algorithm !== "sha256") throw new Error("Pi excluded-path manifest must use version 1 and sha256");
	if (!raw.workspace || typeof raw.workspace !== "object" || Array.isArray(raw.workspace)) {
		throw new Error("Pi excluded-path manifest workspace identity is invalid");
	}
	const workspace = raw.workspace as Record<string, unknown>;
	if (typeof workspace.realpath !== "string" || !isAbsolute(workspace.realpath) || workspace.realpath.includes("\0")
		|| typeof workspace.device !== "string" || !/^[0-9]+$/.test(workspace.device)
		|| typeof workspace.inode !== "string" || !/^[0-9]+$/.test(workspace.inode)) {
		throw new Error("Pi excluded-path manifest workspace identity is invalid");
	}
	if (!Array.isArray(raw.excludedPaths) || raw.excludedPaths.some(path => typeof path !== "string")) {
		throw new Error("Pi excluded-path manifest exclusions are invalid");
	}
	const excludedPaths = normalizedExclusions(workspace.realpath, raw.excludedPaths as string[]);
	if (JSON.stringify(excludedPaths) !== JSON.stringify(raw.excludedPaths)) {
		throw new Error("Pi excluded-path manifest exclusions are not normalized and sorted");
	}
	return Object.freeze({
		version: 1 as const,
		algorithm: "sha256" as const,
		workspace: Object.freeze({
			realpath: workspace.realpath,
			device: workspace.device,
			inode: workspace.inode,
		}),
		excludedPaths: Object.freeze(excludedPaths),
	});
}

export async function createPiExcludedPathManifestV1(
	workspaceRoot: string,
	excludedPaths: readonly string[],
): Promise<Readonly<PiExcludedPathManifestEnvelopeV1>> {
	const status = await lstat(workspaceRoot, { bigint: true });
	if (status.isSymbolicLink() || !status.isDirectory()) {
		throw new Error("Pi excluded-path workspace must be a non-symlink directory");
	}
	const root = await realpath(workspaceRoot);
	const manifest = validatePiExcludedPathManifestV1({
		version: 1,
		algorithm: "sha256",
		workspace: { realpath: root, device: String(status.dev), inode: String(status.ino) },
		excludedPaths: normalizedExclusions(root, excludedPaths),
	});
	return Object.freeze({ manifest, manifestSha256: manifestDigest(manifest) });
}

function isExcluded(path: string, exclusions: readonly string[]): boolean {
	return exclusions.some(excluded => path === excluded || path.startsWith(`${excluded}/`));
}

export async function validatePiPathAgainstExcludedManifest(
	manifestValue: unknown,
	expectedManifestSha256: string,
	requestedPath: string,
	options: { allowMissingLeaf?: boolean } = {},
): Promise<string> {
	if (!SHA256_PATTERN.test(expectedManifestSha256)) throw new Error("Pi excluded-path manifest digest is invalid");
	const manifest = validatePiExcludedPathManifestV1(manifestValue);
	if (manifestDigest(manifest) !== expectedManifestSha256) throw new Error("Pi excluded-path manifest digest does not match its content");
	if (!requestedPath || requestedPath.includes("\0")) throw new Error("Pi tool path is invalid");
	const rootStatus = await lstat(manifest.workspace.realpath, { bigint: true });
	if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()
		|| String(rootStatus.dev) !== manifest.workspace.device
		|| String(rootStatus.ino) !== manifest.workspace.inode
		|| await realpath(manifest.workspace.realpath) !== manifest.workspace.realpath) {
		throw new Error("Pi excluded-path workspace identity is stale");
	}
	const candidate = isAbsolute(requestedPath)
		? resolve(requestedPath)
		: resolve(manifest.workspace.realpath, requestedPath);
	if (!isWithin(manifest.workspace.realpath, candidate)) throw new Error("Pi tool path escapes the approved workspace");
	const relativePath = toManifestPath(manifest.workspace.realpath, candidate);
	if (relativePath !== "." && isExcluded(relativePath, manifest.excludedPaths)) {
		throw new Error("Pi tool path is excluded by the per-run manifest");
	}

	const components = relativePath === "." ? [] : relativePath.split("/");
	let current = manifest.workspace.realpath;
	for (let index = 0; index < components.length; index += 1) {
		current = resolve(current, components[index] as string);
		try {
			const status = await lstat(current);
			if (status.isSymbolicLink()) throw new Error("Pi tool paths may not traverse symlinks");
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
			if (code === "ENOENT" && options.allowMissingLeaf === true && index === components.length - 1) return candidate;
			throw error;
		}
	}
	const resolved = await realpath(candidate);
	if (!isWithin(manifest.workspace.realpath, resolved)) throw new Error("Pi tool path resolves outside the approved workspace");
	const resolvedRelative = toManifestPath(manifest.workspace.realpath, resolved);
	if (resolvedRelative !== "." && isExcluded(resolvedRelative, manifest.excludedPaths)) {
		throw new Error("Pi tool path is excluded by the per-run manifest");
	}
	return resolved;
}
