#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { OpenCodeAdapter } from "@ox-driver/adapter-opencode";
import {
	AdapterRegistry,
	loadRouteProfile,
	OxController,
	RunStore,
	type ResolvedRouteProfile,
	type RunSpec,
	validateRunSpec,
} from "@ox-driver/core";
import { runTask } from "./task.js";

const usage = `Usage:
  ox-driver validate <run-spec.json>
  ox-driver doctor [opencode|--all]
  ox-driver preflight <run-spec.json>
  ox-driver run <run-spec.json>
  ox-driver task <source> <objective...> [--ref revision] [--owned path] [--exclude path]
                 [--check command|--no-check] [--route id] [--profile-dir absolute-dir]
                 [--agent profile] [--child-agent profile] [--timeout seconds] [--cost-ceiling dollars]
  ox-driver inspect <run-id>
  ox-driver tail <run-id> [--events N]
  ox-driver cancel <run-id>
  ox-driver recover <run-id>

Environment:
  OX_DRIVER_STATE_DIR           Override the private run-state directory.
  OX_DRIVER_ROUTE_PROFILE_DIR   Search this absolute route directory first.
  OX_DRIVER_OPENCODE_PROFILE    Select the default OpenCode profile.
  OX_DRIVER_OPENCODE_LAUNCHER   Override the selected profile launcher.
  OX_DRIVER_REQUESTED_RUN_ID    Preassign a canonical UUID for supervision.`;

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function print(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function routeProfileDirectories(): string[] {
	const explicit = process.env.OX_DRIVER_ROUTE_PROFILE_DIR?.trim();
	if (explicit && !isAbsolute(explicit)) throw new Error("OX_DRIVER_ROUTE_PROFILE_DIR must be an absolute path");
	const configuredHome = process.env.XDG_CONFIG_HOME?.trim();
	if (configuredHome && !isAbsolute(configuredHome)) throw new Error("XDG_CONFIG_HOME must be an absolute path");
	const userDirectory = explicit || join(configuredHome || join(homedir(), ".config"), "ox-driver", "routes");
	const bundledDirectory = fileURLToPath(new URL("../../../profiles/routes/", import.meta.url));
	return userDirectory === bundledDirectory ? [userDirectory] : [userDirectory, bundledDirectory];
}

async function resolveRouteProfile(id: string, explicitDirectory?: string): Promise<ResolvedRouteProfile> {
	const directories = explicitDirectory ? [explicitDirectory, ...routeProfileDirectories().filter((item) => item !== explicitDirectory)] : routeProfileDirectories();
	for (const directory of directories) {
		try {
			await access(join(directory, `${id}.json`));
		} catch {
			continue;
		}
		return loadRouteProfile(directory, id, { expectedHarness: "opencode", expectedTier: "trusted-host" });
	}
	throw new Error(`route profile ${id} was not found in: ${directories.join(", ")}`);
}

async function defaultProfile(explicitDirectory?: string): Promise<ResolvedRouteProfile> {
	const selected = process.env.OX_DRIVER_OPENCODE_PROFILE?.trim();
	if (selected) return resolveRouteProfile(selected, explicitDirectory);
	for (const candidate of ["opencode-default", "opencode-ambient"]) {
		try {
			return await resolveRouteProfile(candidate, explicitDirectory);
		} catch (error) {
			if (!String(error).includes("was not found in:")) throw error;
		}
	}
	throw new Error("no default OpenCode route profile is installed");
}

function requireDispatchRoute(profile: ResolvedRouteProfile): ResolvedRouteProfile {
	if (profile.route.source !== "explicit") {
		throw new Error([
			`route profile ${profile.id} declares launcher-default routing, which dispatch rejects before any provider call.`,
			"Create an explicit dispatch profile first:",
			"  node scripts/ox_route.mjs init-opencode --launcher opencode --provider PROVIDER --model MODEL --reasoning EFFORT",
			"or select an existing explicit profile with --route ID.",
		].join("\n"));
	}
	return profile;
}

function requireOpenCodeSpec(value: unknown): RunSpec {
	const spec = validateRunSpec(value);
	if (spec.harness !== "opencode") throw new Error("the public CLI accepts OpenCode RunSpecs only");
	if (!spec.routeProfile) throw new Error("OpenCode RunSpecs require routeProfile");
	return spec;
}

async function createController(spec?: RunSpec, explicitDirectory?: string): Promise<OxController> {
	const profile = spec ? await resolveRouteProfile(spec.routeProfile as string, explicitDirectory) : await defaultProfile(explicitDirectory);
	const registry = new AdapterRegistry({
		approvedAdapters: [{ adapterId: "opencode-v2", harness: "opencode" }],
	});
	registry.register(new OpenCodeAdapter({
		profile,
		...(process.env.OX_DRIVER_OPENCODE_LAUNCHER?.trim()
			? { launcher: process.env.OX_DRIVER_OPENCODE_LAUNCHER.trim() }
			: {}),
	}));
	const stateRoot = process.env.OX_DRIVER_STATE_DIR?.trim();
	return new OxController(registry, stateRoot ? new RunStore(stateRoot) : new RunStore());
}

function createStateController(): OxController {
	const stateRoot = process.env.OX_DRIVER_STATE_DIR?.trim();
	return new OxController(new AdapterRegistry(), stateRoot ? new RunStore(stateRoot) : new RunStore());
}

function requestedRunId(): string {
	const requested = process.env.OX_DRIVER_REQUESTED_RUN_ID?.trim();
	if (!requested) return randomUUID();
	if (!CANONICAL_UUID.test(requested)) throw new Error("OX_DRIVER_REQUESTED_RUN_ID must be a canonical UUID");
	return requested;
}

async function main(argv: string[]): Promise<number> {
	if (argv[0] === "task") {
		if (["help", "--help", "-h"].includes(argv[1] ?? "")) {
			process.stdout.write(`${usage.split("\n").filter((line) => line.includes("ox-driver task") || line.startsWith("                 ")).join("\n")}\n`);
			return 0;
		}
		const result = await runTask(argv.slice(1), {
			resolveProfile: async (requested, directory) => requireDispatchRoute(
				requested ? await resolveRouteProfile(requested, directory) : await defaultProfile(directory),
			),
			createController,
		});
		print(result.receipt);
		return result.exitCode;
	}
	if (argv[0] === "tail") {
		const runId = argv[1];
		if (!runId || runId.startsWith("--")) throw new Error("usage: ox-driver tail RUN_ID [--events N]");
		let maxEvents = 20;
		for (let index = 2; index < argv.length; index += 1) {
			if (argv[index] === "--events") {
				maxEvents = Number(argv[++index]);
				if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 500) {
					throw new Error("--events must be an integer from 1 to 500");
				}
			} else throw new Error(`unknown tail option: ${argv[index]}`);
		}
		const stateRoot = process.env.OX_DRIVER_STATE_DIR?.trim();
		const store = stateRoot ? new RunStore(stateRoot) : new RunStore();
		const status = await store.readStatus(runId);
		// A run in preflight has no event log yet; that is an empty tail, not an error.
		const recent = await store.readRecentEvents(runId, { maxEvents }).catch((error: NodeJS.ErrnoException) => {
			if (error?.code !== "ENOENT") throw error;
			return { events: [], eventsSkipped: 0, tailOnly: false };
		});
		const budget = await readFile(join(store.runDirectory(runId), "budget-ledger.json"), "utf8")
			.then((text) => JSON.parse(text) as unknown, () => undefined);
		print({
			runId,
			status: status.status,
			updatedAt: status.updatedAt,
			...(budget !== undefined ? { budget } : {}),
			events: recent.events,
			eventsSkipped: recent.eventsSkipped,
			tailOnly: recent.tailOnly,
		});
		return 0;
	}
	const [command, argument, extra] = argv;
	if (!command || command === "help" || command === "--help" || command === "-h") {
		process.stdout.write(`${usage}\n`);
		return 0;
	}
	if (extra !== undefined) throw new Error(`unexpected argument: ${extra}`);
	if (command === "validate") {
		if (!argument) throw new Error("validate requires a run-spec JSON path");
		print({ valid: true, spec: requireOpenCodeSpec(await readJson(argument)) });
		return 0;
	}
	switch (command) {
		case "doctor": {
			if (argument && argument !== "opencode" && argument !== "--all") throw new Error("the public CLI doctors OpenCode only");
			const controller = await createController();
			const reports = await controller.doctor(argument === "--all" ? undefined : "opencode");
			print(reports);
			// A blocked controller must fail the readiness gate, not just describe itself.
			return reports.every((report) => report.available && report.compatibility === "verified") ? 0 : 2;
		}
		case "preflight": {
			if (!argument) throw new Error("preflight requires a run-spec JSON path");
			const spec = requireOpenCodeSpec(await readJson(argument));
			const result = await (await createController(spec)).preflight(spec);
			print(result);
			return result.ok ? 0 : 2;
		}
		case "run": {
			if (!argument) throw new Error("run requires a run-spec JSON path");
			const spec = requireOpenCodeSpec(await readJson(argument));
			const runId = requestedRunId();
			process.stderr.write(`OX_DRIVER_RUN_ID=${runId}\n`);
			const receipt = await (await createController(spec)).run(spec, { runId });
			print(receipt);
			return receipt.status === "completed" ? 0 : 1;
		}
		case "inspect": {
			if (!argument) throw new Error("inspect requires a run id");
			print(await createStateController().inspect(argument));
			return 0;
		}
		case "cancel": {
			if (!argument) throw new Error("cancel requires a run id");
			const result = await createStateController().cancel(argument);
			if (!result) throw new Error(`run ${argument} was not found`);
			print({ runId: argument, cancellationRequested: true });
			return 0;
		}
		case "recover": {
			if (!argument) throw new Error("recover requires a run id");
			const result = await createStateController().recover(argument);
			print({ runId: argument, ...result });
			return result.released ? 0 : 2;
		}
		default:
			throw new Error(`unknown command: ${command}\n\n${usage}`);
	}
}

main(process.argv.slice(2)).then(
	(code) => { process.exitCode = code; },
	(error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	},
);
