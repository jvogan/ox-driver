import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readlink, realpath, unlink, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

import { AdapterRegistry } from "./registry.js";
import { RunBudgetLedger, type ControllerBudgetLedger } from "./budget.js";
import { redactedTextEvidence } from "./evidence.js";
import { captureProcessIdentity, processIdentityStatus, reapDetachedProcessGroup } from "./process.js";
import { RunStore } from "./store.js";
import { DEFAULT_ACCEPTANCE_TIMEOUT_SECONDS } from "./types.js";
import type {
	AcceptanceResult,
	AdapterRunResult,
	AgentIdentityEvidence,
	BudgetUsage,
	ConfiguredRoute,
	HarnessCapabilities,
	PreflightIssue,
	PreflightResult,
	RunEvent,
	RunPhase,
	RunReceipt,
	RunSpec,
	RunStatus,
} from "./types.js";
import { capabilityIssues, validateRunSpec } from "./validation.js";

interface ProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	backgroundProcessesDetected: boolean;
	processTreeReaped: boolean;
	terminationEscalated: boolean;
}

interface WorkspaceEntry {
	status: string;
	hash: string | null;
}

type WorkspaceSnapshot = Map<string, WorkspaceEntry>;

const USAGE_SOURCES = new Set(["transport", "provider", "harness", "controller"]);
const RUN_STATUSES = new Set<RunStatus>(["completed", "failed", "blocked", "cancelled", "unknown"]);
const ADAPTER_RESULT_KEYS = new Set(["status", "exitCode", "finalOutput", "configuredRoute", "agentIdentity", "usage", "notices"]);
const ADAPTER_TEXT_LIMIT = 1024 * 1024;
const ADAPTER_NOTICE_LIMIT = 100;
const ADAPTER_NOTICE_TEXT_LIMIT = 8 * 1024;
const USAGE_KEYS = new Set(["providerRequests", "toolCalls", "childrenStarted", "reportedCostUsdMicros", "tokens", "complete", "sources", "principals", "terminationReason"]);
const USAGE_TOKEN_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"]);
const USAGE_PRINCIPAL_KEYS = new Set(["id", "role", "parentId", "requestedProfile", "observedProfile", "requestedRoute", "observedRoute", "providerRequests", "toolCalls", "childrenStarted", "reportedCostUsdMicros"]);
const AGENT_IDENTITY_KEYS = new Set(["requestedProfile", "configuredProfile", "observedProfile", "runtimeObservation", "role"]);
const AGENT_RUNTIME_OBSERVATION_KEYS = new Set(["status", "reason"]);
const CONTROLLER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const ADAPTER_ABORT_GRACE_MILLISECONDS = 1_000;

class AdapterAbortDeadlineError extends Error {
	constructor() {
		super("adapter did not settle within the cancellation grace period");
		this.name = "AdapterAbortDeadlineError";
	}
}

function cancellationDeadline(signal: AbortSignal): { promise: Promise<never>; cancel(): void } {
	let graceTimer: NodeJS.Timeout | undefined;
	let active = true;
	let rejectDeadline: (error: Error) => void = () => undefined;
	const onAbort = (): void => {
		if (!active || graceTimer) return;
		graceTimer = setTimeout(() => rejectDeadline(new AdapterAbortDeadlineError()), ADAPTER_ABORT_GRACE_MILLISECONDS);
	};
	const promise = new Promise<never>((_resolve, reject) => {
		rejectDeadline = reject;
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	return {
		promise,
		cancel: () => {
			active = false;
			signal.removeEventListener("abort", onAbort);
			if (graceTimer) clearTimeout(graceTimer);
		},
	};
}

function nonSecretEnvironment(): NodeJS.ProcessEnv {
	return {
		PATH: CONTROLLER_PATH,
		LANG: "C",
		LC_ALL: "C",
	};
}

function trustedHostToolPath(): string {
	const directories = [
		...CONTROLLER_PATH.split(delimiter),
		...(process.env.PATH ?? "").split(delimiter),
	].filter((entry) => entry && isAbsolute(entry));
	return [...new Set(directories)].join(delimiter);
}

function gitEnvironment(): NodeJS.ProcessEnv {
	return {
		...nonSecretEnvironment(),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
	};
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function normalizedAgentIdentity(value: unknown): AgentIdentityEvidence | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (Object.keys(raw).some((key) => !AGENT_IDENTITY_KEYS.has(key))
		|| raw.role !== "primary"
		|| typeof raw.requestedProfile !== "string"
		|| !raw.requestedProfile.trim()) return undefined;
	const configuredProfile = raw.configuredProfile === undefined
		? undefined
		: typeof raw.configuredProfile === "string" && raw.configuredProfile.trim()
			? raw.configuredProfile
			: undefined;
	const observedProfile = raw.observedProfile === undefined
		? undefined
		: typeof raw.observedProfile === "string" && raw.observedProfile.trim()
			? raw.observedProfile
			: undefined;
	if ((raw.configuredProfile !== undefined && configuredProfile === undefined)
		|| (raw.observedProfile !== undefined && observedProfile === undefined)
		|| (configuredProfile === undefined && observedProfile === undefined)) return undefined;

	let runtimeObservation: AgentIdentityEvidence["runtimeObservation"];
	if (raw.runtimeObservation !== undefined) {
		if (!raw.runtimeObservation || typeof raw.runtimeObservation !== "object" || Array.isArray(raw.runtimeObservation)) return undefined;
		const observation = raw.runtimeObservation as Record<string, unknown>;
		if (Object.keys(observation).some((key) => !AGENT_RUNTIME_OBSERVATION_KEYS.has(key))
			|| !["observed", "unavailable"].includes(String(observation.status))
			|| (observation.reason !== undefined && (typeof observation.reason !== "string"
				|| !observation.reason.trim()
				|| Buffer.byteLength(observation.reason, "utf8") > ADAPTER_NOTICE_TEXT_LIMIT))) return undefined;
		if ((observation.status === "observed" && observedProfile === undefined)
			|| (observation.status === "unavailable" && observedProfile !== undefined)) return undefined;
		runtimeObservation = {
			status: observation.status as "observed" | "unavailable",
			...(typeof observation.reason === "string" ? { reason: observation.reason } : {}),
		};
	}

	return {
		requestedProfile: raw.requestedProfile,
		role: "primary",
		...(configuredProfile !== undefined ? { configuredProfile } : {}),
		...(observedProfile !== undefined ? { observedProfile } : {}),
		...(runtimeObservation !== undefined ? { runtimeObservation } : {}),
	};
}

function isConfiguredRoute(value: unknown): value is NonNullable<AdapterRunResult["configuredRoute"]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const route = value as Record<string, unknown>;
	return [route.provider, route.model, route.reasoning].every((item) => typeof item === "string" && item.trim() !== "");
}

function routesEqual(left: NonNullable<AdapterRunResult["configuredRoute"]>, right: NonNullable<AdapterRunResult["configuredRoute"]>): boolean {
	return left.provider === right.provider && left.model === right.model && left.reasoning === right.reasoning;
}

function adapterEventTypeIssue(type: string): string | undefined {
	if (!type || type.length > 128 || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(type)) {
		return "adapter event types must be bounded lowercase identifiers";
	}
	if (type.startsWith("run.") || type.startsWith("controller.")) {
		return `adapter event type ${type} uses a controller-reserved namespace`;
	}
	return undefined;
}

function normalizeAdapterRunResult(value: unknown): { result: AdapterRunResult; issues: string[] } {
	const issues: string[] = [];
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {
			result: { status: "failed", exitCode: null },
			issues: ["adapter result must be an object"],
		};
	}
	const raw = value as Record<string, unknown>;
	for (const key of Object.keys(raw)) {
		if (!ADAPTER_RESULT_KEYS.has(key)) issues.push(`adapter result.${key} is not supported`);
	}
	const status = RUN_STATUSES.has(raw.status as RunStatus) ? raw.status as RunStatus : "failed";
	if (status !== raw.status) issues.push("adapter result.status is invalid");
	const exitCode = raw.exitCode === null || (Number.isSafeInteger(raw.exitCode) && Number(raw.exitCode) >= 0)
		? raw.exitCode as number | null
		: null;
	if (exitCode !== raw.exitCode) issues.push("adapter result.exitCode must be null or a non-negative integer");
	const finalOutput = typeof raw.finalOutput === "string" && Buffer.byteLength(raw.finalOutput, "utf8") <= ADAPTER_TEXT_LIMIT
		? raw.finalOutput
		: undefined;
	if (raw.finalOutput !== undefined && finalOutput === undefined) issues.push("adapter result.finalOutput must be a bounded string");
	const configuredRoute = raw.configuredRoute === undefined
		? undefined
		: isConfiguredRoute(raw.configuredRoute) ? { ...raw.configuredRoute } : undefined;
	if (raw.configuredRoute !== undefined && configuredRoute === undefined) issues.push("adapter result.configuredRoute is invalid");
	const agentIdentity = raw.agentIdentity === undefined
		? undefined
		: normalizedAgentIdentity(raw.agentIdentity);
	if (raw.agentIdentity !== undefined && agentIdentity === undefined) issues.push("adapter result.agentIdentity is invalid");
	const usage = raw.usage !== undefined && raw.usage !== null && typeof raw.usage === "object" && !Array.isArray(raw.usage)
		? raw.usage as BudgetUsage
		: undefined;
	if (raw.usage !== undefined && usage === undefined) issues.push("adapter result.usage must be an object when present");
	const notices = Array.isArray(raw.notices)
		&& raw.notices.length <= ADAPTER_NOTICE_LIMIT
		&& raw.notices.every((notice) => typeof notice === "string" && Buffer.byteLength(notice, "utf8") <= ADAPTER_NOTICE_TEXT_LIMIT)
		? [...raw.notices] as string[]
		: undefined;
	if (raw.notices !== undefined && notices === undefined) issues.push("adapter result.notices must contain bounded strings");
	return {
		result: {
			status: issues.length > 0 ? "failed" : status,
			exitCode,
			...(finalOutput !== undefined ? { finalOutput } : {}),
			...(configuredRoute ? { configuredRoute } : {}),
			...(agentIdentity ? { agentIdentity } : {}),
			...(usage ? { usage } : {}),
			...(notices ? { notices } : {}),
		},
		issues,
	};
}

