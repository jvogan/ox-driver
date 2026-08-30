import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import {
	compactWorkerReceipt,
	compactOrchestrationError,
	effectiveRetryPlanSha256,
	ManagedWorktreeStore,
	OrchestrationReceiptStore,
	validateEffectiveRetryPlan,
	type OxController,
	type ResolvedRouteProfile,
	type RunSpec,
} from "@ox-driver/core";

interface TaskRuntime {
	resolveProfile(requested: string | undefined, profileDirectory: string | undefined): Promise<ResolvedRouteProfile>;
	createController(spec: RunSpec, profileDirectory: string | undefined): Promise<OxController>;
}

interface TaskOptions {
	source: string;
	objective: string;
	ref: string;
	ownedPaths: string[];
	excludedPaths: string[];
	checks: string[];
	noCheck: boolean;
	route?: string;
	profileDirectory?: string;
	agent?: string;
	childAgents: string[];
	timeoutSeconds: number;
	reportOnlyCostUsdMicros: number;
}

function fail(message: string): never {
	throw new Error(message);
}

function relativeScope(value: string | undefined, flag: string): string {
	if (!value || isAbsolute(value) || value.includes("\0") || value.split(/[\\/]+/).includes("..")) {
		fail(`${flag} must be a relative path that stays inside the task repository`);
	}
	return value;
}

function parseTask(args: string[]): TaskOptions {
	let ref = "HEAD";
	let noCheck = false;
	let route: string | undefined;
	let profileDirectory: string | undefined;
	let agent: string | undefined;
	let timeoutSeconds = 3_600;
	let reportOnlyCostUsdMicros = 50_000;
	const ownedPaths: string[] = [];
	const excludedPaths = [".env"];
	const checks: string[] = [];
	const childAgents: string[] = [];
	const positional: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--ref") ref = args[++index]?.trim() || fail("--ref requires a Git revision");
		else if (argument === "--owned") ownedPaths.push(relativeScope(args[++index], "--owned"));
		else if (argument === "--exclude") excludedPaths.push(relativeScope(args[++index], "--exclude"));
		else if (argument === "--check") checks.push(args[++index]?.trim() || fail("--check requires a command"));
		else if (argument === "--no-check") noCheck = true;
		else if (argument === "--route") route = args[++index]?.trim() || fail("--route requires a profile id");
		else if (argument === "--profile-dir") {
			profileDirectory = args[++index]?.trim() || fail("--profile-dir requires an absolute directory");
			if (!isAbsolute(profileDirectory)) fail("--profile-dir requires an absolute directory");
		} else if (argument === "--agent") agent = args[++index]?.trim() || fail("--agent requires a profile");
		else if (argument === "--child-agent") {
			const child = args[++index]?.trim() || fail("--child-agent requires a profile");
			if (childAgents.includes(child)) fail("--child-agent must not repeat a profile");
			childAgents.push(child);
		}
		else if (argument === "--timeout") {
			timeoutSeconds = Number(args[++index]);
			if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) {
				fail("--timeout must be an integer from 1 to 86400 seconds");
			}
		} else if (argument === "--cost-ceiling") {
			const dollars = Number(args[++index]);
			const micros = Math.round(dollars * 1_000_000);
			if (!Number.isFinite(dollars) || dollars < 0 || !Number.isSafeInteger(micros)) fail("--cost-ceiling must be a non-negative dollar amount representable in integer micros");
			reportOnlyCostUsdMicros = micros;
		} else if (argument?.startsWith("--")) fail(`unknown task option: ${argument}`);
		else if (argument !== undefined) positional.push(argument);
	}
	if (positional.length < 2) {
		fail("task requires a source repository and objective");
	}
	if (checks.length === 0 && !noCheck) fail("task requires at least one --check or explicit --no-check");
	if (checks.length > 0 && noCheck) fail("--check and --no-check are mutually exclusive");
	if (childAgents.length > 0 && !agent) fail("--child-agent requires an explicit delegation-capable --agent primary");
	return {
		source: resolve(positional[0]!),
		objective: positional.slice(1).join(" "),
		ref,
		ownedPaths: [...new Set(ownedPaths.length > 0 ? ownedPaths : ["."])],
		excludedPaths: [...new Set(excludedPaths)],
		checks,
		noCheck,
		...(route ? { route } : {}),
		...(profileDirectory ? { profileDirectory } : {}),
		...(agent ? { agent } : {}),
		childAgents,
		timeoutSeconds,
		reportOnlyCostUsdMicros,
	};
}

function errorEvidence(error: unknown): Record<string, unknown> {
	return compactOrchestrationError(error);
}

