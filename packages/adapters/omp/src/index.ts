import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
	createOmpRuntimeIsolation,
	OMP_AMBIENT_PROVIDER_IDS,
	OMP_ISOLATION_OVERLAY_SHA256,
	OMP_MODEL_CONFIG_NAMES,
	OMP_READ_ONLY_TOOLS,
} from "./isolation.js";
import {
	createOmpProcessContainmentLaunch,
	inspectOmpProcessContainment,
	validateOmpContainmentScope,
	verifyOmpProcessContainmentLaunch,
	type OmpProcessContainmentInspection,
} from "./process-containment.js";
import {
	normalizedHarnessEvent,
	reapDetachedProcessGroup,
	redactedTextEvidence,
	redactedValueEvidence,
	type AdapterRunContext,
	type AdapterRunResult,
	type BudgetUsage,
	type ConfiguredRoute,
	type HarnessAdapter,
	type HarnessCapabilities,
	type ProcessTreeCleanup,
	type PreflightIssue,
	type RunSpec,
} from "@ox-driver/core";

const PINNED_VERSION = "18.0.6";
const PINNED_DARWIN_ARM64_SHA256 = "68d911038e061d35c8caa6a71c91a15b60a98f8c5464ad9f47e5d1eaeda6be4c";
const PHYSICAL_FRAME_LIMIT = 1024 * 1024;
const REASSEMBLED_FRAME_LIMIT = 64 * 1024 * 1024;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const RPC_STREAM_LIMIT = 128 * 1024 * 1024;
const RPC_FRAME_COUNT_LIMIT = 100_000;
const OMP_SYSTEM_PROMPT_LIMIT = 32 * 1024;
const OMP_POLICY_MODULE_NAMES = ["isolation.js", "process-containment.js"] as const;
// Review and update only after the compiled policy modules and their kernel
// effect matrix pass together. This pin intentionally lives outside the two
// modules whose exact bytes it authenticates.
export const OMP_POLICY_BUNDLE_SHA256 = "c8c25da80f81326d79081d7678123ca3e519ad51ea7f3717d4e6d930ac377a69";

export const OMP_CONTROLLER_SYSTEM_PROMPT = [
	"You are running under the Ox Driver controller.",
	"Operate read-only and solo inside the controller-declared workspace.",
	"Use only the tools exposed by the current process. Never request writes, shell execution, delegation, approval bypasses, or policy changes.",
].join(" ");
export const OMP_CONTROLLER_SYSTEM_PROMPT_SHA256 = createHash("sha256")
	.update(OMP_CONTROLLER_SYSTEM_PROMPT)
	.digest("hex");

const RESERVED_ENVIRONMENT_NAMES = new Set([
	"HOME",
	"LANG",
	"LC_ALL",
	"PATH",
	"TMPDIR",
	"PI_CODING_AGENT_DIR",
	"PI_CONFIG_DIR",
	"PI_CONFIG_FILES",
	"PI_PROFILE",
	"OMP_PROFILE",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
]);

function isReservedEnvironmentName(name: string): boolean {
	return RESERVED_ENVIRONMENT_NAMES.has(name)
		|| /^(?:BUN|DYLD|LD|NODE|NPM|OMP|OX_DRIVER|PI)_/.test(name)
		|| /^(?:ALL|HTTP|HTTPS|NO)_PROXY$/.test(name);
}

function dispatchEnforcementSha256(
	routeSha256: string,
	mechanismSha256: string,
	systemPromptEvidenceSha256: string,
	policyBundleSha256: string,
): string {
	return createHash("sha256")
		.update("omp-dispatch-enforcement-v6\0")
		.update(routeSha256)
		.update("\0")
		.update(mechanismSha256)
		.update("\0")
		.update(systemPromptEvidenceSha256)
		.update("\0")
		.update(policyBundleSha256)
		.digest("hex");
}

export interface OmpRoute extends ConfiguredRoute {
	agentDirectory: string;
	homeDirectory: string;
	environment?: Record<string, string>;
}

interface RpcProbe {
	ok: boolean;
	version?: string;
	versionMatches: boolean;
	protocolVersions: number[];
	negotiatedVersion?: number;
	maxFrameBytes?: number;
	maxReassembledFrameBytes?: number;
	processBound: boolean;
	immutableStagedExecutable: boolean;
	networkNone: boolean;
	systemPromptCount?: number;
	systemPromptExactMatch: boolean;
	systemPromptEvidenceSha256?: string;
	notices: string[];
}

interface ProcessCapture extends ProcessTreeCleanup {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
}

interface RpcProbeCapture extends ProcessCapture {
	frames: Record<string, unknown>[];
	protocolError?: string;
}

interface RpcChunkState {
	chunkId: string;
	count: number;
	byteLength: number;
	receivedBytes: number;
	wireBytes: number;
	parts: Buffer[];
}

function validateRpcShape(value: unknown): void {
	const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
	let nodes = 0;
	while (stack.length > 0) {
		const current = stack.pop() as { value: unknown; depth: number };
		nodes += 1;
		if (nodes > 100_000) throw new Error("OMP RPC JSON structure exceeded the controller node limit");
		if (current.depth > 64) throw new Error("OMP RPC JSON structure exceeded the controller depth limit");
		if (Array.isArray(current.value)) {
			for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
		} else if (current.value && typeof current.value === "object") {
			for (const child of Object.values(current.value as Record<string, unknown>)) {
				stack.push({ value: child, depth: current.depth + 1 });
			}
		}
	}
}

export interface OmpRpcTransportEvidence {
	version: 1;
	wireBytes: number;
	ordinaryWireBytes: number;
	replayAmplificationBytes: number;
	messageUpdateFrames: number;
	frameCount: number;
	maxLogicalFrameBytes: number;
}

export class RpcFrameDecoder {
	#segments: Buffer[] = [];
	#lineBytes = 0;
	#wireBytes = 0;
	#ordinaryWireBytes = 0;
	#replayAmplificationBytes = 0;
	#messageUpdateFrames = 0;
	#frameCount = 0;
	#maxLogicalFrameBytes = 0;
	#chunk: RpcChunkState | undefined;
	readonly #ordinaryStreamLimit: number;

	constructor(ordinaryStreamLimit = RPC_STREAM_LIMIT) {
		if (!Number.isSafeInteger(ordinaryStreamLimit) || ordinaryStreamLimit < 1) {
			throw new Error("OMP RPC ordinary stream limit must be a positive safe integer");
		}
		this.#ordinaryStreamLimit = ordinaryStreamLimit;
	}

