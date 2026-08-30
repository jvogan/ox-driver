import { isAbsolute, normalize, sep } from "node:path";

import { isOuterControllerHostIdentifier } from "./registry.js";
import { DEFAULT_ACCEPTANCE_TIMEOUT_SECONDS, MAX_ACCEPTANCE_TIMEOUT_SECONDS } from "./types.js";
import type {
	CapabilityName,
	HarnessCapabilities,
	PreflightIssue,
	RunSpec,
} from "./types.js";

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

function requireStringArray(value: unknown, field: string, errors: string[]): value is string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
		errors.push(`${field} must be an array of non-empty strings`);
		return false;
	}
	if (new Set(value).size !== value.length) errors.push(`${field} must not contain duplicates`);
	return true;
}

function rejectUnknownKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	field: string,
	errors: string[],
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) errors.push(`${field}.${key} is not supported`);
	}
}

function validateScopePaths(value: unknown, field: string, errors: string[]): void {
	if (!requireStringArray(value, field, errors)) return;
	for (const item of value) {
		const normalized = normalize(item);
		if (item.includes("\0")) errors.push(`${field} entries must not contain NUL bytes`);
		if (isAbsolute(item) || normalized === ".." || normalized.startsWith(`..${sep}`)) {
			errors.push(`${field} entries must stay relative to task.cwd: ${item}`);
		}
	}
}

function immutableRunSpec(value: RunSpec): RunSpec {
	const task = Object.freeze({
		objective: value.task.objective,
		cwd: value.task.cwd,
		ownedPaths: Object.freeze([...value.task.ownedPaths]),
		excludedPaths: Object.freeze([...value.task.excludedPaths]),
		...(value.task.expectedWorkspaceSha256 ? { expectedWorkspaceSha256: value.task.expectedWorkspaceSha256 } : {}),
	});
	const execution = Object.freeze({
		...value.execution,
		...(value.execution.childPolicy ? {
			childPolicy: Object.freeze({
				allowedProfiles: Object.freeze([...value.execution.childPolicy.allowedProfiles]),
				allowedRoutes: Object.freeze(value.execution.childPolicy.allowedRoutes.map((route) => Object.freeze({ ...route }))),
			}),
		} : {}),
	});
	const acceptance = Object.freeze({
		commands: Object.freeze([...value.acceptance.commands]),
		requireCleanUnownedPaths: value.acceptance.requireCleanUnownedPaths,
		timeoutSeconds: value.acceptance.timeoutSeconds ?? DEFAULT_ACCEPTANCE_TIMEOUT_SECONDS,
		continueOnFailure: value.acceptance.continueOnFailure ?? false,
	});
	return Object.freeze({
		version: 1,
		tier: value.tier,
		harness: value.harness,
		...(value.routeProfile !== undefined ? { routeProfile: value.routeProfile } : {}),
		task,
		execution,
		acceptance,
	}) as RunSpec;
}

