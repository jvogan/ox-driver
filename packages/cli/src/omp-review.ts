import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { OxController, RunReceipt, RunSpec } from "@ox-driver/core";

interface OmpReviewRuntime {
	createController(spec: RunSpec): Promise<OxController>;
}

interface OmpReviewOptions {
	repository: string;
	objective: string;
	excludedPaths: string[];
	checks: string[];
	noCheck: boolean;
	timeoutSeconds: number;
	routeProfile: string;
}

function fail(message: string): never {
	throw new Error(message);
}

function relativeScope(value: string | undefined, flag: string): string {
	if (!value || value.startsWith("/") || value.includes("\0") || value.split(/[\\/]+/).includes("..")) {
		fail(`${flag} must be a relative path that stays inside the review repository`);
	}
	return value;
}

function parseOmpReview(args: string[]): OmpReviewOptions {
	const positional: string[] = [];
	const excludedPaths = [".git", ".env"];
	const checks: string[] = [];
	let noCheck = false;
	let timeoutSeconds = 3_600;
	let routeProfile = process.env.OX_DRIVER_OMP_PROFILE?.trim() || "omp-explicit-isolated";
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--exclude") excludedPaths.push(relativeScope(args[++index], "--exclude"));
		else if (argument === "--check") checks.push(args[++index]?.trim() || fail("--check requires a command"));
		else if (argument === "--no-check") noCheck = true;
		else if (argument === "--route") routeProfile = args[++index]?.trim() || fail("--route requires a profile id");
		else if (argument === "--timeout") {
			timeoutSeconds = Number(args[++index]);
			if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) {
				fail("--timeout must be an integer from 1 to 86400 seconds");
			}
		} else if (argument?.startsWith("--")) fail(`unknown omp-review option: ${argument}`);
		else if (argument !== undefined) positional.push(argument);
	}
	if (positional.length < 2) fail("omp-review requires a repository and objective");
	if (checks.length === 0 && !noCheck) fail("omp-review requires at least one --check or explicit --no-check");
	if (checks.length > 0 && noCheck) fail("--check and --no-check are mutually exclusive");
	return {
		repository: resolve(positional[0]!),
		objective: positional.slice(1).join(" "),
		excludedPaths: [...new Set(excludedPaths)],
		checks: [...new Set(checks)],
		noCheck,
		timeoutSeconds,
		routeProfile,
	};
}

export async function runOmpReview(
	args: string[],
	runtime: OmpReviewRuntime,
): Promise<{ exitCode: number; receipt: RunReceipt }> {
	const options = parseOmpReview(args);
	const cwd = await realpath(options.repository);
	const runId = randomUUID();
	const spec: RunSpec = {
		version: 1,
		tier: "attested",
		harness: "omp",
		routeProfile: options.routeProfile,
		task: {
			objective: options.objective,
			cwd,
			ownedPaths: [],
			excludedPaths: options.excludedPaths,
		},
		execution: {
			session: "ephemeral",
			topology: "solo",
			writerPolicy: "read-only",
			network: "configured",
			timeoutSeconds: options.timeoutSeconds,
		},
		acceptance: {
			commands: options.checks,
			requireCleanUnownedPaths: true,
			timeoutSeconds: options.timeoutSeconds,
			continueOnFailure: true,
		},
	};
	const controller = await runtime.createController(spec);
	let cancellation: Promise<unknown> | undefined;
	const onSignal = () => {
		cancellation ??= controller.cancel(runId).catch(() => undefined);
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	process.stderr.write(`OX_DRIVER_RUN_ID=${runId}\n`);
	try {
		const receipt = await controller.run(spec, { runId });
		if (cancellation) await cancellation;
		return { exitCode: receipt.status === "completed" ? 0 : 1, receipt };
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
}