	push(chunk: Buffer): Record<string, unknown>[] {
		const frames: Record<string, unknown>[] = [];
		let offset = 0;
		while (offset < chunk.length) {
			const newline = chunk.indexOf(0x0a, offset);
			const end = newline < 0 ? chunk.length : newline;
			const segment = chunk.subarray(offset, end);
			this.#lineBytes += segment.length;
			if (this.#lineBytes > PHYSICAL_FRAME_LIMIT) throw new Error("OMP RPC physical frame exceeded the controller limit");
			if (segment.length > 0) this.#segments.push(segment);
			if (newline < 0) break;
			let line = Buffer.concat(this.#segments, this.#lineBytes);
			this.#segments = [];
			this.#lineBytes = 0;
			if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
			if (line.length > 0) {
				let text: string;
				try {
					text = new TextDecoder("utf-8", { fatal: true }).decode(line);
				} catch {
					throw new Error("OMP RPC emitted invalid UTF-8");
				}
				frames.push(...this.#decodeLine(text, false, line.length + 1));
			}
			offset = newline + 1;
		}
		return frames;
	}

	finish(): Record<string, unknown>[] {
		if (this.#lineBytes !== 0) throw new Error("OMP RPC stream ended with a truncated physical frame");
		if (this.#chunk) throw new Error("OMP RPC stream ended during a chunk sequence");
		return [];
	}

	transportEvidence(): OmpRpcTransportEvidence {
		return {
			version: 1,
			wireBytes: this.#wireBytes,
			ordinaryWireBytes: this.#ordinaryWireBytes,
			replayAmplificationBytes: this.#replayAmplificationBytes,
			messageUpdateFrames: this.#messageUpdateFrames,
			frameCount: this.#frameCount,
			maxLogicalFrameBytes: this.#maxLogicalFrameBytes,
		};
	}

	#decodeLine(
		line: string,
		reassembled: boolean,
		wireBytes: number,
		accountingBytes = wireBytes,
	): Record<string, unknown>[] {
		this.#wireBytes += wireBytes;
		this.#frameCount += 1;
		if (this.#frameCount > RPC_FRAME_COUNT_LIMIT) throw new Error("OMP RPC frame count exceeded the controller limit");
		const lineLimit = reassembled ? REASSEMBLED_FRAME_LIMIT : PHYSICAL_FRAME_LIMIT;
		const logicalBytes = Buffer.byteLength(line, "utf8");
		this.#maxLogicalFrameBytes = Math.max(this.#maxLogicalFrameBytes, logicalBytes);
		if (logicalBytes > lineLimit) {
			throw new Error("OMP RPC physical frame exceeded the controller limit");
		}
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			throw new Error("OMP RPC emitted malformed JSON");
		}
		validateRpcShape(frame);
		if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("OMP RPC emitted a non-object frame");
		const object = frame as Record<string, unknown>;
		if (object.type !== "rpc_chunk") {
			this.#recordTransport(object, accountingBytes);
			if (this.#chunk) throw new Error("OMP RPC chunk sequence was interleaved");
			return [object];
		}
		const chunkId = typeof object.chunkId === "string" ? object.chunkId : "";
		const index = Number(object.index);
		const count = Number(object.count);
		const byteLength = Number(object.byteLength);
		const data = typeof object.data === "string" ? object.data : "";
		if (!chunkId || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || !Number.isSafeInteger(byteLength)) {
			throw new Error("OMP RPC chunk metadata is invalid");
		}
		if (count < 1 || count > 65_536 || index < 0 || index >= count || byteLength < 1 || byteLength > REASSEMBLED_FRAME_LIMIT) {
			throw new Error("OMP RPC chunk bounds are invalid");
		}
		const decoded = Buffer.from(data, "base64");
		if (decoded.toString("base64").replace(/=+$/, "") !== data.replace(/=+$/, "")) {
			throw new Error("OMP RPC chunk is not canonical base64");
		}
		if (!this.#chunk) {
			if (index !== 0) throw new Error("OMP RPC chunk sequence did not start at index zero");
			this.#chunk = { chunkId, count, byteLength, receivedBytes: 0, wireBytes: 0, parts: [] };
		}
		const state = this.#chunk;
		if (state.chunkId !== chunkId || state.count !== count || state.byteLength !== byteLength || state.parts.length !== index) {
			throw new Error("OMP RPC chunk sequence is inconsistent");
		}
		state.receivedBytes += decoded.length;
		state.wireBytes += wireBytes;
		if (state.receivedBytes > state.byteLength || state.receivedBytes > REASSEMBLED_FRAME_LIMIT) {
			throw new Error("OMP RPC chunk payload exceeded its declared length");
		}
		state.parts.push(decoded);
		if (state.parts.length !== state.count) return [];
		this.#chunk = undefined;
		const payload = Buffer.concat(state.parts);
		if (payload.length !== state.byteLength || payload.length > REASSEMBLED_FRAME_LIMIT) {
			throw new Error("OMP RPC reassembled frame length is invalid");
		}
		const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
		return this.#decodeLine(text, true, 0, state.wireBytes);
	}

	#recordTransport(frame: Record<string, unknown>, wireBytes: number): void {
		if (wireBytes === 0) {
			if (frame.type === "message_update") this.#messageUpdateFrames += 1;
			return;
		}
		let replayBytes = 0;
		if (frame.type === "message_update") {
			this.#messageUpdateFrames += 1;
			const message = frame.message;
			const update = frame.assistantMessageEvent;
			const partial = update && typeof update === "object" && !Array.isArray(update)
				? (update as Record<string, unknown>).partial
				: undefined;
			if (message && typeof message === "object" && !Array.isArray(message) && isDeepStrictEqual(message, partial)) {
				const snapshotBytes = Buffer.byteLength(JSON.stringify(message), "utf8");
				// OMP v18.0.6 serializes the same cumulative snapshot in both
				// fields. Treat only those mechanically identical bytes as replay;
				// the event envelope and incremental delta still consume the strict
				// aggregate budget.
				replayBytes = Math.min(wireBytes, snapshotBytes * 2);
			}
		}
		this.#replayAmplificationBytes += replayBytes;
		this.#ordinaryWireBytes += wireBytes - replayBytes;
		if (this.#ordinaryWireBytes > this.#ordinaryStreamLimit) {
			throw new Error("OMP RPC non-replay stream exceeded the controller limit");
		}
	}
}

function compactOmpEventForEvidence(frame: Record<string, unknown>): Record<string, unknown> {
	if (frame.type !== "message_update") return frame;
	const update = frame.assistantMessageEvent;
	if (!update || typeof update !== "object" || Array.isArray(update)) return { type: "message_update" };
	const { partial: _partial, ...incremental } = update as Record<string, unknown>;
	return { type: "message_update", assistantMessageEvent: incremental };
}

function appendBounded(current: Buffer, chunk: Buffer): { value: Buffer; truncated: boolean } {
	if (current.length >= OUTPUT_LIMIT) return { value: current, truncated: chunk.length > 0 };
	const remaining = OUTPUT_LIMIT - current.length;
	return {
		value: Buffer.concat([current, chunk.subarray(0, remaining)]),
		truncated: chunk.length > remaining,
	};
}

function stableMetadata(before: BigIntStats, after: BigIntStats): boolean {
	return before.dev === after.dev
		&& before.ino === after.ino
		&& before.mode === after.mode
		&& before.size === after.size
		&& before.mtimeNs === after.mtimeNs
		&& before.ctimeNs === after.ctimeNs;
}

async function sha256File(path: string): Promise<string> {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const handle = await open(path, constants.O_RDONLY | noFollow);
	try {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile()) throw new Error(`OMP evidence path is not a regular file: ${path}`);
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
			throw new Error(`OMP evidence path changed while it was hashed: ${path}`);
		}
		return hash.digest("hex");
	} finally {
		await handle.close();
	}
}

export async function ompPolicyBundleSha256(): Promise<string> {
	const hash = createHash("sha256").update("omp-policy-bundle-v1\0");
	for (const name of OMP_POLICY_MODULE_NAMES) {
		const path = fileURLToPath(new URL(name, import.meta.url));
		hash.update(name).update("\0").update(await sha256File(path)).update("\0");
	}
	return hash.digest("hex");
}

async function resolveExecutable(command: string): Promise<string> {
	const candidates = command.includes("/")
		? [command]
		: (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, command));
	for (const candidate of candidates) {
		try {
			await access(candidate);
			const path = await realpath(candidate);
			if ((await stat(path)).isFile()) return path;
		} catch {
			continue;
		}
	}
	throw new Error(`OMP executable is unavailable: ${command}`);
}

function defaultLauncher(): string {
	return process.env.OX_DRIVER_OMP_LAUNCHER?.trim()
		|| join(privateDataHome(), "ox-driver", "harnesses", "omp", "current", "bin", "omp");
}

function privateDataHome(): string {
	const configured = process.env.XDG_DATA_HOME?.trim();
	if (configured) {
		if (!isAbsolute(configured)) throw new Error("XDG_DATA_HOME must be an absolute path");
		return configured;
	}
	return join(homedir(), ".local", "share");
}

function configuredRoute(): OmpRoute | undefined {
	const provider = process.env.OX_DRIVER_OMP_PROVIDER?.trim();
	const model = process.env.OX_DRIVER_OMP_MODEL?.trim();
	const reasoning = process.env.OX_DRIVER_OMP_REASONING?.trim();
	const agentDirectory = process.env.OX_DRIVER_OMP_AGENT_DIR?.trim();
	const homeDirectory = process.env.OX_DRIVER_OMP_HOME?.trim();
	const allowedReasoning = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	if (
		!provider || !model || !reasoning || !allowedReasoning.has(reasoning)
		|| !agentDirectory || !isAbsolute(agentDirectory)
		|| !homeDirectory || !isAbsolute(homeDirectory)
	) return undefined;
	const environment: Record<string, string> = {};
	for (const name of (process.env.OX_DRIVER_OMP_ENV_ALLOWLIST ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
		if (!/^[A-Z][A-Z0-9_]*$/.test(name) || isReservedEnvironmentName(name)) return undefined;
		const value = process.env[name];
		if (value !== undefined) environment[name] = value;
	}
	return { provider, model, reasoning, agentDirectory, homeDirectory, environment };
}

async function capture(
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; timeoutMs: number },
): Promise<ProcessCapture> {
	return new Promise((resolveCapture, rejectCapture) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let settled = false;
		const terminate = (): void => {
			if (!child.pid) return;
			try {
				if (process.platform === "win32") child.kill("SIGKILL");
				else process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(terminate, options.timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			const appended = appendBounded(stdout, chunk);
			stdout = appended.value;
			stdoutTruncated ||= appended.truncated;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			const appended = appendBounded(stderr, chunk);
			stderr = appended.value;
			stderrTruncated ||= appended.truncated;
		});
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			rejectCapture(error);
		});
		child.once("close", async (exitCode) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const processTree = await reapDetachedProcessGroup(child.pid);
			resolveCapture({
				exitCode,
				stdout: stdout.toString("utf8"),
				stderr: stderr.toString("utf8"),
				stdoutTruncated,
				stderrTruncated,
				...processTree,
			});
		});
		child.stdin.end(options.stdin ?? "");
	});
}

