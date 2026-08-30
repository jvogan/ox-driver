import type { BudgetLedgerSnapshot, ControllerBudgetLedger } from "./budget.js";
import type { DurableProcessIdentity } from "./process.js";

export const capabilityNames = [
	"session.ephemeral",
	"session.new",
	"session.resume",
	"session.fork",
	"control.cancel",
	"control.steer",
	"approval.bridge",
	"events.structured",
	"output.schema",
	"route.configured",
	"agent.identity",
	"telemetry.usage",
	"limits.providerRequests",
	"limits.toolCalls",
	"limits.spend",
	"limits.children",
	"sandbox.filesystem",
	"sandbox.network.open",
	"sandbox.network.restricted",
	"sandbox.network.none",
	"agents.children",
	"agents.hierarchical",
	"agents.receipts",
	"worktree.native",
] as const;

export type CapabilityName = (typeof capabilityNames)[number];
export type CapabilityMap = Partial<Record<CapabilityName, boolean>>;
export type Compatibility = "verified" | "compatible" | "degraded" | "blocked";
export type RunStatus = "completed" | "failed" | "blocked" | "cancelled" | "unknown";
export type RunPhase = "starting" | "adapter-running" | "adapter-finished" | "reconciling" | "acceptance-running" | "finalizing" | "terminal";

export const DEFAULT_ACCEPTANCE_TIMEOUT_SECONDS = 120;
export const MAX_ACCEPTANCE_TIMEOUT_SECONDS = 86_400;

export interface HarnessCapabilities {
	version: 1;
	adapterId: string;
	harness: string;
	compatibility: Compatibility;
	available: boolean;
	executable?: string;
	binarySha256?: string;
	enforcementSha256?: string;
	routeProfileSha256?: string;
	harnessVersion?: string;
	configuredRoute?: ConfiguredRoute;
	probe?: HarnessProbeEvidence;
	capabilities: CapabilityMap;
	notices: string[];
}

export interface HarnessProbeEvidence {
	version: 1;
	modelCalls: 0;
	contract: string;
	artifact: "verified" | "drifted" | "unverified";
	executionQualified: boolean;
	protocol?: {
		name: string;
		negotiatedVersion?: number;
		supportedVersions?: number[];
	};
}

export interface RunSpec {
	version: 1;
	tier: "trusted-host" | "attested";
	harness: string;
	routeProfile?: string;
	task: {
		objective: string;
		cwd: string;
		ownedPaths: string[];
		excludedPaths: string[];
		expectedWorkspaceSha256?: string;
	};
	execution: {
		session: "ephemeral" | "new" | "resume" | "fork";
		sessionId?: string;
		agentProfile?: string;
		topology: "solo" | "flat" | "hierarchical";
		writerPolicy: "read-only" | "one-writer" | "managed-worktrees";
		network: "configured" | "open" | "restricted" | "none";
		timeoutSeconds: number;
		expectedRouteProfileSha256?: string;
		childPolicy?: {
			allowedProfiles: string[];
			allowedRoutes: ConfiguredRoute[];
		};
		maxProviderRequests?: number;
		maxToolCalls?: number;
		maxCostUsdMicros?: number;
		reportOnlyCostUsdMicros?: number;
		maxChildren?: number;
	};
	acceptance: {
		commands: string[];
		requireCleanUnownedPaths: boolean;
		timeoutSeconds?: number;
		continueOnFailure?: boolean;
	};
}

export interface PreflightIssue {
	severity: "error" | "warning";
	code: string;
	message: string;
}

export interface PreflightResult {
	ok: boolean;
	doctor: HarnessCapabilities;
	issues: PreflightIssue[];
}

export interface ConfiguredRoute {
	provider: string;
	model: string;
	reasoning: string;
}

export interface AgentRuntimeObservation {
	status: "observed" | "unavailable";
	reason?: string;
}

export interface AgentIdentityEvidence {
	requestedProfile: string;
	configuredProfile?: string;
	/**
	 * Retained for historical receipts and adapters with a runtime identity
	 * signal. A selected argv profile is configuration evidence, not runtime
	 * observation.
	 */
	observedProfile?: string;
	runtimeObservation?: AgentRuntimeObservation;
	role: "primary";
}

export interface UsagePrincipal {
	id: string;
	role: "primary" | "child";
	parentId?: string;
	requestedProfile?: string;
	observedProfile?: string;
	requestedRoute?: ConfiguredRoute;
	observedRoute?: ConfiguredRoute;
	providerRequests: number;
	toolCalls: number;
	childrenStarted: number;
	reportedCostUsdMicros?: number;
}

