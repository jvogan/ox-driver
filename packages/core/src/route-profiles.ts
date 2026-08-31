import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { ConfiguredRoute } from "./types.js";

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_PROFILE_BYTES = 64 * 1024;

export type RouteProfileStatus = "active" | "candidate" | "quarantined" | "retired";

export interface RouteProfile {
	version: 1;
	id: string;
	status: RouteProfileStatus;
	harness: string;
	tier: "trusted-host" | "attested";
	launcher: {
		command: string;
		versionArgs: string[];
		doctor?: { args: string[]; requiredText?: string[] };
	};
	route: { source: "launcher" } | ({ source: "explicit" } & ConfiguredRoute);
	agent?: { defaultProfile?: string; allowedProfiles?: string[] };
	defaults?: { timeoutSeconds?: number; reportOnlyCostUsdMicros?: number };
	runtime?: {
		mode?: "direct" | "guarded";
		agentDirectory?: string;
		homeDirectory?: string;
		environmentNames?: string[];
		expectedVersion?: string;
		expectedSha256?: string;
	};
	pricingPolicy: "report-only" | "from-launcher" | "zero-only";
	credentialPolicy?: string;
	notice?: string;
}

export interface ResolvedRouteProfile extends RouteProfile {
	readonly filePath: string;
	readonly sha256: string;
}

export interface LoadRouteProfileOptions {
	expectedHarness?: string;
	expectedTier?: "trusted-host" | "attested";
	requireActive?: boolean;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unexpected.length > 0) throw new Error(`${label} has unsupported fields: ${unexpected.join(", ")}`);
}

function string(value: unknown, label: string, maximum = 4096): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
		throw new Error(`${label} must be a non-empty bounded string`);
	}
	return value;
}

