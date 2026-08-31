import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { AcpAdapter } from "@ox-driver/adapter-acp";
import { DshAdapter } from "@ox-driver/adapter-dsh";
import { OmpAdapter } from "@ox-driver/adapter-omp";
import { OpenCodeAdapter } from "@ox-driver/adapter-opencode";
import { PiAdapter } from "@ox-driver/adapter-pi";
import {
	AdapterRegistry,
	loadRouteProfile,
	OxController,
	RunStore,
	officialTargetAdapterBindings,
	type ResolvedRouteProfile,
	type RunSpec,
} from "@ox-driver/core";
import type { HandoffRuntime } from "./handoff.js";

function dataHome(): string {
	const configured = process.env.XDG_DATA_HOME?.trim();
	if (configured) {
		if (!isAbsolute(configured)) throw new Error("XDG_DATA_HOME must be an absolute path");
		return configured;
	}
	return join(homedir(), ".local", "share");
}

export function routeProfileDirectories(): string[] {
	const explicit = process.env.OX_DRIVER_ROUTE_PROFILE_DIR?.trim();
	if (explicit && !isAbsolute(explicit)) throw new Error("OX_DRIVER_ROUTE_PROFILE_DIR must be an absolute path");
	const configuredHome = process.env.XDG_CONFIG_HOME?.trim();
	if (configuredHome && !isAbsolute(configuredHome)) throw new Error("XDG_CONFIG_HOME must be an absolute path");
	const userDirectory = explicit || join(configuredHome || join(homedir(), ".config"), "ox-driver", "routes");
	const bundledDirectory = fileURLToPath(new URL("../../../profiles/routes/", import.meta.url));
	return userDirectory === bundledDirectory ? [userDirectory] : [userDirectory, bundledDirectory];
}

export async function resolveRouteProfile(
	id: string,
	options: { expectedHarness: string; expectedTier?: "trusted-host" | "attested" },
): Promise<ResolvedRouteProfile> {
	for (const directory of routeProfileDirectories()) {
		try {
			await access(join(directory, `${id}.json`));
		} catch {
			continue;
		}
		return loadRouteProfile(directory, id, options);
	}
	throw new Error(`route profile ${id} was not found in: ${routeProfileDirectories().join(", ")}`);
}

export async function defaultOpenCodeProfile(): Promise<ResolvedRouteProfile> {
	const selected = process.env.OX_DRIVER_OPENCODE_PROFILE?.trim();
	if (selected) return resolveRouteProfile(selected, { expectedHarness: "opencode", expectedTier: "trusted-host" });
	for (const candidate of ["opencode-default", "opencode-ambient"]) {
		try {
			return await resolveRouteProfile(candidate, { expectedHarness: "opencode", expectedTier: "trusted-host" });
		} catch (error) {
			if (!String(error).includes("was not found in:")) throw error;
		}
	}
	throw new Error("no default OpenCode route profile is installed");
}

async function defaultHarnessProfile(
	harness: "pi" | "omp",
	candidates: readonly string[],
): Promise<ResolvedRouteProfile | undefined> {
	const selected = process.env[`OX_DRIVER_${harness.toUpperCase()}_PROFILE`]?.trim();
	for (const candidate of selected ? [selected] : candidates) {
		try {
			return await resolveRouteProfile(candidate, { expectedHarness: harness });
		} catch (error) {
			if (!String(error).includes("was not found in:")) throw error;
		}
	}
	return undefined;
}

async function requestedHarnessProfile(
	id: string,
	harness: "pi" | "omp",
	tier: "trusted-host" | "attested",
	legacyEnvironmentProfile?: string,
): Promise<ResolvedRouteProfile | undefined> {
	try {
		return await resolveRouteProfile(id, { expectedHarness: harness, expectedTier: tier });
	} catch (error) {
		if (id === legacyEnvironmentProfile && String(error).includes("was not found in:")) return undefined;
		throw error;
	}
}

function ompOptionsFromProfile(profile: Readonly<ResolvedRouteProfile>): ConstructorParameters<typeof OmpAdapter>[0] {
	if (profile.harness !== "omp" || profile.tier !== "attested" || profile.route.source !== "explicit") {
		throw new Error("OMP requires an attested route profile with an explicit provider, model, and reasoning route");
	}
	const runtime = profile.runtime;
	if (!runtime?.agentDirectory || !runtime.homeDirectory) {
		throw new Error("OMP route profile runtime requires agentDirectory and homeDirectory");
	}
	const environment: Record<string, string> = {};
	for (const name of runtime.environmentNames ?? []) {
		const value = process.env[name];
		if (value !== undefined) environment[name] = value;
	}
	return {
		launcher: profile.launcher.command,
		profileId: profile.id,
		routeProfileSha256: profile.sha256,
		...(runtime.expectedVersion ? { expectedVersion: runtime.expectedVersion } : {}),
		...(runtime.expectedSha256 ? { expectedSha256: runtime.expectedSha256 } : {}),
		route: {
			provider: profile.route.provider,
			model: profile.route.model,
			reasoning: profile.route.reasoning,
			agentDirectory: runtime.agentDirectory,
			homeDirectory: runtime.homeDirectory,
			environment,
		},
	};
}

