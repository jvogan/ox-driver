import { isAbsolute, normalize, sep } from "node:path";

export const MIN_ORCHESTRATION_PLAN_LANES = 2;
export const MAX_ORCHESTRATION_PLAN_LANES = 32;
export const MAX_LANE_TIMEOUT_SECONDS = 86_400;
export const MICROS_PER_USD = 1_000_000;
export const MAX_LANE_TEXT_BYTES = 16 * 1024;
export const MAX_LANE_NAME_BYTES = 1024;

export interface OrchestrationPlanLane {
	id: string;
	role: string;
	objective: string;
	workerPath: string;
	harness?: "opencode";
	route?: string;
	agent?: string;
	childAgents?: readonly string[];
	ownedPaths?: readonly string[];
	excludedPaths?: readonly string[];
	checks?: readonly string[];
	timeoutSeconds?: number;
	costCeilingUsd?: number;
}

export interface OrchestrationPlan {
	version: 1;
	lanes: readonly OrchestrationPlanLane[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, errors: string[]): value is string {
	if (typeof value !== "string" || value.trim() === "") {
		errors.push(`${field} must be a non-empty string`);
		return false;
	}
	return true;
}

function requireBoundedString(value: unknown, field: string, maximumBytes: number, errors: string[]): value is string {
	if (!requireString(value, field, errors)) return false;
	if (Buffer.byteLength(value, "utf8") > maximumBytes) {
		errors.push(`${field} must be at most ${maximumBytes} UTF-8 bytes`);
		return false;
	}
	return true;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], field: string, errors: string[]): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) errors.push(`${field}.${key} is not supported`);
	}
}

function validateAbsolutePath(value: unknown, field: string, errors: string[]): void {
	if (!requireBoundedString(value, field, MAX_LANE_TEXT_BYTES, errors)) return;
	const path = value as string;
	if (path.includes("\0")) errors.push(`${field} must not contain NUL bytes`);
	else if (!isAbsolute(path)) errors.push(`${field} must be an absolute worker worktree path`);
	else if (path.split(/[\\/]+/).includes("..")) errors.push(`${field} must not contain parent traversal segments: ${path}`);
}

function validateScopePaths(value: unknown, field: string, errors: string[]): void {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
		errors.push(`${field} must be an array of non-empty strings`);
		return;
	}
	if (new Set(value).size !== value.length) errors.push(`${field} must not contain duplicates`);
	for (const item of value as string[]) {
		if (Buffer.byteLength(item, "utf8") > MAX_LANE_TEXT_BYTES) errors.push(`${field} entries must be at most ${MAX_LANE_TEXT_BYTES} UTF-8 bytes`);
		const normalized = normalize(item);
		if (item.includes("\0")) errors.push(`${field} entries must not contain NUL bytes`);
		if (isAbsolute(item) || normalized === ".." || normalized.startsWith(`..${sep}`)) {
			errors.push(`${field} entries must stay relative to the worker repository: ${item}`);
		}
	}
}

function validateChecks(value: unknown, field: string, errors: string[]): void {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
		errors.push(`${field} must be an array of non-empty strings`);
		return;
	}
	if (new Set(value).size !== value.length) errors.push(`${field} must not contain duplicates`);
	for (const item of value as string[]) {
		if (Buffer.byteLength(item, "utf8") > MAX_LANE_TEXT_BYTES) errors.push(`${field} entries must be at most ${MAX_LANE_TEXT_BYTES} UTF-8 bytes`);
	}
}

function validateNames(value: unknown, field: string, errors: string[]): void {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
		errors.push(`${field} must be an array of non-empty strings`);
		return;
	}
	if (new Set(value).size !== value.length) errors.push(`${field} must not contain duplicates`);
	for (const item of value as string[]) {
		if (Buffer.byteLength(item, "utf8") > MAX_LANE_NAME_BYTES) errors.push(`${field} entries must be at most ${MAX_LANE_NAME_BYTES} UTF-8 bytes`);
	}
}

function validateTimeoutSeconds(value: unknown, field: string, errors: string[]): void {
	if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > MAX_LANE_TIMEOUT_SECONDS) {
		errors.push(`${field} must be an integer between 1 and ${MAX_LANE_TIMEOUT_SECONDS}`);
	}
}

function validateCostCeilingUsd(value: unknown, field: string, errors: string[]): void {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		errors.push(`${field} must be a non-negative finite dollar amount`);
		return;
	}
	if (!Number.isSafeInteger(Math.round(value * MICROS_PER_USD))) {
		errors.push(`${field} must be representable in integer USD micros`);
	}
}

