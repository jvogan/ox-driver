import type { HarnessAdapter } from "./types.js";

export const outerControllerHostIdentifiers = [
	"codex",
	"codex-app-server",
	"openai-codex",
	"claude",
	"claude-code",
	"anthropic",
] as const;

export interface ApprovedAdapterBinding {
	readonly adapterId: string;
	readonly harness: string;
}

export const officialTargetAdapterBindings = Object.freeze([
	Object.freeze({ adapterId: "opencode-v2", harness: "opencode" }),
] satisfies readonly ApprovedAdapterBinding[]);

function normalizedIdentifier(value: string): string {
	return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const outerControllerHostIdentifierSet = new Set<string>(
	outerControllerHostIdentifiers.map((value) => normalizedIdentifier(value)),
);

export function isOuterControllerHostIdentifier(value: string): boolean {
	return outerControllerHostIdentifierSet.has(normalizedIdentifier(value));
}

export class AdapterRegistry {
	readonly #adapters = new Map<string, HarnessAdapter>();
	readonly #approved: ReadonlyMap<string, string> | undefined;

	constructor(options: { approvedAdapters?: readonly ApprovedAdapterBinding[] } = {}) {
		if (!options.approvedAdapters) return;
		const approved = new Map<string, string>();
		for (const binding of options.approvedAdapters) {
			const harness = binding.harness.trim().toLowerCase();
			const adapterId = binding.adapterId.trim();
			if (!harness || harness !== binding.harness || !adapterId || adapterId !== binding.adapterId) {
				throw new Error("approved adapter bindings require canonical non-empty harness and adapter ids");
			}
			if (isOuterControllerHostIdentifier(harness)) {
				throw new Error(`${harness} is an outer controller host and cannot be approved as a target adapter`);
			}
			if (approved.has(harness)) throw new Error(`duplicate approved target harness ${harness}`);
			approved.set(harness, adapterId);
		}
		this.#approved = approved;
	}

	register(adapter: HarnessAdapter): void {
		if (isOuterControllerHostIdentifier(adapter.harness)) {
			throw new Error(`${adapter.harness.trim()} is reserved for an outer controller host and cannot be registered as a harness adapter`);
		}
		if (this.#approved) {
			const approvedId = this.#approved.get(adapter.harness);
			if (!approvedId || approvedId !== adapter.id) {
				throw new Error(`adapter ${adapter.id} is not the approved target binding for harness ${adapter.harness}`);
			}
		}
		if (this.#adapters.has(adapter.harness)) {
			throw new Error(`an adapter is already registered for ${adapter.harness}`);
		}
		this.#adapters.set(adapter.harness, adapter);
	}

	get(harness: string): HarnessAdapter {
		const adapter = this.#adapters.get(harness);
		if (!adapter) throw new Error(`no adapter is registered for ${harness}`);
		return adapter;
	}

	list(): HarnessAdapter[] {
		return [...this.#adapters.values()].sort((left, right) => left.harness.localeCompare(right.harness));
	}
}