export interface ControllerFactoryOptions {
	// Opt the registered Pi adapter into trusted-host read-only dispatch. This
	// is a host-level trust decision, so the handoff path passes it explicitly
	// instead of inheriting it from the ambient
	// environment. Every adapter qualification check is unchanged.
	piTrustedHostDispatch?: boolean;
}

export async function createController(
	spec?: RunSpec,
	options: ControllerFactoryOptions = {},
): Promise<{ controller: OxController; piAdapter: PiAdapter }> {
	const registry = new AdapterRegistry({ approvedAdapters: officialTargetAdapterBindings });
	const piProfile = spec?.harness === "pi" && spec.routeProfile
		? await requestedHarnessProfile(spec.routeProfile, "pi", spec.tier)
		: await defaultHarnessProfile("pi", ["pi-default", "pi-protected-inherited"]);
	const piAdapter = new PiAdapter({
		...(piProfile ? { profile: piProfile } : {}),
		...(options.piTrustedHostDispatch || piProfile?.runtime?.mode === "direct" ? { enableTrustedHostDispatch: true } : {}),
	});
	registry.register(piAdapter);
	const ompProfile = spec?.harness === "omp" && spec.routeProfile
		? await requestedHarnessProfile(spec.routeProfile, "omp", spec.tier, "omp-explicit-isolated")
		: await defaultHarnessProfile("omp", ["omp-default", "omp-explicit-isolated"]);
	registry.register(new OmpAdapter(ompProfile ? ompOptionsFromProfile(ompProfile) : {}));
	registry.register(new AcpAdapter());
	const dshRoot = join(dataHome(), "ox-driver", "harnesses", "dsh", "current");
	registry.register(new DshAdapter({
		root: dshRoot,
		...(process.env.OX_DRIVER_DSH_LAUNCHER?.trim() ? { launcher: process.env.OX_DRIVER_DSH_LAUNCHER.trim() } : {}),
	}));
	if (spec?.harness === "opencode") {
		if (!spec.routeProfile) throw new Error("OpenCode RunSpecs require routeProfile");
		const openCodeProfile = await resolveRouteProfile(spec.routeProfile, { expectedHarness: "opencode", expectedTier: spec.tier });
		registry.register(new OpenCodeAdapter({
			profile: openCodeProfile,
			...(process.env.OX_DRIVER_OPENCODE_LAUNCHER?.trim() ? { launcher: process.env.OX_DRIVER_OPENCODE_LAUNCHER.trim() } : {}),
		}));
	} else if (spec === undefined) {
		registry.register(new OpenCodeAdapter({
			profile: await defaultOpenCodeProfile(),
			...(process.env.OX_DRIVER_OPENCODE_LAUNCHER?.trim() ? { launcher: process.env.OX_DRIVER_OPENCODE_LAUNCHER.trim() } : {}),
		}));
	}
	const stateRoot = process.env.OX_DRIVER_STATE_DIR?.trim();
	return {
		controller: new OxController(registry, stateRoot ? new RunStore(stateRoot) : new RunStore()),
		piAdapter,
	};
}

export function createStateController(): OxController {
	const stateRoot = process.env.OX_DRIVER_STATE_DIR?.trim();
	return new OxController(new AdapterRegistry(), stateRoot ? new RunStore(stateRoot) : new RunStore());
}

// The CLI is the trusted host for its sequential handoff reviewer lane, so the
// Pi adapter receives its trusted-host opt-in here explicitly. Callers do not
// need to export a separate dispatch flag.
export function handoffRuntime(): HandoffRuntime {
	return {
		resolveBuilderProfile: async (requested) => {
			const profile = requested
				? await resolveRouteProfile(requested, { expectedHarness: "opencode", expectedTier: "trusted-host" })
				: await defaultOpenCodeProfile();
			if (profile.route.source !== "explicit") {
				throw new Error(`OpenCode handoff builder profile ${profile.id} does not provide an explicit route`);
			}
			return {
				id: profile.id,
				configuredRoute: {
					provider: profile.route.provider,
					model: profile.route.model,
					reasoning: profile.route.reasoning,
				},
			};
		},
		createController: async (spec) => (await createController(spec, { piTrustedHostDispatch: true })).controller,
	};
}
