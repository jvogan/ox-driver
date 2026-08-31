import { isAbsolute, normalize, sep } from "node:path";

export const MIN_ORCHESTRATION_PLAN_LANES = 2;
export const MAX_ORCHESTRATION_PLAN_LANES = 32;
export const MAX_LANE_TIMEOUT_SECONDS = 86_400;
export const MICROS_PER_USD = 1_000_000;
export const MAX_LANE_TEXT_BYTES = 16 * 1024;
export const MAX_LANE_NAME_BYTES = 1024;

export type OrchestrationHarness = "opencode" | "pi" | "omp";
export type OrchestrationWriterPolicy = "read-only" | "one-writer";

export interface OrchestrationHarnessCapabilities {
	readonly harness: OrchestrationHarness;
	readonly defaultWriterPolicy: OrchestrationWriterPolicy;
	readonly writerPolicies: readonly OrchestrationWriterPolicy[];
	readonly acceptsAgentProfile: boolean;
	readonly acceptsChildAgents: boolean;
	readonly readOnlyChecks: boolean;
	readonly requiresExplicitWriterScope: boolean;
}

const ORCHESTRATION_CAPABILITIES: Readonly<Record<OrchestrationHarness, OrchestrationHarnessCapabilities>> = Object.freeze({
	opencode: Object.freeze({
		harness: "opencode",
		defaultWriterPolicy: "one-writer",
		writerPolicies: Object.freeze(["one-writer"] as const),
		acceptsAgentProfile: true,
		acceptsChildAgents: true,
		readOnlyChecks: false,
		requiresExplicitWriterScope: false,
	}),
	pi: Object.freeze({
		harness: "pi",
		defaultWriterPolicy: "read-only",
		writerPolicies: Object.freeze(["read-only", "one-writer"] as const),
		acceptsAgentProfile: false,
		acceptsChildAgents: false,
		readOnlyChecks: false,
		requiresExplicitWriterScope: true,
	}),
	omp: Object.freeze({
		harness: "omp",
		defaultWriterPolicy: "read-only",
		writerPolicies: Object.freeze(["read-only"] as const),
		acceptsAgentProfile: false,
		acceptsChildAgents: false,
		readOnlyChecks: true,
		requiresExplicitWriterScope: false,
	}),
});

export function orchestrationHarnessCapabilities(harness: OrchestrationHarness): OrchestrationHarnessCapabilities {
	return ORCHESTRATION_CAPABILITIES[harness];
}

