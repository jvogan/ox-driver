import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rmdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { reapDetachedProcessGroup } from "@ox-driver/core";

const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_REQUEST_BYTES = 256;
const MAX_SUCCESSFUL_REQUESTS = 2;
const MAX_CONNECTIONS = 8;
const HELPER_TIMEOUT_MS = 5_000;
const CLIENT_TIMEOUT_MS = 2_000;
const MAX_BROKER_LIFETIME_MS = 86_410_000;
const SOCKET_BASENAME = "pi-credential.sock";
const SOCKET_ENV = "OX_DRIVER_PI_CREDENTIAL_BROKER_SOCKET";
const TOKEN_ENV = "OX_DRIVER_PI_CREDENTIAL_BROKER_TOKEN";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface PiCredentialBrokerContract {
	version: 1;
	protocol: "token-line-length-prefixed-v1";
	socketEnvironment: typeof SOCKET_ENV;
	tokenEnvironment: typeof TOKEN_ENV;
	maxCredentialBytes: number;
	maxRequestBytes: number;
	maxSuccessfulRequests: number;
	maxConnections: number;
	helperTimeoutMs: number;
	clientTimeoutMs: number;
	brokerLifetimePolicy: "caller-run-deadline-plus-grace";
	maxBrokerLifetimeMs: number;
}

export const PI_CREDENTIAL_BROKER_CONTRACT: Readonly<PiCredentialBrokerContract> = Object.freeze({
	version: 1,
	protocol: "token-line-length-prefixed-v1",
	socketEnvironment: SOCKET_ENV,
	tokenEnvironment: TOKEN_ENV,
	maxCredentialBytes: MAX_CREDENTIAL_BYTES,
	maxRequestBytes: MAX_REQUEST_BYTES,
	maxSuccessfulRequests: MAX_SUCCESSFUL_REQUESTS,
	maxConnections: MAX_CONNECTIONS,
	helperTimeoutMs: HELPER_TIMEOUT_MS,
	clientTimeoutMs: CLIENT_TIMEOUT_MS,
	brokerLifetimePolicy: "caller-run-deadline-plus-grace",
	maxBrokerLifetimeMs: MAX_BROKER_LIFETIME_MS,
});

export const PI_CREDENTIAL_BROKER_CONTRACT_SHA256 = createHash("sha256")
	.update("ox-driver-pi-credential-broker-contract-v1\0")
	.update(JSON.stringify(PI_CREDENTIAL_BROKER_CONTRACT))
	.digest("hex");

export interface PiCredentialBroker {
	readonly version: 1;
	readonly socketPath: string;
	readonly socketDirectory: string;
	readonly socketDirectoryDevice: string;
	readonly socketDirectoryInode: string;
	readonly socketDevice: string;
	readonly socketInode: string;
	readonly contractSha256: string;
	readonly credentialHelperPath: string;
	readonly credentialHelperSha256: string;
	readonly stagedCredentialHelperPath: string;
	readonly stagedCredentialHelperSha256: string;
	readonly environment: Readonly<Record<typeof SOCKET_ENV | typeof TOKEN_ENV, string>>;
	readonly successfulRequests: () => number;
	close(): Promise<void>;
}

function stableMetadata(before: BigIntStats, after: BigIntStats): boolean {
	return before.dev === after.dev
		&& before.ino === after.ino
		&& before.mode === after.mode
		&& before.size === after.size
		&& before.mtimeNs === after.mtimeNs
		&& before.ctimeNs === after.ctimeNs;
}

async function sha256StableRegularFile(path: string): Promise<string> {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const handle = await open(path, constants.O_RDONLY | noFollow);
	try {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile()) throw new Error("Pi credential source is not a regular file");
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
			throw new Error("Pi credential source changed while it was verified");
		}
		return hash.digest("hex");
	} finally {
		await handle.close();
	}
}

