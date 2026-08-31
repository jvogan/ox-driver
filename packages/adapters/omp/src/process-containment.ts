import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { chmod, lstat, open, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const DARWIN_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const DARWIN_SYSTEM_PROFILE = "/System/Library/Sandbox/Profiles/system.sb";
export const OMP_DARWIN_SEATBELT_SHA256 = "8290e4be7387a0df83cd1559e86afd880464f269450573d012795761fe298f16";
export const OMP_DARWIN_SYSTEM_PROFILE_SHA256 = "1b2c4487f32fba48f29ba871bd1fec4f8d74af9543074c8805c3bc7094b9846f";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DENIED_HOST_CONTROLLER_EXECUTABLES = [
	"/bin/launchctl",
	"/usr/bin/automator",
	"/usr/bin/defaults",
	"/usr/bin/log",
	"/usr/bin/logger",
	"/usr/bin/notifyutil",
	"/usr/bin/open",
	"/usr/bin/osascript",
	"/usr/bin/pluginkit",
	"/usr/bin/profiles",
	"/usr/bin/security",
	"/usr/bin/sfltool",
	"/usr/bin/shortcuts",
	"/usr/bin/tccutil",
] as const;

export type OmpContainmentNetworkPolicy = "configured-https-443-and-dns" | "none";

export interface OmpProcessContainmentInspection {
	available: boolean;
	kind?: "darwin-seatbelt";
	command?: string;
	boundarySha256?: string;
	systemProfilePath?: string;
	systemProfileSha256?: string;
	mechanismSha256?: string;
	notice: string;
}

export interface OmpProcessContainmentLaunch {
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
	workspace: {
		realpath: string;
		device: string;
		inode: string;
	};
	excludedPaths: readonly string[];
	controllerRoot: {
		realpath: string;
		device: string;
		inode: string;
	};
	writableRoots: readonly {
		realpath: string;
		device: string;
		inode: string;
	}[];
	immutableReadPaths: readonly {
		path: string;
		sha256: string;
	}[];
	executablePath: string;
	executableSha256: string;
	routeEnforcementSha256: string;
	networkPolicy: OmpContainmentNetworkPolicy;
}

function stableMetadata(before: BigIntStats, after: BigIntStats): boolean {
	return before.dev === after.dev
		&& before.ino === after.ino
		&& before.mode === after.mode
		&& before.size === after.size
		&& before.mtimeNs === after.mtimeNs
		&& before.ctimeNs === after.ctimeNs;
}

function combinedMechanismSha256(boundarySha256: string, systemProfileSha256: string): string {
	return createHash("sha256")
		.update("omp-darwin-seatbelt-mechanism-v1\0")
		.update(boundarySha256)
		.update("\0")
		.update(systemProfileSha256)
		.digest("hex");
}

async function sha256StableRegularFile(path: string): Promise<string> {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const handle = await open(path, constants.O_RDONLY | noFollow);
	try {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile()) throw new Error(`OMP containment evidence is not a regular file: ${path}`);
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
			throw new Error(`OMP containment evidence changed while it was hashed: ${path}`);
		}
		return hash.digest("hex");
	} finally {
		await handle.close();
	}
}

async function stageExecutable(
	sourcePath: string,
	controllerRoot: string,
	expectedSha256: string,
): Promise<{ sourcePath: string; stagedPath: string }> {
	const source = await realpath(sourcePath);
	const stagedPath = join(controllerRoot, "omp-executable");
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const sourceHandle = await open(source, constants.O_RDONLY | noFollow);
	let stagedHandle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const before = await sourceHandle.stat({ bigint: true });
		if (!before.isFile()) throw new Error("OMP executable source is not a regular file");
		stagedHandle = await open(stagedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o500);
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		let position = 0;
		for (;;) {
			const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
			let written = 0;
			while (written < bytesRead) {
				const result = await stagedHandle.write(buffer, written, bytesRead - written, position + written);
				if (result.bytesWritten === 0) throw new Error("OMP staged executable copy made no progress");
				written += result.bytesWritten;
			}
			position += bytesRead;
		}
		await stagedHandle.sync();
		const [afterHandle, afterPath] = await Promise.all([
			sourceHandle.stat({ bigint: true }),
			lstat(source, { bigint: true }),
		]);
		if (!stableMetadata(before, afterHandle) || !stableMetadata(before, afterPath) || afterPath.isSymbolicLink()) {
			throw new Error("OMP executable source changed while it was staged");
		}
		if (hash.digest("hex") !== expectedSha256) {
			throw new Error("OMP executable source digest changed while it was staged");
		}
	} finally {
		await stagedHandle?.close();
		await sourceHandle.close();
	}
	await chmod(stagedPath, 0o500);
	if (await sha256StableRegularFile(stagedPath) !== expectedSha256) {
		throw new Error("OMP staged executable differs from the reviewed source bytes");
	}
	return { sourcePath: source, stagedPath: await realpath(stagedPath) };
}