export interface BudgetUsage {
	providerRequests: number;
	toolCalls: number;
	childrenStarted: number;
	reportedCostUsdMicros?: number;
	tokens?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		reasoning?: number;
		total: number;
	};
	complete: boolean;
	sources: Array<"transport" | "provider" | "harness" | "controller">;
	principals?: UsagePrincipal[];
	terminationReason?: string;
}

export interface RunEvent {
	version: 1;
	sequence: number;
	time: string;
	runId: string;
	adapterId: string;
	type: string;
	data: Record<string, unknown>;
}

export interface AdapterRunResult {
	status: RunStatus;
	exitCode: number | null;
	finalOutput?: string;
	configuredRoute?: ConfiguredRoute;
	agentIdentity?: AgentIdentityEvidence;
	usage?: BudgetUsage;
	notices?: string[];
}

export interface AdapterRunContext {
	runId: string;
	runDirectory: string;
	signal: AbortSignal;
	doctor: HarnessCapabilities;
	budget: ControllerBudgetLedger;
	processes: HarnessProcessAdmissions;
	emit(type: string, data?: Record<string, unknown>): Promise<RunEvent>;
}

export interface HarnessProcessAdmissionInput {
	label: string;
	detachedProcessGroup: boolean;
}

export interface HarnessProcessCompletion {
	exitCode: number | null;
	terminationSignal?: string;
}

export interface HarnessProcessAdmissionHandle {
	readonly admissionId: string;
	bind(pid: number): Promise<DurableProcessIdentity>;
	complete(result: HarnessProcessCompletion): Promise<void>;
	abandon(reason: string): Promise<void>;
}

export interface HarnessProcessAdmissions {
	admit(input: HarnessProcessAdmissionInput): Promise<HarnessProcessAdmissionHandle>;
}

export interface HarnessAdapter {
	readonly id: string;
	readonly harness: string;
	doctor(): Promise<HarnessCapabilities>;
	preflight(spec: RunSpec, doctor: HarnessCapabilities): Promise<PreflightIssue[]>;
	run(spec: RunSpec, context: AdapterRunContext): Promise<AdapterRunResult>;
}

export interface AcceptanceResult {
	command: string;
	passed: boolean;
	durationMs: number;
	timedOut: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	backgroundProcessesDetected: boolean;
	processTreeReaped: boolean;
	terminationEscalated: boolean;
}

export interface RunReceipt {
	version: 1;
	tier: "trusted-host" | "attested";
	runId: string;
	adapterId: string;
	harness: string;
	harnessVersion?: string;
	harnessBinarySha256?: string;
	harnessEnforcementSha256?: string;
	routeProfileSha256?: string;
	status: RunStatus;
	fallbackReceipt?: boolean;
	failurePhase?: RunPhase;
	workspaceEvidenceComplete?: boolean;
	costReport?: {
		mode: "report-only";
		ceilingUsdMicros: number;
		observedUsdMicros?: number;
		status: "within-ceiling" | "exceeded" | "partial" | "unavailable";
	};
	budgetLedger?: BudgetLedgerSnapshot;
	startedAt: string;
	finishedAt: string;
	requestedRouteProfile?: string;
	configuredRoute?: ConfiguredRoute;
	agentIdentity?: AgentIdentityEvidence;
	effectivePower?: EffectivePowerEvidence;
	usage?: BudgetUsage;
	exitCode?: number | null;
	finalOutput?: string;
	acceptance: AcceptanceResult[];
	harnessChangedPaths: string[];
	acceptanceChangedPaths: string[];
	changedPaths: string[];
	unownedChangedPaths: string[];
	initialWorkspaceSha256?: string;
	postAdapterWorkspaceSha256?: string;
	finalWorkspaceSha256?: string;
	patchPath?: string;
	patchSha256?: string;
	patchBaseCommit?: string;
	eventsPath: string;
	eventsSha256: string;
	notices: string[];
}

export interface EffectivePowerEvidence {
	version: 1;
	route: {
		requestedProfile?: string;
		configured?: ConfiguredRoute;
		observed?: ConfiguredRoute;
	};
	agent: {
		requestedProfile?: string;
		configuredProfile?: string;
		observedProfile?: string;
		observation: "observed" | "configured" | "unobservable";
	};
	topology: {
		requested: "solo" | "flat" | "hierarchical";
		childrenObserved?: number;
		observation: "runtime-observed" | "configured";
	};
	writerPolicy: "read-only" | "one-writer" | "managed-worktrees";
	network: "configured" | "open" | "restricted" | "none";
	timeoutSeconds: number;
	limits: Record<"providerRequests" | "toolCalls" | "children" | "costUsdMicros" | "turns" | "context" | "output", {
		state: "explicit" | "report-only" | "unset" | "unobservable";
		value?: number;
		enforcement: "controller" | "telemetry" | "none" | "unobservable";
	}>;
}
