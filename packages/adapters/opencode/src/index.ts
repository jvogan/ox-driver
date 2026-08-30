import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { gatedProcessArguments } from "@ox-driver/core";
import type {
	AdapterRunContext,
	AdapterRunResult,
	HarnessAdapter,
	HarnessCapabilities,
	PreflightIssue,
	ResolvedRouteProfile,
	RunSpec,
} from "@ox-driver/core";

import {
	delegationEvidenceQuery,
	delegationProbeQuery,
	inspectDelegationEvidence,
} from "./session-db.js";

const OUTPUT_LIMIT = 16 * 1024 * 1024;
const PROBE_OUTPUT_LIMIT = 1024 * 1024;
const PROBE_TIMEOUT_MILLISECONDS = 10_000;
const SESSION_ID = /^ses_[A-Za-z0-9]+$/;
const execFileAsync = promisify(execFile);

type JsonObject = Record<string, unknown>;

export interface OpenCodeAdapterOptions {
	profile: ResolvedRouteProfile;
	launcher?: string;
}

interface OpenCodeRunObservation {
	sessionId?: string;
	exitCode: number | null;
	terminationSignal?: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	providerRequests: number;
	toolCalls: number;
	childrenStarted: number;
	reportedCostUsdMicros?: number;
	finalOutput?: string;
	terminalStop: boolean;
	protocolError?: string;
	backgroundProcessesDetected: boolean;
	agentFallbackDetected: boolean;
}

interface TrustedProcessObservation {
	exitCode: number | null;
	terminationSignal?: string;
	stdout: Buffer;
	stderr: Buffer;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	backgroundProcessesDetected: boolean;
	agentFallbackDetected: boolean;
}

function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertProfile(profile: ResolvedRouteProfile): void {
	if (profile.status !== "active") throw new Error(`OpenCode route profile ${profile.id} must be active`);
	if (profile.harness !== "opencode") throw new Error(`OpenCode route profile ${profile.id} targets ${profile.harness}`);
	if (profile.tier !== "trusted-host") throw new Error(`OpenCode route profile ${profile.id} must use trusted-host tier`);
}

async function probeAgentProfile(launcher: string, profile: string): Promise<JsonObject> {
	const executable = await resolveExecutable(launcher);
	const result = await execFileAsync(executable, ["debug", "agent", profile], {
		timeout: PROBE_TIMEOUT_MILLISECONDS,
		maxBuffer: PROBE_OUTPUT_LIMIT,
	});
	const parsed = JSON.parse(result.stdout) as unknown;
	if (!isObject(parsed) || parsed.name !== profile) {
		throw new Error(`OpenCode debug agent did not return exact profile ${profile}`);
	}
	return parsed;
}

async function resolveExecutable(command: string): Promise<string> {
	const candidates = command.includes("/")
		? [command]
		: (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, command));
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.R_OK | constants.X_OK);
			const path = await realpath(candidate);
			if ((await stat(path)).isFile()) return path;
		} catch {
			continue;
		}
	}
	throw new Error(`OpenCode launcher is unavailable: ${command}`);
}

async function sha256(path: string): Promise<string> {
	return new Promise((resolveHash, rejectHash) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.once("error", rejectHash);
		stream.once("end", () => resolveHash(hash.digest("hex")));
	});
}

function appendBounded(current: Buffer, chunk: Buffer): { bytes: Buffer; truncated: boolean } {
	if (current.length >= OUTPUT_LIMIT) return { bytes: current, truncated: true };
	const remaining = OUTPUT_LIMIT - current.length;
	return { bytes: Buffer.concat([current, chunk.subarray(0, remaining)]), truncated: chunk.length > remaining };
}

function terminateProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		if (process.platform !== "win32") process.kill(-pid, signal);
		else process.kill(pid, signal);
	} catch {
		// The admitted process group may already be gone.
	}
}

