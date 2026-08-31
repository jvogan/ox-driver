import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import {
	compactOrchestrationError,
	compactWorkerReceipt,
	captureWorkspaceSha256,
	HandoffCheckpointStore,
	ManagedWorktreeStore,
	OrchestrationReceiptStore,
	summarizeOrchestrationCosts,
	validateRunSpec,
	type ConfiguredRoute,
	type OxController,
	type HandoffCheckpoint,
	type PreflightResult,
	type RunReceipt,
	type RunSpec,
} from "@ox-driver/core";

export interface HandoffRuntime {
	resolveBuilderProfile(requested: string | undefined): Promise<{ id: string; configuredRoute: ConfiguredRoute }>;
	createController(spec: RunSpec): Promise<OxController>;
	afterBuilderRunningCheckpoint?(): Promise<void> | void;
	afterBuilderCheckpoint?(): Promise<void> | void;
	afterReviewerRunningCheckpoint?(): Promise<void> | void;
	afterReviewerCheckpoint?(): Promise<void> | void;
}

interface HandoffOptions {
	source: string;
	objective: string;
	ref: string;
	ownedPaths: string[];
	excludedPaths: string[];
	checks: string[];
	noCheck: boolean;
	builderRoute?: string;
	reviewerRoute?: string;
	builderAgent?: string;
	builderChildAgents?: string[];
	builderTimeoutSeconds: number;
	reviewerTimeoutSeconds: number;
	builderCostUsdMicros: number;
	reviewerCostUsdMicros: number;
	reviewer: "omp" | "pi";
}

interface HandoffCheckpointPlan extends Record<string, unknown> {
	version: 1;
	args: string[];
	options: HandoffOptions;
	routeProfile: string;
	admittedWorkspaceSha256: string;
	builderSpec: RunSpec;
	reviewerProbeSpec: RunSpec;
	preflightEvidence: Record<string, unknown>;
	runStoreRoot: string;
	workspace: {
		id: string;
		path: string;
		source: string;
		baseCommit: string;
	};
}

function fail(message: string): never {
	throw new Error(message);
}

function relativeScope(value: string | undefined, flag: string): string {
	if (!value || isAbsolute(value) || value.includes("\0") || value.split(/[\\/]+/).includes("..")) {
		fail(`${flag} must be a relative path that stays inside the repository`);
	}
	return value;
}

function seconds(value: string | undefined, flag: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 86_400) {
		fail(`${flag} must be an integer from 1 to 86400 seconds`);
	}
	return parsed;
}

function parseHandoff(args: string[]): HandoffOptions {
	let ref = "HEAD";
	let builderRoute: string | undefined;
	let reviewerRoute: string | undefined;
	let builderAgent: string | undefined;
	const builderChildAgents: string[] = [];
	let builderTimeoutSeconds = 3_600;
	let reviewerTimeoutSeconds = 3_600;
	let builderCostUsdMicros = 50_000;
	let reviewerCostUsdMicros = 50_000;
	let reviewer: "omp" | "pi" = "omp";
	let noCheck = false;
	const ownedPaths: string[] = [];
	const excludedPaths = [".env"];
	const checks: string[] = [];
	const positional: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--ref") ref = args[++index]?.trim() || fail("--ref requires a Git revision");
		else if (argument === "--owned") ownedPaths.push(relativeScope(args[++index], "--owned"));
		else if (argument === "--exclude") excludedPaths.push(relativeScope(args[++index], "--exclude"));
		else if (argument === "--check") checks.push(args[++index]?.trim() || fail("--check requires a command"));
		else if (argument === "--no-check") noCheck = true;
		else if (argument === "--builder-route") builderRoute = args[++index]?.trim() || fail("--builder-route requires a profile id");
		else if (argument === "--reviewer-route") reviewerRoute = args[++index]?.trim() || fail("--reviewer-route requires a profile id");
		else if (argument === "--builder-agent") builderAgent = args[++index]?.trim() || fail("--builder-agent requires a profile");
		else if (argument === "--builder-child-agent") {
			const child = args[++index]?.trim() || fail("--builder-child-agent requires a profile");
			if (builderChildAgents.includes(child)) fail("--builder-child-agent must not repeat a profile");
			builderChildAgents.push(child);
		}
		else if (argument === "--builder-timeout") builderTimeoutSeconds = seconds(args[++index], "--builder-timeout");
		else if (argument === "--reviewer-timeout") reviewerTimeoutSeconds = seconds(args[++index], "--reviewer-timeout");
		else if (argument === "--reviewer") {
			const value = args[++index]?.trim();
			if (value !== "omp" && value !== "pi") fail("--reviewer must be omp or pi");
			reviewer = value;
		}
		else if (argument === "--builder-cost-ceiling") {
			const dollars = Number(args[++index]);
			const micros = Math.round(dollars * 1_000_000);
			if (!Number.isFinite(dollars) || dollars < 0 || !Number.isSafeInteger(micros)) fail("--builder-cost-ceiling must be a non-negative dollar amount representable in integer micros");
			builderCostUsdMicros = micros;
		} else if (argument === "--reviewer-cost-ceiling") {
			const dollars = Number(args[++index]);
			const micros = Math.round(dollars * 1_000_000);
			if (!Number.isFinite(dollars) || dollars < 0 || !Number.isSafeInteger(micros)) fail("--reviewer-cost-ceiling must be a non-negative dollar amount representable in integer micros");
			reviewerCostUsdMicros = micros;
		} else if (argument?.startsWith("--")) fail(`unknown handoff option: ${argument}`);
		else if (argument !== undefined) positional.push(argument);
	}
	if (positional.length < 2) fail("handoff requires a source repository and objective");
	if (checks.length === 0 && !noCheck) fail("handoff requires at least one controller-owned --check or explicit --no-check");
	if (checks.length > 0 && noCheck) fail("--check and --no-check are mutually exclusive");
	if (builderChildAgents.length > 0 && !builderAgent) {
		fail("--builder-child-agent requires an explicit delegation-capable --builder-agent primary");
	}
	return {
		source: resolve(positional[0]!),
		objective: positional.slice(1).join(" "),
		ref,
		ownedPaths: [...new Set(ownedPaths.length > 0 ? ownedPaths : ["."])],
		excludedPaths: [...new Set(excludedPaths)],
		checks: [...new Set(checks)],
		noCheck,
		...(builderRoute ? { builderRoute } : {}),
		...(reviewerRoute ? { reviewerRoute } : {}),
		...(builderAgent ? { builderAgent } : {}),
		...(builderChildAgents.length > 0 ? { builderChildAgents } : {}),
		builderTimeoutSeconds,
		reviewerTimeoutSeconds,
		builderCostUsdMicros,
		reviewerCostUsdMicros,
		reviewer,
	};
}