function immutableLane(lane: Record<string, unknown>): OrchestrationPlanLane {
	return Object.freeze({
		id: lane.id as string,
		role: lane.role as string,
		objective: lane.objective as string,
		workerPath: lane.workerPath as string,
		...(lane.harness !== undefined ? { harness: lane.harness as "opencode" } : {}),
		...(lane.route !== undefined ? { route: lane.route as string } : {}),
		...(lane.agent !== undefined ? { agent: lane.agent as string } : {}),
		...(lane.childAgents !== undefined ? { childAgents: Object.freeze([...(lane.childAgents as string[])]) } : {}),
		...(lane.ownedPaths !== undefined ? { ownedPaths: Object.freeze([...(lane.ownedPaths as string[])]) } : {}),
		...(lane.excludedPaths !== undefined ? { excludedPaths: Object.freeze([...(lane.excludedPaths as string[])]) } : {}),
		...(lane.checks !== undefined ? { checks: Object.freeze([...(lane.checks as string[])]) } : {}),
		...(lane.timeoutSeconds !== undefined ? { timeoutSeconds: lane.timeoutSeconds as number } : {}),
		...(lane.costCeilingUsd !== undefined ? { costCeilingUsd: lane.costCeilingUsd as number } : {}),
	});
}

export function validateOrchestrationPlan(value: unknown): OrchestrationPlan {
	const errors: string[] = [];
	if (!isRecord(value)) throw new Error("orchestration plan must be an object");
	rejectUnknownKeys(value, ["version", "lanes"], "plan", errors);
	if (value.version !== 1) errors.push("version must equal 1");
	const lanesValue = value.lanes;
	if (!Array.isArray(lanesValue)) {
		errors.push("lanes must be an array");
	} else {
		if (lanesValue.length < MIN_ORCHESTRATION_PLAN_LANES || lanesValue.length > MAX_ORCHESTRATION_PLAN_LANES) {
			errors.push(`lanes must contain between ${MIN_ORCHESTRATION_PLAN_LANES} and ${MAX_ORCHESTRATION_PLAN_LANES} lanes`);
		}
		const ids = new Set<string>();
		const roles = new Set<string>();
		const workerPaths = new Set<string>();
		for (const [index, entry] of lanesValue.entries()) {
			const field = `lanes[${index}]`;
			if (!isRecord(entry)) {
				errors.push(`${field} must be an object`);
				continue;
			}
			rejectUnknownKeys(entry, ["id", "role", "objective", "workerPath", "harness", "route", "agent", "childAgents", "ownedPaths", "excludedPaths", "checks", "timeoutSeconds", "costCeilingUsd"], field, errors);
			if (requireBoundedString(entry.id, `${field}.id`, MAX_LANE_NAME_BYTES, errors)) {
				if (ids.has(entry.id)) errors.push(`${field}.id duplicates lane id ${entry.id}`);
				ids.add(entry.id);
			}
			if (requireBoundedString(entry.role, `${field}.role`, MAX_LANE_NAME_BYTES, errors)) {
				if (roles.has(entry.role)) errors.push(`${field}.role duplicates lane role ${entry.role}`);
				roles.add(entry.role);
			}
			requireBoundedString(entry.objective, `${field}.objective`, MAX_LANE_TEXT_BYTES, errors);
			if (requireBoundedString(entry.workerPath, `${field}.workerPath`, MAX_LANE_TEXT_BYTES, errors)) {
				if (workerPaths.has(entry.workerPath)) errors.push(`${field}.workerPath duplicates lane worker path ${entry.workerPath}`);
				workerPaths.add(entry.workerPath);
			}
			validateAbsolutePath(entry.workerPath, `${field}.workerPath`, errors);
			if (entry.harness !== undefined && entry.harness !== "opencode") {
				errors.push(`${field}.harness must be "opencode"`);
			}
			if (entry.route !== undefined) requireBoundedString(entry.route, `${field}.route`, MAX_LANE_NAME_BYTES, errors);
			if (entry.agent !== undefined) requireBoundedString(entry.agent, `${field}.agent`, MAX_LANE_NAME_BYTES, errors);
			if (entry.childAgents !== undefined) validateNames(entry.childAgents, `${field}.childAgents`, errors);
			if (Array.isArray(entry.childAgents) && entry.childAgents.length > 0 && entry.agent === undefined) {
				errors.push(`${field}.childAgents requires an explicit delegation-capable agent`);
			}
			if (entry.ownedPaths !== undefined) validateScopePaths(entry.ownedPaths, `${field}.ownedPaths`, errors);
			if (entry.excludedPaths !== undefined) validateScopePaths(entry.excludedPaths, `${field}.excludedPaths`, errors);
			if (entry.checks !== undefined) validateChecks(entry.checks, `${field}.checks`, errors);
			if (entry.timeoutSeconds !== undefined) validateTimeoutSeconds(entry.timeoutSeconds, `${field}.timeoutSeconds`, errors);
			if (entry.costCeilingUsd !== undefined) validateCostCeilingUsd(entry.costCeilingUsd, `${field}.costCeilingUsd`, errors);
		}
	}
	if (errors.length > 0) throw new Error(`invalid orchestration plan:\n- ${errors.join("\n- ")}`);
	return Object.freeze({
		version: 1 as const,
		lanes: Object.freeze((lanesValue as Record<string, unknown>[]).map(immutableLane)),
	});
}