function immutableSnapshot<T>(value: T): T {
	const clone = structuredClone(value);
	const pending: unknown[] = [clone];
	const seen = new WeakSet<object>();
	while (pending.length > 0) {
		const item = pending.pop();
		if (!item || typeof item !== "object" || seen.has(item)) continue;
		seen.add(item);
		pending.push(...Object.values(item));
		Object.freeze(item);
	}
	return clone;
}

function budgetUsageIssues(value: BudgetUsage, topology: RunSpec["execution"]["topology"]): string[] {
	const issues: string[] = [];
	for (const key of Object.keys(value)) {
		if (!USAGE_KEYS.has(key)) issues.push(`usage.${key} is not supported`);
	}
	for (const field of ["providerRequests", "toolCalls", "childrenStarted"] as const) {
		if (!isNonNegativeInteger(value[field])) issues.push(`usage.${field} must be a non-negative integer`);
	}
	if (value.reportedCostUsdMicros !== undefined && !isNonNegativeInteger(value.reportedCostUsdMicros)) {
		issues.push("usage.reportedCostUsdMicros must be a non-negative integer");
	}
	if (value.tokens !== undefined) {
		if (!value.tokens || typeof value.tokens !== "object" || Array.isArray(value.tokens)) {
			issues.push("usage.tokens must be an object when present");
		} else {
			for (const key of Object.keys(value.tokens)) {
				if (!USAGE_TOKEN_KEYS.has(key)) issues.push(`usage.tokens.${key} is not supported`);
			}
			for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
				if (!isNonNegativeInteger(value.tokens[field])) issues.push(`usage.tokens.${field} must be a non-negative integer`);
			}
			if (value.tokens.reasoning !== undefined && !isNonNegativeInteger(value.tokens.reasoning)) {
				issues.push("usage.tokens.reasoning must be a non-negative integer");
			}
			if ([value.tokens.input, value.tokens.output, value.tokens.cacheRead, value.tokens.cacheWrite, value.tokens.total]
				.every(isNonNegativeInteger)
				&& value.tokens.total !== value.tokens.input + value.tokens.output + value.tokens.cacheRead + value.tokens.cacheWrite) {
				issues.push("usage.tokens.total must equal input + output + cacheRead + cacheWrite");
			}
			if (isNonNegativeInteger(value.tokens.reasoning) && isNonNegativeInteger(value.tokens.output)
				&& Number(value.tokens.reasoning) > value.tokens.output) {
				issues.push("usage.tokens.reasoning must not exceed output");
			}
		}
	}
	if (typeof value.complete !== "boolean") issues.push("usage.complete must be a boolean");
	if (!Array.isArray(value.sources) || value.sources.length === 0 || new Set(value.sources).size !== value.sources.length
		|| value.sources.some((source) => !USAGE_SOURCES.has(source))) {
		issues.push("usage.sources must contain unique recognized evidence sources");
	}
	if (value.terminationReason !== undefined && (typeof value.terminationReason !== "string" || !value.terminationReason.trim())) {
		issues.push("usage.terminationReason must be non-empty when present");
	}
	if (value.principals !== undefined) {
		if (!Array.isArray(value.principals) || value.principals.length === 0
			|| value.principals.some((principal) => !principal || typeof principal !== "object" || Array.isArray(principal))) {
			issues.push("usage.principals must be a non-empty array when present");
		} else {
			const ids = new Set<string>();
			const principalsById = new Map(value.principals.flatMap((principal) =>
				typeof principal.id === "string" ? [[principal.id, principal] as const] : []));
			let primaryCount = 0;
			let childCount = 0;
			let providerRequests = 0;
			let toolCalls = 0;
			let childrenStarted = 0;
			let principalCost = 0;
			let completePrincipalCost = true;
			let primaryId: string | undefined;
			for (const principal of value.principals) {
				for (const key of Object.keys(principal)) {
					if (!USAGE_PRINCIPAL_KEYS.has(key)) issues.push(`usage principal ${principal.id || "<unknown>"}.${key} is not supported`);
				}
				if (typeof principal.id !== "string" || !principal.id.trim() || ids.has(principal.id)) {
					issues.push("usage principal ids must be non-empty and unique");
				} else {
					ids.add(principal.id);
				}
				if (!isNonNegativeInteger(principal.providerRequests)
					|| !isNonNegativeInteger(principal.toolCalls)
					|| !isNonNegativeInteger(principal.childrenStarted)) {
					issues.push(`usage principal ${principal.id || "<unknown>"} has invalid counters`);
				}
				providerRequests += principal.providerRequests;
				toolCalls += principal.toolCalls;
				childrenStarted += principal.childrenStarted;
				if (principal.reportedCostUsdMicros === undefined) completePrincipalCost = false;
				else if (!isNonNegativeInteger(principal.reportedCostUsdMicros)) issues.push(`usage principal ${principal.id || "<unknown>"} has invalid cost`);
				else principalCost += principal.reportedCostUsdMicros;
				if (principal.role === "primary") {
					primaryCount += 1;
					primaryId = principal.id;
					if (principal.parentId !== undefined) issues.push("the primary usage principal must not have a parent");
				} else if (principal.role !== "child" || typeof principal.parentId !== "string" || !principal.parentId.trim()) {
					issues.push(`usage principal ${principal.id || "<unknown>"} has invalid child lineage`);
				} else {
					childCount += 1;
					if (typeof principal.requestedProfile !== "string" || !principal.requestedProfile.trim()
						|| typeof principal.observedProfile !== "string" || !principal.observedProfile.trim()) {
						issues.push(`usage child principal ${principal.id || "<unknown>"} lacks exact agent-profile evidence`);
					} else if (principal.requestedProfile !== principal.observedProfile) {
						issues.push(`usage child principal ${principal.id} used an agent-profile fallback`);
					}
					if (!isConfiguredRoute(principal.requestedRoute) || !isConfiguredRoute(principal.observedRoute)) {
						issues.push(`usage child principal ${principal.id || "<unknown>"} lacks exact route evidence`);
					} else if (!routesEqual(principal.requestedRoute, principal.observedRoute)) {
						issues.push(`usage child principal ${principal.id} used a different route than admitted`);
					}
				}
			}
			if (primaryCount !== 1) issues.push("usage principals must contain exactly one primary");
			for (const principal of value.principals) {
				if (principal.parentId !== undefined
					&& (typeof principal.parentId !== "string" || !ids.has(principal.parentId) || principal.parentId === principal.id)) {
					issues.push(`usage principal ${principal.id} has an unknown or self parent`);
				}
				const lineage = new Set<string>();
				let cursor = principal;
				while (cursor.parentId !== undefined) {
					if (lineage.has(cursor.id)) {
						issues.push(`usage principal ${principal.id} has cyclic lineage`);
						break;
					}
					lineage.add(cursor.id);
					const parent = principalsById.get(cursor.parentId);
					if (!parent) break;
					cursor = parent;
				}
			}
			if (childCount !== value.childrenStarted) issues.push("usage must contain exactly one child principal receipt per admitted child start");
			if (providerRequests !== value.providerRequests || toolCalls !== value.toolCalls || childrenStarted !== value.childrenStarted) {
				issues.push("usage principal counters do not reconcile to aggregate totals");
			}
			if (completePrincipalCost && value.reportedCostUsdMicros !== undefined && principalCost !== value.reportedCostUsdMicros) {
				issues.push("usage principal costs do not reconcile to the aggregate total");
			}
			if (topology === "solo" && value.principals.some((principal) => principal.role === "child")) {
				issues.push("solo usage evidence must not contain child principals");
			}
			if (topology === "solo" && value.childrenStarted !== 0) issues.push("solo usage evidence must not contain child starts");
			if (topology === "flat" && primaryId !== undefined) {
				for (const principal of value.principals.filter((item) => item.role === "child")) {
					if (principal.parentId !== primaryId) issues.push(`flat child principal ${principal.id} must be parented directly by the primary`);
					if (principal.childrenStarted !== 0) issues.push(`flat child principal ${principal.id} must not start grandchildren`);
				}
			}
		}
	} else if (value.childrenStarted > 0) {
		issues.push("usage with admitted child starts must include per-child principal receipts");
	}
	return issues;
}