function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function canonicalPrivateDirectory(path: string, label: string): Promise<{
	realpath: string;
	device: string;
	inode: string;
}> {
	const before = await lstat(path, { bigint: true });
	if (before.isSymbolicLink() || !before.isDirectory() || (before.mode & 0o077n) !== 0n) {
		throw new Error(`OMP containment ${label} must be a private non-symlink directory`);
	}
	const canonical = await realpath(path);
	const after = await lstat(canonical, { bigint: true });
	if (!stableMetadata(before, after) || await realpath(path) !== canonical) {
		throw new Error(`OMP containment ${label} changed while it was resolved`);
	}
	return { realpath: canonical, device: String(before.dev), inode: String(before.ino) };
}

function seatbeltString(path: string): string {
	if (!isAbsolute(path) || path.includes("\0")) throw new Error("OMP Seatbelt paths must be absolute and NUL-free");
	return JSON.stringify(path);
}

function normalizedExcludedPaths(workspace: string, values: readonly string[]): string[] {
	const unique = new Set<string>();
	for (const value of values) {
		if (!value || value.includes("\0") || value.includes("\\") || isAbsolute(value)) {
			throw new Error("OMP containment exclusions must be canonical relative POSIX paths");
		}
		const target = resolve(workspace, value);
		if (!isWithin(workspace, target) || target === workspace || relative(workspace, target).split(sep).join("/") !== value) {
			throw new Error("OMP containment exclusion escapes the canonical workspace");
		}
		unique.add(value);
	}
	const ordered = [...unique].sort();
	return ordered.filter((path, index) => !ordered.some((parent, parentIndex) =>
		parentIndex !== index && path.startsWith(`${parent}/`)));
}