function minimalCredentialEnvironment(): NodeJS.ProcessEnv {
	const user = process.env.USER?.trim();
	if (!user || !/^[A-Za-z0-9._-]+$/.test(user)) {
		throw new Error("Pi credential broker requires a simple controller USER identity");
	}
	return {
		HOME: homedir(),
		PATH: "/usr/bin:/bin",
		USER: user,
		LOGNAME: user,
		LANG: "C",
		LC_ALL: "C",
		PI_ROUTER_KEYCHAIN_SERVICE: "OPENROUTER_API_KEY",
		PI_ROUTER_KEYCHAIN_STRICT: "1",
	};
}

async function loadCredential(input: {
	credentialHelper: string;
	expectedSha256: string;
	stageDirectory: string;
	onStaged?: (identity: CleanupIdentity) => void;
	signal?: AbortSignal;
}): Promise<{ sourcePath: string; stagedPath: string; stagedSha256: string; bytes: Buffer }> {
	if (!SHA256_PATTERN.test(input.expectedSha256)) throw new Error("Pi credential helper digest evidence is invalid");
	input.signal?.throwIfAborted();
	const helper = await realpath(input.credentialHelper);
	if (helper !== input.credentialHelper) throw new Error("Pi credential helper must use its canonical path");
	if (await sha256StableRegularFile(helper) !== input.expectedSha256) {
		throw new Error("Pi credential helper changed before trusted-controller invocation");
	}
	const stagedPath = join(input.stageDirectory, "credential-source");
	const sourceHandle = await open(helper, constants.O_RDONLY | constants.O_NOFOLLOW);
	let stagedHandle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const before = await sourceHandle.stat({ bigint: true });
		if (!before.isFile() || before.size > 1024n * 1024n) throw new Error("Pi credential helper is not a bounded regular file");
		const bytes = await sourceHandle.readFile();
		if (createHash("sha256").update(bytes).digest("hex") !== input.expectedSha256) {
			bytes.fill(0);
			throw new Error("Pi credential helper changed before private staging");
		}
		stagedHandle = await open(stagedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o500);
		await stagedHandle.writeFile(bytes);
		await stagedHandle.sync();
		bytes.fill(0);
		const [afterHandle, afterPath] = await Promise.all([
			sourceHandle.stat({ bigint: true }),
			lstat(helper, { bigint: true }),
		]);
		if (!stableMetadata(before, afterHandle) || !stableMetadata(before, afterPath) || afterPath.isSymbolicLink()) {
			throw new Error("Pi credential helper changed while it was privately staged");
		}
	} finally {
		await stagedHandle?.close();
		await sourceHandle.close();
	}
	await chmod(stagedPath, 0o500);
	const stagedSha256 = await sha256StableRegularFile(stagedPath);
	if (stagedSha256 !== input.expectedSha256) throw new Error("Pi staged credential helper digest is inconsistent");
	const stagedStatus = await lstat(stagedPath, { bigint: true });
	input.onStaged?.({ device: String(stagedStatus.dev), inode: String(stagedStatus.ino) });
	const credential = await new Promise<Buffer>((resolveCredential, rejectCredential) => {
		const child = spawn(stagedPath, [], {
			env: minimalCredentialEnvironment(),
			stdio: ["ignore", "pipe", "ignore"],
			detached: process.platform !== "win32",
		});
		const chunks: Buffer[] = [];
		let bytes = 0;
		let settled = false;
		let overflow = false;
		const zeroChunks = (): void => { for (const chunk of chunks) chunk.fill(0); };
		const rejectOnce = (error: Error): void => {
			if (settled) return;
			settled = true;
			zeroChunks();
			rejectCredential(error);
		};
		const timeout = setTimeout(() => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch { /* already gone */ }
			rejectOnce(new Error("Pi credential helper exceeded the trusted-controller deadline"));
		}, HELPER_TIMEOUT_MS);
		timeout.unref();
		const abort = (): void => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch { /* already gone */ }
			rejectOnce(new Error("Pi credential helper was cancelled"));
		};
		input.signal?.addEventListener("abort", abort, { once: true });
		if (input.signal?.aborted) abort();
		child.stdout.on("data", (chunk: Buffer) => {
			if (overflow) {
				chunk.fill(0);
				return;
			}
			bytes += chunk.length;
			if (bytes > MAX_CREDENTIAL_BYTES) {
				overflow = true;
				chunk.fill(0);
				try {
					if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
					else child.kill("SIGKILL");
				} catch { /* already gone */ }
				return;
			}
			chunks.push(chunk);
		});
		child.once("error", () => rejectOnce(new Error("Pi credential helper could not be invoked by the trusted controller")));
		child.once("close", async (code) => {
			clearTimeout(timeout);
			input.signal?.removeEventListener("abort", abort);
			if (child.pid && process.platform !== "win32") await reapDetachedProcessGroup(child.pid).catch(() => undefined);
			if (settled) return;
			if (overflow) {
				rejectOnce(new Error("Pi credential helper output exceeded the bounded in-memory capsule"));
				return;
			}
			if (code !== 0 || bytes === 0) {
				rejectOnce(new Error("Pi credential helper did not return a nonempty route credential"));
				return;
			}
			const combined = Buffer.concat(chunks, bytes);
			zeroChunks();
			if (combined.includes(0) || combined.includes(0x0a) || combined.includes(0x0d)) {
				combined.fill(0);
				rejectOnce(new Error("Pi credential helper returned an unsupported credential encoding"));
				return;
			}
			settled = true;
			resolveCredential(combined);
		});
	});
	if (input.signal?.aborted) {
		credential.fill(0);
		input.signal.throwIfAborted();
	}
	if (await sha256StableRegularFile(helper) !== input.expectedSha256) {
		credential.fill(0);
		throw new Error("Pi credential helper changed during trusted-controller invocation");
	}
	if (await sha256StableRegularFile(stagedPath) !== stagedSha256) {
		credential.fill(0);
		throw new Error("Pi staged credential helper changed during trusted-controller invocation");
	}
	return { sourcePath: helper, stagedPath, stagedSha256, bytes: credential };
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolveClose) => {
		try { server.close(() => resolveClose()); } catch { resolveClose(); }
	});
}

