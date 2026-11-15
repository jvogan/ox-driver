import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { OxController, ResolvedRouteProfile, RunSpec } from "@ox-driver/core";
import { preflightTask, runTask, type TaskRuntime } from "@ox-driver/opencode-cli/dist/task.js";

import { preflightHandoff, runHandoff, type HandoffRuntime } from "./handoff.js";
import { loadProjectPreset, type ProjectWorkPreset } from "./project-config.js";
import { createController, resolveRouteProfile } from "./runtime.js";

const execute = promisify(execFile);

export interface WorkRuntime {
	resolveProfile(id: string, harness: "opencode" | "pi" | "omp"): Promise<ResolvedRouteProfile>;
	createController(spec: RunSpec): Promise<OxController>;
	afterBuilderRunningCheckpoint?: NonNullable<HandoffRuntime["afterBuilderRunningCheckpoint"]>;
	afterBuilderCheckpoint?: NonNullable<HandoffRuntime["afterBuilderCheckpoint"]>;
	afterReviewerRunningCheckpoint?: NonNullable<HandoffRuntime["afterReviewerRunningCheckpoint"]>;
	afterReviewerCheckpoint?: NonNullable<HandoffRuntime["afterReviewerCheckpoint"]>;
}

export interface WorkRunResult {
	exitCode: number;
	receipt: Record<string, unknown>;
	preview?: Record<string, unknown>;
}

interface WorkOptions {
	repository: string;
	presetName?: string;
	objective: string;
	dryRun: boolean;
}

function parseWork(args: string[]): WorkOptions {
	let repository = process.cwd();
	let presetName: string | undefined;
	let dryRun = false;
	const positional: string[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index]!;
		if (argument === "--") {
			positional.push(...args.slice(index + 1));
			break;
		}
		if (!argument.startsWith("--")) {
			positional.push(argument);
			continue;
		}
		if (seen.has(argument)) throw new Error(`work option must not repeat: ${argument}`);
		seen.add(argument);
		if (argument === "--json") continue;
		if (argument === "--dry-run") { dryRun = true; continue; }
		if (argument !== "--repo" && argument !== "--preset") throw new Error(`unknown work option: ${argument}`);
		const value = args[++index];
		if (!value?.trim() || value.startsWith("--")) throw new Error(`${argument} requires a value`);
		if (argument === "--repo") repository = resolve(value);
		else presetName = value;
	}
	if (positional.length !== 1 || !positional[0]?.trim()) {
		throw new Error('work requires exactly one nonempty objective; quote objectives containing spaces');
	}
	return { repository, ...(presetName !== undefined ? { presetName } : {}), objective: positional[0], dryRun };
}

export function workRuntime(): WorkRuntime {
	return {
		resolveProfile: (id, harness) => resolveRouteProfile(id, {
			expectedHarness: harness,
			expectedTier: harness === "omp" ? "attested" : "trusted-host",
		}),
		createController: async (spec) => (await createController(spec, { piTrustedHostDispatch: true })).controller,
	};
}

function requireBuilder(profile: ResolvedRouteProfile, requested: string): ResolvedRouteProfile {
	if (profile.id !== requested || profile.harness !== "opencode" || profile.tier !== "trusted-host"
		|| profile.route.source !== "explicit") {
		throw new Error(`work requires the exact trusted-host OpenCode profile ${requested} with an explicit route; other writer harnesses are unavailable through work`);
	}
	return profile;
}

function runtimes(runtime: WorkRuntime): { task: TaskRuntime; handoff: HandoffRuntime } {
	const builder = async (requested: string | undefined): Promise<ResolvedRouteProfile> => {
		if (!requested) throw new Error("work requires a repository-selected builder route");
		return requireBuilder(await runtime.resolveProfile(requested, "opencode"), requested);
	};
	return {
		task: {
			resolveProfile: (requested) => builder(requested),
			createController: (spec) => runtime.createController(spec),
		},
		handoff: {
			...runtime,
			resolveBuilderProfile: async (requested) => {
				const profile = await builder(requested);
				if (profile.route.source !== "explicit") throw new Error("work builder requires an explicit route");
				return { id: profile.id, configuredRoute: {
					provider: profile.route.provider, model: profile.route.model, reasoning: profile.route.reasoning,
				} };
			},
		},
	};
}

function costArgument(micros: number): string {
	const dollars = String(micros / 1_000_000);
	if (Math.round(Number(dollars) * 1_000_000) !== micros) {
		throw new Error("work cannot preserve this reported-cost target through the workflow's dollar argument; select an exactly representable micro-dollar amount");
	}
	return dollars;
}

