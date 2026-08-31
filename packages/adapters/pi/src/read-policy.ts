import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

import { createPiExcludedPathManifestV1 } from "./excluded-paths.js";

const POLICY_FILENAME = "pi-read-policy.mjs";
const MAX_POLICY_BYTES = 1024 * 1024;

export interface PiReadPolicyExtensionV1 {
	path: string;
	sha256: string;
}

function stableMetadata(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev
		&& left.ino === right.ino
		&& left.mode === right.mode
		&& left.size === right.size
		&& left.mtimeNs === right.mtimeNs
		&& left.ctimeNs === right.ctimeNs;
}

function noFollowFlag(): number {
	if (typeof constants.O_NOFOLLOW !== "number") throw new Error("Pi read policy requires O_NOFOLLOW support");
	return constants.O_NOFOLLOW;
}

function extensionSource(manifest: Awaited<ReturnType<typeof createPiExcludedPathManifestV1>>): string {
	return `import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const POLICY = Object.freeze(${JSON.stringify({
		version: 1,
		manifest: manifest.manifest,
		manifestSha256: manifest.manifestSha256,
	})});
const ALLOWED_TOOLS = new Set(["read", "grep", "find", "ls"]);

function within(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(\`..\${sep}\`) && !isAbsolute(path));
}

function manifestPath(root, candidate) {
  return relative(root, candidate).split(sep).join("/") || ".";
}

function excluded(path) {
  return POLICY.manifest.excludedPaths.some((item) => path === item || path.startsWith(\`\${item}/\`));
}

function containsExcludedDescendant(path) {
  return POLICY.manifest.excludedPaths.some((item) => path === "." || item.startsWith(\`\${path}/\`));
}

function verifyWorkspace() {
  const workspace = POLICY.manifest.workspace;
  const status = lstatSync(workspace.realpath, { bigint: true });
  if (status.isSymbolicLink() || !status.isDirectory()
    || String(status.dev) !== workspace.device
    || String(status.ino) !== workspace.inode
    || realpathSync(workspace.realpath) !== workspace.realpath) {
    throw new Error("workspace identity is stale");
  }
  return workspace.realpath;
}

function approvedPath(requestedPath) {
  if (typeof requestedPath !== "string" || requestedPath.length === 0 || requestedPath.includes("\\0")) {
    throw new Error("tool path is invalid");
  }
  const root = verifyWorkspace();
  const candidate = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(root, requestedPath);
  if (!within(root, candidate)) throw new Error("tool path escapes the approved workspace");
  const relativePath = manifestPath(root, candidate);
  if (relativePath !== "." && excluded(relativePath)) throw new Error("tool path is excluded by the per-run policy");
  const components = relativePath === "." ? [] : relativePath.split("/");
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    current = resolve(current, components[index]);
    const status = lstatSync(current);
    if (status.isSymbolicLink() && index < components.length - 1) {
      throw new Error("tool path may not traverse symlinked directories");
    }
  }
  const requestedStatus = lstatSync(candidate);
  const resolved = realpathSync(candidate);
  if (!within(root, resolved)) throw new Error("tool path resolves outside the approved workspace");
  const resolvedRelative = manifestPath(root, resolved);
  if (resolvedRelative !== "." && excluded(resolvedRelative)) throw new Error("tool path resolves into an excluded path");
  if (requestedStatus.isSymbolicLink() && !lstatSync(resolved).isFile()) {
    throw new Error("tool path symlinks may resolve only to approved regular workspace files");
  }
  return { path: resolved, relativePath: resolvedRelative };
}

function blocked(reason) {
  return { block: true, reason: \`Ox Driver Pi read policy blocked the call: \${reason}.\` };
}

export default function oxDriverPiReadPolicy(pi) {
  pi.on("tool_call", (event) => {
    try {
      if (!ALLOWED_TOOLS.has(event.toolName)) return blocked(\`tool \${String(event.toolName)} is not allowed\`);
      const input = event.input && typeof event.input === "object" ? event.input : {};
      const requested = input.path === undefined && event.toolName !== "read" ? "." : input.path;
      const approved = approvedPath(requested);
      if (event.toolName === "grep" || event.toolName === "find") {
        if (containsExcludedDescendant(approved.relativePath)) {
          return blocked("recursive read would cross an excluded path");
        }
      }
      return undefined;
    } catch (error) {
      return blocked(error instanceof Error ? error.message : String(error));
    }
  });
}
`;
}

async function readStablePolicy(path: string): Promise<Buffer> {
	const handle = await open(path, constants.O_RDONLY | noFollowFlag());
	try {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile() || (before.mode & 0o077n) !== 0n || before.size > BigInt(MAX_POLICY_BYTES)) {
			throw new Error("Pi read policy must be a bounded private regular file");
		}
		const bytes = await handle.readFile();
		const [afterHandle, afterPath] = await Promise.all([
			handle.stat({ bigint: true }),
			lstat(path, { bigint: true }),
		]);
		if (afterPath.isSymbolicLink() || !stableMetadata(before, afterHandle) || !stableMetadata(before, afterPath)) {
			throw new Error("Pi read policy changed while it was read");
		}
		return bytes;
	} finally {
		await handle.close();
	}
}

export async function writePiReadPolicyExtensionV1(
	runDirectory: string,
	workspaceRoot: string,
	excludedPaths: readonly string[],
): Promise<Readonly<PiReadPolicyExtensionV1>> {
	const parent = await lstat(runDirectory, { bigint: true });
	if (parent.isSymbolicLink() || !parent.isDirectory() || (parent.mode & 0o077n) !== 0n) {
		throw new Error("Pi read-policy parent must be a private non-symlink directory");
	}
	const manifest = await createPiExcludedPathManifestV1(workspaceRoot, excludedPaths);
	const bytes = Buffer.from(extensionSource(manifest), "utf8");
	if (bytes.length > MAX_POLICY_BYTES) throw new Error("Pi read policy exceeds the maximum size");
	const path = join(runDirectory, POLICY_FILENAME);
	const handle = await open(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
		0o400,
	);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	const observed = await readStablePolicy(path);
	return Object.freeze({ path, sha256: createHash("sha256").update(observed).digest("hex") });
}

export async function verifyPiReadPolicyExtensionV1(path: string, expectedSha256: string): Promise<void> {
	if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error("Pi read-policy digest is invalid");
	const observed = createHash("sha256").update(await readStablePolicy(path)).digest("hex");
	if (observed !== expectedSha256) throw new Error("Pi read policy digest changed");
}