interface CleanupIdentity {
	device: string;
	inode: string;
}

async function assertDirectoryIdentity(path: string, expected: CleanupIdentity): Promise<void> {
	const status = await lstat(path, { bigint: true });
	if (!status.isDirectory() || status.isSymbolicLink()
		|| String(status.dev) !== expected.device || String(status.ino) !== expected.inode) {
		throw new Error("Pi credential broker directory identity changed; cleanup retained the path");
	}
}

async function unlinkKnownBrokerEntry(
	directory: string,
	directoryIdentity: CleanupIdentity,
	path: string,
	type: "file" | "socket",
	expectedIdentity?: CleanupIdentity,
): Promise<void> {
	await assertDirectoryIdentity(directory, directoryIdentity);
	let status: BigIntStats;
	try {
		status = await lstat(path, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (status.isSymbolicLink() || (type === "file" ? !status.isFile() : !status.isSocket())
		|| (expectedIdentity && (String(status.dev) !== expectedIdentity.device
			|| String(status.ino) !== expectedIdentity.inode))) {
		throw new Error("Pi credential broker entry identity changed; cleanup retained the path");
	}
	await unlink(path);
}

async function cleanupBrokerDirectory(input: {
	directory: string;
	directoryIdentity: CleanupIdentity;
	stagedPath: string;
	stagedIdentity?: CleanupIdentity;
	socketPath: string;
	socketIdentity?: CleanupIdentity;
}): Promise<void> {
	if (input.socketIdentity) {
		await unlinkKnownBrokerEntry(input.directory, input.directoryIdentity, input.socketPath, "socket", input.socketIdentity);
	}
	if (input.stagedIdentity) {
		await unlinkKnownBrokerEntry(input.directory, input.directoryIdentity, input.stagedPath, "file", input.stagedIdentity);
	}
	await assertDirectoryIdentity(input.directory, input.directoryIdentity);
	// Nonrecursive removal intentionally fails and retains evidence if any
	// unexpected entry exists in the private directory.
	await rmdir(input.directory);
}

export async function startPiCredentialBroker(input: {
	controllerRoot: string;
	credentialHelper: string;
	credentialHelperSha256: string;
	lifetimeMs: number;
	signal?: AbortSignal;
}): Promise<PiCredentialBroker> {
	if (!Number.isSafeInteger(input.lifetimeMs) || input.lifetimeMs < CLIENT_TIMEOUT_MS
		|| input.lifetimeMs > MAX_BROKER_LIFETIME_MS) {
		throw new Error("Pi credential broker lifetime must match a bounded controller run deadline");
	}
	const root = await realpath(input.controllerRoot);
	const [rootStatus, inputRootStatus] = await Promise.all([
		lstat(root, { bigint: true }),
		lstat(input.controllerRoot, { bigint: true }),
	]);
	const expectedUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : rootStatus.uid;
	if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink() || inputRootStatus.isSymbolicLink()
		|| rootStatus.dev !== inputRootStatus.dev || rootStatus.ino !== inputRootStatus.ino
		|| rootStatus.uid !== expectedUid || (rootStatus.mode & 0o077n) !== 0n) {
		throw new Error("Pi credential broker root must be a canonical private caller-owned directory");
	}
	const socketDirectory = await mkdtemp(join(tmpdir(), "ox-pi-b-"));
	await chmod(socketDirectory, 0o700);
	const socketRoot = await realpath(socketDirectory);
	const socketRootStatus = await lstat(socketRoot, { bigint: true });
	const socketRootIdentity = {
		device: String(socketRootStatus.dev),
		inode: String(socketRootStatus.ino),
	};
	if (socketRootStatus.isSymbolicLink() || !socketRootStatus.isDirectory() || socketRootStatus.uid !== expectedUid
		|| (socketRootStatus.mode & 0o077n) !== 0n) {
		await rmdir(socketDirectory).catch(() => undefined);
		throw new Error("Pi credential broker socket directory is not a private controller-owned directory");
	}
	const socketPath = join(socketRoot, SOCKET_BASENAME);
	const stagedPath = join(socketRoot, "credential-source");
	if (Buffer.byteLength(socketPath, "utf8") > 100) {
		await cleanupBrokerDirectory({
			directory: socketRoot,
			directoryIdentity: socketRootIdentity,
			stagedPath,
			socketPath,
		});
		throw new Error("Pi credential broker socket path exceeds the reviewed local limit");
	}
	try {
		await lstat(socketPath);
		throw new Error("Pi credential broker socket path already exists");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			await cleanupBrokerDirectory({
				directory: socketRoot,
				directoryIdentity: socketRootIdentity,
				stagedPath,
				socketPath,
			}).catch(() => undefined);
			throw error;
		}
	}

	let loaded: Awaited<ReturnType<typeof loadCredential>>;
	let provisionalStagedIdentity: CleanupIdentity | undefined;
	try {
		loaded = await loadCredential({
			credentialHelper: input.credentialHelper,
			expectedSha256: input.credentialHelperSha256,
			stageDirectory: socketRoot,
			onStaged: identity => { provisionalStagedIdentity = identity; },
			...(input.signal ? { signal: input.signal } : {}),
		});
	} catch (error) {
		await cleanupBrokerDirectory({
			directory: socketRoot,
			directoryIdentity: socketRootIdentity,
			stagedPath,
			...(provisionalStagedIdentity ? { stagedIdentity: provisionalStagedIdentity } : {}),
			socketPath,
		}).catch(() => undefined);
		throw error;
	}
	let stagedIdentityStatus: BigIntStats;
	try {
		stagedIdentityStatus = await lstat(loaded.stagedPath, { bigint: true });
	} catch (error) {
		loaded.bytes.fill(0);
		await cleanupBrokerDirectory({
			directory: socketRoot,
			directoryIdentity: socketRootIdentity,
			stagedPath: loaded.stagedPath,
			...(provisionalStagedIdentity ? { stagedIdentity: provisionalStagedIdentity } : {}),
			socketPath,
		}).catch(() => undefined);
		throw error;
	}
	const stagedIdentity = { device: String(stagedIdentityStatus.dev), inode: String(stagedIdentityStatus.ino) };
	if (!provisionalStagedIdentity || stagedIdentity.device !== provisionalStagedIdentity.device
		|| stagedIdentity.inode !== provisionalStagedIdentity.inode) {
		loaded.bytes.fill(0);
		await cleanupBrokerDirectory({
			directory: socketRoot,
			directoryIdentity: socketRootIdentity,
			stagedPath: loaded.stagedPath,
			...(provisionalStagedIdentity ? { stagedIdentity: provisionalStagedIdentity } : {}),
			socketPath,
		}).catch(() => undefined);
		throw new Error("Pi staged credential helper identity changed before broker creation");
	}
	const token = randomBytes(32);
	const tokenHex = token.toString("hex");
	const tokenWire = Buffer.from(tokenHex, "ascii");
	token.fill(0);
	const clients = new Set<Socket>();
	let successfulRequests = 0;
	let connections = 0;
	let closed = false;
	const server = createServer((socket) => {
		connections += 1;
		clients.add(socket);
		socket.setTimeout(CLIENT_TIMEOUT_MS);
		let request = Buffer.alloc(0);
		let consumed = false;
		const reject = (): void => {
			request.fill(0);
			request = Buffer.alloc(0);
			socket.destroy();
		};
		if (connections > MAX_CONNECTIONS || closed) {
			reject();
			return;
		}
		socket.on("timeout", reject);
		socket.on("data", (chunk: Buffer) => {
			if (consumed || request.length + chunk.length > MAX_REQUEST_BYTES || request.includes(0x0a)) {
				chunk.fill(0);
				reject();
				return;
			}
			const previous = request;
			request = Buffer.concat([previous, chunk]);
			previous.fill(0);
			chunk.fill(0);
			const newline = request.indexOf(0x0a);
			if (newline === -1) return;
			if (newline !== request.length - 1 || successfulRequests >= MAX_SUCCESSFUL_REQUESTS) {
				reject();
				return;
			}
			const candidate = request.subarray(0, newline);
			const authorized = candidate.length === tokenWire.length && timingSafeEqual(candidate, tokenWire);
			if (!authorized) {
				reject();
				return;
			}
			successfulRequests += 1;
			consumed = true;
			socket.pause();
			request.fill(0);
			request = Buffer.alloc(0);
			const header = Buffer.alloc(4);
			header.writeUInt32BE(loaded.bytes.length, 0);
			socket.write(header);
			socket.end(loaded.bytes, () => header.fill(0));
		});
		socket.once("close", () => {
			request.fill(0);
			clients.delete(socket);
		});
		socket.once("error", () => reject());
	});
	let socketIdentity: BigIntStats | undefined;
	try {
		await new Promise<void>((resolveListen, rejectListen) => {
			server.once("error", rejectListen);
			server.listen(socketPath, () => {
				server.removeListener("error", rejectListen);
				resolveListen();
			});
		});
		await chmod(socketPath, 0o600);
		socketIdentity = await lstat(socketPath, { bigint: true });
		if (!socketIdentity.isSocket() || socketIdentity.isSymbolicLink() || socketIdentity.uid !== expectedUid
			|| (socketIdentity.mode & 0o177n) !== 0n) {
			throw new Error("Pi credential broker socket did not retain its private identity");
		}
	} catch (error) {
		for (const client of clients) client.destroy();
		await closeServer(server).catch(() => undefined);
		loaded.bytes.fill(0);
		tokenWire.fill(0);
		await cleanupBrokerDirectory({
			directory: socketRoot,
			directoryIdentity: socketRootIdentity,
			stagedPath: loaded.stagedPath,
			stagedIdentity,
			socketPath,
		}).catch(() => undefined);
		throw error;
	}
	if (!socketIdentity) throw new Error("Pi credential broker socket identity was not established");
	const socketIdentityValue = { device: String(socketIdentity.dev), inode: String(socketIdentity.ino) };
	let revoked = false;
	const revoke = (): void => {
		if (revoked) return;
		revoked = true;
		closed = true;
		for (const client of clients) client.destroy();
		loaded.bytes.fill(0);
		tokenWire.fill(0);
	};
	let cleanupPromise: Promise<void> | undefined;
	const cleanup = (): Promise<void> => {
		if (cleanupPromise) return cleanupPromise;
		cleanupPromise = (async () => {
			revoke();
			await closeServer(server).catch(() => undefined);
			await cleanupBrokerDirectory({
				directory: socketRoot,
				directoryIdentity: socketRootIdentity,
				stagedPath: loaded.stagedPath,
				stagedIdentity,
				socketPath,
				socketIdentity: socketIdentityValue,
			});
		})();
		return cleanupPromise;
	};
	// Keep a post-listen error handler installed. A late server error must close
	// and zero the capsule, never surface as an uncaught controller exception.
	server.on("error", () => {
		revoke();
	});
	const lifetime = setTimeout(() => {
		revoke();
	}, input.lifetimeMs);
	lifetime.unref();
	// Revocation is synchronous and retains the bound socket inode for the
	// adapter's post-run containment verification. Only final cleanup closes the
	// Node server because server.close() unlinks Unix sockets on macOS.
	const abort = (): void => revoke();
	input.signal?.addEventListener("abort", abort, { once: true });
	if (input.signal?.aborted) revoke();

	return Object.freeze({
		version: 1 as const,
		socketPath,
		socketDirectory: socketRoot,
		socketDirectoryDevice: socketRootIdentity.device,
		socketDirectoryInode: socketRootIdentity.inode,
		socketDevice: String(socketIdentity.dev),
		socketInode: String(socketIdentity.ino),
		contractSha256: PI_CREDENTIAL_BROKER_CONTRACT_SHA256,
		credentialHelperPath: loaded.sourcePath,
		credentialHelperSha256: input.credentialHelperSha256,
		stagedCredentialHelperPath: loaded.stagedPath,
		stagedCredentialHelperSha256: loaded.stagedSha256,
		environment: Object.freeze({
			[SOCKET_ENV]: socketPath,
			[TOKEN_ENV]: tokenHex,
		}),
		successfulRequests: () => successfulRequests,
		close: async (): Promise<void> => {
			clearTimeout(lifetime);
			input.signal?.removeEventListener("abort", abort);
			await cleanup();
		},
	});
}