export function validateRunSpec(value: unknown): RunSpec {
	const errors: string[] = [];
	if (!isRecord(value)) throw new Error("run specification must be an object");
	rejectUnknownKeys(value, ["version", "tier", "harness", "routeProfile", "task", "execution", "acceptance"], "run", errors);
	if (value.version !== 1) errors.push("version must equal 1");
	if (!["trusted-host", "attested"].includes(String(value.tier))) errors.push("tier is invalid");
	if (requireString(value.harness, "harness", errors) && isOuterControllerHostIdentifier(value.harness)) {
		errors.push("harness is reserved for an outer controller host");
	}
	if (value.routeProfile !== undefined) requireString(value.routeProfile, "routeProfile", errors);

	if (!isRecord(value.task)) {
		errors.push("task must be an object");
	} else {
		rejectUnknownKeys(value.task, ["objective", "cwd", "ownedPaths", "excludedPaths", "expectedWorkspaceSha256"], "task", errors);
		requireString(value.task.objective, "task.objective", errors);
		if (requireString(value.task.cwd, "task.cwd", errors) && !isAbsolute(value.task.cwd)) {
			errors.push("task.cwd must be absolute");
		}
		validateScopePaths(value.task.ownedPaths, "task.ownedPaths", errors);
		validateScopePaths(value.task.excludedPaths, "task.excludedPaths", errors);
		if (value.task.expectedWorkspaceSha256 !== undefined
			&& (typeof value.task.expectedWorkspaceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.task.expectedWorkspaceSha256))) {
			errors.push("task.expectedWorkspaceSha256 must be a lowercase SHA-256 digest");
		}
	}

	if (!isRecord(value.execution)) {
		errors.push("execution must be an object");
	} else {
		rejectUnknownKeys(
			value.execution,
			[
				"session",
				"sessionId",
				"agentProfile",
				"topology",
				"writerPolicy",
				"network",
				"timeoutSeconds",
				"expectedRouteProfileSha256",
				"childPolicy",
				"maxProviderRequests",
				"maxToolCalls",
				"maxCostUsdMicros",
				"reportOnlyCostUsdMicros",
				"maxChildren",
			],
			"execution",
			errors,
		);
		if (!["ephemeral", "new", "resume", "fork"].includes(String(value.execution.session))) {
			errors.push("execution.session is invalid");
		}
		if (value.execution.sessionId !== undefined) requireString(value.execution.sessionId, "execution.sessionId", errors);
		if (value.execution.agentProfile !== undefined) requireString(value.execution.agentProfile, "execution.agentProfile", errors);
		if (["resume", "fork"].includes(String(value.execution.session)) && value.execution.sessionId === undefined) {
			errors.push("execution.sessionId is required for resume and fork");
		}
		if (!["solo", "flat", "hierarchical"].includes(String(value.execution.topology))) {
			errors.push("execution.topology is invalid");
		}
		if (!["read-only", "one-writer", "managed-worktrees"].includes(String(value.execution.writerPolicy))) {
			errors.push("execution.writerPolicy is invalid");
		}
		if (!["configured", "open", "restricted", "none"].includes(String(value.execution.network))) {
			errors.push("execution.network is invalid");
		}
		if (!Number.isSafeInteger(value.execution.timeoutSeconds)
			|| Number(value.execution.timeoutSeconds) < 1
			|| Number(value.execution.timeoutSeconds) > 86_400) {
			errors.push("execution.timeoutSeconds must be an integer between 1 and 86400");
		}
		if (value.execution.expectedRouteProfileSha256 !== undefined
			&& (typeof value.execution.expectedRouteProfileSha256 !== "string"
				|| !/^[0-9a-f]{64}$/.test(value.execution.expectedRouteProfileSha256))) {
			errors.push("execution.expectedRouteProfileSha256 must be a lowercase SHA-256 digest");
		}
		if (value.execution.childPolicy !== undefined) {
			if (!isRecord(value.execution.childPolicy)) {
				errors.push("execution.childPolicy must be an object");
			} else {
				rejectUnknownKeys(value.execution.childPolicy, ["allowedProfiles", "allowedRoutes"], "execution.childPolicy", errors);
				requireStringArray(value.execution.childPolicy.allowedProfiles, "execution.childPolicy.allowedProfiles", errors);
				const routes = value.execution.childPolicy.allowedRoutes;
				if (!Array.isArray(routes) || routes.length === 0) {
					errors.push("execution.childPolicy.allowedRoutes must be a non-empty array");
				} else {
					const identities = new Set<string>();
					for (const [index, route] of routes.entries()) {
						if (!isRecord(route)) {
							errors.push(`execution.childPolicy.allowedRoutes[${index}] must be an object`);
							continue;
						}
						rejectUnknownKeys(route, ["provider", "model", "reasoning"], `execution.childPolicy.allowedRoutes[${index}]`, errors);
						const valid = ["provider", "model", "reasoning"].every((field) => requireString(route[field], `execution.childPolicy.allowedRoutes[${index}].${field}`, errors));
						if (valid) {
							const identity = JSON.stringify([route.provider, route.model, route.reasoning]);
							if (identities.has(identity)) errors.push("execution.childPolicy.allowedRoutes must not contain duplicates");
							identities.add(identity);
						}
					}
				}
			}
		}
		for (const field of ["maxProviderRequests", "maxToolCalls", "maxCostUsdMicros", "reportOnlyCostUsdMicros", "maxChildren"] as const) {
			const item = value.execution[field];
			if (item !== undefined && (!Number.isSafeInteger(item) || Number(item) < 0)) {
				errors.push(`execution.${field} is invalid`);
			}
		}
		if (value.execution.maxCostUsdMicros !== undefined && value.execution.reportOnlyCostUsdMicros !== undefined) {
			errors.push("execution.maxCostUsdMicros and execution.reportOnlyCostUsdMicros cannot be combined");
		}
	}

	if (!isRecord(value.acceptance)) {
		errors.push("acceptance must be an object");
	} else {
		rejectUnknownKeys(value.acceptance, ["commands", "requireCleanUnownedPaths", "timeoutSeconds", "continueOnFailure"], "acceptance", errors);
		requireStringArray(value.acceptance.commands, "acceptance.commands", errors);
		if (typeof value.acceptance.requireCleanUnownedPaths !== "boolean") {
			errors.push("acceptance.requireCleanUnownedPaths must be a boolean");
		}
		if (value.acceptance.timeoutSeconds !== undefined
			&& (!Number.isSafeInteger(value.acceptance.timeoutSeconds)
				|| Number(value.acceptance.timeoutSeconds) < 1
				|| Number(value.acceptance.timeoutSeconds) > MAX_ACCEPTANCE_TIMEOUT_SECONDS)) {
			errors.push(`acceptance.timeoutSeconds must be an integer between 1 and ${MAX_ACCEPTANCE_TIMEOUT_SECONDS}`);
		}
		if (value.acceptance.continueOnFailure !== undefined && typeof value.acceptance.continueOnFailure !== "boolean") {
			errors.push("acceptance.continueOnFailure must be a boolean");
		}
	}

	if (errors.length > 0) throw new Error(`invalid run specification:\n- ${errors.join("\n- ")}`);
	return immutableRunSpec(value as unknown as RunSpec);
}