async function routeEnforcement(route: OmpRoute): Promise<{
	ready: boolean;
	sha256?: string;
	modelConfig?: { name: string; sha256: string };
	notice?: string;
}> {
	try {
		if (OMP_AMBIENT_PROVIDER_IDS.includes(route.provider as (typeof OMP_AMBIENT_PROVIDER_IDS)[number])) {
			return { ready: false, notice: "the OMP model provider collides with a disabled ambient discovery provider" };
		}
		const reserved = Object.keys(route.environment ?? {}).find(isReservedEnvironmentName);
		if (reserved) return { ready: false, notice: `the OMP route may not override controller environment ${reserved}` };
		const [agentDirectory, homeDirectory] = await Promise.all([
			realpath(route.agentDirectory),
			realpath(route.homeDirectory),
		]);
		const [agentLinkStatus, homeLinkStatus] = await Promise.all([
			lstat(route.agentDirectory),
			lstat(route.homeDirectory),
		]);
		if (agentLinkStatus.isSymbolicLink() || homeLinkStatus.isSymbolicLink()) {
			return { ready: false, notice: "the OMP agent and home directories must not be symlink aliases" };
		}
		const [agentStatus, homeStatus] = await Promise.all([stat(agentDirectory), stat(homeDirectory)]);
		if (!agentStatus.isDirectory() || !homeStatus.isDirectory()) {
			return { ready: false, notice: "the OMP agent and home paths must both be directories" };
		}
		if ((agentStatus.mode & 0o077) !== 0 || (homeStatus.mode & 0o077) !== 0) {
			return { ready: false, notice: "the OMP agent and home directories must not grant group or other permissions" };
		}
		const hash = createHash("sha256");
		hash.update("omp-route-v2\0isolation-overlay-sha256\0").update(OMP_ISOLATION_OVERLAY_SHA256).update("\0");
		for (const [label, value] of [
			["provider", route.provider],
			["model", route.model],
			["reasoning", route.reasoning],
			["agentDirectory", agentDirectory],
			["homeDirectory", homeDirectory],
		] as const) hash.update(label).update("\0").update(value).update("\0");
		for (const [name, value] of Object.entries(route.environment ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
			hash.update("env-name\0").update(name).update("\0env-value-sha256\0")
				.update(createHash("sha256").update(value).digest("hex")).update("\0");
		}

		const children = await readdir(agentDirectory, { withFileTypes: true });
		children.sort((left, right) => left.name.localeCompare(right.name));
		const allowed = new Set<string>(OMP_MODEL_CONFIG_NAMES);
		if (children.length > 1) throw new Error("OMP route agent directory may contain at most one model catalog");
		let modelConfig: { name: string; sha256: string } | undefined;
		for (const child of children) {
			if (!allowed.has(child.name) || !child.isFile()) {
				throw new Error(`OMP route agent directory contains an unsupported entry: ${child.name}`);
			}
			const path = join(agentDirectory, child.name);
			const status = await lstat(path);
			if (status.isSymbolicLink()) throw new Error(`OMP model catalog is a symlink: ${child.name}`);
			if (status.size > 4 * 1024 * 1024) throw new Error("OMP model catalog exceeds the 4 MiB evidence limit");
			const sha256 = await sha256File(path);
			hash.update("model-catalog\0").update(child.name).update("\0").update(sha256).update("\0");
			modelConfig = { name: child.name, sha256 };
		}
		return { ready: true, sha256: hash.digest("hex"), ...(modelConfig ? { modelConfig } : {}) };
	} catch (error) {
		return { ready: false, notice: error instanceof Error ? error.message : String(error) };
	}
}

function probeModelsYaml(): string {
	return `providers:\n  ox-driver-probe:\n    baseUrl: http://127.0.0.1:9/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: no-network-probe\n        name: Ox Driver Offline Probe\n        reasoning: false\n        input: [text]\n        cost:\n          input: 0\n          output: 0\n          cacheRead: 0\n          cacheWrite: 0\n        contextWindow: 4096\n        maxTokens: 64\n`;
}

async function captureRpcProbe(
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<RpcProbeCapture> {
	return new Promise((resolveCapture, rejectCapture) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		const decoder = new RpcFrameDecoder();
		const frames: Record<string, unknown>[] = [];
		let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let protocolError: string | undefined;
		let settled = false;
		let stage: "ready" | "protocol" | "state" | "commands" | "complete" = "ready";
		const send = (frame: Record<string, unknown>): void => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
		};
		const terminate = (): void => {
			if (!child.pid) return;
			try {
				if (process.platform === "win32") child.kill("SIGKILL");
				else process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const fail = (message: string): void => {
			protocolError ??= message;
			terminate();
		};
		const consume = (frame: Record<string, unknown>): void => {
			frames.push(frame);
			if (frame.type === "ready" && frames.length !== 1) {
				fail("OMP RPC probe emitted a duplicate ready frame");
				return;
			}
			if (["agent_start", "agent_end", "tool_execution_start", "host_tool_call", "subagent_lifecycle"].includes(String(frame.type))) {
				fail(`OMP RPC probe emitted forbidden execution event: ${String(frame.type)}`);
				return;
			}
			if (stage === "ready") {
				if (frames.length !== 1 || frame.type !== "ready" || frame.protocolVersion !== 1
					|| !Array.isArray(frame.supportedProtocolVersions) || !frame.supportedProtocolVersions.includes(2)) {
					fail("OMP RPC probe did not begin with a compatible ready frame");
					return;
				}
				stage = "protocol";
				send({ id: "protocol-1", type: "negotiate_protocol", protocolVersion: 2 });
				return;
			}
			if (frame.type !== "response") return;
			if (stage === "protocol" && frame.id === "protocol-1") {
				const data = frame.data as Record<string, unknown> | undefined;
				if (frame.success !== true || frame.command !== "negotiate_protocol" || data?.protocolVersion !== 2) {
					fail("OMP RPC probe protocol negotiation failed");
					return;
				}
				stage = "state";
				send({ id: "state-1", type: "get_state" });
				return;
			}
			if (stage === "state" && frame.id === "state-1") {
				if (frame.success !== true || frame.command !== "get_state") {
					fail("OMP RPC probe state response was invalid");
					return;
				}
				stage = "commands";
				send({ id: "commands-1", type: "get_available_commands" });
				return;
			}
			if (stage === "commands" && frame.id === "commands-1") {
				if (frame.success !== true || frame.command !== "get_available_commands") {
					fail("OMP RPC probe command response was invalid");
					return;
				}
				stage = "complete";
				child.stdin.end();
			}
		};
		const timer = setTimeout(() => fail("OMP RPC probe timed out"), options.timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			const appended = appendBounded(stdout, chunk);
			stdout = appended.value;
			stdoutTruncated ||= appended.truncated;
			try {
				for (const frame of decoder.push(chunk)) consume(frame);
			} catch (error) {
				fail(error instanceof Error ? error.message : String(error));
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			const appended = appendBounded(stderr, chunk);
			stderr = appended.value;
			stderrTruncated ||= appended.truncated;
		});
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			rejectCapture(error);
		});
		child.once("close", async (exitCode) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				for (const frame of decoder.finish()) consume(frame);
			} catch (error) {
				protocolError ??= error instanceof Error ? error.message : String(error);
			}
			const processTree = await reapDetachedProcessGroup(child.pid);
			resolveCapture({
				exitCode,
				stdout: stdout.toString("utf8"),
				stderr: stderr.toString("utf8"),
				stdoutTruncated,
				stderrTruncated,
				...processTree,
				frames,
				...(protocolError ? { protocolError } : {}),
			});
		});
	});
}

async function probeRpc(
	executable: string,
	executableSha256: string,
	expectedVersion: string,
	containmentInspection: Readonly<OmpProcessContainmentInspection>,
): Promise<RpcProbe> {
	const root = await mkdtemp(join(tmpdir(), "ox-driver-omp-probe-"));
	try {
		const workspace = join(root, "workspace");
		const agentDirectory = join(root, "source-agent");
		const runDirectory = join(root, "controller");
		await Promise.all([
			mkdir(agentDirectory, { recursive: true, mode: 0o700 }),
			mkdir(runDirectory, { recursive: true, mode: 0o700 }),
			mkdir(join(workspace, ".omp"), { recursive: true, mode: 0o700 }),
			mkdir(join(workspace, ".claude"), { recursive: true, mode: 0o700 }),
		]);
		await writeFile(join(agentDirectory, "models.yml"), probeModelsYaml(), { encoding: "utf8", mode: 0o600 });
		await Promise.all([
			writeFile(join(workspace, ".omp", "AGENTS.md"), "OX_DRIVER_AMBIENT_SENTINEL_NATIVE\n", { encoding: "utf8", mode: 0o600 }),
			writeFile(join(workspace, ".claude", "CLAUDE.md"), "OX_DRIVER_AMBIENT_SENTINEL_CLAUDE\n", { encoding: "utf8", mode: 0o600 }),
		]);
		const isolation = await createOmpRuntimeIsolation(agentDirectory, runDirectory);
		const ompArgs = [
			"--mode", "rpc",
			"--no-session",
			"--config", isolation.overlayPath,
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--no-lsp",
			"--no-pty",
			"--no-title",
			"--no-prewalk",
			"--tools", OMP_READ_ONLY_TOOLS.join(","),
			"--approval-mode", "always-ask",
			"--system-prompt", OMP_CONTROLLER_SYSTEM_PROMPT,
			"--model", "ox-driver-probe/no-network-probe",
			"--max-time", "10s",
		];
		let command = executable;
		let commandPrefix: string[] = [];
		let offline = false;
		let processBound = false;
		let immutableStagedExecutable = false;
		let containment: Readonly<Awaited<ReturnType<typeof createOmpProcessContainmentLaunch>>> | undefined;
		if (containmentInspection.available) {
			const probeEnforcementSha256 = createHash("sha256")
				.update("omp-rpc-doctor-probe-v1\0")
				.update(isolation.overlaySha256)
				.update("\0")
				.update(isolation.modelConfig?.sha256 ?? "")
				.digest("hex");
			containment = await createOmpProcessContainmentLaunch({
				inspection: containmentInspection,
				workspaceRoot: workspace,
				excludedPaths: [],
				controllerRoot: isolation.root,
				writablePaths: isolation.writableDirectories,
				immutableReadPaths: isolation.modelConfig
					? [{ path: join(isolation.agentDirectory, isolation.modelConfig.name), sha256: isolation.modelConfig.sha256 }]
					: [],
				executable,
				executableSha256,
				routeEnforcementSha256: probeEnforcementSha256,
				networkPolicy: "none",
			});
			command = containment.command;
			commandPrefix = [...containment.argsPrefix, containment.executablePath];
			offline = containment.networkPolicy === "none";
			processBound = true;
			immutableStagedExecutable = true;
		} else if (process.platform === "darwin") {
			try {
				await access("/usr/bin/sandbox-exec");
				command = "/usr/bin/sandbox-exec";
				commandPrefix = ["-p", "(version 1)(allow default)(deny network*)", executable];
				offline = true;
			} catch {
				// The probe remains safe because it never sends a prompt, but cannot claim OS-level offline evidence.
			}
		}
		const probeEnvironment: NodeJS.ProcessEnv = {
			...isolation.environment,
			PATH: `${containment ? dirname(containment.executablePath) : ""}${containment ? ":" : ""}/usr/bin:/bin:/usr/sbin:/sbin`,
			LANG: "C.UTF-8",
			LC_ALL: "C.UTF-8",
		};
		const versionResult = await capture(command, [...commandPrefix, "--version"], {
			cwd: workspace,
			env: probeEnvironment,
			timeoutMs: 10_000,
		});
		const version = versionResult.stdout.trim().match(/(?:omp\/)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1];
		const versionMatches = versionResult.exitCode === 0
			&& version === expectedVersion
			&& !versionResult.stdoutTruncated
			&& !versionResult.stderrTruncated
			&& !versionResult.backgroundProcessesDetected
			&& versionResult.processTreeReaped;
		const result = await captureRpcProbe(command, [...commandPrefix, ...ompArgs], {
			cwd: workspace,
			env: probeEnvironment,
			timeoutMs: 15_000,
		});
		const notices: string[] = [];
		if (containment) {
			try {
				await verifyOmpProcessContainmentLaunch(containment);
			} catch (error) {
				processBound = false;
				immutableStagedExecutable = false;
				notices.push(`RPC process-bound containment verification failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (!offline) notices.push("RPC probe did not have an OS-enforced offline network boundary on this platform.");
		if (processBound && immutableStagedExecutable && offline) {
			notices.push("Version and RPC probes executed the immutable staged artifact through the production Seatbelt boundary with network denied.");
		}
		if (!versionMatches) notices.push(`OMP version drift: expected ${expectedVersion}, observed ${version ?? "unknown"}`);
		if (versionResult.backgroundProcessesDetected) notices.push("OMP version probe left background processes; the detached group was reaped.");
		if (!versionResult.processTreeReaped) notices.push("OMP version-probe process-tree cleanup could not be verified.");
		if (result.stdoutTruncated || result.stderrTruncated) notices.push("RPC probe output exceeded its capture limit.");
		if (result.backgroundProcessesDetected) notices.push("RPC probe left background processes; the detached group was reaped.");
		if (!result.processTreeReaped) notices.push("RPC probe process-tree cleanup could not be verified.");
		const frames = result.frames;
		if (result.protocolError) notices.push(result.protocolError);
		const ready = frames[0]?.type === "ready" ? frames[0] : undefined;
		const protocolVersions = Array.isArray(ready?.supportedProtocolVersions)
			? ready.supportedProtocolVersions.filter((value): value is number => Number.isSafeInteger(value))
			: [];
		const response = (id: string): Record<string, unknown> | undefined => frames.find((frame) => frame.type === "response" && frame.id === id);
		const responseIndex = (id: string): number => frames.findIndex((frame) => frame.type === "response" && frame.id === id);
		const protocolResponse = response("protocol-1");
		const protocolData = protocolResponse?.data as Record<string, unknown> | undefined;
		const state = response("state-1")?.data as Record<string, unknown> | undefined;
		const model = state?.model as Record<string, unknown> | undefined;
		const dumpTools = Array.isArray(state?.dumpTools) ? state.dumpTools : [];
		const toolNames = dumpTools.flatMap((tool) => {
			if (!tool || typeof tool !== "object") return [];
			const name = (tool as Record<string, unknown>).name;
			return typeof name === "string" ? [name] : [];
		}).sort();
		const expectedTools = [...OMP_READ_ONLY_TOOLS].sort();
		const promptIssue = ompRuntimeSystemPromptIssue(state?.systemPrompt);
		const systemPromptEvidenceSha256 = ompRuntimeSystemPromptEvidenceSha256(state?.systemPrompt);
		const systemPrompt = Array.isArray(state?.systemPrompt) ? state.systemPrompt as unknown[] : undefined;
		const systemPromptCount = systemPrompt?.length;
		const stringPrompts = systemPrompt?.every((item): item is string => typeof item === "string")
			? systemPrompt
			: undefined;
		if (stringPrompts) {
			const joined = stringPrompts.join("\n\n");
			const segments = stringPrompts.map((prompt) => ({
				bytes: Buffer.byteLength(prompt, "utf8"),
				sha256: createHash("sha256").update(prompt).digest("hex"),
			}));
			notices.push(
				`OMP system-prompt observation: ${stringPrompts.length} segment(s), ${Buffer.byteLength(joined, "utf8")} joined byte(s), joined SHA-256 ${createHash("sha256").update(joined).digest("hex")}; segment evidence ${JSON.stringify(segments)}.`,
			);
		}
		const systemPromptExactMatch = promptIssue === undefined
			&& systemPromptEvidenceSha256 !== undefined;
		if (systemPromptExactMatch) {
			notices.push(`OMP reported the exact two-block controller/project system-prompt shape (${systemPromptEvidenceSha256}).`);
		}
		const forbidden = frames.some((frame) => [
			"agent_start", "agent_end", "tool_execution_start", "host_tool_call", "subagent_lifecycle",
		].includes(String(frame.type)));
		const ok = versionMatches
			&& result.exitCode === 0
			&& !result.stdoutTruncated
			&& !result.stderrTruncated
			&& !result.backgroundProcessesDetected
			&& result.processTreeReaped
			&& (!containmentInspection.available || (processBound && immutableStagedExecutable && offline))
			&& ready?.protocolVersion === 1
			&& protocolVersions.includes(2)
			&& protocolResponse?.success === true
			&& protocolResponse.command === "negotiate_protocol"
			&& protocolData?.protocolVersion === 2
			&& response("state-1")?.success === true
			&& response("state-1")?.command === "get_state"
			&& response("commands-1")?.success === true
			&& response("commands-1")?.command === "get_available_commands"
			&& responseIndex("protocol-1") > 0
			&& responseIndex("state-1") > responseIndex("protocol-1")
			&& responseIndex("commands-1") > responseIndex("protocol-1")
			&& model?.provider === "ox-driver-probe"
			&& model?.id === "no-network-probe"
			&& state?.sessionFile === undefined
			&& JSON.stringify(toolNames) === JSON.stringify(expectedTools)
			&& promptIssue === undefined
			&& systemPromptExactMatch
			&& !forbidden;
		if (!ok && result.stderr.trim()) notices.push(`RPC probe stderr: ${result.stderr.trim().slice(0, 500)}`);
		return {
			ok,
			...(version ? { version } : {}),
			versionMatches,
			protocolVersions,
			processBound,
			immutableStagedExecutable,
			networkNone: offline,
			...(systemPromptCount !== undefined ? { systemPromptCount } : {}),
			systemPromptExactMatch,
			...(systemPromptEvidenceSha256 ? { systemPromptEvidenceSha256 } : {}),
			...(protocolResponse?.success === true && protocolData?.protocolVersion === 2 ? { negotiatedVersion: 2 } : {}),
			...(typeof ready?.maxFrameBytes === "number" ? { maxFrameBytes: ready.maxFrameBytes } : {}),
			...(typeof ready?.maxReassembledFrameBytes === "number" ? { maxReassembledFrameBytes: ready.maxReassembledFrameBytes } : {}),
			notices,
		};
	} finally {
		await chmod(root, 0o700).catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	}
}

function buildBrief(spec: RunSpec): string {
	return [
		"# Objective",
		spec.task.objective,
		"",
		"# Controller boundary",
		"Operate read-only and solo. Only controller-approved read-only tools are available.",
		`Working directory: ${spec.task.cwd}`,
		`Owned paths: ${spec.task.ownedPaths.join(", ") || "none"}`,
		`Excluded paths: ${spec.task.excludedPaths.join(", ") || "none"}`,
		"Do not request approval, delegation, network-policy changes, or filesystem writes.",
		"",
		"# Acceptance",
		...spec.acceptance.commands.map((command) => `The controller will run after completion: ${command}`),
		"Return findings, evidence, and unresolved blockers.",
	].join("\n");
}

function assistantMessage(frame: Record<string, unknown>): { text: string; stopReason?: string } | undefined {
	if (frame.type !== "message_end" || !frame.message || typeof frame.message !== "object") return undefined;
	const message = frame.message as Record<string, unknown>;
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const text = message.content.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const content = item as Record<string, unknown>;
		return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
	}).join("\n");
	return { text, ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}) };
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} is not a non-negative safe integer`);
	return Number(value);
}

function nonNegativeNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} is not a non-negative finite number`);
	return value;
}

function safeSum(left: number, right: number, label: string): number {
	const result = left + right;
	if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeded the safe-integer range`);
	return result;
}

