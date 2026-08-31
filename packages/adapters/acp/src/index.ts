import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import type {
	AdapterRunContext,
	AdapterRunResult,
	HarnessAdapter,
	HarnessCapabilities,
	PreflightIssue,
	RunSpec,
} from "@ox-driver/core";
import { reapDetachedProcessGroup } from "@ox-driver/core";

const ACP_PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_FRAMES = 10_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const PROFILE_PLACEHOLDER = "{profile}";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type JsonObject = Record<string, unknown>;

export interface AcpExpectedAgent {
	name: string;
	version?: string;
}

export interface AcpAdapterOptions {
	launcher?: string;
	launcherArgs?: readonly string[];
	expectedLauncherSha256?: string;
	profilePath?: string;
	expectedProfileSha256?: string;
	expectedAgent?: AcpExpectedAgent;
	probeInitialize?: boolean;
	quarantineReason?: string;
}

interface ResolvedLaunch {
	executable: string;
	args: string[];
	launcherSha256: string;
	profilePath: string;
	profileSha256: string;
	enforcementSha256: string;
}

interface ProtocolProbe {
	ok: boolean;
	agentInfo?: AcpExpectedAgent;
	agentCapabilities?: JsonObject;
	notices: string[];
}

class JsonLineDecoder {
	#segments: Buffer[] = [];
	#lineBytes = 0;
	#streamBytes = 0;
	#frames = 0;