function processGroupAlive(pid: number): boolean {
	try {
		if (process.platform !== "win32") process.kill(-pid, 0);
		else process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function persistDelegationEvidence(context: AdapterRunContext, evidence: unknown): Promise<{
	path: string;
	sha256: string;
	bytes: number;
}> {
	const path = join(context.runDirectory, "artifacts", "opencode-delegation.json");
	const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
	const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	return {
		path: "artifacts/opencode-delegation.json",
		sha256: createHash("sha256").update(bytes).digest("hex"),
		bytes: bytes.length,
	};
}

function parseOpenCodeEvents(stdout: string, requireSessionBinding: boolean): Omit<OpenCodeRunObservation,
	"exitCode" | "terminationSignal" | "stdoutTruncated" | "stderrTruncated" | "backgroundProcessesDetected" | "agentFallbackDetected"> {
	let providerRequests = 0;
	let toolCalls = 0;
	let childrenStarted = 0;
	let reportedCostUsdMicros = 0;
	let completeCost = true;
	let sessionId: string | undefined;
	let currentText: string[] = [];
	let finalOutput: string | undefined;
	let terminalStop = false;
	try {
		for (const line of stdout.split("\n")) {
			if (!line.trim()) continue;
			const event = JSON.parse(line) as JsonObject;
			if (!isObject(event) || typeof event.type !== "string" || !isObject(event.part)) {
				throw new Error("event is not a structured OpenCode part");
			}
			const eventSessionId = typeof event.sessionID === "string" && event.sessionID.trim() ? event.sessionID : undefined;
			const partSessionId = typeof event.part.sessionID === "string" && event.part.sessionID.trim() ? event.part.sessionID : undefined;
			if ((eventSessionId && !SESSION_ID.test(eventSessionId)) || (partSessionId && !SESSION_ID.test(partSessionId))) {
				throw new Error("event stream contains a noncanonical session identity");
			}
			if (eventSessionId && partSessionId && eventSessionId !== partSessionId) throw new Error("event and part session identities differ");
			const observedSessionId = eventSessionId ?? partSessionId;
			if (requireSessionBinding && !observedSessionId) throw new Error("flat event stream contains an event without a session identity");
			if (observedSessionId) {
				if (sessionId && sessionId !== observedSessionId) throw new Error("event stream contains multiple root sessions");
				sessionId = observedSessionId;
			}
			if (event.type === "step_start") currentText = [];
			else if (event.type === "text" && typeof event.part.text === "string") currentText.push(event.part.text);
			else if (event.type === "tool_use") {
				toolCalls += 1;
				if (event.part.tool === "task") childrenStarted += 1;
			}
			else if (event.type === "step_finish") {
				providerRequests += 1;
				if (typeof event.part.cost === "number" && Number.isFinite(event.part.cost) && event.part.cost >= 0) {
					reportedCostUsdMicros += Math.round(event.part.cost * 1_000_000);
				} else completeCost = false;
				if (event.part.reason === "stop") {
					terminalStop = true;
					finalOutput = currentText.join("\n").trim();
				}
			}
		}
		return {
			...(sessionId ? { sessionId } : {}),
			providerRequests,
			toolCalls,
			childrenStarted,
			...(completeCost ? { reportedCostUsdMicros } : {}),
			...(finalOutput ? { finalOutput } : {}),
			terminalStop,
		};
	} catch (error) {
		return {
			providerRequests,
			toolCalls,
			childrenStarted,
			terminalStop: false,
			protocolError: `OpenCode JSON event stream was invalid: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

async function runTrustedOpenCode(
	launcher: string,
	args: readonly string[],
	cwd: string,
	context: AdapterRunContext,
	requireSessionBinding: boolean,
): Promise<OpenCodeRunObservation> {
	const processResult = await runTrustedProcess(launcher, args, cwd, context, "opencode-trusted-host");
	const parsed = parseOpenCodeEvents(processResult.stdout.toString("utf8"), requireSessionBinding);
	if (processResult.stderr.length > 0) await context.emit("harness.stderr", {
		bytes: processResult.stderr.length,
		sha256: createHash("sha256").update(processResult.stderr).digest("hex"),
	});
	return {
		...parsed,
		exitCode: processResult.exitCode,
		...(processResult.terminationSignal ? { terminationSignal: processResult.terminationSignal } : {}),
		stdoutTruncated: processResult.stdoutTruncated,
		stderrTruncated: processResult.stderrTruncated,
		backgroundProcessesDetected: processResult.backgroundProcessesDetected,
		agentFallbackDetected: processResult.agentFallbackDetected,
	};
}

async function runTrustedProcess(
	launcher: string,
	args: readonly string[],
	cwd: string,
	context: AdapterRunContext,
	label: string,
): Promise<TrustedProcessObservation> {
	const admission = await context.processes.admit({ label, detachedProcessGroup: true });
	let child;
	try {
		child = spawn(process.execPath, gatedProcessArguments(launcher, args), {
			cwd,
			env: { ...process.env },
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
	} catch (error) {
		await admission.abandon("spawn-error");
		throw error;
	}
	if (!child.pid) {
		await admission.abandon("spawn-error");
		throw new Error("OpenCode did not expose a process id");
	}
	const pid = child.pid;
	let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let stdoutTruncated = false;
	let stderrTruncated = false;
	let agentFallbackDetected = false;
	let stderrScanWindow = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		const next = appendBounded(stdout, chunk);
		stdout = next.bytes;
		stdoutTruncated ||= next.truncated;
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		const scan = `${stderrScanWindow}${chunk.toString("utf8")}`;
		agentFallbackDetected ||= /falling back to (?:the )?default|cannot be used as (?:a )?primary/i.test(scan);
		stderrScanWindow = scan.slice(-512);
		const next = appendBounded(stderr, chunk);
		stderr = next.bytes;
		stderrTruncated ||= next.truncated;
	});
	// Register output and terminal listeners before durable binding. A fast
	// launcher can otherwise exit while bind() is awaiting filesystem I/O,
	// leaving the controller waiting for an event that already fired.
	const exitPromise = new Promise<{ exitCode: number | null; terminationSignal?: string }>((resolveExit, rejectExit) => {
		child.once("error", rejectExit);
		child.once("close", (exitCode, terminationSignal) => resolveExit({
			exitCode,
			...(terminationSignal ? { terminationSignal } : {}),
		}));
	});
	void exitPromise.catch(() => undefined);
	try {
		await admission.bind(pid);
		child.stdin.end("start\n");
	} catch (error) {
		terminateProcessGroup(pid, "SIGKILL");
		await admission.abandon("bind-error");
		throw error;
	}

	let killTimer: NodeJS.Timeout | undefined;
	const cancel = (): void => {
		terminateProcessGroup(pid, "SIGTERM");
		killTimer = setTimeout(() => terminateProcessGroup(pid, "SIGKILL"), 2_000);
		killTimer.unref();
	};
	context.signal.addEventListener("abort", cancel, { once: true });
	if (context.signal.aborted) cancel();
	const exit = await exitPromise.finally(() => {
		context.signal.removeEventListener("abort", cancel);
		if (killTimer) clearTimeout(killTimer);
	});

	let backgroundProcessesDetected = processGroupAlive(pid);
	if (backgroundProcessesDetected) {
		terminateProcessGroup(pid, "SIGKILL");
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
		backgroundProcessesDetected = processGroupAlive(pid);
	}
	await admission.complete(exit);
	return {
		stdout,
		stderr,
		...exit,
		stdoutTruncated,
		stderrTruncated,
		backgroundProcessesDetected,
		agentFallbackDetected,
	};
}

export class OpenCodeAdapter implements HarnessAdapter {
	readonly id = "opencode-v2";
	readonly harness = "opencode";
	readonly #profile: ResolvedRouteProfile;
	readonly #launcher: string;

	constructor(options: OpenCodeAdapterOptions) {
		assertProfile(options.profile);
		this.#profile = options.profile;
		this.#launcher = options.launcher?.trim() || options.profile.launcher.command;
		if (!this.#launcher) throw new Error("OpenCode route profile does not provide a launcher command");
	}

	async doctor(): Promise<HarnessCapabilities> {
		try {
			const executable = await resolveExecutable(this.#launcher);
			const version = await execFileAsync(executable, this.#profile.launcher.versionArgs, {
				timeout: PROBE_TIMEOUT_MILLISECONDS,
				maxBuffer: PROBE_OUTPUT_LIMIT,
			});
			let doctor;
			if (this.#profile.launcher.doctor) {
				doctor = await execFileAsync(executable, this.#profile.launcher.doctor.args, {
					timeout: PROBE_TIMEOUT_MILLISECONDS,
					maxBuffer: PROBE_OUTPUT_LIMIT,
				});
			}
			const harnessVersion = `${version.stdout}\n${version.stderr}`.trim();
			if (!harnessVersion) throw new Error("OpenCode version probe returned no version");
			if (doctor && this.#profile.launcher.doctor?.requiredText) {
				const output = `${doctor.stdout}\n${doctor.stderr}`;
				for (const required of this.#profile.launcher.doctor.requiredText) {
					if (!output.includes(required)) throw new Error(`OpenCode doctor output omitted profile-required text: ${required}`);
				}
			}
			let delegationQualified = false;
			try {
				const databaseProbe = await execFileAsync(executable, ["db", delegationProbeQuery(), "--format", "json"], {
					timeout: PROBE_TIMEOUT_MILLISECONDS,
					maxBuffer: PROBE_OUTPUT_LIMIT,
				});
				const parsed = JSON.parse(databaseProbe.stdout) as unknown;
				delegationQualified = Array.isArray(parsed)
					&& parsed.length === 1
					&& isObject(parsed[0])
					&& parsed[0].contract === "opencode-db-v1";
			} catch {
				delegationQualified = false;
			}
			const configuredRoute = this.#profile.route.source === "explicit"
				? { provider: this.#profile.route.provider, model: this.#profile.route.model, reasoning: this.#profile.route.reasoning }
				: undefined;
			const executionQualified = configuredRoute !== undefined;
			return {
				version: 1,
				adapterId: this.id,
				harness: this.harness,
				compatibility: executionQualified ? "verified" : "degraded",
				available: true,
				executable,
				binarySha256: await sha256(executable),
				routeProfileSha256: this.#profile.sha256,
				harnessVersion,
				...(configuredRoute ? { configuredRoute } : {}),
				probe: {
					version: 1,
					modelCalls: 0,
					contract: "opencode-trusted-host-profile-v1",
					artifact: "verified",
					executionQualified,
					protocol: { name: "opencode-json-events" },
				},
				capabilities: {
					"session.ephemeral": false,
					"session.new": executionQualified,
					"session.resume": false,
					"session.fork": false,
					"control.cancel": executionQualified,
					"control.steer": false,
					"approval.bridge": false,
					"events.structured": executionQualified,
					"output.schema": false,
					"route.configured": executionQualified,
					"agent.identity": executionQualified,
					"telemetry.usage": executionQualified,
					"limits.providerRequests": false,
					"limits.toolCalls": false,
					"limits.spend": false,
					"limits.children": false,
					"agents.children": executionQualified && delegationQualified,
					"agents.hierarchical": false,
					"agents.receipts": executionQualified && delegationQualified,
					"sandbox.filesystem": false,
					"sandbox.network.open": false,
					"sandbox.network.restricted": false,
					"sandbox.network.none": false,
					"worktree.native": false,
				},
					notices: [
					this.#profile.notice ?? "OpenCode uses its selected trusted-host route profile.",
					...(executionQualified ? [] : ["Launcher-derived routes require structured configured-route evidence before dispatch."]),
					"Trusted-host OpenCode uses shared harness configuration, normal built-in tools, automatic permission handling, and report-only cost telemetry.",
					...(delegationQualified
						? ["Flat child receipts use two stable, metadata-only reads through the official OpenCode DB command; hard child limits remain unsupported."]
						: ["This launcher does not expose the qualified OpenCode DB metadata contract, so solo runs remain available and flat child receipts are disabled."]),
				],
			};
		} catch (error) {
			return {
				version: 1,
				adapterId: this.id,
				harness: this.harness,
				compatibility: "blocked",
				available: false,
				capabilities: {},
				notices: [error instanceof Error ? error.message : String(error), "OpenCode trusted-host doctor made zero model calls."],
			};
		}
	}

	async preflight(spec: RunSpec, doctor: HarnessCapabilities): Promise<PreflightIssue[]> {
		const issues: PreflightIssue[] = [];
		if (spec.tier !== "trusted-host") issues.push({ severity: "error", code: "OPENCODE_TRUSTED_HOST_REQUIRED", message: "OpenCode profile dispatch requires trusted-host tier" });
		if (spec.routeProfile !== this.#profile.id) issues.push({ severity: "error", code: "OPENCODE_ROUTE_REQUIRED", message: `OpenCode requires route profile ${this.#profile.id}` });
		if (this.#profile.route.source !== "explicit" || doctor.probe?.executionQualified !== true || !doctor.configuredRoute) {
			issues.push({ severity: "error", code: "OPENCODE_CONFIGURED_ROUTE_REQUIRED", message: "OpenCode dispatch requires an explicit profile route with structured configured-route evidence" });
		}
		const agent = spec.execution.agentProfile ?? this.#profile.agent?.defaultProfile;
		if (agent && this.#profile.agent?.allowedProfiles && !this.#profile.agent.allowedProfiles.includes(agent)) {
			issues.push({ severity: "error", code: "OPENCODE_AGENT_NOT_ALLOWED", message: `OpenCode agent ${agent} is outside the route profile allowlist` });
		}
		if (spec.execution.session !== "new") issues.push({ severity: "error", code: "OPENCODE_NEW_SESSION_REQUIRED", message: "OpenCode starts a new session for every run" });
		if (spec.execution.topology === "hierarchical") issues.push({ severity: "error", code: "OPENCODE_HIERARCHICAL_UNSUPPORTED", message: "OpenCode currently qualifies complete flat child receipts only" });
		if (spec.execution.topology === "flat") {
			const childPolicy = spec.execution.childPolicy;
			if (!childPolicy || childPolicy.allowedProfiles.length === 0) {
				issues.push({ severity: "error", code: "OPENCODE_CHILD_POLICY_REQUIRED", message: "OpenCode flat runs require explicit allowed child profiles and routes" });
			}
			const configuredRoute = this.#profile.route.source === "explicit"
				? { provider: this.#profile.route.provider, model: this.#profile.route.model, reasoning: this.#profile.route.reasoning }
				: undefined;
			const allowedRoute = childPolicy?.allowedRoutes[0];
			if (!configuredRoute || childPolicy?.allowedRoutes.length !== 1 || !allowedRoute
				|| allowedRoute.provider !== configuredRoute.provider
				|| allowedRoute.model !== configuredRoute.model
				|| allowedRoute.reasoning !== configuredRoute.reasoning) {
				issues.push({ severity: "error", code: "OPENCODE_CHILD_ROUTE_INHERITANCE_REQUIRED", message: "OpenCode native children must inherit the primary profile's exact provider, model, and reasoning route" });
			}
			if (!agent) {
				issues.push({ severity: "error", code: "OPENCODE_PRIMARY_AGENT_REQUIRED", message: "OpenCode flat runs require an exact primary agent profile" });
			} else {
				try {
					const primary = await probeAgentProfile(this.#launcher, agent);
					if (!isObject(primary.tools) || primary.tools.task !== true) {
						issues.push({
							severity: "error",
							code: "OPENCODE_NATIVE_TASK_REQUIRED",
							message: `OpenCode primary agent ${agent} does not expose native task delegation`,
						});
					}
				} catch (error) {
					issues.push({
						severity: "error",
						code: "OPENCODE_AGENT_PROBE_FAILED",
						message: `OpenCode could not verify primary agent ${agent}: ${error instanceof Error ? error.message : String(error)}`,
					});
				}
				for (const childProfile of childPolicy?.allowedProfiles ?? []) {
					try {
						const child = await probeAgentProfile(this.#launcher, childProfile);
						if (typeof child.variant === "string" && configuredRoute && child.variant !== configuredRoute.reasoning) {
							issues.push({ severity: "error", code: "OPENCODE_CHILD_REASONING_DRIFT", message: `OpenCode child agent ${childProfile} selects reasoning ${child.variant} instead of ${configuredRoute.reasoning}` });
						}
						if (child.model !== null && child.model !== undefined) {
							const explicitModel = typeof child.model === "string"
								? child.model === `${configuredRoute?.provider}/${configuredRoute?.model}`
								: isObject(child.model) && configuredRoute !== undefined
									&& (child.model.providerID ?? child.model.provider) === configuredRoute.provider
									&& (child.model.modelID ?? child.model.id) === configuredRoute.model;
							if (!explicitModel) issues.push({ severity: "error", code: "OPENCODE_CHILD_EXPLICIT_MODEL_UNQUALIFIED", message: `OpenCode child agent ${childProfile} overrides the inherited route` });
						}
						const childTools = isObject(child.tools) ? child.tools : {};
						if (spec.execution.writerPolicy === "one-writer"
							&& ["write", "edit", "patch"].some((tool) => childTools[tool] === true)) {
							issues.push({ severity: "error", code: "OPENCODE_CHILD_WRITER_UNQUALIFIED", message: `OpenCode child agent ${childProfile} has workspace-writing tools and cannot share a one-writer checkout` });
						}
					} catch (error) {
						issues.push({
							severity: "error",
							code: "OPENCODE_CHILD_AGENT_PROBE_FAILED",
							message: `OpenCode could not verify child agent ${childProfile}: ${error instanceof Error ? error.message : String(error)}`,
						});
					}
				}
			}
		}
		if (spec.execution.writerPolicy !== "read-only" && spec.execution.writerPolicy !== "one-writer") {
			issues.push({ severity: "error", code: "OPENCODE_WRITER_POLICY_UNSUPPORTED", message: "OpenCode supports read-only or one-writer tasks" });
		}
		if (spec.execution.network !== "configured") issues.push({ severity: "error", code: "OPENCODE_NETWORK_CONFIGURED_REQUIRED", message: "OpenCode preserves the launcher's configured network policy" });
		return issues;
	}

	async run(spec: RunSpec, context: AdapterRunContext): Promise<AdapterRunResult> {
		if (spec.tier !== "trusted-host" || spec.routeProfile !== this.#profile.id || this.#profile.route.source !== "explicit") {
			throw new Error("OpenCode run is outside its resolved trusted-host route profile");
		}
		const route = {
			provider: this.#profile.route.provider,
			model: this.#profile.route.model,
			reasoning: this.#profile.route.reasoning,
		};
		if (spec.execution.topology === "flat") {
			const allowed = spec.execution.childPolicy?.allowedRoutes;
			const childRoute = allowed?.[0];
			if (allowed?.length !== 1 || !childRoute || childRoute.provider !== route.provider || childRoute.model !== route.model || childRoute.reasoning !== route.reasoning) {
				throw new Error("OpenCode native children must inherit the exact primary route");
			}
		}
		const agent = spec.execution.agentProfile ?? this.#profile.agent?.defaultProfile;
		if (agent && this.#profile.agent?.allowedProfiles && !this.#profile.agent.allowedProfiles.includes(agent)) {
			throw new Error(`OpenCode agent ${agent} is outside the route profile allowlist`);
		}
		const args = [
			"run",
			"--dir", spec.task.cwd,
			...(agent ? ["--agent", agent] : []),
			"--model", `${route.provider}/${route.model}`,
			"--variant", route.reasoning,
			"--format", "json",
			"--auto",
			spec.task.objective,
		];
		await context.emit("adapter.process.started", {
			tier: "trusted-host",
			profileId: this.#profile.id,
			profileSha256: this.#profile.sha256,
			...(agent ? { agent } : {}),
			route,
		});
		const processStartedAt = Date.now();
		const result = await runTrustedOpenCode(this.#launcher, args, spec.task.cwd, context, spec.execution.topology === "flat");
		const processFinishedAt = Date.now();
		const notices = ["Trusted-host OpenCode uses shared configuration, normal tool permissions, and automatic permission handling."];
		let status: AdapterRunResult["status"] = context.signal.aborted ? "cancelled" : "completed";
		let delegationInspection: ReturnType<typeof inspectDelegationEvidence> | undefined;
		if (!context.signal.aborted && result.exitCode !== 0) {
			status = "failed";
			notices.push(`OpenCode exited with status ${result.exitCode ?? "unknown"}.`);
		}
		if (!context.signal.aborted && (!result.terminalStop || !result.finalOutput?.trim())) {
			status = "failed";
			notices.push("OpenCode exited without a terminal stop response containing useful prose.");
		}
		if (result.protocolError) { status = "failed"; notices.push(result.protocolError); }
		if (spec.execution.topology === "solo" && result.childrenStarted > 0) {
			status = "failed";
			notices.push(`OpenCode invoked the task delegation tool ${result.childrenStarted} time(s), so the requested solo receipt cannot claim complete child lineage.`);
		}
		if (result.stdoutTruncated) { status = "failed"; notices.push("OpenCode structured stdout exceeded the bounded capture limit."); }
		if (result.stderrTruncated) notices.push("OpenCode stderr retention exceeded 16 MiB; the full stream was drained and fallback detection continued.");
		if (result.backgroundProcessesDetected) { status = "failed"; notices.push("OpenCode left processes in its admitted process group after the primary exited."); }
		if (agent && result.agentFallbackDetected) { status = "failed"; notices.push(`OpenCode reported fallback from requested primary agent ${agent}.`); }
		if (spec.execution.topology === "flat" && status === "completed") {
			try {
				if (!agent) throw new Error("OpenCode flat runs require an exact primary agent profile");
				if (!result.sessionId) throw new Error("OpenCode event stream omitted the root session id");
				if (result.reportedCostUsdMicros === undefined) throw new Error("OpenCode event stream omitted complete primary cost telemetry");
				const query = delegationEvidenceQuery(result.sessionId, spec.task.objective);
				const first = await runTrustedProcess(this.#launcher, ["db", query, "--format", "json"], spec.task.cwd, context, "opencode-delegation-evidence-1");
				const second = await runTrustedProcess(this.#launcher, ["db", query, "--format", "json"], spec.task.cwd, context, "opencode-delegation-evidence-2");
				for (const [label, evidence] of [["first", first], ["second", second]] as const) {
					if (evidence.exitCode !== 0 || evidence.stdoutTruncated || evidence.stderrTruncated || evidence.backgroundProcessesDetected) {
						throw new Error(`${label} OpenCode DB evidence read was incomplete`);
					}
					if (evidence.stderr.length > 0) await context.emit("harness.stderr", {
						phase: `delegation-${label}`,
						bytes: evidence.stderr.length,
						sha256: createHash("sha256").update(evidence.stderr).digest("hex"),
					});
				}
				delegationInspection = inspectDelegationEvidence({
					firstJson: first.stdout.toString("utf8"),
					secondJson: second.stdout.toString("utf8"),
					rootSessionId: result.sessionId,
					processStartedAt,
					processFinishedAt,
					spec,
					primaryProfile: agent,
					primaryRoute: route,
					stream: {
						providerRequests: result.providerRequests,
						toolCalls: result.toolCalls,
						taskCalls: result.childrenStarted,
						reportedCostUsdMicros: result.reportedCostUsdMicros,
					},
				});
				const artifact = await persistDelegationEvidence(context, delegationInspection.evidence);
				await context.emit("adapter.child-lineage", {
					version: 1,
					source: delegationInspection.evidence.source,
					rootSessionId: delegationInspection.evidence.rootSessionId,
					children: delegationInspection.usage.childrenStarted,
					sourceSha256: delegationInspection.evidence.sha256,
					artifact,
				});
				notices.push(`OpenCode completed ${delegationInspection.usage.childrenStarted} flat child session(s) with exact route, profile, terminal, usage, cost, and parentage evidence.`);
				const truncatedChildren = delegationInspection.evidence.sessions.filter((session) => session.outputTruncated === true).length;
				if (truncatedChildren > 0) notices.push(`${truncatedChildren} child result(s) were truncated in the parent's context; structural lineage, route, usage, and cost evidence remained complete.`);
			} catch (error) {
				status = "failed";
				notices.push(`OpenCode child receipt reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return {
			status,
			exitCode: result.exitCode,
			...(result.finalOutput ? { finalOutput: result.finalOutput } : {}),
			configuredRoute: route,
			...(agent && !result.agentFallbackDetected ? {
				agentIdentity: {
					role: "primary" as const,
					requestedProfile: agent,
					configuredProfile: agent,
					...(delegationInspection ? {
						observedProfile: delegationInspection.observedPrimaryProfile,
						runtimeObservation: { status: "observed" as const },
					} : {
						runtimeObservation: {
							status: "unavailable" as const,
							reason: "OpenCode JSON event output does not include primary-agent identity.",
						},
					}),
				},
			} : {}),
			usage: delegationInspection?.usage ?? {
				providerRequests: result.providerRequests,
				toolCalls: result.toolCalls,
				// Child task calls without reconciled principals are retained in the
				// notice and tool total. The usage graph reports only the primary
				// lower bound instead of inventing incomplete child principals.
				childrenStarted: 0,
				...(result.reportedCostUsdMicros !== undefined ? { reportedCostUsdMicros: result.reportedCostUsdMicros } : {}),
				complete: result.protocolError === undefined && result.terminalStop && result.childrenStarted === 0,
				sources: ["harness"],
				terminationReason: result.childrenStarted > 0
					? `OpenCode JSON events preserve complete primary usage as a lower bound; ${result.childrenStarted} child task call(s) lacked reconciled principal evidence.`
					: "OpenCode JSON events report each model step, tool use, terminal stop, and provider cost after execution.",
			},
			notices,
		};
	}
}