function normalizedHandoffArgs(options: HandoffOptions, routeProfile: string): string[] {
	return [
		options.source,
		options.objective,
		"--ref", options.ref,
		...options.ownedPaths.flatMap((path) => ["--owned", path]),
		...options.excludedPaths.filter((path) => path !== ".env").flatMap((path) => ["--exclude", path]),
		...(options.checks.length > 0 ? options.checks.flatMap((command) => ["--check", command]) : ["--no-check"]),
		"--builder-route", routeProfile,
		...(options.reviewerRoute ? ["--reviewer-route", options.reviewerRoute] : []),
		...(options.builderAgent ? ["--builder-agent", options.builderAgent] : []),
		...(options.builderChildAgents ?? []).flatMap((profile) => ["--builder-child-agent", profile]),
		"--builder-timeout", String(options.builderTimeoutSeconds),
		"--reviewer-timeout", String(options.reviewerTimeoutSeconds),
		"--builder-cost-ceiling", String(options.builderCostUsdMicros / 1_000_000),
		"--reviewer-cost-ceiling", String(options.reviewerCostUsdMicros / 1_000_000),
		"--reviewer", options.reviewer,
	];
}

function checkpointOptions(value: Record<string, unknown>): HandoffOptions {
	const allowed = new Set([
		"source", "objective", "ref", "ownedPaths", "excludedPaths", "checks", "noCheck",
		"builderRoute", "reviewerRoute", "builderAgent", "builderChildAgents", "builderTimeoutSeconds", "reviewerTimeoutSeconds",
		"builderCostUsdMicros", "reviewerCostUsdMicros", "reviewer",
	]);
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`handoff checkpoint option is unknown: ${key}`);
	if (typeof value.source !== "string" || !isAbsolute(value.source)
		|| typeof value.objective !== "string" || !value.objective
		|| typeof value.ref !== "string" || !value.ref
		|| typeof value.noCheck !== "boolean"
		|| (value.reviewer !== "omp" && value.reviewer !== "pi")) {
		throw new Error("handoff checkpoint scalar options are invalid");
	}
	const strings = (field: "ownedPaths" | "excludedPaths" | "checks"): string[] => {
		const candidate = value[field];
		if (!Array.isArray(candidate) || candidate.some((item) => typeof item !== "string" || !item)) {
			throw new Error(`handoff checkpoint ${field} are invalid`);
		}
		return [...candidate] as string[];
	};
	const integer = (field: "builderTimeoutSeconds" | "reviewerTimeoutSeconds" | "builderCostUsdMicros" | "reviewerCostUsdMicros", minimum: number, maximum: number): number => {
		const candidate = value[field];
		if (!Number.isSafeInteger(candidate) || Number(candidate) < minimum || Number(candidate) > maximum) {
			throw new Error(`handoff checkpoint ${field} is invalid`);
		}
		return Number(candidate);
	};
	for (const field of ["builderRoute", "reviewerRoute", "builderAgent"] as const) {
		if (value[field] !== undefined && (typeof value[field] !== "string" || !value[field])) {
			throw new Error(`handoff checkpoint ${field} is invalid`);
		}
	}
	let builderChildAgents: string[] | undefined;
	if (value.builderChildAgents !== undefined) {
		if (!Array.isArray(value.builderChildAgents)
			|| value.builderChildAgents.length === 0
			|| value.builderChildAgents.some((profile) => typeof profile !== "string" || !profile.trim())
			|| new Set(value.builderChildAgents).size !== value.builderChildAgents.length) {
			throw new Error("handoff checkpoint builderChildAgents are invalid");
		}
		if (typeof value.builderAgent !== "string") {
			throw new Error("handoff checkpoint child agents require an explicit builderAgent");
		}
		builderChildAgents = [...value.builderChildAgents] as string[];
	}
	const ownedPaths = strings("ownedPaths");
	const excludedPaths = strings("excludedPaths");
	const checks = strings("checks");
	if (ownedPaths.length === 0 || (checks.length === 0) === (value.noCheck === false)) {
		throw new Error("handoff checkpoint owned paths or check policy are invalid");
	}
	return {
		source: value.source,
		objective: value.objective,
		ref: value.ref,
		ownedPaths,
		excludedPaths,
		checks,
		noCheck: value.noCheck,
		...(typeof value.builderRoute === "string" ? { builderRoute: value.builderRoute } : {}),
		...(typeof value.reviewerRoute === "string" ? { reviewerRoute: value.reviewerRoute } : {}),
		...(typeof value.builderAgent === "string" ? { builderAgent: value.builderAgent } : {}),
		...(builderChildAgents ? { builderChildAgents } : {}),
		builderTimeoutSeconds: integer("builderTimeoutSeconds", 1, 86_400),
		reviewerTimeoutSeconds: integer("reviewerTimeoutSeconds", 1, 86_400),
		builderCostUsdMicros: integer("builderCostUsdMicros", 0, Number.MAX_SAFE_INTEGER),
		reviewerCostUsdMicros: integer("reviewerCostUsdMicros", 0, Number.MAX_SAFE_INTEGER),
		reviewer: value.reviewer,
	};
}