export function requiredCapabilities(spec: RunSpec): CapabilityName[] {
	const required = new Set<CapabilityName>();
	required.add(`session.${spec.execution.session}` as CapabilityName);
	required.add("control.cancel");
	required.add("route.configured");
	if (spec.tier === "attested") required.add("sandbox.filesystem");
	if (spec.execution.agentProfile !== undefined) required.add("agent.identity");
	if (spec.execution.topology !== "solo") {
		required.add("agents.children");
		required.add("agents.receipts");
	}
	if (spec.execution.topology === "hierarchical") required.add("agents.hierarchical");
	if (spec.execution.writerPolicy === "managed-worktrees") required.add("worktree.native");
	if (spec.execution.network !== "configured") {
		required.add(`sandbox.network.${spec.execution.network}` as CapabilityName);
	}
	const usageBudgetRequested = spec.execution.maxProviderRequests !== undefined
		|| spec.execution.maxToolCalls !== undefined
		|| spec.execution.maxCostUsdMicros !== undefined
		|| spec.execution.maxChildren !== undefined;
	if (usageBudgetRequested) required.add("telemetry.usage");
	if (spec.execution.maxProviderRequests !== undefined) required.add("limits.providerRequests");
	if (spec.execution.maxToolCalls !== undefined) required.add("limits.toolCalls");
	if (spec.execution.maxCostUsdMicros !== undefined) required.add("limits.spend");
	if (spec.execution.maxChildren !== undefined) required.add("limits.children");
	return [...required];
}

export function capabilityIssues(spec: RunSpec, doctor: HarnessCapabilities): PreflightIssue[] {
	const issues: PreflightIssue[] = [];
	if (!doctor.available) {
		issues.push({ severity: "error", code: "HARNESS_UNAVAILABLE", message: `${doctor.harness} is unavailable` });
	}
	if (doctor.compatibility === "blocked") {
		issues.push({ severity: "error", code: "ADAPTER_BLOCKED", message: `${doctor.adapterId} is blocked` });
	}
	if (doctor.compatibility === "compatible"
		&& (doctor.probe?.artifact !== "verified" || doctor.probe.executionQualified !== true)) {
		issues.push({
			severity: "error",
			code: "EXECUTION_QUALIFICATION_REQUIRED",
			message: `${doctor.adapterId} compatibility cannot authorize dispatch without a reviewed artifact and execution-qualified probe`,
		});
	}
	if (doctor.probe && (doctor.probe.artifact !== "verified" || doctor.probe.executionQualified !== true)) {
		issues.push({
			severity: "error",
			code: "PROBE_NOT_EXECUTION_QUALIFIED",
			message: `${doctor.adapterId} probe is not execution-qualified against a verified artifact`,
		});
	}
	for (const capability of requiredCapabilities(spec)) {
		if (doctor.capabilities[capability] !== true) {
			issues.push({
				severity: "error",
				code: "CAPABILITY_UNAVAILABLE",
				message: `${doctor.adapterId} cannot enforce ${capability}`,
			});
		}
	}
	return issues;
}
