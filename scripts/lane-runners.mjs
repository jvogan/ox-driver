import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFINITIONS = Object.freeze({
	opencode: Object.freeze({
		harness: "opencode",
		defaultRunner: resolve(ROOT, "scripts", "ox_opencode.mjs"),
		runnerEnvironment: "OX_DRIVER_OPENCODE_LANE_RUNNER",
		legacyRunnerEnvironment: "OX_DRIVER_HERD_RUNNER",
		defaultRoute: "opencode-default",
		profileEnvironment: "OX_DRIVER_OPENCODE_PROFILE",
		writerPolicies: Object.freeze(["one-writer"]),
	}),
	pi: Object.freeze({
		harness: "pi",
		defaultRunner: resolve(ROOT, "scripts", "ox_pi.mjs"),
		runnerEnvironment: "OX_DRIVER_PI_LANE_RUNNER",
		defaultRoute: "pi-default",
		profileEnvironment: "OX_DRIVER_PI_PROFILE",
		writerPolicies: Object.freeze(["read-only", "one-writer"]),
	}),
	omp: Object.freeze({
		harness: "omp",
		defaultRunner: resolve(ROOT, "scripts", "ox_omp.mjs"),
		runnerEnvironment: "OX_DRIVER_OMP_LANE_RUNNER",
		defaultRoute: "omp-default",
		profileEnvironment: "OX_DRIVER_OMP_PROFILE",
		writerPolicies: Object.freeze(["read-only"]),
	}),
});

export function laneRunnerDefinition(harness) {
	const definition = DEFINITIONS[harness];
	if (!definition) throw new Error(`no Ox lane runner is registered for harness ${harness}`);
	return definition;
}

export function configuredLaneRunner(harness, environment = process.env) {
	const definition = laneRunnerDefinition(harness);
	const explicit = environment[definition.runnerEnvironment]?.trim();
	const legacy = definition.legacyRunnerEnvironment
		? environment[definition.legacyRunnerEnvironment]?.trim()
		: undefined;
	const selected = explicit || legacy || definition.defaultRunner;
	if (!isAbsolute(selected)) throw new Error(`${explicit ? definition.runnerEnvironment : definition.legacyRunnerEnvironment ?? definition.runnerEnvironment} must be an absolute path`);
	return {
		...definition,
		path: selected,
		source: explicit || legacy ? "environment-override" : "bundled",
		route: environment[definition.profileEnvironment]?.trim() || definition.defaultRoute,
	};
}

export function configuredLaneRunners(harnesses, environment = process.env) {
	return [...new Set(harnesses)].map((harness) => configuredLaneRunner(harness, environment));
}