function checkpointPlan(value: Record<string, unknown>): HandoffCheckpointPlan {
	if (value.version !== 1 || !Array.isArray(value.args) || value.args.some((item) => typeof item !== "string")) {
		throw new Error("handoff checkpoint plan arguments are invalid");
	}
	if (!value.options || typeof value.options !== "object" || Array.isArray(value.options)) {
		throw new Error("handoff checkpoint normalized options are invalid");
	}
	const options = checkpointOptions(value.options as Record<string, unknown>);
	if (typeof value.routeProfile !== "string" || !value.routeProfile.trim()) throw new Error("handoff checkpoint route profile is invalid");
	if (typeof value.admittedWorkspaceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.admittedWorkspaceSha256)) {
		throw new Error("handoff checkpoint admitted workspace digest is invalid");
	}
	if (!value.builderSpec || typeof value.builderSpec !== "object" || Array.isArray(value.builderSpec)
		|| !value.reviewerProbeSpec || typeof value.reviewerProbeSpec !== "object" || Array.isArray(value.reviewerProbeSpec)
		|| !value.preflightEvidence || typeof value.preflightEvidence !== "object" || Array.isArray(value.preflightEvidence)) {
		throw new Error("handoff checkpoint specs or preflight evidence are invalid");
	}
	const builderSpecValue = validateRunSpec(value.builderSpec);
	const reviewerProbeSpecValue = validateRunSpec(value.reviewerProbeSpec);
	if (typeof value.runStoreRoot !== "string" || !isAbsolute(value.runStoreRoot)) {
		throw new Error("handoff checkpoint run-state root is invalid");
	}
	if (!value.workspace || typeof value.workspace !== "object" || Array.isArray(value.workspace)) {
		throw new Error("handoff checkpoint workspace is invalid");
	}
	const workspace = value.workspace as Record<string, unknown>;
	for (const field of ["id", "path", "source", "baseCommit"] as const) {
		if (typeof workspace[field] !== "string" || !workspace[field]) throw new Error(`handoff checkpoint workspace ${field} is invalid`);
	}
	return { ...value, options, builderSpec: builderSpecValue, reviewerProbeSpec: reviewerProbeSpecValue } as HandoffCheckpointPlan;
}

function builderSpec(
	options: HandoffOptions,
	cwd: string,
	routeProfile: string,
	configuredRoute?: ConfiguredRoute,
): RunSpec {
	const childAgents = options.builderChildAgents ?? [];
	if (childAgents.length > 0 && !configuredRoute) {
		throw new Error("handoff child delegation requires the builder's exact configured route");
	}
	return {
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
			...(options.builderAgent ? { agentProfile: options.builderAgent } : {}),
			topology: childAgents.length > 0 ? "flat" : "solo",
			writerPolicy: "one-writer",
			network: "configured",
			timeoutSeconds: options.builderTimeoutSeconds,
			reportOnlyCostUsdMicros: options.builderCostUsdMicros,
			...(childAgents.length > 0 ? {
				childPolicy: { allowedProfiles: childAgents, allowedRoutes: [configuredRoute as ConfiguredRoute] },
			} : {}),
		},
		acceptance: {
			commands: [],
			requireCleanUnownedPaths: true,
			timeoutSeconds: options.builderTimeoutSeconds,
			continueOnFailure: true,
		},
	};
}

function utf8Preview(value: string, maximumBytes: number): { value: string; truncated: boolean } {
	let bytes = 0;
	let preview = "";
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maximumBytes) return { value: preview, truncated: true };
		preview += character;
		bytes += characterBytes;
	}
	return { value: preview, truncated: false };
}

function reviewerObjective(objective: string, changedPaths: string[]): string {
	const serializedPaths = JSON.stringify(changedPaths);
	const pathsSha256 = createHash("sha256").update("ox-driver-changed-paths-v1\0").update(serializedPaths).digest("hex");
	const objectiveBytes = Buffer.byteLength(objective, "utf8");
	const objectiveSha256 = createHash("sha256").update(objective).digest("hex");
	const objectivePreview = utf8Preview(objective, 24 * 1024);
	const pathPreview: string[] = [];
	let previewBytes = 0;
	for (const path of changedPaths) {
		const line = `- ${path}`;
		const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
		if (pathPreview.length >= 256 || previewBytes + lineBytes > 24 * 1024) break;
		pathPreview.push(line);
		previewBytes += lineBytes;
	}
	const value = [
		"Review the implementation in this workspace read-only and report concrete correctness, security, regression, and acceptance risks.",
		`Original objective: ${objectiveBytes} UTF-8 bytes; full-text SHA-256 ${objectiveSha256}.`,
		objectivePreview.value,
		...(objectivePreview.truncated ? ["[objective preview truncated; the complete objective is retained in the handoff checkpoint and aggregate receipt]"] : []),
		`Controller-observed builder paths: ${changedPaths.length} total; full-list SHA-256 ${pathsSha256}.`,
		"Bounded path preview:",
		...(pathPreview.length > 0 ? pathPreview : ["- (none)"]),
		...(pathPreview.length < changedPaths.length ? [`- ... ${changedPaths.length - pathPreview.length} additional path(s) are retained in the builder receipt.`] : []),
		"Do not modify the workspace. Do not treat the builder's prose as evidence; inspect the files yourself.",
	].join("\n");
	if (Buffer.byteLength(value, "utf8") > 64 * 1024) throw new Error("reviewer handoff prompt exceeds the bounded size limit");
	return value;
}

