#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { validateRunSpec } from "@ox-driver/core";
import { runHandoff } from "./handoff.js";
import { runOmpReview } from "./omp-review.js";
import { createController, createStateController, handoffRuntime } from "./runtime.js";

const usage = `Usage:
  ox-driver validate <run-spec.json>
  ox-driver doctor [harness|--all]
  ox-driver preflight <run-spec.json>
  ox-driver run <run-spec.json>
  ox-driver omp-review <repository> <objective...> [--route PROFILE] [--check command|--no-check] [--timeout seconds]
  ox-driver handoff <source-repo> <objective> --owned <path> [--builder-route PROFILE] [--builder-agent PROFILE] [--builder-child-agent PROFILE] [--reviewer omp|pi] [--reviewer-route PROFILE] [--check <command>|--no-check] [options]
  ox-driver handoff resume <checkpoint-id>
  ox-driver inspect <run-id>
  ox-driver cancel <run-id>
  ox-driver recover <run-id>

From a source checkout, run npm run build, then node packages/cli/dist/main.js <command>.

Environment:
  OX_DRIVER_STATE_DIR     Override the run-state directory.
  OX_DRIVER_PI_PROFILE    Select the default Pi route profile.
  OX_DRIVER_OMP_PROFILE   Select the default OMP route profile.
  OX_DRIVER_PI_LAUNCHER   Select the attested Pi launcher.
  OX_DRIVER_PI_READ_ONLY=1
                          Opt in to Pi read-only dispatch, off by default.
  OX_DRIVER_PI_LAUNCHER_SHA256, OX_DRIVER_PI_ENFORCEMENT_SHA256
                          Pin the exact Pi launcher and enforcement digests.
                          Set both with OX_DRIVER_PI_READ_ONLY=1 to select the
                          exact-pinned, ephemeral, solo Pi read-only lane. Its
                          generated read policy and macOS Seatbelt profile
                          confine the staged process. This does not qualify
                          writer or team modes.
  OX_DRIVER_OMP_LAUNCHER  Select the pinned OMP binary.
  OX_DRIVER_OMP_PROVIDER, OX_DRIVER_OMP_MODEL, OX_DRIVER_OMP_REASONING
  OX_DRIVER_OMP_AGENT_DIR, OX_DRIVER_OMP_HOME
                          Configure an exact OMP route (dispatch still
                          requires containment bound to the admitted process).
  OX_DRIVER_ACP_LAUNCHER, OX_DRIVER_ACP_LAUNCHER_SHA256
  OX_DRIVER_ACP_PROFILE, OX_DRIVER_ACP_PROFILE_SHA256, OX_DRIVER_ACP_ARGS_JSON
                          Inspect an exact ACP v1 launcher and profile.
                          Dispatch remains quarantined.
  OX_DRIVER_DSH_LAUNCHER  Override the pinned DSH launcher.
  OX_DRIVER_ROUTE_PROFILE_DIR
                          Search this absolute directory for route profiles
                          before the bundled profiles directory.
  OX_DRIVER_OPENCODE_PROFILE
                          Default OpenCode route profile id for doctor and
                          helper commands. A RunSpec's routeProfile wins.
  OX_DRIVER_OPENCODE_LAUNCHER
                          Override the selected profile's launcher command.`;

function print(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function main(argv: string[]): Promise<number> {
	if (argv[0] === "omp-review") {
		const result = await runOmpReview(argv.slice(1), {
			createController: async (spec) => (await createController(spec)).controller,
		});
		print(result.receipt);
		return result.exitCode;
	}
	if (argv[0] === "handoff") {
		const result = await runHandoff(argv.slice(1), handoffRuntime());
		print(result.receipt);
		return result.exitCode;
	}
	const [command, argument, extra] = argv;

	if (!command || command === "help" || command === "--help" || command === "-h") {
		process.stdout.write(`${usage}\n`);
		return 0;
	}
	if (extra !== undefined) throw new Error(`unexpected argument: ${extra}`);
	if (command === "validate") {
		if (!argument) throw new Error("validate requires a run-spec JSON path");
		print({ valid: true, spec: validateRunSpec(await readJson(argument)) });
		return 0;
	}

	switch (command) {
		case "doctor": {
			const { controller } = await createController();
			print(await controller.doctor(argument === "--all" ? undefined : argument ?? "opencode"));
			return 0;
		}
		case "preflight": {
			if (!argument) throw new Error("preflight requires a run-spec JSON path");
			const spec = validateRunSpec(await readJson(argument));
			const { controller } = await createController(spec);
			const result = await controller.preflight(spec);
			print(result);
			return result.ok ? 0 : 2;
		}
		case "run": {
			if (!argument) throw new Error("run requires a run-spec JSON path");
			const spec = validateRunSpec(await readJson(argument));
			const { controller, piAdapter } = await createController(spec);
			// Honor a preassigned run id and announce it before dispatch so a
			// supervisor can cancel or recover this run.
			const requested = process.env.OX_DRIVER_REQUESTED_RUN_ID?.trim();
			if (requested && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requested)) {
				throw new Error("OX_DRIVER_REQUESTED_RUN_ID must be a canonical UUID");
			}
			const runId = requested || randomUUID();
			process.stderr.write(`OX_DRIVER_RUN_ID=${runId}\n`);
			const receipt = await controller.run(spec, { runId });
			if (receipt.harness !== "pi" || receipt.status !== "completed") {
				print(receipt);
				return receipt.status === "completed" ? 0 : 1;
			}
			try {
				const usefulnessEvidence = await piAdapter.finalizeUsefulnessEvidence(
					receipt,
					controller.store.runDirectory(receipt.runId),
				);
				print(usefulnessEvidence ? { receipt, usefulnessEvidence } : receipt);
				return 0;
			} catch {
				print({
					receipt,
					qualificationFailure: {
						code: "PI_USEFULNESS_EVIDENCE_FINALIZATION_FAILED",
						message: "The completed Pi receipt was retained, but its optional usefulness evidence did not finalize.",
					},
				});
				return 1;
			}
		}
		case "inspect": {
			if (!argument) throw new Error("inspect requires a run id");
			const controller = createStateController();
			print(await controller.inspect(argument));
			return 0;
		}
		case "cancel": {
			if (!argument) throw new Error("cancel requires a run id");
			const controller = createStateController();
			const cancelled = await controller.cancel(argument);
			if (!cancelled) throw new Error(`run ${argument} has no recoverable process state`);
			print({ runId: argument, cancellationRequested: true });
			return 0;
		}
		case "recover": {
			if (!argument) throw new Error("recover requires a run id");
			const controller = createStateController();
			const result = await controller.recover(argument);
			print({ runId: argument, ...result });
			return result.released ? 0 : 2;
		}
		default:
			throw new Error(`unknown command: ${command}\n\n${usage}`);
	}
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	},
);
