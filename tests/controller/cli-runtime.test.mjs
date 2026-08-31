import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RunStore } from "../../packages/core/dist/index.js";
import { createController, createStateController, handoffRuntime } from "../../packages/cli/dist/runtime.js";
import { trackedMkdtemp } from "./helpers/tracked-temp.mjs";

function restoreEnvironment(name, value) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function qualifiedPiDoctor() {
	// Shape the Pi adapter's own preflight contract relies on for the
	// trusted-host tier: an execution-qualified probe from doctor().
	return { probe: { executionQualified: true } };
}

function piReviewerSpec(cwd) {
	return {
		version: 1,
		tier: "trusted-host",
		harness: "pi",
		routeProfile: "pi-protected-inherited",
		task: {
			objective: "Review the workspace read-only",
			cwd,
			ownedPaths: [],
			excludedPaths: [".env", ".git"],
		},
		execution: {
			session: "ephemeral",
			topology: "solo",
			writerPolicy: "read-only",
			network: "configured",
			timeoutSeconds: 60,
			reportOnlyCostUsdMicros: 50_000,
		},
		acceptance: {
			commands: [],
			requireCleanUnownedPaths: true,
			continueOnFailure: true,
		},
	};
}

async function withPiEnvironment(callback) {
	const saved = {
		trustedHost: process.env.OX_DRIVER_PI_TRUSTED_HOST,
		readOnly: process.env.OX_DRIVER_PI_READ_ONLY,
		launcher: process.env.OX_DRIVER_PI_LAUNCHER,
		routeProfileDirectory: process.env.OX_DRIVER_ROUTE_PROFILE_DIR,
	};
	delete process.env.OX_DRIVER_PI_TRUSTED_HOST;
	delete process.env.OX_DRIVER_PI_READ_ONLY;
	delete process.env.OX_DRIVER_PI_LAUNCHER;
	const routeProfileDirectory = await trackedMkdtemp(join(tmpdir(), "ox-cli-runtime-routes-"));
	process.env.OX_DRIVER_ROUTE_PROFILE_DIR = routeProfileDirectory;
	try {
		return await callback(routeProfileDirectory);
	} finally {
		restoreEnvironment("OX_DRIVER_PI_TRUSTED_HOST", saved.trustedHost);
		restoreEnvironment("OX_DRIVER_PI_READ_ONLY", saved.readOnly);
		restoreEnvironment("OX_DRIVER_PI_LAUNCHER", saved.launcher);
		restoreEnvironment("OX_DRIVER_ROUTE_PROFILE_DIR", saved.routeProfileDirectory);
	}
}

test("passes explicit trusted-host Pi configuration without OX_DRIVER_PI_TRUSTED_HOST", async () => {
	await withPiEnvironment(async () => {
		const cwd = await trackedMkdtemp(join(tmpdir(), "ox-cli-runtime-pi-"));

		// The exact configuration the private handoff path passes.
		const { piAdapter } = await createController({ harness: "pi" }, { piTrustedHostDispatch: true });
		const enabledIssues = await piAdapter.preflight(piReviewerSpec(cwd), qualifiedPiDoctor());
		assert.ok(!enabledIssues.some((issue) => issue.code === "PI_TRUSTED_HOST_DISABLED"));
		assert.ok(enabledIssues.some((issue) => issue.code === "PI_TRUSTED_HOST_RESIDUAL_RISK"));

		// Without explicit configuration the ambient environment stays off.
		const { piAdapter: ambientAdapter } = await createController({ harness: "pi" });
		const ambientIssues = await ambientAdapter.preflight(piReviewerSpec(cwd), qualifiedPiDoctor());
		assert.ok(ambientIssues.some((issue) => issue.code === "PI_TRUSTED_HOST_DISABLED"));
	});
});

test("handoffRuntime wires the Pi reviewer lane as an explicitly trusted host", async () => {
	await withPiEnvironment(async (routeProfileDirectory) => {
		const cwd = await trackedMkdtemp(join(tmpdir(), "ox-cli-runtime-handoff-"));
		await writeFile(join(routeProfileDirectory, "opencode-default.json"), JSON.stringify({
			version: 1,
			id: "opencode-default",
			status: "active",
			harness: "opencode",
			tier: "trusted-host",
			launcher: { command: "opencode", versionArgs: ["--version"] },
			route: { source: "explicit", provider: "fixture", model: "fixture", reasoning: "max" },
			pricingPolicy: "report-only",
		}));
		const runtime = handoffRuntime();

		const controller = await runtime.createController({ harness: "pi" });
		const issues = await controller.registry.get("pi").preflight(piReviewerSpec(cwd), qualifiedPiDoctor());
		assert.ok(!issues.some((issue) => issue.code === "PI_TRUSTED_HOST_DISABLED"));

		// Builder route resolution still uses the reviewed OpenCode profile path.
		const builderProfile = await runtime.resolveBuilderProfile(undefined);
		assert.match(builderProfile.id, /^opencode-(default|ambient)$/);
		assert.equal(builderProfile.configuredRoute.reasoning.length > 0, true);
	});
});