function reviewerSpec(
	options: HandoffOptions,
	cwd: string,
	objective: string,
	expectedWorkspaceSha256?: string,
): RunSpec {
	return {
		version: 1,
		tier: options.reviewer === "pi" ? "trusted-host" : "attested",
		harness: options.reviewer,
		routeProfile: options.reviewerRoute
			?? (options.reviewer === "pi"
				? (process.env.OX_DRIVER_PI_PROFILE?.trim() || "pi-default")
				: (process.env.OX_DRIVER_OMP_PROFILE?.trim() || "omp-default")),
		task: {
			objective,
			cwd,
			ownedPaths: [],
			excludedPaths: options.excludedPaths,
			...(expectedWorkspaceSha256 ? { expectedWorkspaceSha256 } : {}),
		},
		execution: {
			session: "ephemeral",
			topology: "solo",
			writerPolicy: "read-only",
			network: "configured",
			timeoutSeconds: options.reviewerTimeoutSeconds,
			reportOnlyCostUsdMicros: options.reviewerCostUsdMicros,
		},
		acceptance: {
			commands: options.checks,
			requireCleanUnownedPaths: true,
			timeoutSeconds: options.reviewerTimeoutSeconds,
			continueOnFailure: true,
		},
	};
}

function allAcceptancePassed(receipt: RunReceipt, expected: number): boolean {
	return receipt.acceptance.length === expected && receipt.acceptance.every((entry) => entry.passed);
}

function describePreflightIssues(issues: PreflightResult["issues"]): string {
	return issues.map((issue) => `${issue.code}: ${issue.message}`).join("\n");
}

