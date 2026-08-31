import { createHash } from "node:crypto";
import { isAbsolute, normalize, sep } from "node:path";

import { laneTransitivelyDependsOn } from "./orchestration-plan.js";

export const MAX_EFFECTIVE_RETRY_LANES = 32;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_OBJECTIVE_BYTES = 1024 * 1024;
const MAX_NAME_BYTES = 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40,64}$/;

export interface EffectiveRetryLane {
	id: string;
	role: string;
	objective: string;
	workerPath: string;
	harness?: "opencode" | "pi" | "omp";
	writerPolicy?: "read-only" | "one-writer";
	dependsOn?: readonly string[];
	route: string;
	agent?: string;
	childAgents?: readonly string[];
	profileDirectory?: string;
	ownedPaths: readonly string[];
	excludedPaths: readonly string[];
	checks: readonly string[];
	timeoutSeconds: number;
	reportOnlyCostUsdMicros: number;
	worktreeId?: string;
	baseCommit?: string;
}

export interface EffectiveRetryPlan {
	version: 1;
	lanes: readonly EffectiveRetryLane[];
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) throw new Error(`${label} has unsupported fields: ${unknown.join(", ")}`);
}

function string(value: unknown, label: string, maximumBytes: number): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximumBytes) {
		throw new Error(`${label} must be a non-empty bounded string`);
	}
	return value;
}

function absolutePath(value: unknown, label: string): string {
	const path = string(value, label, MAX_TEXT_BYTES);
	if (!isAbsolute(path) || path.split(/[\\/]+/).includes("..")) throw new Error(`${label} must be an absolute path without parent traversal`);
	return path;
}

function stringList(value: unknown, label: string, scopePaths = false): readonly string[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	const result = value.map((item, index) => string(item, `${label}[${index}]`, MAX_TEXT_BYTES));
	if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates`);
	if (scopePaths) {
		for (const item of result) {
			const normalized = normalize(item);
			if (isAbsolute(item) || normalized === ".." || normalized.startsWith(`..${sep}`)) {
				throw new Error(`${label} entries must stay relative to the worker repository: ${item}`);
			}
		}
	}
	return Object.freeze(result);
}

function nameList(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	const result = value.map((item, index) => string(item, `${label}[${index}]`, MAX_NAME_BYTES));
	if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates`);
	return Object.freeze(result);
}

function lane(value: unknown, index: number): EffectiveRetryLane {
	const input = record(value, `effective retry lane ${index}`);
	exactKeys(input, [
		"id", "role", "objective", "workerPath", "harness", "writerPolicy", "dependsOn", "route", "agent", "childAgents", "profileDirectory",
		"ownedPaths", "excludedPaths", "checks", "timeoutSeconds", "reportOnlyCostUsdMicros",
		"worktreeId", "baseCommit",
	], `effective retry lane ${index}`);
	if (input.harness !== undefined && input.harness !== "opencode" && input.harness !== "pi" && input.harness !== "omp") {
		throw new Error(`effective retry lane ${index} harness must be "opencode", "pi", or "omp"`);
	}
	if (input.writerPolicy !== undefined && input.writerPolicy !== "read-only" && input.writerPolicy !== "one-writer") {
		throw new Error(`effective retry lane ${index} writerPolicy must be "read-only" or "one-writer"`);
	}
	if (input.writerPolicy === "one-writer" && (!Array.isArray(input.ownedPaths) || input.ownedPaths.length === 0)) {
		throw new Error(`effective retry lane ${index} writerPolicy "one-writer" requires at least one owned path`);
	}
	const timeoutSeconds = input.timeoutSeconds;
	if (!Number.isSafeInteger(timeoutSeconds) || Number(timeoutSeconds) < 1 || Number(timeoutSeconds) > 86_400) {
		throw new Error(`effective retry lane ${index} timeoutSeconds must be an integer from 1 to 86400`);
	}
	const reportOnlyCostUsdMicros = input.reportOnlyCostUsdMicros;
	if (!Number.isSafeInteger(reportOnlyCostUsdMicros) || Number(reportOnlyCostUsdMicros) < 0) {
		throw new Error(`effective retry lane ${index} reportOnlyCostUsdMicros must be a non-negative safe integer`);
	}
	const worktreeId = input.worktreeId === undefined ? undefined : string(input.worktreeId, `effective retry lane ${index} worktreeId`, 128);
	if (worktreeId !== undefined && !UUID.test(worktreeId)) throw new Error(`effective retry lane ${index} worktreeId must be a canonical UUID`);
	const baseCommit = input.baseCommit === undefined ? undefined : string(input.baseCommit, `effective retry lane ${index} baseCommit`, 128);
	if (baseCommit !== undefined && !COMMIT.test(baseCommit)) throw new Error(`effective retry lane ${index} baseCommit is invalid`);
	return Object.freeze({
		id: string(input.id, `effective retry lane ${index} id`, MAX_NAME_BYTES),
		role: string(input.role, `effective retry lane ${index} role`, MAX_NAME_BYTES),
		objective: string(input.objective, `effective retry lane ${index} objective`, MAX_OBJECTIVE_BYTES),
		workerPath: absolutePath(input.workerPath, `effective retry lane ${index} workerPath`),
		// Serialized keys stay provided-only, so a lane without harness hashes
		// byte-identically to plans recorded before this field existed.
		...(input.harness === undefined ? {} : { harness: input.harness as "opencode" | "pi" | "omp" }),
		...(input.writerPolicy === undefined ? {} : { writerPolicy: input.writerPolicy as "read-only" | "one-writer" }),
		...(input.dependsOn === undefined ? {} : { dependsOn: nameList(input.dependsOn, `effective retry lane ${index} dependsOn`) }),
		route: string(input.route, `effective retry lane ${index} route`, MAX_NAME_BYTES),
		...(input.agent === undefined ? {} : { agent: string(input.agent, `effective retry lane ${index} agent`, MAX_NAME_BYTES) }),
		...(input.childAgents === undefined ? {} : { childAgents: nameList(input.childAgents, `effective retry lane ${index} childAgents`) }),
		...(input.profileDirectory === undefined ? {} : { profileDirectory: absolutePath(input.profileDirectory, `effective retry lane ${index} profileDirectory`) }),
		ownedPaths: stringList(input.ownedPaths, `effective retry lane ${index} ownedPaths`, true),
		excludedPaths: stringList(input.excludedPaths, `effective retry lane ${index} excludedPaths`, true),
		checks: stringList(input.checks, `effective retry lane ${index} checks`),
		timeoutSeconds: Number(timeoutSeconds),
		reportOnlyCostUsdMicros: Number(reportOnlyCostUsdMicros),
		...(worktreeId === undefined ? {} : { worktreeId }),
		...(baseCommit === undefined ? {} : { baseCommit }),
	});
}