test("the registered Pi adapter still rejects attested dispatch without digest pins", async () => {
	await withPiEnvironment(async () => {
		const cwd = await trackedMkdtemp(join(tmpdir(), "ox-cli-runtime-attested-"));
		const { piAdapter } = await createController({ harness: "pi" }, { piTrustedHostDispatch: true });
		const attestedSpec = {
			...piReviewerSpec(cwd),
			tier: "attested",
			execution: { ...piReviewerSpec(cwd).execution, reportOnlyCostUsdMicros: 50_000 },
		};
		const issues = await piAdapter.preflight(attestedSpec, {
			probe: { executionQualified: true },
			capabilities: { "sandbox.filesystem": true },
		});
		assert.ok(issues.some((issue) => issue.code === "PI_EXECUTION_NOT_QUALIFIED"));
	});
});

function runCli(args, env) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [join("packages", "cli", "dist", "main.js"), ...args], {
			cwd: join(import.meta.dirname, "..", ".."),
			env: { ...env, PATH: process.env.PATH },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
	});
}

test("private inspect, cancel, and recover work without an installed OpenCode route profile", async () => {
	const stateRoot = await trackedMkdtemp(join(tmpdir(), "ox-cli-runtime-state-"));
	// A missing default profile id proves none of these commands resolve or
	// require an OpenCode route profile.
	const env = {
		OX_DRIVER_STATE_DIR: stateRoot,
		OX_DRIVER_OPENCODE_PROFILE: "missing-profile",
	};
	const unknownId = randomUUID();

	const inspected = await runCli(["inspect", unknownId], env);
	assert.notEqual(inspected.exitCode, 0);
	assert.doesNotMatch(inspected.stderr, /route profile/);

	const recovered = await runCli(["recover", unknownId], env);
	assert.equal(recovered.exitCode, 2);
	assert.deepEqual(JSON.parse(recovered.stdout), {
		runId: unknownId,
		released: false,
		reason: "run state or receipt is unavailable",
	});

	const cancelled = await runCli(["cancel", unknownId], env);
	assert.equal(cancelled.exitCode, 1);
	assert.match(cancelled.stderr, new RegExp(`run ${unknownId} has no recoverable process state`));
});

test("cancel of a finished run fails with its concrete status", async () => {
	const stateRoot = await trackedMkdtemp(join(tmpdir(), "ox-cli-runtime-state-"));
	const store = new RunStore(stateRoot, join(stateRoot, "leases"));
	const runId = randomUUID();
	await store.create(runId, {
		version: 1,
		tier: "trusted-host",
		harness: "fake",
		routeProfile: "fixture",
		task: { objective: "finished", cwd: stateRoot, ownedPaths: [], excludedPaths: [] },
		execution: {
			session: "ephemeral",
			topology: "solo",
			writerPolicy: "read-only",
			network: "none",
			timeoutSeconds: 10,
		},
		acceptance: { commands: [], requireCleanUnownedPaths: true },
	});
	await store.writeStatus(runId, "completed");

	const cancelled = await runCli(["cancel", runId], { OX_DRIVER_STATE_DIR: stateRoot });
	assert.equal(cancelled.exitCode, 1);
	assert.match(cancelled.stderr, new RegExp(`run ${runId} is completed, not running`));
});

test("createStateController does not resolve route profiles or adapters", async () => {
	const stateRoot = await trackedMkdtemp(join(tmpdir(), "ox-cli-runtime-state-"));
	const previousState = process.env.OX_DRIVER_STATE_DIR;
	const previousProfile = process.env.OX_DRIVER_OPENCODE_PROFILE;
	process.env.OX_DRIVER_STATE_DIR = stateRoot;
	process.env.OX_DRIVER_OPENCODE_PROFILE = "missing-profile";
	try {
		const controller = createStateController();
		assert.deepEqual(controller.registry.list(), []);
	} finally {
		restoreEnvironment("OX_DRIVER_STATE_DIR", previousState);
		restoreEnvironment("OX_DRIVER_OPENCODE_PROFILE", previousProfile);
	}
});