function reportOnlyCost(spec: RunSpec, usage?: BudgetUsage): RunReceipt["costReport"] | undefined {
	const ceilingUsdMicros = spec.execution.reportOnlyCostUsdMicros;
	if (ceilingUsdMicros === undefined) return undefined;
	const observedUsdMicros = usage?.reportedCostUsdMicros;
	if (observedUsdMicros === undefined) {
		return { mode: "report-only", ceilingUsdMicros, status: "unavailable" };
	}
	return {
		mode: "report-only",
		ceilingUsdMicros,
		observedUsdMicros,
		status: observedUsdMicros > ceilingUsdMicros ? "exceeded" : usage?.complete === false ? "partial" : "within-ceiling",
	};
}

function effectivePowerEvidence(
	spec: RunSpec,
	doctor: HarnessCapabilities,
	configuredRoute: ConfiguredRoute | undefined,
	agentIdentity: AgentIdentityEvidence | undefined,
	usage: BudgetUsage | undefined,
): NonNullable<RunReceipt["effectivePower"]> {
	const explicit = (value: number | undefined) => value === undefined
		? { state: "unset" as const, enforcement: "none" as const }
		: { state: "explicit" as const, value, enforcement: "controller" as const };
	return {
		version: 1,
		route: {
			...(spec.routeProfile ? { requestedProfile: spec.routeProfile } : {}),
			...(doctor.configuredRoute ? { configured: doctor.configuredRoute } : {}),
			...(configuredRoute ? { observed: configuredRoute } : {}),
		},
		agent: {
			...(spec.execution.agentProfile ? { requestedProfile: spec.execution.agentProfile } : {}),
			...(agentIdentity?.configuredProfile ? { configuredProfile: agentIdentity.configuredProfile } : {}),
			...(agentIdentity?.observedProfile ? { observedProfile: agentIdentity.observedProfile } : {}),
			observation: agentIdentity?.observedProfile ? "observed" : agentIdentity?.configuredProfile ? "configured" : "unobservable",
		},
		topology: {
			requested: spec.execution.topology,
			...(usage ? { childrenObserved: usage.childrenStarted } : {}),
			observation: usage ? "runtime-observed" : "configured",
		},
		writerPolicy: spec.execution.writerPolicy,
		network: spec.execution.network,
		timeoutSeconds: spec.execution.timeoutSeconds,
		limits: {
			providerRequests: explicit(spec.execution.maxProviderRequests),
			toolCalls: explicit(spec.execution.maxToolCalls),
			children: explicit(spec.execution.maxChildren),
			costUsdMicros: spec.execution.maxCostUsdMicros !== undefined
				? explicit(spec.execution.maxCostUsdMicros)
				: spec.execution.reportOnlyCostUsdMicros !== undefined
					? { state: "report-only", value: spec.execution.reportOnlyCostUsdMicros, enforcement: "telemetry" }
					: { state: "unset", enforcement: "none" },
			turns: { state: "unobservable", enforcement: "unobservable" },
			context: { state: "unobservable", enforcement: "unobservable" },
			output: { state: "unobservable", enforcement: "unobservable" },
		},
	};
}

const OUTPUT_LIMIT = 1024 * 1024;
const WORKSPACE_OUTPUT_LIMIT = 64 * 1024 * 1024;
const WORKSPACE_FILE_LIMIT = 256 * 1024 * 1024;

function appendBounded(current: Buffer, chunk: Buffer, limit: number): Buffer {
	if (current.length >= limit) return current;
	return Buffer.concat([current, chunk.subarray(0, limit - current.length)]);
}

async function runProcess(
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; outputLimitBytes?: number },
): Promise<ProcessResult> {
	return new Promise((resolveProcess, rejectProcess) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let stdoutTruncated = false;
		let stderrTruncated = false;
		const outputLimit = options.outputLimitBytes ?? OUTPUT_LIMIT;
		let settled = false;
		let forceKillTimer: NodeJS.Timeout | undefined;
		const terminate = (): void => {
			if (!child.pid) return;
			try {
				if (process.platform === "win32") child.kill("SIGTERM");
				else process.kill(-child.pid, "SIGTERM");
			} catch {
				child.kill("SIGTERM");
			}
			forceKillTimer = setTimeout(() => {
				if (child.exitCode !== null || !child.pid) return;
				try {
					if (process.platform === "win32") child.kill("SIGKILL");
					else process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}, 5_000);
			forceKillTimer.unref();
		};
		options.signal?.addEventListener("abort", terminate, { once: true });
		if (options.signal?.aborted) terminate();
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length + chunk.length > outputLimit) stdoutTruncated = true;
			stdout = appendBounded(stdout, chunk, outputLimit);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length + chunk.length > outputLimit) stderrTruncated = true;
			stderr = appendBounded(stderr, chunk, outputLimit);
		});
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			if (forceKillTimer) clearTimeout(forceKillTimer);
			options.signal?.removeEventListener("abort", terminate);
			rejectProcess(error);
		});
		child.once("close", async (code) => {
			if (settled) return;
			settled = true;
			if (forceKillTimer) clearTimeout(forceKillTimer);
			options.signal?.removeEventListener("abort", terminate);
			const processTree = await reapDetachedProcessGroup(child.pid);
			resolveProcess({
				exitCode: code,
				stdout: stdout.toString("utf8"),
				stderr: stderr.toString("utf8"),
				stdoutTruncated,
				stderrTruncated,
				...processTree,
			});
		});
	});
}