function strings(value: unknown, label: string, maximumItems: number, allowEmpty = true): string[] {
	if (!Array.isArray(value) || value.length > maximumItems || (!allowEmpty && value.length === 0)) {
		throw new Error(`${label} must be a bounded string array`);
	}
	const result = value.map((item, index) => string(item, `${label}[${index}]`, 4096));
	if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicate values`);
	return result;
}

function positiveInteger(value: unknown, label: string, maximum: number, allowZero = false): number {
	if (!Number.isSafeInteger(value) || (allowZero ? Number(value) < 0 : Number(value) < 1) || Number(value) > maximum) {
		throw new Error(`${label} must be ${allowZero ? "a non-negative" : "a positive"} bounded integer`);
	}
	return Number(value);
}

function optionalObject(value: unknown, label: string): Record<string, unknown> | undefined {
	return value === undefined ? undefined : record(value, label);
}

export function validateRouteProfile(value: unknown): RouteProfile {
	const root = record(value, "route profile");
	keys(root, ["version", "id", "status", "harness", "tier", "launcher", "route", "agent", "defaults", "runtime", "pricingPolicy", "credentialPolicy", "notice"], "route profile");
	if (root.version !== 1) throw new Error("route profile version must be 1");
	const id = string(root.id, "route profile id", 128);
	const harness = string(root.harness, "route profile harness", 128);
	if (!PROFILE_ID.test(id) || !PROFILE_ID.test(harness)) throw new Error("route profile id and harness must use canonical lowercase identifiers");
	if (!["active", "candidate", "quarantined", "retired"].includes(String(root.status))) throw new Error("route profile status is unsupported");
	if (root.tier !== "trusted-host" && root.tier !== "attested") throw new Error("route profile tier is unsupported");

	const launcherRaw = record(root.launcher, "route profile launcher");
	keys(launcherRaw, ["command", "versionArgs", "doctor"], "route profile launcher");
	const launcher: RouteProfile["launcher"] = {
		command: string(launcherRaw.command, "route profile launcher command"),
		versionArgs: strings(launcherRaw.versionArgs, "route profile launcher versionArgs", 16),
	};
	const doctorRaw = optionalObject(launcherRaw.doctor, "route profile launcher doctor");
	if (doctorRaw) {
		keys(doctorRaw, ["args", "requiredText"], "route profile launcher doctor");
		launcher.doctor = {
			args: strings(doctorRaw.args, "route profile launcher doctor args", 16),
			...(doctorRaw.requiredText === undefined ? {} : { requiredText: strings(doctorRaw.requiredText, "route profile launcher doctor requiredText", 16, false) }),
		};
	}

	const routeRaw = record(root.route, "route profile route");
	let route: RouteProfile["route"];
	if (routeRaw.source === "launcher") {
		keys(routeRaw, ["source"], "launcher-derived route");
		route = { source: "launcher" };
	} else if (routeRaw.source === "explicit") {
		keys(routeRaw, ["source", "provider", "model", "reasoning"], "explicit route");
		route = {
			source: "explicit",
			provider: string(routeRaw.provider, "route provider", 256),
			model: string(routeRaw.model, "route model", 512),
			reasoning: string(routeRaw.reasoning, "route reasoning", 128),
		};
	} else throw new Error("route profile route source must be launcher or explicit");

	const agentRaw = optionalObject(root.agent, "route profile agent");
	let agent: RouteProfile["agent"];
	if (agentRaw) {
		keys(agentRaw, ["defaultProfile", "allowedProfiles"], "route profile agent");
		agent = {
			...(agentRaw.defaultProfile === undefined ? {} : { defaultProfile: string(agentRaw.defaultProfile, "route profile default agent", 256) }),
			...(agentRaw.allowedProfiles === undefined ? {} : { allowedProfiles: strings(agentRaw.allowedProfiles, "route profile allowed agents", 128, false) }),
		};
		if (agent.defaultProfile && agent.allowedProfiles && !agent.allowedProfiles.includes(agent.defaultProfile)) {
			throw new Error("route profile default agent must appear in allowedProfiles");
		}
	}

	const defaultsRaw = optionalObject(root.defaults, "route profile defaults");
	let defaults: RouteProfile["defaults"];
	if (defaultsRaw) {
		keys(defaultsRaw, ["timeoutSeconds", "reportOnlyCostUsdMicros"], "route profile defaults");
		defaults = {
			...(defaultsRaw.timeoutSeconds === undefined ? {} : { timeoutSeconds: positiveInteger(defaultsRaw.timeoutSeconds, "route profile timeoutSeconds", 86_400) }),
			...(defaultsRaw.reportOnlyCostUsdMicros === undefined ? {} : { reportOnlyCostUsdMicros: positiveInteger(defaultsRaw.reportOnlyCostUsdMicros, "route profile reportOnlyCostUsdMicros", Number.MAX_SAFE_INTEGER, true) }),
		};
	}

	const runtimeRaw = optionalObject(root.runtime, "route profile runtime");
	let runtime: RouteProfile["runtime"];
	if (runtimeRaw) {
		keys(runtimeRaw, ["mode", "agentDirectory", "homeDirectory", "environmentNames", "expectedVersion", "expectedSha256"], "route profile runtime");
		if (runtimeRaw.mode !== undefined && runtimeRaw.mode !== "direct" && runtimeRaw.mode !== "guarded") {
			throw new Error("route profile runtime mode must be direct or guarded");
		}
		const agentDirectory = runtimeRaw.agentDirectory === undefined ? undefined : string(runtimeRaw.agentDirectory, "route profile runtime agentDirectory");
		const homeDirectory = runtimeRaw.homeDirectory === undefined ? undefined : string(runtimeRaw.homeDirectory, "route profile runtime homeDirectory");
		if (agentDirectory !== undefined && !isAbsolute(agentDirectory)) throw new Error("route profile runtime agentDirectory must be absolute");
		if (homeDirectory !== undefined && !isAbsolute(homeDirectory)) throw new Error("route profile runtime homeDirectory must be absolute");
		const environmentNames = runtimeRaw.environmentNames === undefined
			? undefined
			: strings(runtimeRaw.environmentNames, "route profile runtime environmentNames", 64);
		if (environmentNames?.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name))) {
			throw new Error("route profile runtime environmentNames must use uppercase environment-variable names");
		}
		const expectedSha256 = runtimeRaw.expectedSha256 === undefined ? undefined : string(runtimeRaw.expectedSha256, "route profile runtime expectedSha256", 64);
		if (expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(expectedSha256)) {
			throw new Error("route profile runtime expectedSha256 must be a lowercase SHA-256 digest");
		}
		runtime = {
			...(runtimeRaw.mode === undefined ? {} : { mode: runtimeRaw.mode as "direct" | "guarded" }),
			...(agentDirectory === undefined ? {} : { agentDirectory }),
			...(homeDirectory === undefined ? {} : { homeDirectory }),
			...(environmentNames === undefined ? {} : { environmentNames }),
			...(runtimeRaw.expectedVersion === undefined ? {} : { expectedVersion: string(runtimeRaw.expectedVersion, "route profile runtime expectedVersion", 128) }),
			...(expectedSha256 === undefined ? {} : { expectedSha256 }),
		};
	}

	if (!["report-only", "from-launcher", "zero-only"].includes(String(root.pricingPolicy))) throw new Error("route profile pricingPolicy is unsupported");
	return {
		version: 1,
		id,
		status: root.status as RouteProfileStatus,
		harness,
		tier: root.tier,
		launcher,
		route,
		...(agent ? { agent } : {}),
		...(defaults ? { defaults } : {}),
		...(runtime ? { runtime } : {}),
		pricingPolicy: root.pricingPolicy as RouteProfile["pricingPolicy"],
		...(root.credentialPolicy === undefined ? {} : { credentialPolicy: string(root.credentialPolicy, "route profile credentialPolicy", 512) }),
		...(root.notice === undefined ? {} : { notice: string(root.notice, "route profile notice") }),
	};
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, item]) => [key, canonical(item)]));
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

export async function loadRouteProfile(directory: string, id: string, options: LoadRouteProfileOptions = {}): Promise<ResolvedRouteProfile> {
	if (!isAbsolute(directory)) throw new Error("route profile directory must be absolute");
	if (!PROFILE_ID.test(id)) throw new Error("route profile id is invalid");
	const root = await realpath(directory);
	const filePath = resolve(root, `${id}.json`);
	const inside = relative(root, filePath);
	if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error("route profile path escapes its directory");
	const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	let bytes: Buffer;
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.size < 2 || before.size > MAX_PROFILE_BYTES) throw new Error("route profile must be a bounded regular file");
		bytes = await handle.readFile();
		const after = await handle.stat();
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
			throw new Error("route profile changed while reading");
		}
	} finally {
		await handle.close();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (error) {
		throw new Error(`route profile is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const profile = validateRouteProfile(parsed);
	if (profile.id !== id) throw new Error(`route profile id ${profile.id} does not match requested id ${id}`);
	if ((options.requireActive ?? true) && profile.status !== "active") throw new Error(`route profile ${id} is ${profile.status}, not active`);
	if (options.expectedHarness && profile.harness !== options.expectedHarness) throw new Error(`route profile ${id} targets ${profile.harness}, not ${options.expectedHarness}`);
	if (options.expectedTier && profile.tier !== options.expectedTier) throw new Error(`route profile ${id} targets ${profile.tier}, not ${options.expectedTier}`);
	const sha256 = createHash("sha256").update(`${JSON.stringify(canonical(profile))}\n`).digest("hex");
	return deepFreeze({ ...profile, filePath, sha256 });
}