export function validateEffectiveRetryPlan(value: unknown): EffectiveRetryPlan {
	const input = record(value, "effective retry plan");
	exactKeys(input, ["version", "lanes"], "effective retry plan");
	if (input.version !== 1) throw new Error("effective retry plan version must equal 1");
	if (!Array.isArray(input.lanes) || input.lanes.length < 1 || input.lanes.length > MAX_EFFECTIVE_RETRY_LANES) {
		throw new Error(`effective retry plan must contain from 1 to ${MAX_EFFECTIVE_RETRY_LANES} lanes`);
	}
	const lanes = input.lanes.map(lane);
	for (const field of ["id", "role"] as const) {
		const values = lanes.map((item) => item[field]);
		if (new Set(values).size !== values.length) throw new Error(`effective retry plan lane ${field} values must be unique`);
	}
	const ids = new Set(lanes.map((item) => item.id));
	for (const lane of lanes) for (const dependency of lane.dependsOn ?? []) {
		if (dependency === lane.id) throw new Error(`effective retry lane ${lane.id} must not depend on itself`);
		if (!ids.has(dependency)) throw new Error(`effective retry lane ${lane.id} references unknown dependency ${dependency}`);
	}
	for (const lane of lanes) if (laneTransitivelyDependsOn(lanes, lane.id, lane.id)) {
		throw new Error(`effective retry plan contains a dependency cycle through ${lane.id}`);
	}
	for (const [index, lane] of lanes.entries()) for (let otherIndex = 0; otherIndex < index; otherIndex += 1) {
		const other = lanes[otherIndex]!;
		if (lane.workerPath !== other.workerPath) continue;
		if (!laneTransitivelyDependsOn(lanes, lane.id, other.id)
			&& !laneTransitivelyDependsOn(lanes, other.id, lane.id)) {
			throw new Error(`effective retry lanes ${other.id} and ${lane.id} share an unordered worker path`);
		}
	}
	return Object.freeze({ version: 1 as const, lanes: Object.freeze(lanes) });
}

export function effectiveRetryPlanSha256(value: EffectiveRetryPlan): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function validateEffectiveRetryPlanSha256(value: unknown, plan: EffectiveRetryPlan): string {
	const digest = string(value, "effective retry plan SHA-256", 64);
	if (!DIGEST.test(digest) || digest !== effectiveRetryPlanSha256(plan)) throw new Error("effective retry plan SHA-256 does not match the plan");
	return digest;
}
