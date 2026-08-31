import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import type {
	AdapterRunContext,
	AdapterRunResult,
	BudgetUsage,
	HarnessAdapter,
	HarnessCapabilities,
	CapabilityMap,
	ConfiguredRoute,
	PreflightIssue,
	RunSpec,
} from "@ox-driver/core";

export interface FakeAdapterOptions {
	status?: AdapterRunResult["status"];
	exitCode?: number | null;
	delayMilliseconds?: number;
	write?: { path: string; content: string };
	capabilities?: CapabilityMap;
	finalOutput?: string | null;
	usage?: BudgetUsage | null;
	observedAgentProfile?: string | null;
	enforceBudgets?: boolean;
	doctorRoute?: ConfiguredRoute;
	runRoute?: ConfiguredRoute;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolveDelay, rejectDelay) => {
		if (signal.aborted) {
			rejectDelay(new DOMException("run cancelled", "AbortError"));
			return;
		}
		const timer = setTimeout(resolveDelay, milliseconds);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			rejectDelay(new DOMException("run cancelled", "AbortError"));
		}, { once: true });
	});
}

export class FakeAdapter implements HarnessAdapter {
	readonly id = "fake-v1";
	readonly harness = "fake";
	readonly #options: FakeAdapterOptions;

	constructor(options: FakeAdapterOptions = {}) {
		this.#options = options;
	}