export async function inspectOmpProcessContainment(
	expectedBoundarySha256: string = OMP_DARWIN_SEATBELT_SHA256,
	expectedSystemProfileSha256: string = OMP_DARWIN_SYSTEM_PROFILE_SHA256,
): Promise<Readonly<OmpProcessContainmentInspection>> {
	if (process.platform !== "darwin") {
		return Object.freeze({
			available: false,
			notice: "OMP process containment is unavailable: Linux bubblewrap remains disabled until a pinned provider passes the same boundary tests",
		});
	}
	try {
		const before = await lstat(DARWIN_SANDBOX_EXEC, { bigint: true });
		if (before.isSymbolicLink() || !before.isFile() || before.uid !== 0n || (before.mode & 0o022n) !== 0n) {
			throw new Error("sandbox-exec is not a root-owned, non-writable regular file");
		}
		const command = await realpath(DARWIN_SANDBOX_EXEC);
		if (command !== DARWIN_SANDBOX_EXEC) throw new Error("sandbox-exec resolved away from its canonical system path");
		const systemProfileStatus = await lstat(DARWIN_SYSTEM_PROFILE, { bigint: true });
		if (systemProfileStatus.isSymbolicLink() || !systemProfileStatus.isFile() || systemProfileStatus.uid !== 0n
			|| (systemProfileStatus.mode & 0o022n) !== 0n) {
			throw new Error("system.sb is not a root-owned, non-writable regular file");
		}
		const systemProfilePath = await realpath(DARWIN_SYSTEM_PROFILE);
		if (systemProfilePath !== DARWIN_SYSTEM_PROFILE) throw new Error("system.sb resolved away from its canonical system path");
		const [boundarySha256, systemProfileSha256] = await Promise.all([
			sha256StableRegularFile(command),
			sha256StableRegularFile(systemProfilePath),
		]);
		if (!SHA256_PATTERN.test(expectedBoundarySha256) || boundarySha256 !== expectedBoundarySha256) {
			throw new Error(`sandbox-exec digest drifted from the reviewed mechanism: ${boundarySha256}`);
		}
		if (!SHA256_PATTERN.test(expectedSystemProfileSha256) || systemProfileSha256 !== expectedSystemProfileSha256) {
			throw new Error(`system.sb digest drifted from the reviewed mechanism: ${systemProfileSha256}`);
		}
		const mechanismSha256 = combinedMechanismSha256(boundarySha256, systemProfileSha256);
		return Object.freeze({
			available: true,
			kind: "darwin-seatbelt" as const,
			command,
			boundarySha256,
			systemProfilePath,
			systemProfileSha256,
			mechanismSha256,
			notice: "macOS Seatbelt is available through the exact reviewed root-owned sandbox-exec and system.sb mechanism",
		});
	} catch (error) {
		return Object.freeze({
			available: false,
			notice: `OMP process containment is unavailable: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
}

export async function validateOmpContainmentScope(
	workspaceRoot: string,
	excludedPaths: readonly string[],
): Promise<{ workspace: { realpath: string; device: string; inode: string }; excludedPaths: readonly string[] }> {
	const before = await lstat(workspaceRoot, { bigint: true });
	if (before.isSymbolicLink() || !before.isDirectory()) throw new Error("OMP containment workspace must be a non-symlink directory");
	const workspace = await realpath(workspaceRoot);
	const after = await lstat(workspace, { bigint: true });
	if (!stableMetadata(before, after) || await realpath(workspaceRoot) !== workspace) {
		throw new Error("OMP containment workspace changed while it was resolved");
	}
	return {
		workspace: { realpath: workspace, device: String(before.dev), inode: String(before.ino) },
		excludedPaths: Object.freeze(normalizedExcludedPaths(workspace, excludedPaths)),
	};
}

function seatbeltProfile(input: {
	workspace: string;
	excludedPaths: readonly string[];
	controllerRoot: string;
	writableRoots: readonly string[];
	immutableReadPaths: readonly string[];
	executable: string;
	executableSha256: string;
	routeEnforcementSha256: string;
	mechanismSha256: string;
	boundarySha256: string;
	systemProfileSha256: string;
	networkPolicy: OmpContainmentNetworkPolicy;
}): string {
	const systemReadRoots = [
		"/System",
		"/Library",
		"/usr",
		"/bin",
		"/sbin",
		"/dev",
		"/private/etc",
		"/private/var/db",
	];
	const allowedReads = [...systemReadRoots, input.workspace, input.controllerRoot]
		.map(path => `  (subpath ${seatbeltString(path)})`).join("\n");
	const deniedReads = input.excludedPaths
		.map(path => `  (subpath ${seatbeltString(resolve(input.workspace, path))})`).join("\n");
	const allowedWrites = input.writableRoots
		.map(path => `  (subpath ${seatbeltString(path)})`).join("\n");
	const deniedWrites = input.immutableReadPaths
		.map(path => `  (literal ${seatbeltString(path)})`).join("\n");
	const deniedHostControllers = DENIED_HOST_CONTROLLER_EXECUTABLES
		.map(path => `  (literal ${seatbeltString(path)})`).join("\n");
	return `(version 1)
; Apple system.sb supplies the minimum runtime/Mach bootstrap rules needed to
; exec dynamically linked programs. Explicit filesystem rules below retain the
; workspace/exclusion boundary.
(import "system.sb")
; ox-driver-omp-containment-v1
; executable-sha256 ${input.executableSha256}
; route-enforcement-sha256 ${input.routeEnforcementSha256}
; mechanism-sha256 ${input.mechanismSha256}
; boundary-sha256 ${input.boundarySha256}
; system-profile-sha256 ${input.systemProfileSha256}
(deny default)
(allow process*)
(deny process-exec
${deniedHostControllers}
)
(allow signal (target self))
(allow sysctl-read)
(deny sysctl-write)
(deny mach-register)
(deny network-outbound (literal "/private/var/run/syslog"))
(deny file-write*
  (subpath "/cores")
  (literal "/dev/dtracehelper")
)
(allow file-read*
${allowedReads}
)
${deniedReads ? `(deny file-read*\n${deniedReads})\n` : ""}(allow file-write*
${allowedWrites})
${deniedWrites ? `(deny file-write*\n${deniedWrites})\n` : ""}
${input.networkPolicy === "configured-https-443-and-dns" ? `(allow network-outbound
  (remote tcp "*:443")
  (literal "/private/var/run/mDNSResponder")
)` : "(deny network*)"}
`;
}

export async function createOmpProcessContainmentLaunch(input: {
	inspection: Readonly<OmpProcessContainmentInspection>;
	workspaceRoot: string;
	excludedPaths: readonly string[];
	controllerRoot: string;
	writablePaths: readonly string[];
	immutableReadPaths?: readonly { path: string; sha256: string }[];
	executable: string;
	executableSha256: string;
	routeEnforcementSha256: string;
	networkPolicy?: OmpContainmentNetworkPolicy;
}): Promise<Readonly<OmpProcessContainmentLaunch>> {
	if (!input.inspection.available || input.inspection.kind !== "darwin-seatbelt"
		|| !input.inspection.command || !input.inspection.boundarySha256 || !input.inspection.mechanismSha256
		|| !input.inspection.systemProfilePath || !input.inspection.systemProfileSha256) {
		throw new Error("OMP process containment provider is not available");
	}
	if (!SHA256_PATTERN.test(input.executableSha256) || !SHA256_PATTERN.test(input.routeEnforcementSha256)
		|| !SHA256_PATTERN.test(input.inspection.mechanismSha256)) {
		throw new Error("OMP containment digest evidence is invalid");
	}
	const scope = await validateOmpContainmentScope(input.workspaceRoot, input.excludedPaths);
	const controllerRoot = await canonicalPrivateDirectory(input.controllerRoot, "controller root");
	if (isWithin(scope.workspace.realpath, controllerRoot.realpath)
		|| isWithin(controllerRoot.realpath, scope.workspace.realpath)) {
		throw new Error("OMP containment workspace and controller root must be disjoint");
	}
	const writableRoots = await Promise.all(input.writablePaths.map((path) => canonicalPrivateDirectory(path, "writable root")));
	if (writableRoots.length === 0 || new Set(writableRoots.map(root => root.realpath)).size !== writableRoots.length
		|| writableRoots.some(root => root.realpath === controllerRoot.realpath || !isWithin(controllerRoot.realpath, root.realpath))) {
		throw new Error("OMP containment writable roots must be unique children of the controller root");
	}
	const immutableReadPaths = await Promise.all((input.immutableReadPaths ?? []).map(async (entry) => {
		if (!SHA256_PATTERN.test(entry.sha256)) throw new Error("OMP immutable read-path digest is invalid");
		const path = await realpath(entry.path);
		if (!isWithin(controllerRoot.realpath, path) || path === controllerRoot.realpath) {
			throw new Error("OMP immutable read paths must be files inside the controller root");
		}
		if (await sha256StableRegularFile(path) !== entry.sha256) {
			throw new Error("OMP immutable read path differs from its reviewed digest");
		}
		return { path, sha256: entry.sha256 };
	}));
	if (new Set(immutableReadPaths.map(entry => entry.path)).size !== immutableReadPaths.length) {
		throw new Error("OMP immutable read paths must be unique");
	}
	const sourceExecutable = await realpath(input.executable);
	if (await sha256StableRegularFile(sourceExecutable) !== input.executableSha256) {
		throw new Error("OMP executable changed while preparing process containment");
	}
	const stagedExecutable = await stageExecutable(sourceExecutable, controllerRoot.realpath, input.executableSha256);
	const executable = stagedExecutable.stagedPath;
	const networkPolicy = input.networkPolicy ?? "configured-https-443-and-dns";
	if (networkPolicy !== "configured-https-443-and-dns" && networkPolicy !== "none") {
		throw new Error("OMP containment network policy is invalid");
	}
	const profile = seatbeltProfile({
		workspace: scope.workspace.realpath,
		excludedPaths: scope.excludedPaths,
		controllerRoot: controllerRoot.realpath,
		writableRoots: writableRoots.map(root => root.realpath),
		immutableReadPaths: immutableReadPaths.map(entry => entry.path),
		executable,
		executableSha256: input.executableSha256,
		routeEnforcementSha256: input.routeEnforcementSha256,
		mechanismSha256: input.inspection.mechanismSha256,
		boundarySha256: input.inspection.boundarySha256,
		systemProfileSha256: input.inspection.systemProfileSha256,
		networkPolicy,
	});
	const profilePath = join(controllerRoot.realpath, "seatbelt.sb");
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
		writableRoots,
		immutableReadPaths,
		sourceExecutable: { path: stagedExecutable.sourcePath, sha256: input.executableSha256 },
		executable: { path: executable, sha256: input.executableSha256, staged: true },
		routeEnforcementSha256: input.routeEnforcementSha256,
		networkPolicy,
		writerPolicy: "read-only-workspace",
	};
	const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
	const evidencePath = join(controllerRoot.realpath, "containment.json");
	await writeFile(evidencePath, evidenceText, { encoding: "utf8", flag: "wx", mode: 0o400 });
	await chmod(evidencePath, 0o400);
	const evidenceSha256 = createHash("sha256").update(evidenceText).digest("hex");
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
		evidenceSha256,
		workspace: Object.freeze(scope.workspace),
		excludedPaths: Object.freeze([...scope.excludedPaths]),
		controllerRoot: Object.freeze(controllerRoot),
		writableRoots: Object.freeze(writableRoots.map(root => Object.freeze(root))),
		immutableReadPaths: Object.freeze(immutableReadPaths.map(entry => Object.freeze(entry))),
		executablePath: executable,
		executableSha256: input.executableSha256,
		routeEnforcementSha256: input.routeEnforcementSha256,
		networkPolicy,
	});
}

export async function verifyOmpProcessContainmentLaunch(
	launch: Readonly<OmpProcessContainmentLaunch>,
): Promise<void> {
	const inspection = await inspectOmpProcessContainment();
	if (!inspection.available || inspection.command !== launch.command
		|| inspection.mechanismSha256 !== launch.mechanismSha256
		|| inspection.boundarySha256 !== launch.boundarySha256
		|| inspection.systemProfilePath !== launch.systemProfilePath
		|| inspection.systemProfileSha256 !== launch.systemProfileSha256) {
		throw new Error("OMP containment mechanism changed during the run");
	}
	if (await sha256StableRegularFile(launch.profilePath) !== launch.profileSha256) {
		throw new Error("OMP containment profile changed during the run");
	}
	if (await sha256StableRegularFile(launch.evidencePath) !== launch.evidenceSha256) {
		throw new Error("OMP containment evidence changed during the run");
	}
	if (await sha256StableRegularFile(launch.executablePath) !== launch.executableSha256) {
		throw new Error("OMP staged executable changed during the run");
	}
	const controllerRoot = await canonicalPrivateDirectory(launch.controllerRoot.realpath, "controller root");
	if (controllerRoot.device !== launch.controllerRoot.device || controllerRoot.inode !== launch.controllerRoot.inode) {
		throw new Error("OMP containment controller root identity changed during the run");
	}
	for (const expected of launch.writableRoots) {
		const observed = await canonicalPrivateDirectory(expected.realpath, "writable root");
		if (observed.device !== expected.device || observed.inode !== expected.inode) {
			throw new Error("OMP containment writable root identity changed during the run");
		}
	}
	for (const expected of launch.immutableReadPaths) {
		if (await sha256StableRegularFile(expected.path) !== expected.sha256) {
			throw new Error("OMP immutable read path changed during the run");
		}
	}
	const scope = await validateOmpContainmentScope(launch.workspace.realpath, launch.excludedPaths);
	if (scope.workspace.device !== launch.workspace.device || scope.workspace.inode !== launch.workspace.inode) {
		throw new Error("OMP containment workspace identity changed during the run");
	}
}