export async function runHandoff(args: string[], runtime: HandoffRuntime): Promise<{ exitCode: number; receipt: Record<string, unknown> }> {
	const orchestrationStore = new OrchestrationReceiptStore();
	const checkpointStore = new HandoffCheckpointStore(orchestrationStore.root);
	const worktreeStore = new ManagedWorktreeStore();
	const resumeCheckpointId = args[0] === "resume" ? args[1] : undefined;
	if (args[0] === "resume" && (args.length !== 2 || !resumeCheckpointId)) {
		throw new Error("handoff resume requires exactly one checkpoint id");
	}
	let checkpoint: HandoffCheckpoint | undefined;
	let plan: HandoffCheckpointPlan | undefined;
	let options: HandoffOptions;
	let workspace: Awaited<ReturnType<ManagedWorktreeStore["create"]>> | undefined;
	let worktreeId: string;
	let builderRunId: string;
	let reviewerRunId: string;
	let routeProfile: string;
	let builderConfiguredRoute: ConfiguredRoute | undefined;
	let resumed = false;
	let reusedStages: string[] = [];
	let lease: Awaited<ReturnType<HandoffCheckpointStore["acquireLease"]>> | undefined;
	if (resumeCheckpointId) {
		checkpoint = await checkpointStore.read(resumeCheckpointId);
		plan = checkpointPlan(checkpoint.plan);
		options = plan.options;
		routeProfile = plan.routeProfile;
		builderConfiguredRoute = plan.builderSpec.execution.childPolicy?.allowedRoutes[0];
		workspace = await worktreeStore.inspect(plan.workspace.id);
		if (workspace.path !== plan.workspace.path || workspace.source !== plan.workspace.source
			|| workspace.baseCommit !== plan.workspace.baseCommit
			|| !["ready", "dirty", "advanced"].includes(workspace.status)) {
			throw new Error("handoff checkpoint managed workspace identity or status is invalid");
		}
		worktreeId = workspace.id;
		builderRunId = checkpoint.builder.runId;
		reviewerRunId = checkpoint.reviewerAttempts.at(-1)!.runId;
		resumed = true;
		for (const orchestrationId of [...checkpoint.orchestrationAttempts].reverse()) {
			try {
				const existing = await orchestrationStore.inspect(orchestrationId);
				if (existing.kind === "handoff" && existing.checkpointId === checkpoint.checkpointId && existing.status === "completed") {
					return { exitCode: 0, receipt: existing };
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	} else {
		options = parseHandoff(args);
		const builderProfile = await runtime.resolveBuilderProfile(options.builderRoute);
		routeProfile = builderProfile.id;
		builderConfiguredRoute = builderProfile.configuredRoute;
		worktreeId = randomUUID();
		builderRunId = randomUUID();
		reviewerRunId = randomUUID();
	}
	const allocation = await orchestrationStore.allocate();
	if (checkpoint) {
		lease = await checkpointStore.acquireLease(checkpoint.checkpointId, allocation.orchestrationId);
		checkpoint.orchestrationAttempts.push(allocation.orchestrationId);
		try {
			checkpoint = await checkpointStore.write(checkpoint);
		} catch (error) {
			await lease.release().catch(() => undefined);
			throw error;
		}
	}
	process.stderr.write(`OX_DRIVER_HANDOFF_ID=${allocation.orchestrationId}\n`);
	process.stderr.write(`OX_DRIVER_WORKTREE_ID=${worktreeId}\n`);
	process.stderr.write(`OX_DRIVER_BUILDER_RUN_ID=${builderRunId}\n`);
	process.stderr.write(`OX_DRIVER_REVIEWER_RUN_ID=${reviewerRunId}\n`);
	process.stderr.write(`OX_DRIVER_HANDOFF_CHECKPOINT_ID=${checkpoint?.checkpointId ?? allocation.orchestrationId}\n`);

	let stage = "route-resolving";
	const workers: Record<string, unknown>[] = [];
	const historicalReviewerWorkers: Record<string, unknown>[] = [];
	const historicalReviewerRunIds = new Set<string>();
	let status: "completed" | "failed" | "cancelled" = "failed";
	let failure: Record<string, unknown> | undefined;
	let activeController: OxController | undefined;
	let activeRunId: string | undefined;
	let cancellation: Promise<unknown> | undefined;
	let interrupted = false;
	let builderReceipt: RunReceipt | undefined;
	let reviewerReceipt: RunReceipt | undefined;
	let inFlight: Awaited<ReturnType<OrchestrationReceiptStore["beginInFlight"]>> | undefined;
	const evidence = {
		reviewerReceivedExactBuilderState: false,
		reviewerChangedWorkspace: false,
		acceptancePassed: false,
		acceptanceChangedWorkspace: false,
	};
	const onSignal = () => {
		interrupted = true;
		if (activeController && activeRunId && !cancellation) {
			cancellation = activeController.cancel(activeRunId).catch(() => undefined);
		}
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		if (!workspace) {
			stage = "workspace-creating";
			workspace = await worktreeStore.create(options.source, { ref: options.ref, id: worktreeId });
		}
		const build = builderSpec(options, workspace.path, routeProfile, builderConfiguredRoute);
		const reviewProbe = reviewerSpec(options, workspace.path, reviewerObjective(options.objective, []));
		if (plan && (JSON.stringify(plan.builderSpec) !== JSON.stringify(build)
			|| JSON.stringify(plan.reviewerProbeSpec) !== JSON.stringify(reviewProbe))) {
			throw new Error("handoff checkpoint RunSpecs do not match their immutable normalized options");
		}
		stage = "preflight";
		const builderController = await runtime.createController(build);
		const reviewerController = await runtime.createController(reviewProbe);
		const [builderPreflight, reviewerPreflight] = await Promise.all([
			builderController.preflight(build),
			reviewerController.preflight(reviewProbe),
		]);
		if (!builderPreflight.ok) {
			throw new Error(`OpenCode builder preflight failed:\n${describePreflightIssues(builderPreflight.issues)}`);
		}
		if (!reviewerPreflight.ok) {
			throw new Error(
				`${options.reviewer === "pi" ? "Pi" : "OMP"} reviewer preflight failed:\n${describePreflightIssues(reviewerPreflight.issues)}`,
			);
		}
		const preflightEvidence = {
			builder: {
				adapterId: builderPreflight.doctor.adapterId,
				harnessVersion: builderPreflight.doctor.harnessVersion,
				harnessBinarySha256: builderPreflight.doctor.binarySha256,
				harnessEnforcementSha256: builderPreflight.doctor.enforcementSha256,
				routeProfileSha256: builderPreflight.doctor.routeProfileSha256,
				configuredRoute: builderPreflight.doctor.configuredRoute,
			},
			reviewer: {
				adapterId: reviewerPreflight.doctor.adapterId,
				harnessVersion: reviewerPreflight.doctor.harnessVersion,
				harnessBinarySha256: reviewerPreflight.doctor.binarySha256,
				harnessEnforcementSha256: reviewerPreflight.doctor.enforcementSha256,
				routeProfileSha256: reviewerPreflight.doctor.routeProfileSha256,
				configuredRoute: reviewerPreflight.doctor.configuredRoute,
			},
		};
		if (plan && JSON.stringify(plan.preflightEvidence) !== JSON.stringify(preflightEvidence)) {
			throw new Error("handoff route, harness, or effective-power preflight evidence drifted since admission");
		}
		if (plan && (builderController.store.root !== (plan.runStoreRoot as string)
			|| reviewerController.store.root !== (plan.runStoreRoot as string))) {
			throw new Error("handoff run-state root differs from the admitted checkpoint");
		}
		if (!checkpoint) {
			const admittedWorkspaceSha256 = await captureWorkspaceSha256(workspace.path);
			const canonicalArgs = normalizedHandoffArgs(options, routeProfile);
			plan = {
				version: 1,
				args: canonicalArgs,
				options: parseHandoff(canonicalArgs),
				routeProfile,
				admittedWorkspaceSha256,
				builderSpec: build,
				reviewerProbeSpec: reviewProbe,
				preflightEvidence,
				runStoreRoot: builderController.store.root,
				workspace: {
					id: workspace.id,
					path: workspace.path,
					source: workspace.source,
					baseCommit: workspace.baseCommit,
				},
			} as HandoffCheckpointPlan;
			checkpoint = checkpointStore.createValue({
				checkpointId: allocation.orchestrationId,
				plan,
				builderRunId,
				reviewerRunId,
			});
			checkpoint = await checkpointStore.write(checkpoint, { create: true });
		}
		if (plan && checkpoint.builder.status === "pending"
			&& await captureWorkspaceSha256(workspace.path) !== plan.admittedWorkspaceSha256) {
			throw new Error("managed workspace drifted before the admitted builder stage could start");
		}
		lease ??= await checkpointStore.acquireLease(checkpoint.checkpointId, allocation.orchestrationId);
		inFlight = await orchestrationStore.beginInFlight(allocation, {
			kind: "handoff",
			objective: options.objective,
			lanes: [
				{ laneId: "builder", role: "builder", workerPath: workspace.path, worktreeId, baseCommit: workspace.baseCommit },
				{ laneId: "reviewer", role: "reviewer", workerPath: workspace.path, worktreeId, baseCommit: workspace.baseCommit },
			],
		});

		const inspectChildState = async (controller: OxController, runId: string): Promise<{ exists: boolean; receipt?: RunReceipt }> => {
			try {
				const inspection = await controller.inspect(runId);
				return { exists: true, ...(inspection.receipt ? { receipt: inspection.receipt } : {}) };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
				throw error;
			}
		};
		const inspectChild = async (controller: OxController, runId: string): Promise<RunReceipt | undefined> => (
			await inspectChildState(controller, runId)
		).receipt;
		const addHistoricalReviewer = async (attempt: HandoffCheckpoint["reviewerAttempts"][number], index: number): Promise<void> => {
			if (historicalReviewerRunIds.has(attempt.runId)) return;
			const receipt = await inspectChild(reviewerController, attempt.runId);
			if (!receipt || receipt.runId !== attempt.runId || receipt.harness !== options.reviewer
				|| (receipt.status === "cancelled" ? "cancelled" : receipt.status === "completed" ? "completed" : "failed") !== attempt.status) {
				throw new Error(`historical reviewer attempt ${index + 1} does not have its exact durable child receipt`);
			}
			historicalReviewerWorkers.push({
				...compactWorkerReceipt(receipt, workspace!.path, `reviewer-attempt-${index + 1}`),
				expectedHarness: options.reviewer,
			});
			historicalReviewerRunIds.add(attempt.runId);
		};
		const validateBuilder = async (receipt: RunReceipt): Promise<void> => {
			if (receipt.runId !== builderRunId || receipt.harness !== "opencode" || receipt.status !== "completed"
				|| receipt.fallbackReceipt || receipt.workspaceEvidenceComplete === false
				|| receipt.requestedRouteProfile !== routeProfile || !receipt.finalWorkspaceSha256) {
				throw new Error("stored OpenCode builder receipt does not match the admitted completed stage");
			}
			if (checkpoint!.builder.workspaceSha256 && checkpoint!.builder.workspaceSha256 !== receipt.finalWorkspaceSha256) {
				throw new Error("stored OpenCode builder receipt workspace digest differs from its checkpoint");
			}
			if (await captureWorkspaceSha256(workspace!.path) !== receipt.finalWorkspaceSha256) {
				throw new Error("managed workspace drifted after the completed OpenCode builder stage");
			}
		};
		const validateReviewer = async (receipt: RunReceipt, expectedBuilderSha256: string): Promise<void> => {
			const expectedRouteProfile = reviewProbe.routeProfile;
			if (receipt.runId !== reviewerRunId || receipt.harness !== options.reviewer || receipt.status !== "completed"
				|| receipt.fallbackReceipt || receipt.workspaceEvidenceComplete === false
				|| receipt.requestedRouteProfile !== expectedRouteProfile
				|| receipt.initialWorkspaceSha256 !== expectedBuilderSha256
				|| receipt.postAdapterWorkspaceSha256 !== receipt.initialWorkspaceSha256
				|| receipt.harnessChangedPaths.length > 0
				|| !allAcceptancePassed(receipt, options.checks.length)
				|| receipt.finalWorkspaceSha256 !== receipt.postAdapterWorkspaceSha256
				|| receipt.acceptanceChangedPaths.length > 0
				|| !receipt.finalWorkspaceSha256) {
				throw new Error("stored reviewer receipt does not prove the admitted exact-state read-only review and acceptance result");
			}
			if (await captureWorkspaceSha256(workspace!.path) !== receipt.finalWorkspaceSha256) {
				throw new Error("managed workspace drifted after the completed reviewer stage");
			}
		};

		if (interrupted) {
			status = "cancelled";
			stage = "cancelled-before-builder";
		} else {
			if (checkpoint.builder.status !== "pending") {
				const builderInspection = await inspectChildState(builderController, builderRunId);
				builderReceipt = builderInspection.receipt;
				if (!builderReceipt && !builderInspection.exists) {
					const expectedSha256 = checkpoint.builder.workspaceSha256 ?? plan!.admittedWorkspaceSha256;
					if (await captureWorkspaceSha256(workspace.path) !== expectedSha256) {
						throw new Error("managed workspace drifted while reconciling an unstarted builder stage");
					}
					checkpoint.builder = { runId: builderRunId, status: "pending" };
					checkpoint = await checkpointStore.write(checkpoint);
				} else if (!builderReceipt) {
					throw new Error("the admitted builder stage has durable nonterminal run state; recover or cancel it before resume");
				} else {
					if (builderReceipt.status !== checkpoint.builder.status && checkpoint.builder.status !== "running") {
						throw new Error("stored builder receipt status differs from its checkpoint");
					}
					if (builderReceipt.status !== "completed") {
						if (checkpoint.builder.status === "running") {
							checkpoint.builder = {
								runId: builderRunId,
								status: builderReceipt.status === "cancelled" ? "cancelled" : "failed",
								receiptPath: join(builderController.store.runDirectory(builderRunId), "receipt.json"),
								...(builderReceipt.finalWorkspaceSha256 ? { workspaceSha256: builderReceipt.finalWorkspaceSha256 } : {}),
							};
							checkpoint = await checkpointStore.write(checkpoint);
						}
						throw new Error("a failed or cancelled builder requires a new handoff, not resume");
					}
					await validateBuilder(builderReceipt);
					if (checkpoint.builder.status === "running") {
						checkpoint.builder = { runId: builderRunId, status: "completed", receiptPath: join(builderController.store.runDirectory(builderRunId), "receipt.json"), workspaceSha256: builderReceipt.finalWorkspaceSha256! };
						checkpoint = await checkpointStore.write(checkpoint);
					}
					reusedStages.push("builder");
				}
			}
			if (checkpoint.builder.status === "pending") {
				stage = "builder-running";
				activeController = builderController;
				activeRunId = builderRunId;
				checkpoint.builder = { runId: builderRunId, status: "running" };
				checkpoint = await checkpointStore.write(checkpoint);
				await runtime.afterBuilderRunningCheckpoint?.();
				inFlight.updateLane("builder", { status: "running", runId: builderRunId });
				builderReceipt = await builderController.run(build, { runId: builderRunId });
				checkpoint.builder = {
					runId: builderRunId,
					status: builderReceipt.status === "completed" ? "completed" : builderReceipt.status === "cancelled" ? "cancelled" : "failed",
					receiptPath: join(builderController.store.runDirectory(builderRunId), "receipt.json"),
					...(builderReceipt.finalWorkspaceSha256 ? { workspaceSha256: builderReceipt.finalWorkspaceSha256 } : {}),
				};
				checkpoint = await checkpointStore.write(checkpoint);
					if (builderReceipt.status === "completed") await validateBuilder(builderReceipt);
					await runtime.afterBuilderCheckpoint?.();
				}
				if (!builderReceipt) throw new Error("builder checkpoint reconciliation did not produce or dispatch a child receipt");
				workers.push({ ...compactWorkerReceipt(builderReceipt, workspace.path, "builder"), expectedHarness: "opencode" });
			inFlight.updateLane("builder", { status: "finished" });
			if (cancellation) await cancellation;
			if (interrupted || builderReceipt.status === "cancelled") {
				status = "cancelled";
			} else if (builderReceipt.status !== "completed" || !builderReceipt.finalWorkspaceSha256) {
				throw new Error("OpenCode builder did not complete with exact workspace evidence");
			} else {
				const review = reviewerSpec(
					options,
					workspace.path,
					reviewerObjective(options.objective, builderReceipt.changedPaths),
					builderReceipt.finalWorkspaceSha256,
				);
				let reviewerIndex = checkpoint.reviewerAttempts.length - 1;
				let reviewerStage = checkpoint.reviewerAttempts[reviewerIndex]!;
				for (let index = 0; index < reviewerIndex; index += 1) {
					await addHistoricalReviewer(checkpoint.reviewerAttempts[index]!, index);
				}
				if (reviewerStage.status === "running") {
					const reviewerInspection = await inspectChildState(reviewerController, reviewerRunId);
					reviewerReceipt = reviewerInspection.receipt;
					if (!reviewerReceipt && !reviewerInspection.exists) {
						if (await captureWorkspaceSha256(workspace.path) !== builderReceipt.finalWorkspaceSha256) {
							throw new Error("managed workspace drifted while reconciling an unstarted reviewer stage");
						}
						reviewerStage = { runId: reviewerRunId, status: "pending" };
					} else if (!reviewerReceipt) {
						throw new Error("the admitted reviewer stage has durable nonterminal run state; recover or cancel it before resume");
					} else {
						reviewerStage = {
							runId: reviewerRunId,
							status: reviewerReceipt.status === "completed" ? "completed" : reviewerReceipt.status === "cancelled" ? "cancelled" : "failed",
							receiptPath: join(reviewerController.store.runDirectory(reviewerRunId), "receipt.json"),
							...(reviewerReceipt.finalWorkspaceSha256 ? { workspaceSha256: reviewerReceipt.finalWorkspaceSha256 } : {}),
						};
					}
					checkpoint.reviewerAttempts[reviewerIndex] = reviewerStage;
					checkpoint = await checkpointStore.write(checkpoint);
				}
				if (reviewerStage.status === "failed" || reviewerStage.status === "cancelled") {
					await addHistoricalReviewer(reviewerStage, reviewerIndex);
					reviewerReceipt = undefined;
					reviewerRunId = randomUUID();
					reviewerStage = { runId: reviewerRunId, status: "pending" };
					checkpoint.reviewerAttempts.push(reviewerStage);
					checkpoint = await checkpointStore.write(checkpoint);
					reviewerIndex = checkpoint.reviewerAttempts.length - 1;
					process.stderr.write(`OX_DRIVER_REVIEWER_RETRY_RUN_ID=${reviewerRunId}\n`);
				}
				if (reviewerStage.status !== "pending") {
					reviewerReceipt ??= await inspectChild(reviewerController, reviewerRunId);
					if (!reviewerReceipt) throw new Error("the admitted reviewer stage is running or unresolved; recover or cancel it before resume");
					if (reviewerReceipt.status !== "completed") throw new Error("stored reviewer attempt is not reusable");
					await validateReviewer(reviewerReceipt, builderReceipt.finalWorkspaceSha256);
					reusedStages.push("reviewer");
				} else {
					stage = "reviewer-running";
					activeController = reviewerController;
					activeRunId = reviewerRunId;
					cancellation = undefined;
					reviewerStage = { runId: reviewerRunId, status: "running" };
					checkpoint.reviewerAttempts[reviewerIndex] = reviewerStage;
					checkpoint = await checkpointStore.write(checkpoint);
					await runtime.afterReviewerRunningCheckpoint?.();
					inFlight.updateLane("reviewer", { status: "running", runId: reviewerRunId });
					reviewerReceipt = await reviewerController.run(review, { runId: reviewerRunId });
					reviewerStage = {
						runId: reviewerRunId,
						status: reviewerReceipt.status === "completed" ? "completed" : reviewerReceipt.status === "cancelled" ? "cancelled" : "failed",
						receiptPath: join(reviewerController.store.runDirectory(reviewerRunId), "receipt.json"),
						...(reviewerReceipt.finalWorkspaceSha256 ? { workspaceSha256: reviewerReceipt.finalWorkspaceSha256 } : {}),
					};
					checkpoint.reviewerAttempts[checkpoint.reviewerAttempts.length - 1] = reviewerStage;
					checkpoint = await checkpointStore.write(checkpoint);
					if (reviewerReceipt.status === "completed") await validateReviewer(reviewerReceipt, builderReceipt.finalWorkspaceSha256);
					await runtime.afterReviewerCheckpoint?.();
				}
				workers.push({ ...compactWorkerReceipt(reviewerReceipt, workspace.path, "reviewer"), expectedHarness: options.reviewer });
				inFlight.updateLane("reviewer", { status: "finished" });
				if (cancellation) await cancellation;
				evidence.reviewerReceivedExactBuilderState = reviewerReceipt.initialWorkspaceSha256 === builderReceipt.finalWorkspaceSha256;
				evidence.reviewerChangedWorkspace = reviewerReceipt.postAdapterWorkspaceSha256 !== reviewerReceipt.initialWorkspaceSha256
					|| reviewerReceipt.harnessChangedPaths.length > 0;
				evidence.acceptancePassed = allAcceptancePassed(reviewerReceipt, options.checks.length);
				evidence.acceptanceChangedWorkspace = reviewerReceipt.finalWorkspaceSha256 !== reviewerReceipt.postAdapterWorkspaceSha256
					|| reviewerReceipt.acceptanceChangedPaths.length > 0;
				workspace = await worktreeStore.inspect(worktreeId);
				const intact = workspace.status === "ready" || workspace.status === "dirty" || workspace.status === "advanced";
				status = interrupted || reviewerReceipt.status === "cancelled" ? "cancelled"
					: reviewerReceipt.status === "completed"
						&& evidence.reviewerReceivedExactBuilderState
						&& !evidence.reviewerChangedWorkspace
						&& evidence.acceptancePassed
						&& !evidence.acceptanceChangedWorkspace
						&& intact ? "completed" : "failed";
			}
		}
	} catch (error) {
		status = interrupted ? "cancelled" : "failed";
		failure = { stage, ...compactOrchestrationError(error) };
		if (workspace) workspace = await worktreeStore.inspect(worktreeId).catch(() => workspace);
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}

	const reviewerAttemptCount = checkpoint?.reviewerAttempts.length ?? 1;
	const reportOnlyCeilingUsdMicros = options.builderCostUsdMicros + (options.reviewerCostUsdMicros * reviewerAttemptCount);
	const costSummary = summarizeOrchestrationCosts([...workers, ...historicalReviewerWorkers], reportOnlyCeilingUsdMicros);
	const receiptValue = {
		version: 1,
		kind: "handoff",
		checkpointId: checkpoint?.checkpointId ?? allocation.orchestrationId,
		planSha256: checkpoint?.planSha256,
		resumed,
		reusedStages,
		reviewerAttempts: checkpoint?.reviewerAttempts ?? [],
		historicalReviewerWorkers,
		orchestrationAttempts: checkpoint?.orchestrationAttempts ?? [allocation.orchestrationId],
		orchestrationId: allocation.orchestrationId,
		receiptPath: allocation.receiptPath,
		objective: options.objective,
		status,
		source: workspace?.source ?? options.source,
		requestedRef: options.ref,
		requestedWorktreeId: worktreeId,
		requestedBuilderRunId: builderRunId,
		requestedReviewerRunId: reviewerRunId,
		checksDeclared: options.checks.length > 0,
		reviewerHarness: options.reviewer,
		reportOnlyCeilingUsdMicros,
		...costSummary,
		...(workspace ? { workspace } : {}),
		workers,
		evidence,
		...(failure ? { failure } : {}),
		integrationRecommendation: status === "completed"
			? "inspect-review-receipt-and-worktree-before-integration"
			: workspace ? "inspect-worktree-and-resolve-handoff-failures" : "no-worktree-created",
		notices: [
			"The reviewer ran after the builder on the controller-admitted Git-visible workspace digest; Git-ignored files are outside that digest.",
			"A completed handoff proves sequencing and controller-owned checks. Reviewer prose remains advisory and is available only in its linked run receipt.",
			"The live handoff checkpoint records the managed worktree and preassigned child run ids; the immutable aggregate remains terminal-only.",
		],
		autoMerged: false,
	};
	await inFlight?.flush();
	let receipt: Record<string, unknown>;
	try {
		receipt = await orchestrationStore.persist(receiptValue);
		if (status === "completed" && checkpoint) {
			checkpoint.terminalOrchestrationId = allocation.orchestrationId;
			checkpoint = await checkpointStore.write(checkpoint);
		}
	} catch (error) {
		await inFlight?.markAborted(error instanceof Error ? error.message : String(error)).catch(() => undefined);
		await lease?.release().catch(() => undefined);
		throw error;
	}
	await lease?.release().catch(() => undefined);
	return { exitCode: status === "completed" ? 0 : 1, receipt };
}
