import { randomUUID } from "node:crypto";

import type { ConfiguredRoute, RunSpec } from "./types.js";

export type ProviderRequestPurpose = "primary" | "child" | "retry" | "fallback" | "auxiliary";

export interface ProviderRequestAdmissionInput {
	principalId: string;
	purpose: ProviderRequestPurpose;
	requestedRoute: ConfiguredRoute;
	estimatedCostUsdMicros?: number;
}

export interface ToolCallAdmissionInput {
	principalId: string;
	toolName: string;
}

export interface ChildAdmissionInput {
	principalId: string;
	parentId: string;
	requestedProfile: string;
	requestedRoute: ConfiguredRoute;
}

export interface BudgetAdmission {
	version: 1;
	id: string;
	ordinal: number;
	kind: "provider-request" | "tool-call" | "child-start";
	principalId: string;
	parentId?: string;
	purpose?: ProviderRequestPurpose;
	toolName?: string;
	requestedProfile?: string;
	requestedRoute?: ConfiguredRoute;
	estimatedCostUsdMicros?: number;
}

export interface DeniedBudgetAdmission {
	version: 1;
	ordinal: number;
	kind: BudgetAdmission["kind"];
	principalId: string;
	reason: "unknown-principal" | "duplicate-child" | "topology" | "child-policy" | "route-policy" | "purpose-order" | "provider-request-limit" | "tool-call-limit" | "child-limit" | "spend-estimate-required" | "spend-limit" | "invalid-input";
}

export interface BudgetLedgerSnapshot {
	version: 1;
	primaryPrincipalId: "primary";
	providerRequests: number;
	toolCalls: number;
	childrenStarted: number;
	reservedCostUsdMicros: number;
	admissions: BudgetAdmission[];
	deniedAdmissions: DeniedBudgetAdmission[];
}

export interface ControllerBudgetLedger {
	readonly primaryPrincipalId: "primary";
	reserveProviderRequest(input: ProviderRequestAdmissionInput): BudgetAdmission;
	admitToolCall(input: ToolCallAdmissionInput): BudgetAdmission;
	admitChild(input: ChildAdmissionInput): BudgetAdmission;
	snapshot(): BudgetLedgerSnapshot;
}

export class BudgetAdmissionError extends Error {
	readonly reason: DeniedBudgetAdmission["reason"];