export async function runTask(args: string[], runtime: TaskRuntime): Promise<{ exitCode: number; receipt: Record<string, unknown> }> {
	const options = parseTask(args);
	const orchestrationStore = new OrchestrationReceiptStore();
	const worktreeStore = new ManagedWorktreeStore();
	const allocation = await orchestrationStore.allocate();
	const worktreeId = randomUUID();
	const runId = randomUUID();
	process.stderr.write(`OX_DRIVER_TASK_ID=${allocation.orchestrationId}\n`);
	process.stderr.write(`OX_DRIVER_WORKTREE_ID=${worktreeId}\n`);
	process.stderr.write(`OX_DRIVER_RUN_ID=${runId}\n`);

	let stage = "workspace-creating";
	let workspace: Awaited<ReturnType<ManagedWorktreeStore["create"]>> | undefined;
	let worker: Record<string, unknown> | undefined;
	let status: "completed" | "failed" | "cancelled" = "failed";
	let failure: Record<string, unknown> | undefined;
	let controller: OxController | undefined;
	let resolvedRouteProfile: string | undefined;
	let cancellation: Promise<unknown> | undefined;
	let interrupted = false;
	const onSignal = () => {
		interrupted = true;
		if (controller && !cancellation) cancellation = controller.cancel(runId).catch(() => undefined);
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		stage = "route-resolving";
		const profile = await runtime.resolveProfile(options.route, options.profileDirectory);
		const routeProfile = profile.id;
		if (profile.route.source !== "explicit") throw new Error(`route profile ${profile.id} does not provide an explicit dispatch route`);
		const childRoute = { provider: profile.route.provider, model: profile.route.model, reasoning: profile.route.reasoning };
		resolvedRouteProfile = routeProfile;
		const buildSpec = (cwd: string): RunSpec => ({
			version: 1,
			tier: "trusted-host",
			harness: "opencode",
			routeProfile,
			task: {
				objective: options.objective,
				cwd,
				ownedPaths: [...new Set([...options.ownedPaths, ".git/HEAD"])],
				excludedPaths: options.excludedPaths,
			},
			execution: {
				session: "new",
				...(options.agent ? { agentProfile: options.agent } : {}),
				topology: options.childAgents.length > 0 ? "flat" : "solo",
				writerPolicy: "one-writer",
				network: "configured",
				timeoutSeconds: options.timeoutSeconds,
				reportOnlyCostUsdMicros: options.reportOnlyCostUsdMicros,
				...(options.childAgents.length > 0 ? {
					childPolicy: { allowedProfiles: options.childAgents, allowedRoutes: [childRoute] },
				} : {}),
			},
			acceptance: {
				commands: options.checks,
				requireCleanUnownedPaths: true,
				timeoutSeconds: options.timeoutSeconds,
				continueOnFailure: true,
			},
		});
		// Preflight against the source repository before creating a managed
		// worktree, so a blocked launcher or route leaves nothing to clean up.
		stage = "route-preflight";
		controller = await runtime.createController(buildSpec(options.source), options.profileDirectory);
		const admission = await controller.preflight(buildSpec(options.source));
		if (!admission.ok) {
			throw new Error(`preflight failed before workspace creation:\n${admission.issues
				.filter((issue) => issue.severity === "error")
				.map((issue) => `${issue.code}: ${issue.message}`)
				.join("\n")}`);
		}
		stage = "workspace-creating";
		workspace = await worktreeStore.create(options.source, { ref: options.ref, id: worktreeId });
		if (interrupted) {
			status = "cancelled";
			stage = "cancelled-before-run";
		} else {
			const spec: RunSpec = buildSpec(workspace.path);
			if (interrupted) {
				status = "cancelled";
				stage = "cancelled-before-run";
			} else {
				stage = "worker-running";
				const runReceipt = await controller.run(spec, { runId });
				if (cancellation) await cancellation;
				worker = {
					...compactWorkerReceipt(runReceipt, workspace.path, "builder"),
					laneId: "task",
					worktreeId: workspace.id,
					baseCommit: workspace.baseCommit,
				};
				stage = "workspace-reconciling";
				workspace = await worktreeStore.inspect(worktreeId);
				const identityIntact = workspace.status === "ready" || workspace.status === "dirty" || workspace.status === "advanced";
				status = interrupted || runReceipt.status === "cancelled"
					? "cancelled"
					: runReceipt.status === "completed" && identityIntact ? "completed" : "failed";
			}
		}
	} catch (error) {
		status = interrupted ? "cancelled" : "failed";
		failure = { stage, ...errorEvidence(error) };
		if (workspace) workspace = await worktreeStore.inspect(worktreeId).catch(() => workspace);
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}

	const integrationRecommendation = status === "completed"
		? "inspect-worktree-diff-and-integrate-selected-changes"
		: workspace
			? "inspect-worktree-and-resolve-failures-before-integration"
			: "no-worktree-created";
	const effectivePlan = workspace && resolvedRouteProfile ? validateEffectiveRetryPlan({
		version: 1,
		lanes: [{
			id: "task",
			role: "builder",
			objective: options.objective,
			workerPath: workspace.path,
			route: resolvedRouteProfile,
			...(options.agent ? { agent: options.agent } : {}),
			...(options.childAgents.length > 0 ? { childAgents: options.childAgents } : {}),
			...(options.profileDirectory ? { profileDirectory: options.profileDirectory } : {}),
			ownedPaths: options.ownedPaths,
			excludedPaths: options.excludedPaths,
			checks: options.checks,
			timeoutSeconds: options.timeoutSeconds,
			reportOnlyCostUsdMicros: options.reportOnlyCostUsdMicros,
			worktreeId: workspace.id,
			baseCommit: workspace.baseCommit,
		}],
	}) : undefined;
	const receipt = await orchestrationStore.persist({
		version: 1,
		kind: "task",
		orchestrationId: allocation.orchestrationId,
		receiptPath: allocation.receiptPath,
		objective: options.objective,
		status,
		source: workspace?.source ?? options.source,
		requestedRef: options.ref,
		requestedWorktreeId: worktreeId,
		requestedRunId: runId,
		checksDeclared: options.checks.length > 0,
		...(workspace ? { workspace } : {}),
		workers: worker ? [worker] : [],
		...(effectivePlan ? {
			effectivePlan,
			effectivePlanSha256: effectiveRetryPlanSha256(effectivePlan),
		} : {}),
		...(failure ? { failure } : {}),
		integrationRecommendation,
		notices: [
			"Task aggregate receipts are finalized only at terminal completion; an abrupt CLI-process exit can leave linked run and worktree records without a task aggregate.",
		],
		autoMerged: false,
	});
	return { exitCode: status === "completed" ? 0 : 1, receipt };
}