function workflowArgs(repository: string, objective: string, preset: ProjectWorkPreset): string[] {
	const review = preset.reviewer;
	return [
		...preset.ownedPaths.flatMap((path) => ["--owned", path]),
		...preset.excludedPaths.flatMap((path) => ["--exclude", path]),
		...(preset.checks.length ? preset.checks.flatMap((command) => ["--check", command]) : ["--no-check"]),
		review ? "--builder-route" : "--route", preset.route,
		...(preset.agent ? [review ? "--builder-agent" : "--agent", preset.agent] : []),
		...(preset.childAgents ?? []).flatMap((agent) => [review ? "--builder-child-agent" : "--child-agent", agent]),
		...(preset.timeoutSeconds !== undefined ? [review ? "--builder-timeout" : "--timeout", String(preset.timeoutSeconds)] : []),
		...(preset.reportOnlyCostUsdMicros !== undefined ? [review ? "--builder-cost-ceiling" : "--cost-ceiling", costArgument(preset.reportOnlyCostUsdMicros)] : []),
		...(review ? ["--reviewer", review.harness, "--reviewer-route", review.route] : []),
		...(preset.reviewerTimeoutSeconds !== undefined ? ["--reviewer-timeout", String(preset.reviewerTimeoutSeconds)] : []),
		...(preset.reviewerReportOnlyCostUsdMicros !== undefined ? ["--reviewer-cost-ceiling", costArgument(preset.reviewerReportOnlyCostUsdMicros)] : []),
		"--", repository, objective,
	];
}

export async function runWork(args: string[], runtime: WorkRuntime = workRuntime()): Promise<WorkRunResult> {
	const adapters = runtimes(runtime);
	if (args[0] === "resume") {
		const checkpointId = args[1];
		if (!checkpointId || checkpointId.startsWith("--") || args.length < 2 || args.length > 3
			|| (args[2] !== undefined && args[2] !== "--json")) {
			throw new Error("work resume requires exactly one handoff checkpoint id and accepts only --json");
		}
		return runHandoff(["resume", checkpointId], adapters.handoff);
	}
	const options = parseWork(args);
	const selected = await loadProjectPreset(options.repository, options.presetName);
	let sourceBaseCommit: string;
	try {
		const { stdout } = await execute("git", ["--no-optional-locks", "-C", selected.repository, "rev-parse", "--verify", "HEAD^{commit}"], {
			encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024,
		});
		sourceBaseCommit = stdout.trim();
		if (!/^[0-9a-f]{40,64}$/.test(sourceBaseCommit)) throw new Error("invalid source commit");
	} catch {
		throw new Error("work requires a committed HEAD for its managed worktree; create the repository's initial commit before running work");
	}
	const { preset } = selected;
	// Resolve both configured identities before any orchestration allocation. A
	// reviewer mismatch must not leave a builder running without its review lane.
	requireBuilder(await runtime.resolveProfile(preset.route, "opencode"), preset.route);
	if (preset.reviewer) {
		const profile = await runtime.resolveProfile(preset.reviewer.route, preset.reviewer.harness);
		if (profile.id !== preset.reviewer.route || profile.harness !== preset.reviewer.harness
			|| profile.tier !== (preset.reviewer.harness === "omp" ? "attested" : "trusted-host")) {
			throw new Error(`work reviewer profile ${preset.reviewer.route} must preserve its selected harness and tier`);
		}
	}
	const forwarded = workflowArgs(selected.repository, options.objective, preset);
	if (options.dryRun) {
		const lanes = preset.reviewer
			? await preflightHandoff(forwarded, adapters.handoff).then((result) => [
				{ role: "builder", ...result.builder }, { role: "reviewer", ...result.reviewer },
			])
			: [{ role: "builder", ...await preflightTask(forwarded, adapters.task) }];
		const ready = lanes.every((lane) => lane.preflight.ok);
		const preview = {
			version: 1, kind: "work-preview", status: ready ? "ready" : "blocked", executionStarted: false,
			source: selected.repository, sourceBaseCommit, configPath: selected.configPath, presetName: selected.presetName,
			objective: options.objective, workflow: preset.reviewer ? "handoff" : "task", lanes,
			notices: [
				"The managed worktree starts from source HEAD. Uncommitted source changes and untracked files are not copied, including local changes to ox-driver.json; the selected preset is loaded separately from the source configuration.",
				"Preflight inspects the source repository and configured launchers without starting model work or creating a managed worktree.",
				"Execution rechecks the route and workspace. Checks run only during execution; reviewer exact-state evidence is established after the builder finishes.",
			],
		};
		return { exitCode: ready ? 0 : 1, receipt: preview, preview };
	}
	return preset.reviewer ? runHandoff(forwarded, adapters.handoff) : runTask(forwarded, adapters.task);
}