	constructor(reason: DeniedBudgetAdmission["reason"], message: string) {
		super(message);
		this.name = "BudgetAdmissionError";
		this.reason = reason;
	}
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validText(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function validRoute(value: unknown): value is ConfiguredRoute {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const route = value as Record<string, unknown>;
	return validText(route.provider) && validText(route.model) && validText(route.reasoning);
}

function routesEqual(left: ConfiguredRoute, right: ConfiguredRoute): boolean {
	return left.provider === right.provider && left.model === right.model && left.reasoning === right.reasoning;
}

export class RunBudgetLedger implements ControllerBudgetLedger {
	readonly primaryPrincipalId = "primary" as const;
	readonly #execution: Pick<RunSpec["execution"], "topology" | "childPolicy" | "maxProviderRequests" | "maxToolCalls" | "maxCostUsdMicros" | "maxChildren">;
	readonly #principals = new Map<string, { parentId?: string; route?: ConfiguredRoute }>();
	readonly #providerRequestsByPrincipal = new Map<string, number>();
	readonly #admissions: BudgetAdmission[] = [];
	readonly #denied: DeniedBudgetAdmission[] = [];
	readonly #onChange: ((snapshot: BudgetLedgerSnapshot) => void) | undefined;
	#ordinal = 0;
	#providerRequests = 0;
	#toolCalls = 0;
	#childrenStarted = 0;
	#reservedCostUsdMicros = 0;

	constructor(
		execution: RunSpec["execution"],
		options: { primaryRoute?: ConfiguredRoute; onChange?: (snapshot: BudgetLedgerSnapshot) => void } = {},
	) {
		this.#execution = {
			topology: execution.topology,
			...(execution.childPolicy ? {
				childPolicy: {
					allowedProfiles: [...execution.childPolicy.allowedProfiles],
					allowedRoutes: execution.childPolicy.allowedRoutes.map((route) => ({ ...route })),
				},
			} : {}),
			...(execution.maxProviderRequests !== undefined ? { maxProviderRequests: execution.maxProviderRequests } : {}),
			...(execution.maxToolCalls !== undefined ? { maxToolCalls: execution.maxToolCalls } : {}),
			...(execution.maxCostUsdMicros !== undefined ? { maxCostUsdMicros: execution.maxCostUsdMicros } : {}),
			...(execution.maxChildren !== undefined ? { maxChildren: execution.maxChildren } : {}),
		};
		this.#principals.set(this.primaryPrincipalId, {
			...(options.primaryRoute ? { route: { ...options.primaryRoute } } : {}),
		});
		this.#onChange = options.onChange;
	}

	#copyAdmission(admission: BudgetAdmission): BudgetAdmission {
		return {
			...admission,
			...(admission.requestedRoute ? { requestedRoute: { ...admission.requestedRoute } } : {}),
		};
	}

	#deny(kind: BudgetAdmission["kind"], principalId: string, reason: DeniedBudgetAdmission["reason"], message: string): never {
		this.#denied.push({
			version: 1,
			ordinal: (this.#ordinal += 1),
			kind,
			principalId: validText(principalId) ? principalId : "<invalid>",
			reason,
		});
		this.#onChange?.(this.snapshot());
		throw new BudgetAdmissionError(reason, message);
	}

	#requirePrincipal(kind: BudgetAdmission["kind"], principalId: string): void {
		if (!validText(principalId)) this.#deny(kind, principalId, "invalid-input", "budget admission requires a non-empty principal id");
		if (!this.#principals.has(principalId)) this.#deny(kind, principalId, "unknown-principal", `budget admission references unknown principal ${principalId}`);
	}

	#record(admission: Omit<BudgetAdmission, "version" | "id" | "ordinal">): BudgetAdmission {
		const result: BudgetAdmission = {
			version: 1,
			id: randomUUID(),
			ordinal: (this.#ordinal += 1),
			...admission,
		};
		this.#admissions.push(result);
		this.#onChange?.(this.snapshot());
		return this.#copyAdmission(result);
	}

	reserveProviderRequest(input: ProviderRequestAdmissionInput): BudgetAdmission {
		this.#requirePrincipal("provider-request", input.principalId);
		if (!["primary", "child", "retry", "fallback", "auxiliary"].includes(input.purpose)) {
			this.#deny("provider-request", input.principalId, "invalid-input", "provider request admission has an invalid purpose");
		}
		if (!validRoute(input.requestedRoute)) {
			this.#deny("provider-request", input.principalId, "invalid-input", "provider request admission requires an exact route");
		}
		const principal = this.#principals.get(input.principalId) as { parentId?: string; route?: ConfiguredRoute };
		if (!principal.route || !routesEqual(principal.route, input.requestedRoute)) {
			this.#deny("provider-request", input.principalId, "route-policy", "provider request route is not authorized for this principal");
		}
		const priorRequests = this.#providerRequestsByPrincipal.get(input.principalId) ?? 0;
		const isPrimary = input.principalId === this.primaryPrincipalId;
		if ((priorRequests === 0 && input.purpose !== (isPrimary ? "primary" : "child"))
			|| (priorRequests > 0 && (input.purpose === "primary" || input.purpose === "child"))) {
			this.#deny("provider-request", input.principalId, "purpose-order", "provider request purpose is inconsistent with the principal and request order");
		}
		const nextCount = this.#providerRequests + 1;
		if (this.#execution.maxProviderRequests !== undefined && nextCount > this.#execution.maxProviderRequests) {
			this.#deny("provider-request", input.principalId, "provider-request-limit", "provider request budget is exhausted");
		}
		if (input.estimatedCostUsdMicros !== undefined && !isNonNegativeInteger(input.estimatedCostUsdMicros)) {
			this.#deny("provider-request", input.principalId, "invalid-input", "provider request cost reservation must be a non-negative integer");
		}
		if (this.#execution.maxCostUsdMicros !== undefined && input.estimatedCostUsdMicros === undefined) {
			this.#deny("provider-request", input.principalId, "spend-estimate-required", "a spend budget requires a pre-request worst-case cost reservation");
		}
		const estimatedCost = input.estimatedCostUsdMicros ?? 0;
		if (this.#execution.maxCostUsdMicros !== undefined
			&& this.#reservedCostUsdMicros + estimatedCost > this.#execution.maxCostUsdMicros) {
			this.#deny("provider-request", input.principalId, "spend-limit", "provider request cost reservation would exceed the spend budget");
		}
		this.#providerRequests = nextCount;
		this.#providerRequestsByPrincipal.set(input.principalId, priorRequests + 1);
		this.#reservedCostUsdMicros += estimatedCost;
		return this.#record({
			kind: "provider-request",
			principalId: input.principalId,
			purpose: input.purpose,
			requestedRoute: { ...input.requestedRoute },
			...(input.estimatedCostUsdMicros !== undefined ? { estimatedCostUsdMicros: input.estimatedCostUsdMicros } : {}),
		});
	}

	admitToolCall(input: ToolCallAdmissionInput): BudgetAdmission {
		this.#requirePrincipal("tool-call", input.principalId);
		if (!validText(input.toolName)) this.#deny("tool-call", input.principalId, "invalid-input", "tool admission requires a non-empty tool name");
		const nextCount = this.#toolCalls + 1;
		if (this.#execution.maxToolCalls !== undefined && nextCount > this.#execution.maxToolCalls) {
			this.#deny("tool-call", input.principalId, "tool-call-limit", "tool call budget is exhausted");
		}
		this.#toolCalls = nextCount;
		return this.#record({ kind: "tool-call", principalId: input.principalId, toolName: input.toolName });
	}

	admitChild(input: ChildAdmissionInput): BudgetAdmission {
		this.#requirePrincipal("child-start", input.parentId);
		if (!validText(input.principalId) || !validText(input.requestedProfile) || !validRoute(input.requestedRoute)) {
			this.#deny("child-start", input.principalId, "invalid-input", "child admission requires exact principal, profile, and route identity");
		}
		if (this.#principals.has(input.principalId)) this.#deny("child-start", input.principalId, "duplicate-child", "child principal id was already admitted");
		if (this.#execution.topology === "solo"
			|| (this.#execution.topology === "flat" && input.parentId !== this.primaryPrincipalId)) {
			this.#deny("child-start", input.principalId, "topology", "child admission violates the configured topology");
		}
		const childPolicy = this.#execution.childPolicy;
		if (!childPolicy
			|| !childPolicy.allowedProfiles.includes(input.requestedProfile)
			|| !childPolicy.allowedRoutes.some((route) => routesEqual(route, input.requestedRoute))) {
			this.#deny("child-start", input.principalId, "child-policy", "child profile or route is outside the controller-owned child policy");
		}
		const nextCount = this.#childrenStarted + 1;
		if (this.#execution.maxChildren !== undefined && nextCount > this.#execution.maxChildren) {
			this.#deny("child-start", input.principalId, "child-limit", "child-start budget is exhausted");
		}
		this.#childrenStarted = nextCount;
		this.#principals.set(input.principalId, { parentId: input.parentId, route: { ...input.requestedRoute } });
		return this.#record({
			kind: "child-start",
			principalId: input.principalId,
			parentId: input.parentId,
			requestedProfile: input.requestedProfile,
			requestedRoute: { ...input.requestedRoute },
		});
	}

	snapshot(): BudgetLedgerSnapshot {
		return {
			version: 1,
			primaryPrincipalId: this.primaryPrincipalId,
			providerRequests: this.#providerRequests,
			toolCalls: this.#toolCalls,
			childrenStarted: this.#childrenStarted,
			reservedCostUsdMicros: this.#reservedCostUsdMicros,
			admissions: this.#admissions.map((item) => this.#copyAdmission(item)),
			deniedAdmissions: this.#denied.map((item) => ({ ...item })),
		};
	}
}