	#usage(): BudgetUsage | undefined {
		if (this.#options.usage === null) return undefined;
		return this.#options.usage ?? {
			providerRequests: 1,
			toolCalls: this.#options.write ? 1 : 0,
			childrenStarted: 0,
			reportedCostUsdMicros: 0,
			complete: true,
			sources: ["controller"],
			principals: [{
				id: "primary",
				role: "primary",
				providerRequests: 1,
				toolCalls: this.#options.write ? 1 : 0,
				childrenStarted: 0,
				reportedCostUsdMicros: 0,
			}],
			terminationReason: "fixture-completed",
		};
	}

	async doctor(): Promise<HarnessCapabilities> {
		return {
			version: 1,
			adapterId: this.id,
			harness: this.harness,
			compatibility: "verified",
			available: true,
			harnessVersion: "fixture-1",
			configuredRoute: this.#options.doctorRoute ?? { provider: "fixture", model: "deterministic", reasoning: "none" },
			capabilities: {
				"session.ephemeral": true,
				"session.new": true,
				"session.resume": true,
				"session.fork": true,
				"control.cancel": true,
				"control.steer": false,
				"approval.bridge": false,
				"events.structured": true,
				"output.schema": true,
				"route.configured": true,
				"agent.identity": true,
				"telemetry.usage": true,
				"limits.providerRequests": true,
				"limits.toolCalls": true,
				"limits.spend": true,
				"limits.children": true,
				"sandbox.filesystem": true,
				"sandbox.network.open": true,
				"sandbox.network.restricted": true,
				"sandbox.network.none": true,
				"agents.children": true,
				"agents.hierarchical": true,
				"agents.receipts": true,
				"worktree.native": true,
				...this.#options.capabilities,
			},
			notices: [],
		};
	}

	async preflight(spec: RunSpec, _doctor: HarnessCapabilities): Promise<PreflightIssue[]> {
		if (this.#options.enforceBudgets === false) return [];
		const usage = this.#usage();
		const limits = [
			["provider requests", usage?.providerRequests, spec.execution.maxProviderRequests],
			["tool calls", usage?.toolCalls, spec.execution.maxToolCalls],
			["children", usage?.childrenStarted, spec.execution.maxChildren],
			["spend", usage?.reportedCostUsdMicros, spec.execution.maxCostUsdMicros],
		] as const;
		return limits.flatMap(([label, observed, maximum]) => maximum !== undefined && (observed === undefined || observed > maximum)
			? [{ severity: "error" as const, code: "FAKE_BUDGET_EXCEEDED", message: `fixture ${label} would exceed its budget` }]
			: []);
	}

	async run(spec: RunSpec, context: AdapterRunContext): Promise<AdapterRunResult> {
		const usage = this.#usage();
		if (usage && this.#options.enforceBudgets !== false) {
			const route = this.#options.runRoute ?? { provider: "fixture", model: "deterministic", reasoning: "none" };
			const children = usage.principals?.filter((principal) => principal.role === "child") ?? [];
			for (const child of children) {
				context.budget.admitChild({
					principalId: child.id,
					parentId: child.parentId === usage.principals?.find((principal) => principal.role === "primary")?.id
						? context.budget.primaryPrincipalId
						: child.parentId ?? context.budget.primaryPrincipalId,
					requestedProfile: child.requestedProfile ?? "fixture-child",
					requestedRoute: child.requestedRoute ?? route,
				});
			}
			const requestPrincipals = usage.principals
				? usage.principals.flatMap((principal) => Array.from(
					{ length: principal.providerRequests },
					() => principal.role === "primary" ? context.budget.primaryPrincipalId : principal.id,
				))
				: Array.from({ length: usage.providerRequests }, () => context.budget.primaryPrincipalId);
			const requests = requestPrincipals.length;
			const totalReservation = spec.execution.maxCostUsdMicros !== undefined
				? usage.reportedCostUsdMicros ?? spec.execution.maxCostUsdMicros
				: undefined;
			const requestsByPrincipal = new Map<string, number>();
			for (let index = 0; index < requests; index += 1) {
				const principalId = requestPrincipals[index] as string;
				const principal = usage.principals?.find((item) => item.id === principalId || (item.role === "primary" && principalId === context.budget.primaryPrincipalId));
				const principalRequestIndex = requestsByPrincipal.get(principalId) ?? 0;
				const estimatedCostUsdMicros = totalReservation === undefined
					? undefined
					: Math.floor(totalReservation / requests) + (index < totalReservation % requests ? 1 : 0);
				context.budget.reserveProviderRequest({
					principalId,
					purpose: principalRequestIndex === 0
						? (principalId === context.budget.primaryPrincipalId ? "primary" : "child")
						: "auxiliary",
					requestedRoute: principal?.requestedRoute ?? route,
					...(estimatedCostUsdMicros !== undefined ? { estimatedCostUsdMicros } : {}),
				});
				requestsByPrincipal.set(principalId, principalRequestIndex + 1);
			}
			const toolPrincipals = usage.principals
				? usage.principals.flatMap((principal) => Array.from(
					{ length: principal.toolCalls },
					() => principal.role === "primary" ? context.budget.primaryPrincipalId : principal.id,
				))
				: Array.from({ length: usage.toolCalls }, () => context.budget.primaryPrincipalId);
			for (const principalId of toolPrincipals) {
				context.budget.admitToolCall({ principalId, toolName: "fake-tool" });
			}
		}
		await context.emit("agent.started", { fixture: true });
		await delay(this.#options.delayMilliseconds ?? 1, context.signal);
		if (this.#options.write) {
			const target = resolve(spec.task.cwd, this.#options.write.path);
			const local = relative(spec.task.cwd, target);
			if (local.startsWith("..") || resolve(target) === resolve(spec.task.cwd)) {
				throw new Error("fake adapter write escaped the task directory");
			}
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, this.#options.write.content, "utf8");
			await context.emit("tool.completed", { tool: "write", path: local });
		}
		const status = this.#options.status ?? "completed";
		await context.emit("agent.finished", { status });
		return {
			status,
			exitCode: this.#options.exitCode ?? (status === "completed" ? 0 : 1),
			...(this.#options.finalOutput === null
				? {}
				: { finalOutput: this.#options.finalOutput ?? "FAKE_ADAPTER_COMPLETE" }),
			configuredRoute: this.#options.runRoute ?? { provider: "fixture", model: "deterministic", reasoning: "none" },
			...(spec.execution.agentProfile !== undefined && this.#options.observedAgentProfile !== null
				? {
					agentIdentity: {
						requestedProfile: spec.execution.agentProfile,
						observedProfile: this.#options.observedAgentProfile ?? spec.execution.agentProfile,
						role: "primary" as const,
					},
				}
				: {}),
			...(usage ? { usage } : {}),
		};
	}
}
