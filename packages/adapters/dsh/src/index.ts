import { join } from "node:path";

import { ProbeOnlyAdapter } from "@ox-driver/adapter-probe-only";
import type {
	AdapterRunContext,
	AdapterRunResult,
	HarnessAdapter,
	HarnessCapabilities,
	PreflightIssue,
	RunSpec,
} from "@ox-driver/core";

export interface DshAdapterOptions {
	root: string;
	launcher?: string;
}

export class DshAdapter implements HarnessAdapter {
	readonly id = "dsh-sdk-v1-quarantined";
	readonly harness = "dsh";
	readonly #probe: ProbeOnlyAdapter;

	constructor(options: DshAdapterOptions) {
		const launcher = options.launcher ?? join(options.root, "node_modules", ".bin", "dsh");
		this.#probe = new ProbeOnlyAdapter({
			id: this.id,
			harness: this.harness,
			launcher,
			expectedVersion: "0.1.1-rc.2",
			expectedLauncherSha256: "c0226687bb20f45c603ec6fe50f3de16d1c3510c3a803304ec575ef9bc366c62",
			expectedVersionCommandSha256: "c0226687bb20f45c603ec6fe50f3de16d1c3510c3a803304ec575ef9bc366c62",
			invokeVersionProbe: false,
				evidencePaths: [{
					label: "frozen npm dependency graph",
					path: join(options.root, "package-lock.json"),
					expectedSha256: "17953a44e7af0abf59266bbdd3bd7b0731a3b6191de57a544c041d8efb348173",
				}, {
					label: "complete installed DSH tree",
					path: options.root,
					kind: "tree",
					...(process.platform === "darwin" && process.arch === "arm64"
						? { expectedSha256: "870a14719e38168e756bc5688cd8735952a144a5f60fb80edf5ad1ec2d73b7f1" }
						: {}),
				}],
			observations: [
				"Routine host doctor is artifact-only and executes no DSH code.",
				"The reviewed rc.1 Python client inherits ambient environment variables and accepts malformed stdout; Ox does neither.",
				"Static artifact research found distinct SDK, embedded runtime, and initialize identities; routine doctor does not execute initialize or claim wire compatibility.",
				"Ox ships no DSH JSON-RPC decoder, event tracker, approval bridge, or dispatch transport while the upstream protocol lacks causal prompt completion and cancellation.",
			],
			reason: "dispatch remains quarantined because the protocol has no version negotiation, causally bound prompt result, prompt cancellation, or session close, and credential containment, server-request handling, finish-reason success mapping, and request budgeting are not mechanically qualified",
		});
	}

	doctor(): Promise<HarnessCapabilities> {
		return this.#probe.doctor();
	}

	preflight(spec: RunSpec, doctor: HarnessCapabilities): Promise<PreflightIssue[]> {
		return this.#probe.preflight(spec, doctor);
	}

	run(_spec: RunSpec, _context: AdapterRunContext): Promise<AdapterRunResult> {
		return Promise.reject(new Error("DSH adapter execution is quarantined"));
	}
}