	push(chunk: Buffer): JsonObject[] {
		this.#streamBytes += chunk.length;
		if (this.#streamBytes > MAX_STREAM_BYTES) throw new Error("ACP stdout exceeded the controller stream limit");
		const frames: JsonObject[] = [];
		let offset = 0;
		while (offset < chunk.length) {
			const newline = chunk.indexOf(0x0a, offset);
			const end = newline < 0 ? chunk.length : newline;
			const segment = chunk.subarray(offset, end);
			this.#lineBytes += segment.length;
			if (this.#lineBytes > MAX_FRAME_BYTES) throw new Error("ACP JSON-RPC frame exceeded the controller limit");
			if (segment.length > 0) this.#segments.push(segment);
			if (newline < 0) break;
			let line = Buffer.concat(this.#segments, this.#lineBytes);
			this.#segments = [];
			this.#lineBytes = 0;
			if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
			if (line.length === 0) throw new Error("ACP emitted an empty protocol frame");
			frames.push(this.#parse(line));
			offset = newline + 1;
		}
		return frames;
	}

	finish(): JsonObject[] {
		if (this.#lineBytes !== 0) throw new Error("ACP stdout ended with a truncated JSON-RPC frame");
		return [];
	}

	#parse(line: Buffer): JsonObject {
		this.#frames += 1;
		if (this.#frames > MAX_EVENT_FRAMES) throw new Error("ACP JSON-RPC frame count exceeded the controller limit");
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
		} catch {
			throw new Error("ACP emitted malformed JSON or invalid UTF-8");
		}
		validateJsonShape(value);
		if (!isObject(value) || value.jsonrpc !== "2.0") throw new Error("ACP emitted an invalid JSON-RPC 2.0 frame");
		return value;
	}
}

function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateJsonShape(value: unknown): void {
	const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
	let nodes = 0;
	while (stack.length > 0) {
		const current = stack.pop() as { value: unknown; depth: number };
		nodes += 1;
		if (nodes > 10_000) throw new Error("ACP JSON structure exceeded the controller node limit");
		if (current.depth > 64) throw new Error("ACP JSON structure exceeded the controller depth limit");
		if (Array.isArray(current.value)) {
			for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
		} else if (isObject(current.value)) {
			for (const child of Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1 });
		}
	}
}

function boundedAppend(current: Buffer, chunk: Buffer): { value: Buffer; truncated: boolean } {
	if (current.length >= MAX_CAPTURE_BYTES) return { value: current, truncated: chunk.length > 0 };
	const remaining = MAX_CAPTURE_BYTES - current.length;
	return {
		value: Buffer.concat([current, chunk.subarray(0, remaining)]),
		truncated: chunk.length > remaining,
	};
}

async function sha256File(path: string): Promise<string> {
	return new Promise((resolveHash, rejectHash) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.once("error", rejectHash);
		stream.once("end", () => resolveHash(hash.digest("hex")));
	});
}

function parseArgs(value: string | undefined): string[] | undefined {
	if (value === undefined || !value.trim()) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("OX_DRIVER_ACP_ARGS_JSON must be a JSON string array");
	}
	if (!Array.isArray(parsed) || parsed.length > 64 || !parsed.every((item) => typeof item === "string")) {
		throw new Error("OX_DRIVER_ACP_ARGS_JSON must contain at most 64 string arguments");
	}
	return parsed.map((item) => validateArgument(item));
}

function validateArgument(value: string): string {
	if (value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error("ACP launcher arguments must be bounded single-line strings");
	return value;
}

function validatePath(label: string, value: string): void {
	if (!isAbsolute(value) || value.length > 4096 || /[\0\r\n]/.test(value)) {
		throw new Error(`${label} must be a bounded absolute path without control characters`);
	}
}

function validateDigest(label: string, value: string | undefined): string | undefined {
	if (value === undefined || !value.trim()) return undefined;
	const normalized = value.trim().toLowerCase();
	if (!SHA256_PATTERN.test(normalized)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
	return normalized;
}

function configuredFromEnvironment(): AcpAdapterOptions {
	const launcherArgs = parseArgs(process.env.OX_DRIVER_ACP_ARGS_JSON);
	const expectedLauncherSha256 = validateDigest("OX_DRIVER_ACP_LAUNCHER_SHA256", process.env.OX_DRIVER_ACP_LAUNCHER_SHA256);
	const expectedProfileSha256 = validateDigest("OX_DRIVER_ACP_PROFILE_SHA256", process.env.OX_DRIVER_ACP_PROFILE_SHA256);
	return {
		...(process.env.OX_DRIVER_ACP_LAUNCHER?.trim() ? { launcher: process.env.OX_DRIVER_ACP_LAUNCHER.trim() } : {}),
		...(launcherArgs ? { launcherArgs } : {}),
		...(expectedLauncherSha256 ? { expectedLauncherSha256 } : {}),
		...(process.env.OX_DRIVER_ACP_PROFILE?.trim() ? { profilePath: process.env.OX_DRIVER_ACP_PROFILE.trim() } : {}),
		...(expectedProfileSha256 ? { expectedProfileSha256 } : {}),
		...(process.env.OX_DRIVER_ACP_AGENT_NAME?.trim() ? {
			expectedAgent: {
				name: process.env.OX_DRIVER_ACP_AGENT_NAME.trim(),
				...(process.env.OX_DRIVER_ACP_AGENT_VERSION?.trim() ? { version: process.env.OX_DRIVER_ACP_AGENT_VERSION.trim() } : {}),
			},
		} : {}),
	};
}

function cleanEnvironment(root: string): NodeJS.ProcessEnv {
	return {
		HOME: join(root, "home"),
		PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
		TMPDIR: join(root, "tmp"),
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		NO_COLOR: "1",
	};
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (!child.pid) return;
	try {
		if (process.platform === "win32") child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}

function writeRpc(child: ChildProcess, frame: JsonObject): void {
	const line = `${JSON.stringify(frame)}\n`;
	if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) throw new Error("ACP outbound JSON-RPC frame exceeded the controller limit");
	if (child.stdin?.writable && !child.stdin.destroyed) child.stdin.write(line);
}

function initializeRequest(): JsonObject {
	return {
		jsonrpc: "2.0",
		id: "initialize-1",
		method: "initialize",
		params: {
			protocolVersion: ACP_PROTOCOL_VERSION,
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false,
				auth: { terminal: false },
			},
			clientInfo: { name: "ox-driver", version: "2.0.0-dev.0" },
		},
	};
}

function responseResult(frame: JsonObject, id: string): JsonObject | undefined {
	if (frame.id !== id || frame.method !== undefined) return undefined;
	if (isObject(frame.error)) throw new Error(`ACP ${id} failed: ${String(frame.error.message ?? "unknown JSON-RPC error")}`);
	if (!isObject(frame.result)) throw new Error(`ACP ${id} returned no result object`);
	return frame.result;
}

function verifyAgentInfo(result: JsonObject, expected: AcpExpectedAgent | undefined): AcpExpectedAgent | undefined {
	const raw = result.agentInfo;
	if (raw === undefined || raw === null) {
		if (expected) throw new Error("ACP initialize omitted required agentInfo evidence");
		return undefined;
	}
	if (!isObject(raw) || typeof raw.name !== "string" || typeof raw.version !== "string") throw new Error("ACP initialize returned invalid agentInfo");
	if (expected && (raw.name !== expected.name || (expected.version !== undefined && raw.version !== expected.version))) {
		throw new Error(`ACP agent identity drift: expected ${expected.name}${expected.version ? `/${expected.version}` : ""}, observed ${raw.name}/${raw.version}`);
	}
	return { name: raw.name, version: raw.version };
}

async function resolveLaunch(options: AcpAdapterOptions): Promise<ResolvedLaunch> {
	if (!options.launcher) throw new Error("ACP launcher must be an explicit absolute path");
	validatePath("ACP launcher", options.launcher);
	if (!options.expectedLauncherSha256 || !SHA256_PATTERN.test(options.expectedLauncherSha256)) throw new Error("ACP launcher requires an exact SHA-256 pin");
	if (!options.profilePath) throw new Error("ACP profile must be an explicit absolute path");
	validatePath("ACP profile", options.profilePath);
	if (!options.expectedProfileSha256 || !SHA256_PATTERN.test(options.expectedProfileSha256)) throw new Error("ACP profile requires an exact SHA-256 pin");
	if (!options.expectedAgent?.name.trim() || !options.expectedAgent.version?.trim()) {
		throw new Error("ACP launcher requires an exact expected agent name and version");
	}
	const rawArgs = [...(options.launcherArgs ?? [])].map((item) => validateArgument(item));
	const placeholderCount = rawArgs.reduce((count, item) => count + item.split(PROFILE_PLACEHOLDER).length - 1, 0);
	if (placeholderCount !== 1) {
		throw new Error(`ACP launcher arguments must contain ${PROFILE_PLACEHOLDER} exactly once`);
	}
	await access(options.launcher, constants.R_OK | constants.X_OK);
	const executable = await realpath(options.launcher);
	if (!(await stat(executable)).isFile()) throw new Error("ACP launcher does not resolve to a regular file");
	await access(options.profilePath, constants.R_OK);
	const profilePath = await realpath(options.profilePath);
	if (!(await stat(profilePath)).isFile()) throw new Error("ACP profile does not resolve to a regular file");
	const launcherSha256 = await sha256File(executable);
	const profileSha256 = await sha256File(profilePath);
	if (launcherSha256 !== options.expectedLauncherSha256) throw new Error("ACP launcher digest differs from the pinned artifact");
	if (profileSha256 !== options.expectedProfileSha256) throw new Error("ACP profile digest differs from the pinned artifact");
	const args = rawArgs.map((item) => item.replace(PROFILE_PLACEHOLDER, profilePath));
	const enforcementSha256 = createHash("sha256").update(JSON.stringify({
		launcherSha256,
		profileSha256,
		args,
		expectedAgent: options.expectedAgent,
	})).digest("hex");
	return { executable, args, launcherSha256, profilePath, profileSha256, enforcementSha256 };
}

async function probeProtocol(launch: ResolvedLaunch, expectedAgent: AcpExpectedAgent | undefined): Promise<ProtocolProbe> {
	const root = await mkdtemp(join(tmpdir(), "ox-driver-acp-probe-"));
	try {
		await Promise.all([
			mkdir(join(root, "home"), { mode: 0o700 }),
			mkdir(join(root, "tmp"), { mode: 0o700 }),
		]);
		return await new Promise((resolveProbe) => {
			const child = spawn(launch.executable, launch.args, {
				cwd: root,
				env: cleanEnvironment(root),
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			const decoder = new JsonLineDecoder();
			const notices: string[] = [];
			let ok = false;
			let agentInfo: AcpExpectedAgent | undefined;
			let agentCapabilities: JsonObject | undefined;
			let stderr: Buffer = Buffer.alloc(0);
			let timer: NodeJS.Timeout | undefined;
			let settled = false;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
					if (stderr.length) notices.push(`ACP probe stderr redacted: ${stderr.length} bytes, sha256 ${createHash("sha256").update(stderr).digest("hex")}`);
				resolveProbe({ ok, ...(agentInfo ? { agentInfo } : {}), ...(agentCapabilities ? { agentCapabilities } : {}), notices });
			};
			const fail = (error: unknown): void => {
				if (settled) return;
				ok = false;
				notices.push(error instanceof Error ? error.message : String(error));
				killProcessTree(child, "SIGKILL");
			};
			timer = setTimeout(() => {
				ok = false;
				notices.push("ACP initialize probe timed out");
				killProcessTree(child, "SIGKILL");
			}, 10_000);
			child.stdout?.on("data", (chunk: Buffer) => {
				try {
					for (const frame of decoder.push(chunk)) {
						const result = responseResult(frame, "initialize-1");
						if (!result) throw new Error("ACP initialize probe received an unexpected frame");
						if (result.protocolVersion !== ACP_PROTOCOL_VERSION) throw new Error(`ACP protocol version ${String(result.protocolVersion)} is incompatible`);
						agentInfo = verifyAgentInfo(result, expectedAgent);
						agentCapabilities = isObject(result.agentCapabilities) ? result.agentCapabilities : {};
						ok = true;
						child.stdin?.end();
					}
				} catch (error) {
					fail(error);
				}
			});
			child.stderr?.on("data", (chunk: Buffer) => { stderr = boundedAppend(stderr, chunk).value; });
			child.stdin?.once("error", fail);
			child.once("error", fail);
			child.once("close", async (exitCode) => {
				if (exitCode !== 0) {
					notices.push(`ACP initialize probe exited with code ${String(exitCode)}`);
					ok = false;
				}
				const processTree = await reapDetachedProcessGroup(child.pid);
				if (processTree.backgroundProcessesDetected) {
					notices.push("ACP initialize probe left background processes; the detached group was reaped.");
					ok = false;
				}
				if (!processTree.processTreeReaped) {
					notices.push("ACP initialize probe process-tree cleanup could not be verified.");
					ok = false;
				}
				try {
					decoder.finish();
				} catch (error) {
					notices.push(error instanceof Error ? error.message : String(error));
					ok = false;
				}
				finish();
			});
			try {
				writeRpc(child, initializeRequest());
			} catch (error) {
				fail(error);
			}
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

export class AcpAdapter implements HarnessAdapter {
	readonly id = "acp-v1-quarantined";
	readonly harness = "acp";
	readonly #options: AcpAdapterOptions;
	readonly #configurationError: string | undefined;

	constructor(options?: AcpAdapterOptions) {
		try {
			const configured = options ?? configuredFromEnvironment();
			this.#options = {
				...configured,
				...(configured.launcherArgs ? { launcherArgs: [...configured.launcherArgs] } : {}),
				...(configured.expectedAgent ? { expectedAgent: { ...configured.expectedAgent } } : {}),
			};
			this.#configurationError = undefined;
		} catch (error) {
			this.#options = {};
			this.#configurationError = error instanceof Error ? error.message : String(error);
		}
	}

	async doctor(): Promise<HarnessCapabilities> {
		if (this.#configurationError) return this.#blockedDoctor(false, [this.#configurationError]);
		let launch: ResolvedLaunch;
		try {
			launch = await resolveLaunch(this.#options);
		} catch (error) {
			return this.#blockedDoctor(false, [error instanceof Error ? error.message : String(error)]);
		}
		const probe = this.#options.probeInitialize
			? await probeProtocol(launch, this.#options.expectedAgent)
			: { ok: false, notices: ["ACP initialize probe is disabled; doctor made zero harness and model calls."] };
		return {
			version: 1,
			adapterId: this.id,
			harness: this.harness,
			compatibility: "blocked",
			available: true,
			executable: launch.executable,
			binarySha256: launch.launcherSha256,
			enforcementSha256: launch.enforcementSha256,
			...(probe.agentInfo?.version ? { harnessVersion: probe.agentInfo.version } : {}),
			probe: {
				version: 1,
				modelCalls: 0,
				contract: "acp-stable-v1-quarantined",
				artifact: "verified",
				executionQualified: false,
				protocol: {
					name: "acp-jsonrpc-stdio",
					...(probe.ok ? { negotiatedVersion: ACP_PROTOCOL_VERSION, supportedVersions: [ACP_PROTOCOL_VERSION] } : {}),
				},
			},
			capabilities: {
				"session.ephemeral": false,
				"session.new": false,
				"session.resume": false,
				"session.fork": false,
				"control.cancel": false,
				"control.steer": false,
				"approval.bridge": false,
				"events.structured": false,
				"output.schema": false,
				"route.configured": false,
				"agent.identity": false,
				"telemetry.usage": false,
				"limits.providerRequests": false,
				"limits.toolCalls": false,
				"limits.spend": false,
				"limits.children": false,
				"sandbox.filesystem": false,
				"sandbox.network.open": false,
				"sandbox.network.restricted": false,
				"sandbox.network.none": false,
				"agents.children": false,
				"agents.hierarchical": false,
				"agents.receipts": false,
				"worktree.native": false,
			},
			notices: [
				`ACP launcher and profile digests verified: ${launch.profilePath}`,
				...probe.notices,
				this.#options.quarantineReason ?? "ACP dispatch remains quarantined until an exact route and external containment probe are qualified.",
				"ACP stable v1 does not provide authoritative route, tool-policy, or filesystem-containment evidence.",
			],
		};
	}

	async preflight(spec: RunSpec, _doctor: HarnessCapabilities): Promise<PreflightIssue[]> {
		const issues: PreflightIssue[] = [];
		if (spec.execution.session !== "ephemeral") issues.push({ severity: "error", code: "ACP_SESSION_UNSUPPORTED", message: "the ACP foundation supports ephemeral sessions only" });
		if (spec.execution.topology !== "solo") issues.push({ severity: "error", code: "ACP_TOPOLOGY_UNSUPPORTED", message: "the ACP foundation does not authorize child agents" });
		if (spec.execution.writerPolicy !== "read-only") issues.push({ severity: "error", code: "ACP_WRITER_UNSUPPORTED", message: "the ACP foundation does not claim writer support" });
		if (spec.execution.network !== "configured") issues.push({ severity: "error", code: "ACP_NETWORK_UNVERIFIED", message: "the ACP foundation does not claim a network sandbox mode" });
		issues.push({
			severity: "error",
			code: "ACP_ADAPTER_QUARANTINED",
			message: this.#options.quarantineReason ?? "ACP dispatch requires a separately qualified route profile and external containment probe",
		});
		return issues;
	}

	async run(_spec: RunSpec, _context: AdapterRunContext): Promise<AdapterRunResult> {
		throw new Error("ACP adapter dispatch is quarantined; initialize-only qualification cannot authorize a run");
	}

	#blockedDoctor(available: boolean, notices: string[]): HarnessCapabilities {
		return {
			version: 1,
			adapterId: this.id,
			harness: this.harness,
			compatibility: "blocked",
			available,
			capabilities: {},
			notices: [...notices, "Ambient or unpinned ACP launchers are rejected."],
		};
	}
}

export const acpStableProtocol = {
	version: ACP_PROTOCOL_VERSION,
	maxFrameBytes: MAX_FRAME_BYTES,
	maxStreamBytes: MAX_STREAM_BYTES,
	maxEventFrames: MAX_EVENT_FRAMES,
} as const;