async function runGit(
	cwd: string,
	args: string[],
	options: { outputLimitBytes?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ProcessResult> {
	return runProcess("git", [
		"--no-optional-locks",
		"-c", "core.fsmonitor=false",
		"-c", "core.hooksPath=/dev/null",
		...args,
	], {
		cwd,
		...options,
		env: { ...gitEnvironment(), ...options.env },
	});
}

function parseGitStatus(output: string): Map<string, string> {
	const records = output.split("\0");
	const result = new Map<string, string>();
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (!record || record.length < 4) continue;
		const status = record.slice(0, 2);
		const path = record.slice(3);
		result.set(path, status);
		if ((status.includes("R") || status.includes("C")) && records[index + 1]) {
			index += 1;
			result.set(records[index] as string, status);
		}
	}
	return result;
}

async function gitWorktreeRoot(cwd: string): Promise<string> {
	const canonicalCwd = await realpath(cwd);
	const result = await runGit(canonicalCwd, ["rev-parse", "--show-toplevel"]);
	if (result.exitCode !== 0 || !result.stdout.trim()) {
		throw new Error(result.stderr.trim() || "task.cwd must be inside a Git worktree");
	}
	return realpath(resolve(canonicalCwd, result.stdout.trim()));
}

async function hashWorkspacePath(worktreeRoot: string, path: string): Promise<string | null> {
	const absolute = resolve(worktreeRoot, path);
	try {
		const status = await lstat(absolute);
		if (status.isSymbolicLink()) return `symlink:${await readlink(absolute).catch(() => "unreadable")}`;
		if (!status.isFile()) return `type:${status.mode}`;
		if (status.size > WORKSPACE_FILE_LIMIT) {
			throw new Error(`workspace evidence file exceeds the ${WORKSPACE_FILE_LIMIT}-byte limit: ${path}`);
		}
		const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const openedStatus = await handle.stat();
			if (!openedStatus.isFile()) throw new Error(`workspace evidence path changed type while hashing: ${path}`);
			if (openedStatus.size > WORKSPACE_FILE_LIMIT) {
				throw new Error(`workspace evidence file exceeds the ${WORKSPACE_FILE_LIMIT}-byte limit: ${path}`);
			}
			const digest = createHash("sha256");
			for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
			return digest.digest("hex");
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function workspaceSnapshot(worktreeRoot: string): Promise<WorkspaceSnapshot> {
	const statusResult = await runGit(worktreeRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
		outputLimitBytes: WORKSPACE_OUTPUT_LIMIT,
	});
	if (statusResult.exitCode !== 0) {
		throw new Error(`cannot inspect Git workspace: ${statusResult.stderr.trim() || "git status failed"}`);
	}
	if (statusResult.stdoutTruncated || statusResult.stderrTruncated) throw new Error("Git status evidence exceeded the workspace output limit");
	const snapshot: WorkspaceSnapshot = new Map();
	const trackedResult = await runGit(worktreeRoot, ["ls-files", "--stage", "-z"], {
		outputLimitBytes: WORKSPACE_OUTPUT_LIMIT,
	});
	if (trackedResult.exitCode !== 0) {
		throw new Error(`cannot inspect tracked files: ${trackedResult.stderr.trim() || "git ls-files failed"}`);
	}
	if (trackedResult.stdoutTruncated || trackedResult.stderrTruncated) throw new Error("Git tracked-file evidence exceeded the workspace output limit");
	for (const record of trackedResult.stdout.split("\0")) {
		const match = record.match(/^(\d+) ([0-9a-f]+) (\d)\t(.+)$/s);
		if (!match) continue;
		const [, mode, objectId, stage, path] = match;
		if (stage === "0" && path) snapshot.set(path, { status: "tracked", hash: `index:${mode}:${objectId}` });
	}
	const entries = parseGitStatus(statusResult.stdout);
	for (const [path, status] of entries) {
		snapshot.set(path, { status, hash: await hashWorkspacePath(worktreeRoot, path) });
	}
	const head = await runGit(worktreeRoot, ["rev-parse", "--verify", "HEAD"]);
	snapshot.set(".git/HEAD", { status: "HEAD", hash: head.exitCode === 0 ? head.stdout.trim() : null });
	return snapshot;
}

export type CapturedWorkspacePatch =
	| { patch: string }
	| { patch: null; reason: string };

// Reproduces the worktree's full content change from the given base commit,
// including committed work and untracked files, through a disposable index so
// the repository's real index and the workspace digests stay untouched.
export async function captureWorkspacePatch(
	worktreeRoot: string,
	indexPath: string,
	baseCommit: string,
): Promise<CapturedWorkspacePatch> {
	const environment = { GIT_INDEX_FILE: indexPath };
	const staged = await runGit(worktreeRoot, ["read-tree", baseCommit], { env: environment });
	if (staged.exitCode !== 0) return { patch: null, reason: staged.stderr.trim() || "git read-tree failed" };
	const added = await runGit(worktreeRoot, ["add", "-A"], { env: environment });
	if (added.exitCode !== 0) return { patch: null, reason: added.stderr.trim() || "git add failed" };
	const diff = await runGit(worktreeRoot, ["diff", "--cached", "--binary", baseCommit], {
		env: environment,
		outputLimitBytes: WORKSPACE_OUTPUT_LIMIT,
	});
	if (diff.exitCode !== 0) return { patch: null, reason: diff.stderr.trim() || "git diff failed" };
	if (diff.stdoutTruncated) {
		return { patch: null, reason: `the change patch exceeded the ${WORKSPACE_OUTPUT_LIMIT}-byte evidence limit` };
	}
	return { patch: diff.stdout };
}

function workspaceSnapshotSha256(snapshot: WorkspaceSnapshot): string {
	const entries = [...snapshot.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([path, entry]) => [path, entry.status, entry.hash]);
	return createHash("sha256")
		.update("ox-driver-git-visible-workspace-v1\0")
		.update(JSON.stringify(entries))
		.digest("hex");
}

export async function captureWorkspaceSha256(cwd: string): Promise<string> {
	const worktreeRoot = await gitWorktreeRoot(cwd);
	return workspaceSnapshotSha256(await workspaceSnapshot(worktreeRoot));
}

async function workspaceIssues(spec: RunSpec): Promise<PreflightIssue[]> {
	try {
		await gitWorktreeRoot(spec.task.cwd);
		return [];
	} catch (error) {
		return [{
			severity: "error",
			code: "GIT_WORKSPACE_REQUIRED",
			message: error instanceof Error ? error.message : String(error),
		}];
	}
}

function changedPaths(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
	const paths = new Set([...before.keys(), ...after.keys()]);
	return [...paths]
		.filter((path) => {
			const left = before.get(path);
			const right = after.get(path);
			return left?.status !== right?.status || left?.hash !== right?.hash;
		})
		.sort();
}

function matchesPath(path: string, candidate: string): boolean {
	const normalizedPath = normalize(path);
	const normalizedCandidate = normalize(candidate).replace(new RegExp(`${sep}+$`), "");
	return normalizedCandidate === "." || normalizedPath === normalizedCandidate || normalizedPath.startsWith(`${normalizedCandidate}${sep}`);
}

function unownedPaths(spec: RunSpec, changed: string[], taskPrefix: string): string[] {
	if (spec.execution.writerPolicy === "read-only") return [...changed];
	return changed.filter((path) => {
		if (spec.task.excludedPaths.some((candidate) => matchesPath(path, join(taskPrefix, candidate)))) return true;
		return !spec.task.ownedPaths.some((candidate) => matchesPath(path, join(taskPrefix, candidate)));
	});
}

async function acceptanceEnvironment(runDirectory: string): Promise<NodeJS.ProcessEnv> {
	const root = join(runDirectory, "acceptance-runtime");
	const home = join(root, "home");
	const temporary = join(root, "tmp");
	const xdgConfig = join(root, "xdg", "config");
	const xdgCache = join(root, "xdg", "cache");
	const xdgData = join(root, "xdg", "data");
	const xdgState = join(root, "xdg", "state");
	const xdgRuntime = join(root, "xdg", "runtime");
	await Promise.all([home, temporary, xdgConfig, xdgCache, xdgData, xdgState, xdgRuntime]
		.map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
	return {
		...nonSecretEnvironment(),
		PATH: trustedHostToolPath(),
		HOME: home,
		TMPDIR: temporary,
		TMP: temporary,
		TEMP: temporary,
		XDG_CONFIG_HOME: xdgConfig,
		XDG_CACHE_HOME: xdgCache,
		XDG_DATA_HOME: xdgData,
		XDG_STATE_HOME: xdgState,
		XDG_RUNTIME_DIR: xdgRuntime,
	};
}

function acceptanceCommandSignal(parentSignal: AbortSignal, timeoutSeconds: number): {
	signal: AbortSignal;
	timedOut(): boolean;
	dispose(): void;
} {
	const controller = new AbortController();
	let timeout: NodeJS.Timeout | undefined;
	let didTimeOut = false;
	const abortForParent = (): void => controller.abort(parentSignal.reason);
	if (parentSignal.aborted) {
		abortForParent();
	} else {
		parentSignal.addEventListener("abort", abortForParent, { once: true });
		timeout = setTimeout(() => {
			if (parentSignal.aborted) return;
			didTimeOut = true;
			controller.abort("acceptance-timeout");
		}, timeoutSeconds * 1_000);
	}
	return {
		signal: controller.signal,
		timedOut: () => didTimeOut,
		dispose: () => {
			if (timeout) clearTimeout(timeout);
			parentSignal.removeEventListener("abort", abortForParent);
		},
	};
}

async function runAcceptance(spec: RunSpec, signal: AbortSignal, runDirectory: string): Promise<AcceptanceResult[]> {
	const results: AcceptanceResult[] = [];
	if (spec.acceptance.commands.length === 0) return results;
	const env = await acceptanceEnvironment(runDirectory);
	const timeoutSeconds = spec.acceptance.timeoutSeconds ?? DEFAULT_ACCEPTANCE_TIMEOUT_SECONDS;
	const continueOnFailure = spec.acceptance.continueOnFailure ?? false;
	for (const command of spec.acceptance.commands) {
		if (signal.aborted) break;
		const commandAbort = acceptanceCommandSignal(signal, timeoutSeconds);
		const startedAt = Date.now();
		let result: ProcessResult;
		try {
			result = await runProcess("/bin/sh", ["-c", command], { cwd: spec.task.cwd, env, signal: commandAbort.signal });
		} finally {
			commandAbort.dispose();
		}
		const acceptance = {
			command,
			passed: result.exitCode === 0 && !commandAbort.timedOut() && !result.backgroundProcessesDetected && result.processTreeReaped,
			durationMs: Math.max(0, Date.now() - startedAt),
			timedOut: commandAbort.timedOut(),
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			stdoutTruncated: result.stdoutTruncated,
			stderrTruncated: result.stderrTruncated,
			backgroundProcessesDetected: result.backgroundProcessesDetected,
			processTreeReaped: result.processTreeReaped,
			terminationEscalated: result.terminationEscalated,
		};
		results.push(acceptance);
		if (!acceptance.passed && !continueOnFailure) break;
	}
	return results;
}

export class OxController {
	readonly registry: AdapterRegistry;
	readonly store: RunStore;

	constructor(registry: AdapterRegistry, store = new RunStore()) {
		this.registry = registry;
		this.store = store;
	}

	async doctor(harness?: string): Promise<HarnessCapabilities[]> {
		const adapters = harness ? [this.registry.get(harness)] : this.registry.list();
		return Promise.all(adapters.map(async (adapter) => immutableSnapshot(await adapter.doctor())));
	}

	async preflight(input: unknown): Promise<PreflightResult> {
		const spec = validateRunSpec(input);
		const adapter = this.registry.get(spec.harness);
		const doctor = immutableSnapshot(await adapter.doctor());
		const issues: PreflightIssue[] = [
			...capabilityIssues(spec, doctor),
			...(spec.execution.expectedRouteProfileSha256 !== undefined
				&& doctor.routeProfileSha256 !== spec.execution.expectedRouteProfileSha256
				? [{ severity: "error" as const, code: "ROUTE_PROFILE_DRIFT", message: `${doctor.adapterId} route profile digest differs from the admitted retry profile` }]
				: []),
			...(doctor.capabilities["route.configured"] === true && !isConfiguredRoute(doctor.configuredRoute)
				? [{ severity: "error" as const, code: "DOCTOR_ROUTE_EVIDENCE_INVALID", message: `${doctor.adapterId} claims route configuration without an exact provider, model, and reasoning baseline` }]
				: []),
			...(await workspaceIssues(spec)),
			...immutableSnapshot(await adapter.preflight(spec, doctor)),
		];
		return immutableSnapshot({ ok: issues.every((issue) => issue.severity !== "error"), doctor, issues });
	}

	async run(input: unknown, options: { runId?: string } = {}): Promise<RunReceipt> {
		const requestedSpec = validateRunSpec(input);
		const canonicalTaskCwd = await realpath(requestedSpec.task.cwd);
		const workspaceRoot = await gitWorktreeRoot(canonicalTaskCwd);
		const taskPrefix = relative(workspaceRoot, canonicalTaskCwd) || ".";
		if (taskPrefix !== "." && (taskPrefix === ".." || taskPrefix.startsWith(`..${sep}`) || isAbsolute(taskPrefix))) {
			throw new Error("canonical task.cwd is outside its Git worktree root");
		}
		const spec = validateRunSpec({
			...requestedSpec,
			task: { ...requestedSpec.task, cwd: canonicalTaskCwd },
		});
		const preflight = await this.preflight(spec);
		if (!preflight.ok) {
			throw new Error(`preflight failed:\n${preflight.issues.map((issue) => `${issue.code}: ${issue.message}`).join("\n")}`);
		}

		const adapter = this.registry.get(spec.harness);
		const runId = options.runId ?? randomUUID();
		const runDirectory = await this.store.create(runId, spec);
		let workspaceLease: Awaited<ReturnType<RunStore["acquireWorkspaceLease"]>>;
		try {
			workspaceLease = await this.store.acquireWorkspaceLease(workspaceRoot, runId);
		} catch (error) {
			await this.store.writeStatus(runId, "failed").catch(() => undefined);
			throw error;
		}
		const startedAt = new Date().toISOString();
		let sequence = 0;
		let eventWrite = Promise.resolve();
		const abortController = new AbortController();
		const budget = new RunBudgetLedger(spec.execution, {
			...(preflight.doctor.configuredRoute ? { primaryRoute: preflight.doctor.configuredRoute } : {}),
			onChange: (snapshot) => this.store.writeBudgetSnapshotSync(runId, snapshot),
		});
		const timer = setTimeout(() => abortController.abort("timeout"), spec.execution.timeoutSeconds * 1000);
		let stopWatching = (): void => undefined;
		let phase: RunPhase = "starting";
		let startedEventPersisted = false;
		let terminalEventPersisted = false;
		let terminalStatus: RunStatus | undefined;
		let receiptCandidate: RunReceipt | undefined;
		let leaseCanRelease = true;
		let leaseHoldReason = "unresolved harness process admission";
		try {
			await this.store.initializeAdmissionState({
				runId,
				adapterId: adapter.id,
				harness: adapter.harness,
				workspaceRoot,
				startedAt,
				controller: await captureProcessIdentity(process.pid),
				budgetLedger: budget.snapshot(),
			});
			stopWatching = await this.store.watchCancellation(runId, () => abortController.abort("cancel-request"));
			const before = await workspaceSnapshot(workspaceRoot);
			const initialWorkspaceSha256 = workspaceSnapshotSha256(before);
			const emit = async (type: string, data: Record<string, unknown> = {}): Promise<RunEvent> => {
				const event: RunEvent = {
					version: 1,
					sequence: (sequence += 1),
					time: new Date().toISOString(),
					runId,
					adapterId: adapter.id,
					type,
					data,
				};
				eventWrite = eventWrite.then(async () => this.store.appendEvent(runId, event));
				await eventWrite;
				return event;
			};
			let adapterContextActive = true;
			const requireAdapterContext = (): void => {
				if (!adapterContextActive) throw new Error("adapter run context is closed");
			};
			const emitAdapter = async (type: string, data: Record<string, unknown> = {}): Promise<RunEvent> => {
				requireAdapterContext();
				const issue = adapterEventTypeIssue(type);
				if (issue) throw new Error(issue);
				return emit(type, data);
			};

			await this.store.writeStatus(runId, "running");
			await emit("run.started", { harness: spec.harness });
			startedEventPersisted = true;
			if (spec.task.expectedWorkspaceSha256 !== undefined
				&& spec.task.expectedWorkspaceSha256 !== initialWorkspaceSha256) {
				throw new Error("workspace state does not match the controller-admitted handoff digest");
			}
			phase = "adapter-running";
			await this.store.advancePhase(runId, phase, budget.snapshot());
			const adapterBudget: ControllerBudgetLedger = {
				primaryPrincipalId: budget.primaryPrincipalId,
				reserveProviderRequest: (input) => {
					requireAdapterContext();
					return budget.reserveProviderRequest(input);
				},
				admitToolCall: (input) => {
					requireAdapterContext();
					return budget.admitToolCall(input);
				},
				admitChild: (input) => {
					requireAdapterContext();
					return budget.admitChild(input);
				},
				snapshot: () => {
					requireAdapterContext();
					return budget.snapshot();
				},
			};
			const processes = {
				admit: async (input: { label: string; detachedProcessGroup: boolean }) => {
					requireAdapterContext();
					const admission = await this.store.admitHarnessProcess(runId, input, budget.snapshot());
					let bound = false;
					let completed = false;
					return {
						admissionId: admission.admissionId,
						bind: async (pid: number) => {
							requireAdapterContext();
							if (completed) throw new Error(`harness process admission ${admission.admissionId} is already complete`);
							if (bound) throw new Error(`harness process admission ${admission.admissionId} is already bound`);
							const identity = await this.store.bindHarnessProcess(runId, admission.admissionId, pid);
							bound = true;
							return identity;
						},
						complete: async (result: { exitCode: number | null; terminationSignal?: string }) => {
							requireAdapterContext();
							if (!bound) throw new Error(`harness process admission ${admission.admissionId} is not bound`);
							if (completed) throw new Error(`harness process admission ${admission.admissionId} is already complete`);
							await this.store.completeHarnessProcess(runId, admission.admissionId, result);
							completed = true;
						},
						abandon: async (reason: string) => {
							requireAdapterContext();
							if (bound) throw new Error(`harness process admission ${admission.admissionId} is already bound`);
							if (completed) throw new Error(`harness process admission ${admission.admissionId} is already complete`);
							await this.store.abandonHarnessProcess(runId, admission.admissionId, reason);
							completed = true;
						},
					};
				},
			};

			let adapterResult: AdapterRunResult;
			let adapterContractIssues: string[] = [];
			let adapterDidNotSettle = false;
			try {
				const deadline = cancellationDeadline(abortController.signal);
				const adapterExecution = Promise.resolve().then(() => adapter.run(spec, {
					runId,
					runDirectory,
					signal: abortController.signal,
					doctor: preflight.doctor,
					budget: adapterBudget,
					processes,
					emit: emitAdapter,
				}));
				// If the deadline wins, the trusted in-process adapter promise can still
				// settle later. Attach a rejection handler and revoke every controller API
				// exposed through its context before cleanup continues.
				adapterExecution.catch(() => undefined);
				let returnedValue: Awaited<ReturnType<typeof adapter.run>>;
				try {
					returnedValue = await Promise.race([adapterExecution, deadline.promise]);
				} finally {
					adapterContextActive = false;
					deadline.cancel();
				}
				const returned = immutableSnapshot(returnedValue);
				({ result: adapterResult, issues: adapterContractIssues } = normalizeAdapterRunResult(returned));
			} catch (error) {
				adapterContextActive = false;
				if (error instanceof AdapterAbortDeadlineError) {
					adapterDidNotSettle = true;
					leaseCanRelease = false;
					leaseHoldReason = "adapter did not settle after cancellation and its in-process execution may still be active";
				}
				const message = error instanceof Error ? error.message : String(error);
				adapterResult = {
					status: abortController.signal.aborted ? "cancelled" : "failed",
					exitCode: null,
					notices: ["The adapter threw before returning a result; only digest evidence of the error was retained."],
				};
					await emit("adapter.error", { error: redactedTextEvidence(message) });
				}
				const processState = await this.store.readAdmissionState(runId);
				const unfinishedProcesses = processState.processes.filter((item) => item.status !== "exited");
				if (unfinishedProcesses.length > 0) {
					const cleanup = await this.store.terminateAdmittedProcesses(runId, "controller-adapter-cleanup");
					if (cleanup.unresolvedAdmissionIds.length > 0) leaseCanRelease = false;
					adapterContractIssues.push(
						`adapter returned with ${unfinishedProcesses.length} incomplete harness process admission(s)`,
					);
				}
				if (adapterDidNotSettle) {
					throw new Error("adapter remained active after its cancellation grace period");
				}

				phase = "adapter-finished";
			await this.store.advancePhase(runId, phase, budget.snapshot());
			phase = "reconciling";
			await this.store.advancePhase(runId, phase, budget.snapshot());
			const postAdapter = await workspaceSnapshot(workspaceRoot);
			const postAdapterWorkspaceSha256 = workspaceSnapshotSha256(postAdapter);
			const harnessChanged = changedPaths(before, postAdapter);
			const controllerNotices: string[] = [];
			if (adapterContractIssues.length > 0) {
				controllerNotices.push(`The adapter returned invalid result evidence: ${adapterContractIssues.join("; ")}.`);
			}
			// Capture the harness change as a durable patch before acceptance runs, so
			// the change survives worktree removal. Diff from the run's starting HEAD:
			// a harness that commits its work would otherwise produce an empty patch.
			let patchEvidence: { patchPath: string; patchSha256: string; patchBaseCommit: string } | undefined;
			if (spec.execution.writerPolicy !== "read-only" && harnessChanged.length > 0) {
				const baseCommit = before.get(".git/HEAD")?.hash;
				if (!baseCommit || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit)) {
					controllerNotices.push("The harness change patch was not captured: the workspace had no resolvable HEAD commit at run start.");
				} else {
					const indexPath = resolve(runDirectory, "artifacts", "patch.index");
					const captured = await captureWorkspacePatch(workspaceRoot, indexPath, baseCommit);
					await unlink(indexPath).catch(() => undefined);
					if (captured.patch === null) {
						controllerNotices.push(`The harness change patch was not captured: ${captured.reason}.`);
					} else if (captured.patch.length > 0) {
						const patchAbsolutePath = resolve(runDirectory, "artifacts", "harness.patch");
						await writeFile(patchAbsolutePath, captured.patch, { mode: 0o600 });
						patchEvidence = {
							patchPath: relative(this.store.root, patchAbsolutePath),
							patchSha256: createHash("sha256").update(captured.patch).digest("hex"),
							patchBaseCommit: baseCommit,
						};
					}
				}
			}
			const usageIssues = adapterResult.usage ? budgetUsageIssues(adapterResult.usage, spec.execution.topology) : [];
			const usage = usageIssues.length === 0 ? adapterResult.usage : undefined;
			const costReport = reportOnlyCost(spec, usage);
			const agentIdentity = normalizedAgentIdentity(adapterResult.agentIdentity);
			const usageBudgetRequested = spec.execution.maxProviderRequests !== undefined
				|| spec.execution.maxToolCalls !== undefined
				|| spec.execution.maxCostUsdMicros !== undefined
				|| spec.execution.maxChildren !== undefined;
			const budgetLedger = budget.snapshot();

			let status: RunStatus = adapterResult.status;
			if (abortController.signal.aborted) status = "cancelled";
			if (status === "completed" && adapterContractIssues.length > 0) {
				status = "failed";
			}
			if (status === "completed" && adapterResult.exitCode !== 0) {
				status = "failed";
				controllerNotices.push("The harness reported completion without a zero exit code.");
			}
			if (status === "completed" && !adapterResult.finalOutput?.trim()) {
				status = "failed";
				controllerNotices.push("The harness reported completion without a final output.");
			}
			if (status === "completed" && !adapterResult.configuredRoute) {
				status = "failed";
				controllerNotices.push("The harness reported completion without configured route evidence.");
			}
			if (status === "completed" && adapterResult.configuredRoute && preflight.doctor.configuredRoute
				&& (!isConfiguredRoute(adapterResult.configuredRoute)
					|| !isConfiguredRoute(preflight.doctor.configuredRoute)
					|| !routesEqual(adapterResult.configuredRoute, preflight.doctor.configuredRoute))) {
				status = "failed";
				controllerNotices.push("The harness route changed after preflight; provider, model, and reasoning must match exactly.");
			}
			if (usageIssues.length > 0) {
				if (status === "completed") status = "failed";
				controllerNotices.push(`The harness returned invalid usage evidence: ${usageIssues.join("; ")}.`);
			}
			if (costReport?.status === "unavailable") {
				controllerNotices.push("The report-only cost ceiling could not be evaluated because the harness returned no cost telemetry.");
			} else if (costReport?.status === "partial") {
				controllerNotices.push(`The harness reported at least ${costReport.observedUsdMicros} USD micros, but partial usage evidence cannot prove the total stayed within the report-only ceiling.`);
			} else if (costReport?.status === "exceeded") {
				controllerNotices.push(`Reported spend exceeded the report-only ceiling: ${costReport.observedUsdMicros} > ${costReport.ceilingUsdMicros} USD micros. The controller did not enforce this ceiling before provider requests.`);
			}
			if (adapterResult.agentIdentity !== undefined && !agentIdentity) {
				if (status === "completed") status = "failed";
				controllerNotices.push("The harness returned invalid primary-agent identity evidence.");
			}
			if (status === "completed" && spec.execution.agentProfile !== undefined) {
				const identity = agentIdentity;
				if (!identity
					|| identity.role !== "primary"
					|| identity.requestedProfile !== spec.execution.agentProfile
					|| (identity.configuredProfile !== undefined && identity.configuredProfile !== spec.execution.agentProfile)
					|| (identity.observedProfile !== undefined && identity.observedProfile !== spec.execution.agentProfile)) {
					status = "failed";
					controllerNotices.push("The harness did not record the exact requested primary-agent selection; fallback is not accepted.");
				}
			}
			if (status === "completed" && usageBudgetRequested) {
				if (!usage) {
					status = "failed";
					controllerNotices.push("The harness completed without required aggregate usage evidence.");
				} else if (!usage.complete) {
					status = "failed";
					controllerNotices.push("The harness completed with partial usage evidence.");
				} else if (spec.execution.topology !== "solo" && !usage.principals) {
					status = "failed";
					controllerNotices.push("A multi-agent run completed without per-principal lineage and usage evidence.");
				} else {
					const exceeded = [
						["provider requests", usage.providerRequests, spec.execution.maxProviderRequests],
						["tool calls", usage.toolCalls, spec.execution.maxToolCalls],
						["children started", usage.childrenStarted, spec.execution.maxChildren],
					] as const;
					for (const [label, observed, maximum] of exceeded) {
						if (maximum !== undefined && observed > maximum) {
							status = "failed";
							controllerNotices.push(`The harness exceeded the ${label} budget: ${observed} > ${maximum}.`);
						}
					}
					if (spec.execution.maxCostUsdMicros !== undefined) {
						if (usage.reportedCostUsdMicros === undefined) {
							status = "failed";
							controllerNotices.push("The harness completed without cost evidence required by the spend budget.");
						} else if (usage.reportedCostUsdMicros > spec.execution.maxCostUsdMicros) {
							status = "failed";
							controllerNotices.push(`The harness exceeded the spend budget: ${usage.reportedCostUsdMicros} > ${spec.execution.maxCostUsdMicros} USD micros.`);
						}
					}
				}
			}
			if (usageBudgetRequested && usage) {
				const reconciliation = [
					["provider requests", usage.providerRequests, budgetLedger.providerRequests],
					["tool calls", usage.toolCalls, budgetLedger.toolCalls],
					["children started", usage.childrenStarted, budgetLedger.childrenStarted],
				] as const;
				for (const [label, reported, admitted] of reconciliation) {
					if (reported !== admitted) {
						if (status === "completed") status = "failed";
						controllerNotices.push(`The harness ${label} receipt does not reconcile to controller admissions: ${reported} reported, ${admitted} admitted.`);
					}
				}
				if (spec.execution.maxCostUsdMicros !== undefined && usage.reportedCostUsdMicros !== undefined
					&& usage.reportedCostUsdMicros > budgetLedger.reservedCostUsdMicros) {
					if (status === "completed") status = "failed";
					controllerNotices.push(`Reported spend exceeded controller cost reservations: ${usage.reportedCostUsdMicros} > ${budgetLedger.reservedCostUsdMicros} USD micros.`);
				}
				if (usage.principals) {
					const usagePrimary = usage.principals.find((principal) => principal.role === "primary");
					if (usagePrimary?.id !== budgetLedger.primaryPrincipalId) {
						if (status === "completed") status = "failed";
						controllerNotices.push(`The primary usage principal must use controller admission id ${budgetLedger.primaryPrincipalId}.`);
					}
					for (const principal of usage.principals) {
						const ledgerId = principal.role === "primary" ? budgetLedger.primaryPrincipalId : principal.id;
						const admittedProviderRequests = budgetLedger.admissions.filter((item) => item.kind === "provider-request" && item.principalId === ledgerId).length;
						const admittedToolCalls = budgetLedger.admissions.filter((item) => item.kind === "tool-call" && item.principalId === ledgerId).length;
						const admittedChildren = budgetLedger.admissions.filter((item) => item.kind === "child-start" && item.parentId === ledgerId).length;
						if (principal.providerRequests !== admittedProviderRequests
							|| principal.toolCalls !== admittedToolCalls
							|| principal.childrenStarted !== admittedChildren) {
							if (status === "completed") status = "failed";
							controllerNotices.push(`Usage principal ${principal.id} counters do not reconcile to its controller admissions.`);
						}
						if (principal.role === "child") {
							const admission = budgetLedger.admissions.find((item) => item.kind === "child-start" && item.principalId === principal.id);
							if (!admission
								|| admission.parentId !== principal.parentId
								|| admission.requestedProfile !== principal.requestedProfile
								|| !principal.requestedRoute
								|| !admission.requestedRoute
								|| !routesEqual(admission.requestedRoute, principal.requestedRoute)) {
								if (status === "completed") status = "failed";
								controllerNotices.push(`Usage child principal ${principal.id} identity does not match its controller admission.`);
							}
						}
					}
				}
			}
			if (budgetLedger.deniedAdmissions.length > 0) {
				if (status === "completed") status = "failed";
				const reasons = [...new Set(budgetLedger.deniedAdmissions.map((admission) => admission.reason))].join(", ");
				controllerNotices.push(`The controller denied one or more budget admissions (${reasons}).`);
			}

			// Acceptance commands are controller-owned code execution. They run only after
			// adapter identity, route, usage, and admission evidence has passed every gate.
			phase = "acceptance-running";
			await this.store.advancePhase(runId, phase, budgetLedger);
			const acceptance = status === "completed" && !abortController.signal.aborted
				? await runAcceptance(spec, abortController.signal, runDirectory)
				: [];
			const postAcceptance = await workspaceSnapshot(workspaceRoot);
			const finalWorkspaceSha256 = workspaceSnapshotSha256(postAcceptance);
			const acceptanceChanged = changedPaths(postAdapter, postAcceptance);
			const changed = [...new Set([...harnessChanged, ...acceptanceChanged])].sort();
			const unowned = unownedPaths(spec, changed, taskPrefix);
			const acceptancePassed = acceptance.length === spec.acceptance.commands.length && acceptance.every((item) => item.passed);
			if (abortController.signal.aborted) status = "cancelled";
			else if (status === "completed" && !acceptancePassed) status = "failed";
			if (status === "completed" && spec.acceptance.requireCleanUnownedPaths && unowned.length > 0) status = "failed";
			if (usageBudgetRequested) {
				await emit("controller.budget.reconciled", {
					providerRequests: budgetLedger.providerRequests,
					toolCalls: budgetLedger.toolCalls,
					childrenStarted: budgetLedger.childrenStarted,
					reservedCostUsdMicros: budgetLedger.reservedCostUsdMicros,
					deniedAdmissions: budgetLedger.deniedAdmissions.length,
				});
			}
			phase = "finalizing";
			await this.store.advancePhase(runId, phase, budgetLedger);
			await emit("run.finished", { status });
			terminalEventPersisted = true;
			terminalStatus = status;
			if (this.store.eventsWereTruncated(runId)) {
				controllerNotices.push("The normalized event log reached a controller size or count limit; oversized or excess events were replaced or omitted with truncation evidence.");
			}
			const eventsAbsolutePath = resolve(runDirectory, "events.jsonl");
			const eventsSha256 = createHash("sha256").update(await readFile(eventsAbsolutePath)).digest("hex");
			const receipt: RunReceipt = {
				version: 1,
				tier: spec.tier,
				runId,
				adapterId: adapter.id,
				harness: adapter.harness,
				...(preflight.doctor.harnessVersion ? { harnessVersion: preflight.doctor.harnessVersion } : {}),
				...(preflight.doctor.binarySha256 ? { harnessBinarySha256: preflight.doctor.binarySha256 } : {}),
				...(preflight.doctor.enforcementSha256 ? { harnessEnforcementSha256: preflight.doctor.enforcementSha256 } : {}),
				...(preflight.doctor.routeProfileSha256 ? { routeProfileSha256: preflight.doctor.routeProfileSha256 } : {}),
				status,
				...(costReport ? { costReport } : {}),
				...(usageBudgetRequested ? { budgetLedger } : {}),
				startedAt,
				finishedAt: new Date().toISOString(),
				...(spec.routeProfile ? { requestedRouteProfile: spec.routeProfile } : {}),
				...(adapterResult.configuredRoute ? { configuredRoute: adapterResult.configuredRoute } : {}),
				...(agentIdentity ? { agentIdentity } : {}),
				effectivePower: effectivePowerEvidence(spec, preflight.doctor, adapterResult.configuredRoute, agentIdentity, usage),
				...(usage ? { usage } : {}),
				exitCode: adapterResult.exitCode,
				...(adapterResult.finalOutput !== undefined ? { finalOutput: adapterResult.finalOutput } : {}),
				acceptance,
				harnessChangedPaths: harnessChanged,
				acceptanceChangedPaths: acceptanceChanged,
				changedPaths: changed,
				unownedChangedPaths: unowned,
				initialWorkspaceSha256,
				postAdapterWorkspaceSha256,
				finalWorkspaceSha256,
				...(patchEvidence ?? {}),
				eventsPath: relative(this.store.root, eventsAbsolutePath),
				eventsSha256,
				notices: [...new Set([...preflight.doctor.notices, ...(adapterResult.notices ?? []), ...controllerNotices])],
			};

			receiptCandidate = receipt;
			await this.store.writeReceipt(receipt);
			phase = "terminal";
			await this.store.advancePhase(runId, phase, budgetLedger).catch(() => undefined);
			await this.store.writeStatus(runId, status).catch(() => undefined);
			return receipt;
			} catch (error) {
				if (!startedEventPersisted) {
				await this.store.writeStatus(runId, "failed").catch(() => undefined);
					throw error;
				}
				try {
					const cleanup = await this.store.terminateAdmittedProcesses(runId, "controller-fallback-cleanup");
					if (cleanup.unresolvedAdmissionIds.length > 0) leaseCanRelease = false;
				} catch {
					leaseCanRelease = false;
				}
			const failureStatus: RunStatus = abortController.signal.aborted ? "cancelled" : "failed";
			const errorEvidence = redactedTextEvidence(error instanceof Error ? error.message : String(error));
			if (!terminalEventPersisted) {
				await eventWrite.catch(() => undefined);
				const fallbackEvent: RunEvent = {
					version: 1,
					sequence: (sequence += 1),
					time: new Date().toISOString(),
					runId,
					adapterId: adapter.id,
					type: "run.finished",
					data: { status: failureStatus, phase, fallback: true, error: errorEvidence },
				};
				await this.store.appendEvent(runId, fallbackEvent);
				terminalEventPersisted = true;
				terminalStatus = failureStatus;
			}
			if (receiptCandidate && terminalStatus === receiptCandidate.status) {
				await this.store.writeReceipt(receiptCandidate);
				await this.store.advancePhase(runId, "terminal", budget.snapshot()).catch(() => undefined);
				await this.store.writeStatus(runId, receiptCandidate.status).catch(() => undefined);
				return receiptCandidate;
			}
			if (terminalStatus === "completed") {
				// A completed terminal event is authoritative. A persistent failure to
				// read its event log cannot be represented by a truthful failed receipt.
				await this.store.writeStatus(runId, "completed").catch(() => undefined);
				throw error;
			}
			const eventsAbsolutePath = resolve(runDirectory, "events.jsonl");
			const fallbackCostReport = reportOnlyCost(spec);
			const fallbackReceipt: RunReceipt = {
				version: 1,
				tier: spec.tier,
				runId,
				adapterId: adapter.id,
				harness: adapter.harness,
				...(preflight.doctor.harnessVersion ? { harnessVersion: preflight.doctor.harnessVersion } : {}),
				...(preflight.doctor.binarySha256 ? { harnessBinarySha256: preflight.doctor.binarySha256 } : {}),
				...(preflight.doctor.enforcementSha256 ? { harnessEnforcementSha256: preflight.doctor.enforcementSha256 } : {}),
				...(preflight.doctor.routeProfileSha256 ? { routeProfileSha256: preflight.doctor.routeProfileSha256 } : {}),
				status: terminalStatus ?? failureStatus,
				fallbackReceipt: true,
				failurePhase: phase,
				workspaceEvidenceComplete: false,
				...(fallbackCostReport ? { costReport: fallbackCostReport } : {}),
				budgetLedger: budget.snapshot(),
				startedAt,
				finishedAt: new Date().toISOString(),
				...(spec.routeProfile ? { requestedRouteProfile: spec.routeProfile } : {}),
				exitCode: null,
				acceptance: [],
				harnessChangedPaths: [],
				acceptanceChangedPaths: [],
				changedPaths: [],
				unownedChangedPaths: [],
				eventsPath: relative(this.store.root, eventsAbsolutePath),
				eventsSha256: createHash("sha256").update(await readFile(eventsAbsolutePath)).digest("hex"),
				notices: [
					...preflight.doctor.notices,
					`The controller wrote a fallback receipt after a recoverable failure during ${phase}; workspace-change and acceptance evidence is incomplete.`,
				],
			};
			await this.store.writeReceipt(fallbackReceipt);
			await this.store.advancePhase(runId, "terminal", budget.snapshot()).catch(() => undefined);
			await this.store.writeStatus(runId, fallbackReceipt.status).catch(() => undefined);
			return fallbackReceipt;
			} finally {
				stopWatching();
				clearTimeout(timer);
				if (leaseCanRelease) await workspaceLease.release().catch(() => undefined);
				else await workspaceLease.holdForRecovery(leaseHoldReason).catch(() => undefined);
			}
	}

	async #writeRecoveryCancellationReceipt(runId: string): Promise<RunReceipt | undefined> {
		const state = await this.store.readAdmissionState(runId);
		if (state.phase === "terminal") return this.store.readReceipt(runId).catch(() => undefined);
		if (state.processes.some((admission) => admission.status !== "exited")) return undefined;
		if ((state.phase === "starting" || state.phase === "adapter-running") && state.processes.length === 0) {
			// A controller can fail between process spawn and durable binding. Without
			// any admission evidence, recovery cannot prove that no harness exists.
			return undefined;
		}
		const eventsAbsolutePath = resolve(this.store.runDirectory(runId), "events.jsonl");
		const eventText = await readFile(eventsAbsolutePath, "utf8");
		const events = eventText.trim() === "" ? [] : eventText.trim().split("\n").map((line) => JSON.parse(line) as RunEvent);
		if (events.some((event) => event.type === "run.finished")) return undefined;
		const lastSequence = events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0);
		await this.store.appendEvent(runId, {
			version: 1,
			sequence: lastSequence + 1,
			time: new Date().toISOString(),
			runId,
			adapterId: state.adapterId,
			type: "run.finished",
			data: { status: "cancelled", phase: state.phase, fallback: true, recovery: true },
		});
		const spec = await this.store.readJson<RunSpec>(runId, "spec.json");
		const recoveryCostReport = reportOnlyCost(spec);
		const receipt: RunReceipt = {
			version: 1,
			tier: spec.tier,
			runId,
			adapterId: state.adapterId,
			harness: state.harness,
			status: "cancelled",
			fallbackReceipt: true,
			failurePhase: state.phase,
			workspaceEvidenceComplete: false,
			...(recoveryCostReport ? { costReport: recoveryCostReport } : {}),
			budgetLedger: await this.store.readBudgetSnapshot(runId),
			startedAt: state.startedAt,
			finishedAt: new Date().toISOString(),
			...(spec.routeProfile ? { requestedRouteProfile: spec.routeProfile } : {}),
			exitCode: null,
			acceptance: [],
			harnessChangedPaths: [],
			acceptanceChangedPaths: [],
			changedPaths: [],
			unownedChangedPaths: [],
			eventsPath: relative(this.store.root, eventsAbsolutePath),
			eventsSha256: createHash("sha256").update(await readFile(eventsAbsolutePath)).digest("hex"),
			notices: [
				`A restarted controller cancelled the orphaned harness after exact process-identity verification during ${state.phase}; workspace-change and acceptance evidence is incomplete.`,
			],
		};
		await this.store.writeReceipt(receipt);
		await this.store.advancePhase(runId, "terminal", state.budgetLedger).catch(() => undefined);
		await this.store.writeStatus(runId, "cancelled").catch(() => undefined);
		await this.store.releaseRecoveryWorkspaceLease(state.workspaceRoot, runId).catch(() => undefined);
		return receipt;
	}

	async inspect(runId: string): Promise<{
		status: Awaited<ReturnType<RunStore["readStatus"]>>;
		receipt?: RunReceipt;
		recovery?: Awaited<ReturnType<RunStore["reconcileRun"]>>;
	}> {
		const status = await this.store.readStatus(runId);
		try {
			return { status, receipt: await this.store.readReceipt(runId) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				if (status.status !== "running") return { status };
				try {
					return { status, recovery: await this.store.reconcileRun(runId) };
				} catch (recoveryError) {
					if ((recoveryError as NodeJS.ErrnoException).code === "ENOENT") return { status };
					throw recoveryError;
				}
			}
			throw error;
		}
	}

	async cancel(runId: string): Promise<(
		Awaited<ReturnType<RunStore["cancelOrphanProcesses"]>> & { receipt?: RunReceipt }
	) | undefined> {
		try {
			await this.store.requestCancellation(runId);
			const result = await this.store.cancelOrphanProcesses(runId);
			if (!result.recovery.orphaned) return result;
			const receipt = await this.#writeRecoveryCancellationReceipt(runId);
			return { ...result, ...(receipt ? { receipt } : {}) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async recover(runId: string): Promise<{
		released: boolean;
		reason?: string;
		receipt?: RunReceipt;
	}> {
		let state;
		let receipt: RunReceipt;
		try {
			state = await this.store.readAdmissionState(runId);
			receipt = await this.store.readReceipt(runId);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { released: false, reason: "run state or receipt is unavailable" };
			}
			throw error;
		}
		if (state.phase !== "terminal") {
			return { released: false, reason: "run is not terminal", receipt };
		}
		if (!receipt.fallbackReceipt || receipt.workspaceEvidenceComplete !== false) {
			return { released: false, reason: "run does not have an incomplete fallback receipt", receipt };
		}
		const controllerStatus = await processIdentityStatus(state.controller);
		if (controllerStatus === "same" || controllerStatus === "unverifiable") {
			return {
				released: false,
				reason: controllerStatus === "same"
					? "the controller that owned the run is still active"
					: "the controller identity cannot be verified",
				receipt,
			};
		}
		if (state.processes.some((admission) => admission.status !== "exited" && !admission.identity)) {
			return {
				released: false,
				reason: "an admitted process was never durably bound, so absence cannot be proven",
				receipt,
			};
		}
		if (state.processes.some((admission) => admission.status !== "exited")) {
			const cleanup = await this.store.terminateAdmittedProcesses(runId, "explicit-recovery-cleanup");
			if (cleanup.unresolvedAdmissionIds.length > 0) {
				return { released: false, reason: "one or more admitted processes remain unresolved", receipt };
			}
		}
		const reconciled = await this.store.readAdmissionState(runId);
		if (reconciled.processes.some((admission) => admission.status !== "exited")) {
			return { released: false, reason: "one or more admitted processes remain active", receipt };
		}
		const released = await this.store.releaseRecoveryWorkspaceLease(state.workspaceRoot, runId);
		return {
			released,
			...(released ? {} : { reason: "no matching recovery-held workspace lease exists" }),
			receipt,
		};
	}
}