export class OmpUsageTracker {
	readonly #route: Readonly<ConfiguredRoute>;
	#providerRequests = 0;
	#toolCalls = 0;
	#input = 0;
	#output = 0;
	#cacheRead = 0;
	#cacheWrite = 0;
	#reasoning = 0;
	#total = 0;
	#costUsd = 0;

	constructor(route: Readonly<ConfiguredRoute>) {
		this.#route = route;
	}

	observe(frame: Record<string, unknown>): void {
		if (frame.type === "tool_execution_start") {
			this.#toolCalls = safeSum(this.#toolCalls, 1, "OMP tool-call count");
			return;
		}
		if (frame.type !== "message_end" || !frame.message || typeof frame.message !== "object" || Array.isArray(frame.message)) return;
		const message = frame.message as Record<string, unknown>;
		if (message.role !== "assistant") return;
		if (message.provider !== this.#route.provider || message.model !== this.#route.model) {
			throw new Error("OMP assistant usage route differs from the controller-admitted provider and model");
		}
		if (!message.usage || typeof message.usage !== "object" || Array.isArray(message.usage)) {
			throw new Error("OMP assistant message omitted structured usage telemetry");
		}
		const usage = message.usage as Record<string, unknown>;
		const input = nonNegativeInteger(usage.input, "OMP input tokens");
		const output = nonNegativeInteger(usage.output, "OMP output tokens");
		const cacheRead = nonNegativeInteger(usage.cacheRead, "OMP cache-read tokens");
		const cacheWrite = nonNegativeInteger(usage.cacheWrite, "OMP cache-write tokens");
		const reasoning = usage.reasoningTokens === undefined
			? 0
			: nonNegativeInteger(usage.reasoningTokens, "OMP reasoning tokens");
		const total = nonNegativeInteger(usage.totalTokens, "OMP total tokens");
		if (total !== input + output + cacheRead + cacheWrite) {
			throw new Error("OMP total tokens do not reconcile to input, output, and cache tokens");
		}
		if (reasoning > output) throw new Error("OMP reasoning tokens exceed output tokens");
		if (!usage.cost || typeof usage.cost !== "object" || Array.isArray(usage.cost)) {
			throw new Error("OMP assistant usage omitted structured cost telemetry");
		}
		const cost = usage.cost as Record<string, unknown>;
		const inputCost = nonNegativeNumber(cost.input, "OMP input cost");
		const outputCost = nonNegativeNumber(cost.output, "OMP output cost");
		const cacheReadCost = nonNegativeNumber(cost.cacheRead, "OMP cache-read cost");
		const cacheWriteCost = nonNegativeNumber(cost.cacheWrite, "OMP cache-write cost");
		const totalCost = nonNegativeNumber(cost.total, "OMP total cost");
		const componentCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;
		if (Math.abs(componentCost - totalCost) > Math.max(1e-12, totalCost * 1e-9)) {
			throw new Error("OMP total cost does not reconcile to input, output, and cache cost");
		}

		this.#providerRequests = safeSum(this.#providerRequests, 1, "OMP provider-request count");
		this.#input = safeSum(this.#input, input, "OMP input-token total");
		this.#output = safeSum(this.#output, output, "OMP output-token total");
		this.#cacheRead = safeSum(this.#cacheRead, cacheRead, "OMP cache-read-token total");
		this.#cacheWrite = safeSum(this.#cacheWrite, cacheWrite, "OMP cache-write-token total");
		this.#reasoning = safeSum(this.#reasoning, reasoning, "OMP reasoning-token total");
		this.#total = safeSum(this.#total, total, "OMP token total");
		this.#costUsd += totalCost;
		if (!Number.isFinite(this.#costUsd) || this.#costUsd < 0) throw new Error("OMP reported-cost total is invalid");
	}

	snapshot(complete: boolean): BudgetUsage {
		const hasProviderEvidence = this.#providerRequests > 0;
		const reportedCostUsdMicros = Math.round(this.#costUsd * 1_000_000);
		if (hasProviderEvidence && !Number.isSafeInteger(reportedCostUsdMicros)) {
			throw new Error("OMP reported-cost total exceeded the receipt range");
		}
		return {
			providerRequests: this.#providerRequests,
			toolCalls: this.#toolCalls,
			childrenStarted: 0,
			...(hasProviderEvidence ? {
				reportedCostUsdMicros,
				tokens: {
					input: this.#input,
					output: this.#output,
					cacheRead: this.#cacheRead,
					cacheWrite: this.#cacheWrite,
					reasoning: this.#reasoning,
					total: this.#total,
				},
			} : {}),
			complete: complete && hasProviderEvidence,
			sources: ["harness"],
			terminationReason: complete && hasProviderEvidence
				? "OMP terminal assistant message_end frames report exact per-turn route, token, tool, and cost telemetry."
				: "OMP retained complete telemetry for settled assistant turns; an unsettled or absent turn keeps the receipt partial.",
		};
	}
}

/**
 * Provider-supplied error text can contain request fragments, credential hints,
 * or service diagnostics. Keep the receipt useful for an operator without
 * allowing that untrusted text to cross the adapter boundary.
 */
type OmpProviderFailureCategory = "auth" | "rate-limit" | "timeout-network" | "invalid-request" | "server" | "unknown";

const HTTP_STATUS_PATTERN = /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?:[-_ ]?code)?\s*[:=]?\s*)([45]\d{2})\b/gi;

function recognizedHttpStatus(value: unknown): number | undefined {
	const candidates = new Set<number>();
	const add = (candidate: unknown): void => {
		const parsed = typeof candidate === "number"
			? candidate
			: typeof candidate === "string" && /^(?:[45]\d{2})$/.test(candidate) ? Number(candidate) : undefined;
		if (parsed !== undefined && Number.isInteger(parsed) && parsed >= 400 && parsed <= 599) candidates.add(parsed);
	};
	const visit = (candidate: unknown, depth: number): void => {
		if (depth > 3 || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
		const record = candidate as Record<string, unknown>;
		for (const name of ["status", "statusCode", "httpStatus", "http_status"] as const) add(record[name]);
		for (const name of ["error", "details", "cause"] as const) visit(record[name], depth + 1);
	};
	visit(value, 0);
	if (typeof value === "string") {
		for (const match of value.matchAll(HTTP_STATUS_PATTERN)) add(match[1]);
	}
	return candidates.size === 1 ? [...candidates][0] : undefined;
}

function providerFailureText(value: unknown): string {
	if (typeof value === "string") return value.slice(0, 64 * 1024);
	if (!value || typeof value !== "object" || Array.isArray(value)) return "";
	const fragments: string[] = [];
	const visit = (candidate: unknown, depth: number): void => {
		if (depth > 2 || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
		const record = candidate as Record<string, unknown>;
		for (const name of ["message", "error", "detail", "code", "type"] as const) {
			if (typeof record[name] === "string") fragments.push(record[name].slice(0, 16 * 1024));
		}
		for (const name of ["error", "details", "cause"] as const) visit(record[name], depth + 1);
	};
	visit(value, 0);
	return fragments.join("\n");
}

function providerFailureCategory(status: number | undefined, text: string): OmpProviderFailureCategory {
	if (status === 401 || status === 403) return "auth";
	if (status === 429) return "rate-limit";
	if (status === 408 || status === 504) return "timeout-network";
	if (status !== undefined && status >= 400 && status <= 499) return "invalid-request";
	if (status !== undefined && status >= 500) return "server";
	const normalized = text.toLowerCase();
	if (/\b(?:unauthorized|forbidden|authentication|authorization|credentials?|invalid\s+(?:api\s+)?key)\b/.test(normalized)) return "auth";
	if (/\b(?:rate[ -]?limit|too many requests|throttl)/.test(normalized)) return "rate-limit";
	if (/\b(?:timed?\s*out|timeout|network|connection|socket|dns|econn)/.test(normalized)) return "timeout-network";
	if (/\b(?:bad request|not found|unprocessable|invalid request|validation)/.test(normalized)) return "invalid-request";
	if (/\b(?:internal server|service unavailable|gateway|server error)/.test(normalized)) return "server";
	return "unknown";
}

function providerFailureNotice(prefix: string, value: unknown): string {
	const evidence = typeof value === "string" ? redactedTextEvidence(value) : redactedValueEvidence(value);
	const status = recognizedHttpStatus(value);
	const category = providerFailureCategory(status, providerFailureText(value));
	return `${prefix}; category=${category};${status === undefined ? "" : ` httpStatus=${status};`} rawUtf8Bytes=${evidence.bytes}; sha256=${evidence.sha256}; raw provider details were not retained.`;
}

function terminalProviderFailureNotice(stopReason: string | undefined, text: string): string | undefined {
	if (stopReason === "stop" && text.trim()) return undefined;
	if (stopReason === "error") {
		return providerFailureNotice("OMP terminal provider outcome: error", text);
	}
	if (stopReason === "stop") {
		return providerFailureNotice("OMP terminal provider outcome: empty-output", text);
	}
	if (stopReason === "aborted" || stopReason === "cancelled") {
		return providerFailureNotice("OMP terminal provider outcome: cancelled", text);
	}
	if (stopReason === "length") {
		return providerFailureNotice("OMP terminal provider outcome: length-limited", text);
	}
	return providerFailureNotice("OMP terminal provider outcome: non-stop", text);
}

export function ompRuntimeStateIssue(stateValue: unknown, route: Readonly<OmpRoute>): string | undefined {
	if (!stateValue || typeof stateValue !== "object" || Array.isArray(stateValue)) return "OMP runtime state is missing";
	const data = stateValue as Record<string, unknown>;
	const model = data.model as Record<string, unknown> | undefined;
	if (model?.provider !== route.provider || model.id !== route.model || data.thinkingLevel !== route.reasoning) {
		const observedProvider = typeof model?.provider === "string" ? model.provider : "(missing)";
		const observedModel = typeof model?.id === "string" ? model.id : "(missing)";
		const observedReasoning = typeof data.thinkingLevel === "string" ? data.thinkingLevel : "(missing)";
		return `OMP runtime route or reasoning drifted (expected ${route.provider}/${route.model} at ${route.reasoning}; observed ${observedProvider}/${observedModel} at ${observedReasoning})`;
	}
	if (data.sessionFile !== undefined) return "OMP runtime created unexpected session state";
	const promptIssue = ompRuntimeSystemPromptIssue(data.systemPrompt);
	if (promptIssue) return promptIssue;
	const dumpTools = Array.isArray(data.dumpTools) ? data.dumpTools : [];
	const toolNames = dumpTools.flatMap((tool) => {
		if (!tool || typeof tool !== "object") return [];
		const name = (tool as Record<string, unknown>).name;
		return typeof name === "string" ? [name] : [];
	}).sort();
	if (JSON.stringify(toolNames) !== JSON.stringify([...OMP_READ_ONLY_TOOLS].sort())) {
		return "OMP runtime tool inventory drifted";
	}
	return undefined;
}

export function ompRuntimeSystemPromptIssue(value: unknown): string | undefined {
	if (!Array.isArray(value) || value.length !== 2 || value.some(item => typeof item !== "string")) {
		const strings = Array.isArray(value) && value.every((item): item is string => typeof item === "string")
			? value
			: undefined;
		if (!strings) return "OMP runtime system prompt has an invalid controller-owned shape";
		const joined = strings.join("\n\n");
		return `OMP runtime system prompt has an invalid controller-owned shape (observed ${strings.length} segments, ${Buffer.byteLength(joined, "utf8")} joined bytes, SHA-256 ${createHash("sha256").update(joined).digest("hex")})`;
	}
	const prompts = value as string[];
	const joined = prompts.join("\n\n");
	if (Buffer.byteLength(joined, "utf8") > OMP_SYSTEM_PROMPT_LIMIT) {
		return "OMP runtime system prompt exceeds the controller limit";
	}
	if (prompts[0] !== OMP_CONTROLLER_SYSTEM_PROMPT) {
		return "OMP runtime system prompt does not exactly match the controller-owned first block";
	}
	const projectPrompt = prompts[1]!;
	if (projectPrompt.length === 0) {
		return "OMP runtime system prompt has an empty OMP-owned project block";
	}
	if (/OX_DRIVER_AMBIENT_SENTINEL|<repo-rules>|<instructions>|<file\s+path=/i.test(projectPrompt)) {
		return "OMP runtime system prompt contains ambient instructions in the OMP-owned project block";
	}
	return undefined;
}

export function ompRuntimeSystemPromptEvidenceSha256(value: unknown): string | undefined {
	if (ompRuntimeSystemPromptIssue(value) !== undefined) return undefined;
	return createHash("sha256")
		.update((value as string[]).join("\n\n"))
		.digest("hex");
}

async function runRpc(
	executable: string,
	route: OmpRoute,
	spec: RunSpec,
	context: AdapterRunContext,
	expectedRouteEnforcementSha256: string,
	containmentInspection: Readonly<OmpProcessContainmentInspection>,
	policyBundleSha256: string,
): Promise<AdapterRunResult> {
	const isolation = await createOmpRuntimeIsolation(route.agentDirectory, context.runDirectory);
	const copiedRouteEvidence = await routeEnforcement(route);
	if (!copiedRouteEvidence.ready || copiedRouteEvidence.sha256 !== expectedRouteEnforcementSha256) {
		throw new Error("OMP route enforcement changed while preparing the isolated runtime");
	}
	if (JSON.stringify(copiedRouteEvidence.modelConfig ?? null) !== JSON.stringify(isolation.modelConfig ?? null)) {
		throw new Error("OMP isolated model configuration bytes do not match the reviewed route evidence");
	}
	if (await sha256File(executable) !== context.doctor.binarySha256) {
		throw new Error("OMP binary changed immediately before process admission");
	}
	const containment = await createOmpProcessContainmentLaunch({
		inspection: containmentInspection,
		workspaceRoot: spec.task.cwd,
		excludedPaths: spec.task.excludedPaths,
		controllerRoot: isolation.root,
		writablePaths: isolation.writableDirectories,
		immutableReadPaths: isolation.modelConfig
			? [{ path: join(isolation.agentDirectory, isolation.modelConfig.name), sha256: isolation.modelConfig.sha256 }]
			: [],
		executable,
		executableSha256: context.doctor.binarySha256,
		routeEnforcementSha256: expectedRouteEnforcementSha256,
	});
	const expectedToolNames: string[] = [...OMP_READ_ONLY_TOOLS].sort();
	const loggedArgs = [
		"--mode", "rpc",
		"--cwd", spec.task.cwd,
		"--no-session",
		"--config", isolation.overlayPath,
		"--no-extensions",
		"--no-skills",
		"--no-rules",
		"--no-lsp",
		"--no-pty",
		"--no-title",
		"--no-prewalk",
		"--tools", OMP_READ_ONLY_TOOLS.join(","),
		"--approval-mode", "always-ask",
		"--system-prompt", OMP_CONTROLLER_SYSTEM_PROMPT,
		"--model", `${route.provider}/${route.model}`,
		"--thinking", route.reasoning,
		"--max-time", `${spec.execution.timeoutSeconds}s`,
	];
	await context.emit("adapter.process.started", {
		executable: containment.command,
		argv: [...containment.argsPrefix, containment.executablePath, ...loggedArgs],
		targetExecutable: containment.executablePath,
		sourceExecutable: executable,
		isolationOverlaySha256: isolation.overlaySha256,
		containmentKind: containment.kind,
		containmentMechanismSha256: containment.mechanismSha256,
		containmentProfileSha256: containment.profileSha256,
		containmentEvidenceSha256: containment.evidenceSha256,
	});
	const admission = await context.processes.admit({
		label: "OMP RPC harness through macOS Seatbelt",
		detachedProcessGroup: process.platform !== "win32",
	});
	return new Promise((resolveRun, rejectRun) => {
		const args = loggedArgs;
		const childEnvironment: NodeJS.ProcessEnv = {
			...(route.environment ?? {}),
			...isolation.environment,
			PATH: `${dirname(containment.executablePath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
			LANG: "C.UTF-8",
			LC_ALL: "C.UTF-8",
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(containment.command, [...containment.argsPrefix, containment.executablePath, ...args], {
				cwd: spec.task.cwd,
				env: childEnvironment,
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
		} catch (error) {
			void admission.abandon("spawn-error").then(() => rejectRun(error), rejectRun);
			return;
		}
		const binding = child.pid === undefined
			? admission.abandon("spawn-error").then(() => { throw new Error("OMP RPC process did not expose a pid"); })
			: admission.bind(child.pid).catch(async (error: unknown) => {
				try { child.kill("SIGKILL"); } catch { /* child already exited */ }
				await admission.abandon("bind-error");
				throw error;
			});
		void binding.catch(() => undefined);
		let postSpawnExecutableError: unknown;
		const postSpawnExecutableEvidence = binding.then(async () => {
			if (await sha256File(containment.executablePath) !== context.doctor.binarySha256) {
				throw new Error("OMP staged binary changed across process spawn");
			}
			await verifyOmpProcessContainmentLaunch(containment);
		}).catch((error: unknown) => {
			postSpawnExecutableError = error;
		});
		const decoder = new RpcFrameDecoder();
		let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let settled = false;
		let ready = false;
		let protocolNegotiated = false;
		let promptSent = false;
		let promptAccepted = false;
		let agentStarted = false;
		let routeVerifiedBefore = false;
		let routeVerifiedAfter = false;
		let systemPromptEvidenceSha256Before: string | undefined;
		let terminalAgentEnd = false;
		let terminalStopReason: string | undefined;
		let terminalProviderFailure: string | undefined;
		let finalOutput: string | undefined;
		let blockedReason: string | undefined;
		let protocolError: string | undefined;
		let terminating = false;
		let forceKillTimer: NodeJS.Timeout | undefined;
		let eventWrite = Promise.resolve();
		const usageTracker = new OmpUsageTracker(route);

		const closeStdin = (): void => {
			if (!child.stdin!.destroyed && child.stdin!.writable) child.stdin!.end();
		};
		const send = (frame: Record<string, unknown>): void => {
			if (!child.stdin!.destroyed && child.stdin!.writable) child.stdin!.write(`${JSON.stringify(frame)}\n`);
		};
		const terminate = (): void => {
			if (terminating) return;
			terminating = true;
			send({ id: "abort-1", type: "abort" });
			setTimeout(closeStdin, 250).unref();
			forceKillTimer = setTimeout(() => {
				if (!child.pid || child.exitCode !== null) return;
				try {
					if (process.platform === "win32") child.kill("SIGKILL");
					else process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}, 5_000);
			forceKillTimer.unref();
		};
		child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
			protocolError ??= "OMP RPC stdin failed before transport shutdown.";
			terminate();
		});
		const closeWhenComplete = (): void => {
			if (promptAccepted && terminalAgentEnd && routeVerifiedAfter) closeStdin();
		};
		const verifyState = (frame: Record<string, unknown>, phase: "before" | "after"): boolean => {
			const issue = ompRuntimeStateIssue(frame.data, route);
			if (issue) protocolError = `${issue} ${phase} prompt`;
			if (issue) return false;
			const state = frame.data as Record<string, unknown>;
			const systemPromptEvidenceSha256 = ompRuntimeSystemPromptEvidenceSha256(state.systemPrompt);
			if (!systemPromptEvidenceSha256) {
				protocolError = `OMP runtime system-prompt evidence is unavailable ${phase} prompt`;
				return false;
			}
			const observedDispatchEnforcement = dispatchEnforcementSha256(
				expectedRouteEnforcementSha256,
				containment.mechanismSha256,
				systemPromptEvidenceSha256,
				policyBundleSha256,
			);
			if (observedDispatchEnforcement !== context.doctor.enforcementSha256) {
				protocolError = `OMP runtime system-prompt digest differs from the fresh-root doctor evidence ${phase} prompt`;
				return false;
			}
			if (phase === "before") systemPromptEvidenceSha256Before = systemPromptEvidenceSha256;
			else if (systemPromptEvidenceSha256Before !== systemPromptEvidenceSha256) {
				protocolError = "OMP runtime system prompt changed during the prompt";
				return false;
			}
			return true;
		};
		const consume = (frame: Record<string, unknown>): void => {
			usageTracker.observe(frame);
			// Normalize synchronously so the serialized event-write queue never
			// retains OMP's cumulative message snapshots. The full frame remains
			// available below only for immediate protocol decisions.
			const normalizedEvent = normalizedHarnessEvent(compactOmpEventForEvidence(frame));
			eventWrite = eventWrite.then(async () => context.emit("harness.event", {
				event: normalizedEvent,
			})).then(() => undefined);
			if (frame.type === "ready") {
				const supported = Array.isArray(frame.supportedProtocolVersions) ? frame.supportedProtocolVersions : [];
				if (ready || frame.protocolVersion !== 1 || !supported.includes(2)) {
					protocolError = ready ? "OMP emitted a duplicate ready frame" : "OMP RPC v2 is unavailable";
					terminate();
					return;
				}
				ready = true;
				send({ id: "protocol-1", type: "negotiate_protocol", protocolVersion: 2 });
				return;
			}
			if (frame.type === "extension_ui_request") {
				const method = String(frame.method ?? "");
				if (["setWidget", "setStatus", "setTitle", "notify"].includes(method) && typeof frame.id === "string") {
					send({ type: "extension_ui_response", id: frame.id, confirmed: true });
					return;
				}
				blockedReason = `unexpected interactive OMP request: ${method || "extension_ui_request"}`;
				if (typeof frame.id === "string") send({ type: "extension_ui_response", id: frame.id, cancelled: true });
				terminate();
				return;
			}
			if (frame.type === "host_tool_call") {
				blockedReason = "unexpected interactive OMP request: host_tool_call";
				terminate();
				return;
			}
			if (frame.type === "host_tool_cancel") return;
			if (frame.type === "host_uri_request" || frame.type === "host_uri_cancel") {
				blockedReason = `unexpected interactive OMP request: ${String(frame.type)}`;
				terminate();
				return;
			}
			if (frame.type === "tool_execution_start") {
				const toolCall = frame.toolCall as Record<string, unknown> | undefined;
				const tool = frame.tool as Record<string, unknown> | undefined;
				const toolName = String(frame.toolName ?? toolCall?.name ?? tool?.name ?? "");
				if (!expectedToolNames.includes(toolName)) {
					blockedReason = `unexpected OMP tool in read-only mode: ${toolName || "unknown"}`;
					terminate();
					return;
				}
			}
			if (["model_changed", "thinking_level_changed", "retry_fallback_applied", "retry_fallback_succeeded"].includes(String(frame.type))) {
				protocolError = `unexpected OMP route-control event: ${String(frame.type)}`;
				terminate();
				return;
			}
			if (String(frame.type).startsWith("subagent_")) {
				protocolError = `unexpected OMP child event in solo mode: ${String(frame.type)}`;
				terminate();
				return;
			}
			if (frame.type === "extension_error") {
				protocolError = providerFailureNotice("OMP extension error", frame.error);
				terminate();
				return;
			}
			if (frame.type === "prompt_result" && promptSent) {
				if (frame.agentInvoked === false) {
					protocolError = "OMP reported that the prompt completed without a model-backed agent turn";
					terminate();
				}
				return;
			}
			if (frame.type === "agent_start" && promptSent) {
				if (agentStarted || terminalAgentEnd) {
					protocolError = "OMP emitted an out-of-order agent_start event";
					terminate();
					return;
				}
				agentStarted = true;
			}
			const message = assistantMessage(frame);
			if (message && promptSent && agentStarted) {
				if (terminalAgentEnd) {
					protocolError = "OMP emitted an assistant message after terminal agent_end";
					terminate();
					return;
				}
				terminalStopReason = message.stopReason;
				terminalProviderFailure = terminalProviderFailureNotice(message.stopReason, message.text);
				if (!terminalProviderFailure) finalOutput = message.text;
			}
			if (frame.type === "agent_end" && frame.isTerminal !== false && promptSent) {
				if (!agentStarted || terminalAgentEnd || terminalStopReason === undefined) {
					protocolError = "OMP emitted an out-of-order terminal agent_end event";
					terminate();
					return;
				}
				terminalAgentEnd = true;
				send({ id: "state-after", type: "get_state" });
				return;
			}
			if (frame.type !== "response") return;
			if (frame.success !== true) {
				protocolError = frame.id === "prompt-1" || frame.command === "prompt"
					? providerFailureNotice("OMP provider request failed before a terminal response", frame.error)
					: providerFailureNotice("OMP RPC control command failed", frame.error);
				terminate();
				return;
			}
			if (frame.id === "protocol-1") {
				const data = frame.data as Record<string, unknown> | undefined;
				if (!ready || protocolNegotiated || frame.command !== "negotiate_protocol" || data?.protocolVersion !== 2) {
					protocolError = "OMP returned an invalid protocol-negotiation response";
					terminate();
					return;
				}
				protocolNegotiated = true;
				send({ id: "state-before", type: "get_state" });
			} else if (frame.id === "state-before") {
				if (!protocolNegotiated || routeVerifiedBefore || promptSent || frame.command !== "get_state") {
					protocolError = "OMP returned a mismatched state response";
					terminate();
					return;
				}
				routeVerifiedBefore = verifyState(frame, "before");
				if (routeVerifiedBefore) {
					promptSent = true;
					send({ id: "prompt-1", type: "prompt", message: buildBrief(spec) });
				}
				else terminate();
			} else if (frame.id === "prompt-1") {
				const data = frame.data as Record<string, unknown> | undefined;
				const agentInvoked = data?.agentInvoked;
				if (!promptSent || !routeVerifiedBefore || promptAccepted || frame.command !== "prompt"
					|| agentInvoked === false || (agentInvoked !== undefined && agentInvoked !== true)) {
					protocolError = "OMP prompt did not acknowledge a model-backed agent turn";
					terminate();
					return;
				}
				promptAccepted = true;
				closeWhenComplete();
			} else if (frame.id === "state-after") {
				if (!terminalAgentEnd || routeVerifiedAfter || frame.command !== "get_state") {
					protocolError = "OMP returned a mismatched final-state response";
					terminate();
					return;
				}
				routeVerifiedAfter = verifyState(frame, "after");
				if (routeVerifiedAfter) closeWhenComplete();
				else terminate();
			}
		};

		context.signal.addEventListener("abort", terminate, { once: true });
		if (context.signal.aborted) terminate();
		child.stdout!.on("data", (chunk: Buffer) => {
			const appended = appendBounded(stdout, chunk);
			stdout = appended.value;
			stdoutTruncated ||= appended.truncated;
			try {
				for (const frame of decoder.push(chunk)) consume(frame);
			} catch (error) {
				protocolError ??= error instanceof Error ? error.message : String(error);
				terminate();
			}
		});
		child.stderr!.on("data", (chunk: Buffer) => {
			const appended = appendBounded(stderr, chunk);
			stderr = appended.value;
			stderrTruncated ||= appended.truncated;
		});
		child.once("error", async (error) => {
			if (settled) return;
			settled = true;
			if (forceKillTimer) clearTimeout(forceKillTimer);
			context.signal.removeEventListener("abort", terminate);
			await postSpawnExecutableEvidence;
			rejectRun(error);
		});
		child.once("close", async (exitCode, terminationSignal) => {
			if (settled) return;
			settled = true;
			if (terminating && child.pid && process.platform !== "win32") {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					// The process group already exited.
				}
			}
			if (forceKillTimer) clearTimeout(forceKillTimer);
			context.signal.removeEventListener("abort", terminate);
			try {
				await postSpawnExecutableEvidence;
				if (postSpawnExecutableError) throw postSpawnExecutableError;
				await admission.complete({
					exitCode,
					...(terminationSignal ? { terminationSignal } : {}),
				});
				if (!protocolError) {
					for (const frame of decoder.finish()) consume(frame);
				}
				await eventWrite;
				const processTree = await reapDetachedProcessGroup(child.pid);
					const overlayVerified = await sha256File(isolation.overlayPath).then(
						observed => observed === isolation.overlaySha256,
						() => false,
					);
					const containmentVerified = await verifyOmpProcessContainmentLaunch(containment).then(
						() => true,
						() => false,
					);
				await Promise.all([
					writeFile(join(context.runDirectory, "stdout.log"), `${JSON.stringify({
						...redactedTextEvidence(stdout.toString("utf8")),
						captureTruncated: stdoutTruncated,
					})}\n`, { mode: 0o600 }),
					writeFile(join(context.runDirectory, "stderr.log"), `${JSON.stringify({
						...redactedTextEvidence(stderr.toString("utf8")),
						captureTruncated: stderrTruncated,
					})}\n`, { mode: 0o600 }),
				]);
					const complete = exitCode === 0
						&& ready
						&& promptAccepted
						&& agentStarted
					&& routeVerifiedBefore
					&& routeVerifiedAfter
					&& terminalAgentEnd
					&& terminalStopReason === "stop"
						&& Boolean(finalOutput?.trim())
						&& overlayVerified
						&& containmentVerified
					&& !protocolError
					&& !blockedReason
					&& !processTree.backgroundProcessesDetected
					&& processTree.processTreeReaped;
				const transport = decoder.transportEvidence();
				const notices = [
					...(protocolError ? [protocolError] : []),
					...(blockedReason ? [blockedReason] : []),
					...(terminalProviderFailure ? [terminalProviderFailure] : []),
					...(stdoutTruncated ? ["OMP stdout capture was truncated."] : []),
						...(stderrTruncated ? ["OMP stderr capture was truncated."] : []),
						...(!overlayVerified ? ["OMP controller isolation overlay changed during the run."] : []),
						...(!containmentVerified ? ["OMP process-bound containment evidence changed during the run."] : []),
					...(exitCode !== 0 && stderr.length ? ["OMP emitted stderr; only digest evidence was retained."] : []),
					...(processTree.backgroundProcessesDetected ? ["OMP left background processes after its main process exited; the controller reaped the detached group and failed the run."] : []),
					...(!processTree.processTreeReaped ? ["OMP process-tree cleanup could not be verified."] : []),
					...(processTree.terminationEscalated ? ["OMP process-tree cleanup required SIGKILL escalation."] : []),
					`OMP RPC transport evidence: wireBytes=${transport.wireBytes}; ordinaryWireBytes=${transport.ordinaryWireBytes}; replayAmplificationBytes=${transport.replayAmplificationBytes}; messageUpdateFrames=${transport.messageUpdateFrames}; frameCount=${transport.frameCount}; maxLogicalFrameBytes=${transport.maxLogicalFrameBytes}.`,
				];
				resolveRun({
					status: context.signal.aborted ? "cancelled" : blockedReason ? "blocked" : complete ? "completed" : "failed",
					exitCode,
					...(finalOutput !== undefined ? { finalOutput } : {}),
					configuredRoute: { provider: route.provider, model: route.model, reasoning: route.reasoning },
					usage: usageTracker.snapshot(complete),
					...(notices.length ? { notices } : {}),
				});
			} catch (error) {
				rejectRun(error);
			}
		});
	});
}

export interface OmpAdapterOptions {
	launcher?: string;
	profileId?: string;
	routeProfileSha256?: string;
	expectedVersion?: string;
	expectedSha256?: string;
	route?: OmpRoute;
	skipRpcProbe?: boolean;
	enableProcessContainment?: boolean;
	enableReadOnlyHostTools?: boolean;
	expectedPolicyBundleSha256?: string;
}

export class OmpAdapter implements HarnessAdapter {
	readonly id = "omp-rpc-v2";
	readonly harness = "omp";
	readonly #launcher: string;
	readonly #profileId: string;
	readonly #routeProfileSha256: string | undefined;
	readonly #expectedVersion: string;
	readonly #expectedSha256: string | undefined;
	readonly #route: OmpRoute | undefined;
	readonly #skipRpcProbe: boolean;
	readonly #enableProcessContainment: boolean;
	readonly #enableReadOnlyHostTools: boolean;
	readonly #expectedPolicyBundleSha256: string;

	constructor(options: OmpAdapterOptions = {}) {
		this.#launcher = options.launcher ?? defaultLauncher();
		this.#profileId = options.profileId ?? "omp-explicit-isolated";
		this.#routeProfileSha256 = options.routeProfileSha256;
		this.#expectedVersion = options.expectedVersion ?? PINNED_VERSION;
		this.#expectedSha256 = options.expectedSha256
			?? (process.platform === "darwin" && process.arch === "arm64" ? PINNED_DARWIN_ARM64_SHA256 : undefined);
		this.#route = options.route ?? configuredRoute();
		this.#skipRpcProbe = options.skipRpcProbe ?? false;
		this.#enableProcessContainment = options.enableProcessContainment ?? true;
		this.#enableReadOnlyHostTools = options.enableReadOnlyHostTools ?? false;
		this.#expectedPolicyBundleSha256 = options.expectedPolicyBundleSha256 ?? OMP_POLICY_BUNDLE_SHA256;
	}

	async doctor(): Promise<HarnessCapabilities> {
		let executable: string;
		let binarySha256: string;
		try {
			executable = await resolveExecutable(this.#launcher);
			binarySha256 = await sha256File(executable);
		} catch (error) {
			return {
				version: 1,
				adapterId: this.id,
				harness: this.harness,
				compatibility: "blocked",
				available: false,
				capabilities: {},
					notices: [error instanceof Error ? error.message : String(error)],
			};
		}
		const artifactStatus = this.#expectedSha256 === undefined
			? "unverified" as const
			: binarySha256 === this.#expectedSha256 ? "verified" as const : "drifted" as const;
		if (artifactStatus !== "verified") {
			return {
				version: 1,
				adapterId: this.id,
				harness: this.harness,
				compatibility: "blocked",
				available: true,
				executable,
				binarySha256,
				probe: {
					version: 1,
					modelCalls: 0,
					contract: `omp-${this.#expectedVersion}-rpc-v2`,
					artifact: artifactStatus,
					executionQualified: false,
				},
				capabilities: {},
				notices: [
					artifactStatus === "unverified"
						? "this platform has no reviewed OMP binary digest; doctor refused to execute it"
						: "OMP binary digest differs from the pinned release artifact; doctor refused to execute it",
					"No version command, RPC command, prompt, or model call was executed.",
				],
			};
		}
		const containment = this.#enableProcessContainment
			? await inspectOmpProcessContainment()
			: { available: false, notice: "OMP process containment was disabled by explicit adapter configuration" };
		let rpc: RpcProbe;
		try {
			if (this.#skipRpcProbe) {
				rpc = {
					ok: false,
					versionMatches: false,
					protocolVersions: [1, 2],
					negotiatedVersion: 2,
					processBound: false,
					immutableStagedExecutable: false,
					networkNone: false,
					systemPromptExactMatch: false,
					notices: ["RPC smoke was skipped by an explicit test option."],
				};
			} else {
				const firstProbe = await probeRpc(executable, binarySha256, this.#expectedVersion, containment);
				const freshRootProbe = await probeRpc(executable, binarySha256, this.#expectedVersion, containment);
				const promptEvidenceStable = firstProbe.systemPromptEvidenceSha256 !== undefined
					&& firstProbe.systemPromptEvidenceSha256 === freshRootProbe.systemPromptEvidenceSha256;
				rpc = {
					...firstProbe,
					ok: firstProbe.ok && freshRootProbe.ok && promptEvidenceStable,
					versionMatches: firstProbe.versionMatches && freshRootProbe.versionMatches,
					processBound: firstProbe.processBound && freshRootProbe.processBound,
					immutableStagedExecutable: firstProbe.immutableStagedExecutable && freshRootProbe.immutableStagedExecutable,
					networkNone: firstProbe.networkNone && freshRootProbe.networkNone,
					systemPromptExactMatch: firstProbe.systemPromptExactMatch
						&& freshRootProbe.systemPromptExactMatch
						&& promptEvidenceStable,
					notices: [
						...firstProbe.notices,
						...(freshRootProbe.ok ? [] : freshRootProbe.notices.map(notice => `Fresh-root RPC probe: ${notice}`)),
						...(promptEvidenceStable
							? [`Fresh-root RPC probe reproduced the exact system-prompt digest ${firstProbe.systemPromptEvidenceSha256}.`]
							: ["Fresh-root RPC probe did not reproduce the system-prompt digest."]),
					],
				};
			}
		} catch (error) {
			rpc = {
				ok: false,
				versionMatches: false,
				protocolVersions: [],
				processBound: false,
				immutableStagedExecutable: false,
				networkNone: false,
				systemPromptExactMatch: false,
				notices: [`RPC probe failed: ${error instanceof Error ? error.message : String(error)}`],
			};
		}
		const routeEvidence = this.#route
			? await routeEnforcement(this.#route)
			: { ready: false, notice: "no explicit OMP route is configured" };
		const policyBundleSha256 = await ompPolicyBundleSha256();
		const policyBundlePinned = policyBundleSha256 === this.#expectedPolicyBundleSha256;
		const routeReady = routeEvidence.ready;
		const qualified = rpc.versionMatches && rpc.ok;
		const executionReady = qualified
			&& routeReady
			&& containment.available
			&& rpc.processBound
			&& rpc.immutableStagedExecutable
			&& rpc.networkNone
			&& rpc.systemPromptExactMatch
			&& rpc.systemPromptEvidenceSha256 !== undefined
			&& policyBundlePinned
			&& !this.#enableReadOnlyHostTools;
		const dispatchEnforcement = routeEvidence.sha256 && containment.mechanismSha256 && rpc.systemPromptEvidenceSha256
			? dispatchEnforcementSha256(routeEvidence.sha256, containment.mechanismSha256, rpc.systemPromptEvidenceSha256, policyBundleSha256)
			: undefined;
		const notices = [
			`qualified OMP contract: ${this.#expectedVersion}, RPC v2`,
			...rpc.notices,
			...(routeReady
				? ["An exact OMP provider, model, reasoning level, private home, and hashed agent configuration are configured."]
				: [routeEvidence.notice ?? "No dispatch route is configured. Set OX_DRIVER_OMP_PROVIDER, OX_DRIVER_OMP_MODEL, OX_DRIVER_OMP_REASONING, OX_DRIVER_OMP_AGENT_DIR, and OX_DRIVER_OMP_HOME."]),
			containment.notice,
			policyBundlePinned
				? `The compiled OMP isolation and process-containment policy bundle matches the reviewed SHA-256 ${policyBundleSha256}.`
				: `OMP policy bundle drifted from the reviewed SHA-256 pin: observed ${policyBundleSha256}.`,
			...(containment.available
				? ["The controller will spawn the durably admitted OMP process through a generated macOS Seatbelt profile; callback-issued proof digests are not accepted."]
				: ["OMP RPC transport may be qualified, but dispatch remains blocked without a process-bound containment launcher."]),
			...(this.#enableReadOnlyHostTools
				? ["The requested OMP controller host-tool lane is disabled because path-based filesystem calls cannot eliminate path-component TOCTOU races."]
				: []),
			"Doctor used a synthetic no-network model and did not send a prompt or invoke a model.",
		];
		return {
			version: 1,
			adapterId: this.id,
			harness: this.harness,
			compatibility: qualified ? (executionReady ? "compatible" : "degraded") : "blocked",
			available: true,
			executable,
			binarySha256,
			...(this.#routeProfileSha256 ? { routeProfileSha256: this.#routeProfileSha256 } : {}),
			...(dispatchEnforcement
				? { enforcementSha256: dispatchEnforcement }
				: routeEvidence.sha256 ? { enforcementSha256: routeEvidence.sha256 } : {}),
			...(rpc.version ? { harnessVersion: rpc.version } : {}),
			...(routeReady && this.#route ? {
				configuredRoute: {
					provider: this.#route.provider,
					model: this.#route.model,
					reasoning: this.#route.reasoning,
				},
			} : {}),
			probe: {
				version: 1,
				modelCalls: 0,
				contract: `omp-${this.#expectedVersion}-rpc-v2`,
				artifact: artifactStatus,
				executionQualified: executionReady,
				protocol: {
					name: "omp-jsonl-rpc",
					...(rpc.negotiatedVersion ? { negotiatedVersion: rpc.negotiatedVersion } : {}),
					supportedVersions: rpc.protocolVersions,
				},
			},
			capabilities: {
				"session.ephemeral": qualified,
				"session.new": false,
				"session.resume": false,
				"session.fork": false,
				"control.cancel": qualified,
				"control.steer": false,
				"approval.bridge": false,
				"events.structured": qualified,
				"output.schema": false,
				"route.configured": qualified && routeReady,
				"agent.identity": false,
				"telemetry.usage": executionReady,
				"limits.providerRequests": false,
				"limits.toolCalls": false,
				"limits.spend": false,
				"limits.children": false,
				"sandbox.filesystem": executionReady,
				"sandbox.network.open": false,
				"sandbox.network.restricted": false,
				"sandbox.network.none": false,
				"agents.children": false,
				"agents.hierarchical": false,
				"agents.receipts": false,
				"worktree.native": false,
			},
			notices,
		};
	}

	async preflight(spec: RunSpec, doctor: HarnessCapabilities): Promise<PreflightIssue[]> {
		const issues: PreflightIssue[] = [];
		if (spec.tier !== "attested") {
			issues.push({ severity: "error", code: "OMP_TIER_UNSUPPORTED", message: "OMP dispatch is qualified only for the attested tier" });
		}
		if (spec.routeProfile !== this.#profileId) {
			issues.push({ severity: "error", code: "ROUTE_PROFILE_REQUIRED", message: `OMP dispatch requires route profile ${this.#profileId}` });
		}
		if (spec.execution.session !== "ephemeral") {
			issues.push({ severity: "error", code: "OMP_SESSION_UNVERIFIED", message: "the first OMP RPC adapter supports ephemeral sessions only" });
		}
		if (spec.execution.topology !== "solo") {
			issues.push({ severity: "error", code: "OMP_TOPOLOGY_UNVERIFIED", message: "OMP task agents remain disabled until child limits and receipts pass controller tests" });
		}
		if (spec.execution.writerPolicy !== "read-only") {
			issues.push({ severity: "error", code: "OMP_WRITER_UNVERIFIED", message: "the OMP adapter exposes only read, grep, and glob" });
		}
		if (spec.execution.network !== "configured") {
			issues.push({ severity: "error", code: "OMP_NETWORK_MODE_UNVERIFIED", message: "explicit OMP network modes have not passed OS-level integration tests" });
		}
		if (this.#enableReadOnlyHostTools) {
			issues.push({
				severity: "error",
				code: "OMP_HOST_TOOLS_DISABLED",
				message: "controller host tools remain disabled until an OS-level descriptor-relative broker eliminates path-component TOCTOU races",
			});
		}
		if (!doctor.configuredRoute || !this.#route) {
			issues.push({ severity: "error", code: "OMP_ROUTE_REQUIRED", message: "an exact isolated OMP route must be configured before dispatch" });
		}
		if (doctor.capabilities["sandbox.filesystem"] !== true) {
			issues.push({
				severity: "error",
				code: "OMP_CONTAINMENT_UNVERIFIED",
				message: "OMP dispatch requires a process-bound containment launcher",
			});
		} else {
			try {
				await validateOmpContainmentScope(spec.task.cwd, spec.task.excludedPaths);
			} catch (error) {
				issues.push({
					severity: "error",
					code: "OMP_CONTAINMENT_SCOPE_REJECTED",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return issues;
	}

	async run(spec: RunSpec, context: AdapterRunContext): Promise<AdapterRunResult> {
		if (spec.tier !== "attested") throw new Error("OMP received a run outside its attested tier contract");
		if (!this.#route || !context.doctor.configuredRoute || !context.doctor.executable) {
			throw new Error("OMP route or executable disappeared after preflight");
		}
		if (!this.#enableProcessContainment || context.doctor.capabilities["sandbox.filesystem"] !== true) {
			throw new Error("OMP process-bound containment disappeared after preflight");
		}
		if (this.#enableReadOnlyHostTools) {
			throw new Error("OMP controller host tools are disabled until an OS-level descriptor-relative broker is qualified");
		}
		const containment = await inspectOmpProcessContainment();
		if (!containment.available || !containment.mechanismSha256) throw new Error(containment.notice);
		const policyBundleSha256 = await ompPolicyBundleSha256();
		if (policyBundleSha256 !== this.#expectedPolicyBundleSha256) {
			throw new Error("OMP policy bundle changed after preflight");
		}
		const executable = await resolveExecutable(context.doctor.executable);
		if (await sha256File(executable) !== context.doctor.binarySha256) throw new Error("OMP binary changed after preflight");
		const routeEvidence = await routeEnforcement(this.#route);
		if (!routeEvidence.ready || !routeEvidence.sha256 || !context.doctor.enforcementSha256) {
			throw new Error("OMP route or process-containment enforcement changed after preflight");
		}
		const result = await runRpc(executable, this.#route, spec, context, routeEvidence.sha256, containment, policyBundleSha256);
		const [postRunRouteEvidence, postRunContainment, postRunPolicyBundleSha256] = await Promise.all([
			routeEnforcement(this.#route),
			inspectOmpProcessContainment(),
			ompPolicyBundleSha256(),
		]);
		if (!postRunRouteEvidence.ready || postRunRouteEvidence.sha256 !== routeEvidence.sha256
			|| postRunContainment.mechanismSha256 !== containment.mechanismSha256
			|| postRunPolicyBundleSha256 !== policyBundleSha256) {
			return {
				...result,
				status: "failed",
				notices: [...(result.notices ?? []), "OMP route or process-bound containment enforcement changed during the run."],
			};
		}
		return result;
	}
}

export const ompPinnedRelease = {
	version: PINNED_VERSION,
	darwinArm64Sha256: PINNED_DARWIN_ARM64_SHA256,
} as const;

export { OMP_ISOLATION_OVERLAY, OMP_ISOLATION_OVERLAY_SHA256 } from "./isolation.js";
export {
	OMP_DARWIN_SEATBELT_SHA256,
	OMP_DARWIN_SYSTEM_PROFILE_SHA256,
	createOmpProcessContainmentLaunch,
	inspectOmpProcessContainment,
	validateOmpContainmentScope,
	verifyOmpProcessContainmentLaunch,
	type OmpProcessContainmentInspection,
	type OmpProcessContainmentLaunch,
} from "./process-containment.js";