export function piCredentialClientSource(nodeInterpreter: string): string {
	if (!nodeInterpreter.startsWith("/") || nodeInterpreter.includes("\n") || nodeInterpreter.includes("\0")) {
		throw new Error("Pi credential client requires an absolute NUL-free Node interpreter");
	}
	return `#!${nodeInterpreter}
import { createConnection } from "node:net";

const socketPath = process.env.${SOCKET_ENV};
const token = process.env.${TOKEN_ENV};
delete process.env.${SOCKET_ENV};
delete process.env.${TOKEN_ENV};
if (!socketPath || !token || !/^[0-9a-f]{64}$/.test(token)) fail();
const client = createConnection({ path: socketPath });
const chunks = [];
let bytes = 0;
let settled = false;
const timer = setTimeout(fail, ${CLIENT_TIMEOUT_MS});
timer.unref();
function zero() { for (const chunk of chunks) chunk.fill(0); }
function fail() {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  zero();
  client.destroy();
  process.stderr.write("Pi route credential broker unavailable.\\n");
  process.exitCode = 72;
}
client.once("connect", () => client.write(token + "\\n"));
client.on("data", (chunk) => {
  if (settled) { chunk.fill(0); return; }
  bytes += chunk.length;
  if (bytes > ${MAX_CREDENTIAL_BYTES + 4}) { chunk.fill(0); fail(); return; }
  chunks.push(chunk);
});
client.once("end", () => {
  if (settled) return;
  const response = Buffer.concat(chunks, bytes);
  zero();
  if (response.length < 5 || response.readUInt32BE(0) !== response.length - 4) {
    response.fill(0);
    fail();
    return;
  }
  const key = response.subarray(4);
  if (key.includes(0) || key.includes(10) || key.includes(13)) {
    response.fill(0);
    fail();
    return;
  }
  settled = true;
  clearTimeout(timer);
  process.stdout.write(key, () => {
    response.fill(0);
  });
});
client.once("error", fail);
client.once("close", () => { if (!settled) fail(); });
`;
}