export interface OrchestrationPlanLane {
	id: string;
	role: string;
	objective: string;
	workerPath: string;
	harness?: OrchestrationHarness;
	writerPolicy?: OrchestrationWriterPolicy;
	dependsOn?: readonly string[];
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

/**
 * The writer policy a lane actually dispatches with. OpenCode lanes are always
 * writers. A Pi lane is read-only unless it explicitly declares a writer, so a
 * plan can never widen a Pi lane's capability by omission.
 */
export function laneWriterPolicy(lane: {
	harness?: OrchestrationHarness;
	writerPolicy?: OrchestrationWriterPolicy;
}): OrchestrationWriterPolicy {
	const harness = lane.harness ?? "opencode";
	return lane.writerPolicy ?? orchestrationHarnessCapabilities(harness).defaultWriterPolicy;
}

export function laneDependsOn(lane: Pick<OrchestrationPlanLane, "dependsOn">): readonly string[] {
	return lane.dependsOn ?? Object.freeze([]);
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
		...(lane.harness !== undefined ? { harness: lane.harness as OrchestrationHarness } : {}),
		...(lane.writerPolicy !== undefined ? { writerPolicy: lane.writerPolicy as OrchestrationWriterPolicy } : {}),
		...(lane.dependsOn !== undefined ? { dependsOn: Object.freeze([...(lane.dependsOn as string[])]) } : {}),
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

function validateDependencyGraph(lanes: readonly OrchestrationPlanLane[], errors: string[]): void {
	const ids = new Set(lanes.map((lane) => lane.id));
	const state = new Map<string, "visiting" | "visited">();
	const byId = new Map(lanes.map((lane) => [lane.id, lane] as const));
	for (const [index, lane] of lanes.entries()) {
		for (const dependency of laneDependsOn(lane)) {
			if (dependency === lane.id) errors.push(`lanes[${index}].dependsOn must not contain its own lane id`);
			else if (!ids.has(dependency)) errors.push(`lanes[${index}].dependsOn references unknown lane ${dependency}`);
		}
	}
	const visit = (id: string, path: readonly string[]): void => {
		const status = state.get(id);
		if (status === "visited") return;
		if (status === "visiting") {
			errors.push(`lane dependency cycle: ${[...path, id].join(" -> ")}`);
			return;
		}
		state.set(id, "visiting");
		const lane = byId.get(id);
		if (lane) for (const dependency of laneDependsOn(lane)) {
			if (ids.has(dependency)) visit(dependency, [...path, id]);
		}
		state.set(id, "visited");
	};
	for (const id of ids) visit(id, []);
}

export function laneTransitivelyDependsOn(
	lanes: readonly Pick<OrchestrationPlanLane, "id" | "dependsOn">[],
	laneId: string,
	dependencyId: string,
): boolean {
	const byId = new Map(lanes.map((lane) => [lane.id, lane] as const));
	const pending = [...laneDependsOn(byId.get(laneId) ?? {})];
	const seen = new Set<string>();
	while (pending.length > 0) {
		const current = pending.pop()!;
		if (current === dependencyId) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		const lane = byId.get(current);
		if (lane) pending.push(...laneDependsOn(lane));
	}
	return false;
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
		for (const [index, entry] of lanesValue.entries()) {
			const field = `lanes[${index}]`;
			if (!isRecord(entry)) {
				errors.push(`${field} must be an object`);
				continue;
			}
			rejectUnknownKeys(entry, ["id", "role", "objective", "workerPath", "harness", "writerPolicy", "dependsOn", "route", "agent", "childAgents", "ownedPaths", "excludedPaths", "checks", "timeoutSeconds", "costCeilingUsd"], field, errors);
			if (requireBoundedString(entry.id, `${field}.id`, MAX_LANE_NAME_BYTES, errors)) {
				if (ids.has(entry.id)) errors.push(`${field}.id duplicates lane id ${entry.id}`);
				ids.add(entry.id);
			}
			if (requireBoundedString(entry.role, `${field}.role`, MAX_LANE_NAME_BYTES, errors)) {
				if (roles.has(entry.role)) errors.push(`${field}.role duplicates lane role ${entry.role}`);
				roles.add(entry.role);
			}
			requireBoundedString(entry.objective, `${field}.objective`, MAX_LANE_TEXT_BYTES, errors);
			requireBoundedString(entry.workerPath, `${field}.workerPath`, MAX_LANE_TEXT_BYTES, errors);
			validateAbsolutePath(entry.workerPath, `${field}.workerPath`, errors);
			if (entry.harness !== undefined && entry.harness !== "opencode" && entry.harness !== "pi" && entry.harness !== "omp") {
				errors.push(`${field}.harness must be "opencode", "pi", or "omp"`);
			}
			if (entry.dependsOn !== undefined) validateNames(entry.dependsOn, `${field}.dependsOn`, errors);
			if (entry.route !== undefined) requireBoundedString(entry.route, `${field}.route`, MAX_LANE_NAME_BYTES, errors);
			if (entry.agent !== undefined) requireBoundedString(entry.agent, `${field}.agent`, MAX_LANE_NAME_BYTES, errors);
			if (entry.childAgents !== undefined) validateNames(entry.childAgents, `${field}.childAgents`, errors);
			if (Array.isArray(entry.childAgents) && entry.childAgents.length > 0 && entry.agent === undefined) {
				errors.push(`${field}.childAgents requires an explicit delegation-capable agent`);
			}
			const harness = entry.harness === "pi" || entry.harness === "omp" || entry.harness === "opencode"
				? entry.harness
				: "opencode";
			const harnessLabel = harness === "pi" ? "Pi" : harness === "omp" ? "OMP" : "OpenCode";
			const capabilities = ORCHESTRATION_CAPABILITIES[harness];
			if (capabilities && entry.agent !== undefined && !capabilities.acceptsAgentProfile) {
				errors.push(`${field}.agent is unavailable for ${harnessLabel} lanes`);
			}
			if (capabilities && Array.isArray(entry.childAgents) && entry.childAgents.length > 0 && !capabilities.acceptsChildAgents) {
				errors.push(`${field}.childAgents is unavailable for ${harnessLabel} lanes`);
			}
			if (entry.writerPolicy !== undefined && entry.writerPolicy !== "read-only" && entry.writerPolicy !== "one-writer") {
				errors.push(`${field}.writerPolicy must be "read-only" or "one-writer"`);
			}
			const writerPolicy = laneWriterPolicy({
				harness,
				...(entry.writerPolicy === "read-only" || entry.writerPolicy === "one-writer" ? { writerPolicy: entry.writerPolicy } : {}),
			});
			if (capabilities && !capabilities.writerPolicies.includes(writerPolicy)) {
				errors.push(`${field}.writerPolicy "${writerPolicy}" is unavailable for ${harnessLabel} lanes`);
			}
			if (capabilities?.requiresExplicitWriterScope && writerPolicy === "one-writer" && (!Array.isArray(entry.ownedPaths) || entry.ownedPaths.length === 0)) {
				errors.push(`${field}.writerPolicy "one-writer" requires at least one ownedPaths entry on a ${harnessLabel} lane`);
			}
			if (writerPolicy === "read-only" && Array.isArray(entry.ownedPaths) && entry.ownedPaths.length > 0) {
				errors.push(`${field}.ownedPaths requires writerPolicy "one-writer" on a ${harnessLabel} lane`);
			}
			if (writerPolicy === "read-only" && Array.isArray(entry.checks) && entry.checks.length > 0 && !capabilities?.readOnlyChecks) {
				errors.push(`${field}.checks is unavailable for read-only ${harnessLabel} lanes`);
			}
			if (entry.ownedPaths !== undefined) validateScopePaths(entry.ownedPaths, `${field}.ownedPaths`, errors);
			if (entry.excludedPaths !== undefined) validateScopePaths(entry.excludedPaths, `${field}.excludedPaths`, errors);
			if (entry.checks !== undefined) validateChecks(entry.checks, `${field}.checks`, errors);
			if (entry.timeoutSeconds !== undefined) validateTimeoutSeconds(entry.timeoutSeconds, `${field}.timeoutSeconds`, errors);
			if (entry.costCeilingUsd !== undefined) validateCostCeilingUsd(entry.costCeilingUsd, `${field}.costCeilingUsd`, errors);
		}
	}
	if (errors.length > 0) throw new Error(`invalid orchestration plan:\n- ${errors.join("\n- ")}`);
	const plan = Object.freeze({
		version: 1 as const,
		lanes: Object.freeze((lanesValue as Record<string, unknown>[]).map(immutableLane)),
	});
	const dependencyErrors: string[] = [];
	validateDependencyGraph(plan.lanes, dependencyErrors);
	if (dependencyErrors.length > 0) throw new Error(`invalid orchestration plan:\n- ${dependencyErrors.join("\n- ")}`);
	for (const [index, lane] of plan.lanes.entries()) {
		for (const [otherIndex, other] of plan.lanes.entries()) {
			if (otherIndex >= index || lane.workerPath !== other.workerPath) continue;
			if (!laneTransitivelyDependsOn(plan.lanes, lane.id, other.id)
				&& !laneTransitivelyDependsOn(plan.lanes, other.id, lane.id)) {
				throw new Error(`invalid orchestration plan:\n- lanes[${index}].workerPath duplicates lane worker path ${lane.workerPath} without dependency ordering after ${other.id}`);
			}
		}
	}
	return plan;
}
