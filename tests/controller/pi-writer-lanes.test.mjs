import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { trackedMkdtemp } from "./helpers/tracked-temp.mjs";
import { OX_DRIVER_SUPPORTS_PI_LANES } from "../../scripts/distribution.mjs";
import {
	effectiveRetryPlanSha256,
	laneWriterPolicy,
	validateEffectiveRetryPlan,
	validateOrchestrationPlan,
} from "../../packages/core/dist/index.js";

const execFileAsync = promisify(execFile);

function writerLane(overrides = {}) {
	return {
		id: "build",
		role: "builder",
		objective: "implement the parser module",
		workerPath: "/tmp/worktrees/build",
		checks: ["npm test"],
		...overrides,
	};
}

function piLane(overrides = {}) {
	return {
		id: "pi",
		role: "pi",
		objective: "implement the loader",
		workerPath: "/tmp/worktrees/pi",
		harness: "pi",
		...overrides,
	};
}

test("laneWriterPolicy keeps OpenCode lanes writers and Pi lanes read-only unless asked", () => {
	assert.equal(laneWriterPolicy({}), "one-writer");
	assert.equal(laneWriterPolicy({ harness: "opencode" }), "one-writer");
	assert.equal(laneWriterPolicy({ harness: "pi" }), "read-only");
	assert.equal(laneWriterPolicy({ harness: "pi", writerPolicy: "read-only" }), "read-only");
	assert.equal(laneWriterPolicy({ harness: "pi", writerPolicy: "one-writer" }), "one-writer");
});

test("a plan accepts a Pi writer lane with owned paths and controller acceptance", () => {
	const plan = validateOrchestrationPlan({ version: 1, lanes: [
		writerLane(),
		piLane({ writerPolicy: "one-writer", ownedPaths: ["src/loader.ts"], checks: ["npm test -- loader"] }),
	] });
	assert.equal(plan.lanes[1].harness, "pi");
	assert.equal(plan.lanes[1].writerPolicy, "one-writer");
	assert.deepEqual(plan.lanes[1].ownedPaths, ["src/loader.ts"]);
	assert.deepEqual(plan.lanes[1].checks, ["npm test -- loader"]);
	assert.equal(Object.isFrozen(plan.lanes[1]), true);
});

test("a plan accepts a herd of Pi writer lanes in distinct worktrees", () => {
	const plan = validateOrchestrationPlan({ version: 1, lanes: [0, 1, 2, 3].map((index) => piLane({
		id: `pi-${index}`,
		role: `pi-${index}`,
		workerPath: `/tmp/worktrees/pi-${index}`,
		writerPolicy: "one-writer",
		ownedPaths: [`src/part-${index}.ts`],
		checks: ["npm test"],
	})) });
	assert.equal(plan.lanes.length, 4);
	assert.equal(new Set(plan.lanes.map((lane) => lane.workerPath)).size, 4);
	assert.ok(plan.lanes.every((lane) => lane.writerPolicy === "one-writer"));
});

test("a Pi writer lane must declare at least one owned path", () => {
	assert.throws(() => validateOrchestrationPlan({ version: 1, lanes: [
		writerLane(),
		piLane({ writerPolicy: "one-writer", checks: ["npm test"] }),
	] }), /writerPolicy "one-writer" requires at least one ownedPaths entry on a Pi lane/);
	assert.throws(() => validateOrchestrationPlan({ version: 1, lanes: [
		writerLane(),
		piLane({ writerPolicy: "one-writer", ownedPaths: [], checks: ["npm test"] }),
	] }), /writerPolicy "one-writer" requires at least one ownedPaths entry on a Pi lane/);
});

test("a read-only Pi lane still refuses owned paths, shell checks, and child agents", () => {
	assert.throws(() => validateOrchestrationPlan({ version: 1, lanes: [
		writerLane(),
		piLane({ ownedPaths: ["src"] }),
	] }), /ownedPaths requires writerPolicy "one-writer" on a Pi lane/);
	assert.throws(() => validateOrchestrationPlan({ version: 1, lanes: [
		writerLane(),
		piLane({ writerPolicy: "read-only", checks: ["npm test"] }),
	] }), /checks is unavailable for read-only Pi lanes/);
	assert.throws(() => validateOrchestrationPlan({ version: 1, lanes: [
		writerLane(),
		piLane({ writerPolicy: "one-writer", ownedPaths: ["src"], checks: ["npm test"], agent: "primary", childAgents: ["researcher"] }),
	] }), /childAgents is unavailable for Pi lanes/);
});

test("writerPolicy rejects unknown values and never turns an OpenCode lane read-only", () => {
	assert.throws(() => validateOrchestrationPlan({ version: 1, lanes: [
		writerLane(),
		piLane({ writerPolicy: "managed-worktrees" }),
	] }), /writerPolicy must be "read-only" or "one-writer"/);
	assert.throws(() => validateOrchestrationPlan({ version: 1, lanes: [
		writerLane({ writerPolicy: "read-only" }),
		piLane(),
	] }), /writerPolicy "read-only" is unavailable for OpenCode lanes/);
	assert.throws(() => validateOrchestrationPlan({ version: 1, lanes: [
		writerLane({ harness: "opencode", writerPolicy: "read-only" }),
		piLane(),
	] }), /writerPolicy "read-only" is unavailable for OpenCode lanes/);
});

test("the published lane schema matches the keys the validator accepts", async () => {
	const schema = JSON.parse(await readFile(new URL("../../schemas/orchestration-plan.schema.json", import.meta.url), "utf8"));
	const lane = schema.$defs.lane;
	assert.deepEqual(Object.keys(lane.properties), [
		"id", "role", "objective", "workerPath", "harness", "writerPolicy", "dependsOn", "route", "agent",
		"childAgents", "ownedPaths", "excludedPaths", "checks", "timeoutSeconds", "costCeilingUsd",
	]);
	assert.deepEqual(lane.properties.writerPolicy, { enum: ["read-only", "one-writer"] });
	assert.equal(lane.additionalProperties, false);
	assert.equal(lane.allOf.length, 6);
	// Every declared key is genuinely accepted, and an undeclared key is not.
	const accepted = validateOrchestrationPlan({ version: 1, lanes: [
		writerLane({ route: "opencode-default", agent: "primary", childAgents: ["researcher"], ownedPaths: ["src"], excludedPaths: ["dist"], timeoutSeconds: 600, costCeilingUsd: 0.05 }),
		piLane({ writerPolicy: "one-writer", dependsOn: ["build"], route: "pi-protected-inherited", ownedPaths: ["docs"], excludedPaths: ["dist"], checks: ["npm test"], timeoutSeconds: 600, costCeilingUsd: 0.05 }),
	] });
	for (const key of Object.keys(lane.properties)) {
		if (key === "harness" || key === "writerPolicy") continue;
		assert.notEqual(accepted.lanes[1][key] ?? accepted.lanes[0][key], undefined, `${key} was dropped by the validator`);
	}
	assert.throws(() => validateOrchestrationPlan({ version: 1, lanes: [
		writerLane({ writerPolicyMode: "one-writer" }),
		piLane(),
	] }), /writerPolicyMode is not supported/);
});

test("an effective retry lane records a Pi writer and rejects one without owned paths", () => {
	const base = {
		id: "pi", role: "pi", objective: "implement", workerPath: "/tmp/worktrees/pi",
		harness: "pi", route: "pi-protected-inherited",
		ownedPaths: ["src"], excludedPaths: [".env", ".git"], checks: ["npm test"],
		timeoutSeconds: 600, reportOnlyCostUsdMicros: 50_000,
	};
	const plan = validateEffectiveRetryPlan({ version: 1, lanes: [{ ...base, writerPolicy: "one-writer" }] });
	assert.equal(plan.lanes[0].writerPolicy, "one-writer");
	assert.throws(
		() => validateEffectiveRetryPlan({ version: 1, lanes: [{ ...base, writerPolicy: "one-writer", ownedPaths: [] }] }),
		/writerPolicy "one-writer" requires at least one owned path/,
	);
	assert.throws(
		() => validateEffectiveRetryPlan({ version: 1, lanes: [{ ...base, writerPolicy: "managed-worktrees" }] }),
		/writerPolicy must be "read-only" or "one-writer"/,
	);
	// A lane that does not declare the field still hashes exactly as it did
	// before the field existed.
	const readOnly = { ...base, ownedPaths: [], checks: [] };
	assert.equal(
		effectiveRetryPlanSha256(validateEffectiveRetryPlan({ version: 1, lanes: [readOnly] })),
		effectiveRetryPlanSha256({ version: 1, lanes: [Object.freeze({
			id: base.id, role: base.role, objective: base.objective, workerPath: base.workerPath,
			harness: "pi", route: base.route, ownedPaths: [], excludedPaths: base.excludedPaths,
			checks: [], timeoutSeconds: base.timeoutSeconds, reportOnlyCostUsdMicros: base.reportOnlyCostUsdMicros,
		})] }),
	);
});

async function piHerdFixture() {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-pi-writer-herd-"));
	const echoDir = join(root, "echo");
	// The OpenCode stand-in records the argv it received so a lane's runner
	// selection and flags stay observable.
	const openCodeRunner = join(root, "opencode-runner.mjs");
	await writeFile(openCodeRunner, `
import { mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const flags = process.argv.slice(4);
const values = (name) => flags.flatMap((value, index) => value === name ? [flags[index + 1]] : []);
mkdirSync(process.env.OX_LANE_ECHO_DIR, { recursive: true });
writeFileSync(process.env.OX_LANE_ECHO_DIR + "/opencode-" + basename(process.argv[2]) + ".json", JSON.stringify({ flags }));
process.stdout.write(JSON.stringify({
  runId: process.env.OX_DRIVER_REQUESTED_RUN_ID, harness: "opencode", status: "completed",
  costReport: { observedUsdMicros: 1000 }, changedPaths: [], unownedChangedPaths: [],
  acceptance: values("--check").map((command) => ({ command, passed: true })),
  effectivePower: { writerPolicy: "one-writer", topology: { requested: "solo", observation: "configured" } },
  finalOutput: "opencode " + basename(process.argv[2]),
}));
`, { mode: 0o700 });
	await chmod(openCodeRunner, 0o700);

	// The Pi stand-in mirrors the real runner's contract: --writer selects the
	// one-writer receipt, and its absence keeps the lane a read-only review.
	const piRunner = join(root, "pi-runner.mjs");
	await writeFile(piRunner, `
import { mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const worker = process.argv[2];
const flags = process.argv.slice(4);
const values = (name) => flags.flatMap((value, index) => value === name ? [flags[index + 1]] : []);
const writer = flags.includes("--writer");
const owned = values("--owned");
const checks = values("--check");
mkdirSync(process.env.OX_LANE_ECHO_DIR, { recursive: true });
writeFileSync(process.env.OX_LANE_ECHO_DIR + "/pi-" + basename(worker) + ".json", JSON.stringify({
  objective: process.argv[3], writer, owned, checks,
  excluded: values("--exclude"), route: values("--route")[0] ?? null, timeout: values("--timeout")[0] ?? null,
  ceiling: values("--cost-ceiling")[0] ?? null, agent: values("--agent"),
}));
if (writer && owned.length === 0) {
  process.stderr.write("--writer requires at least one --owned path\\n");
  process.exitCode = 1;
} else {
  process.stderr.write("OX_DRIVER_RUN_ID=" + process.env.OX_DRIVER_REQUESTED_RUN_ID + "\\n");
  const downgrade = process.env.OX_PI_FAKE_DOWNGRADE === basename(worker);
  process.stdout.write(JSON.stringify({
    runId: process.env.OX_DRIVER_REQUESTED_RUN_ID, harness: "pi", status: "completed",
    costReport: { observedUsdMicros: 3000 },
    requestedRouteProfile: values("--route")[0] ?? "pi-default",
    routeProfileSha256: "b".repeat(64),
    configuredRoute: { provider: "route-provider", model: "route-model", reasoning: "max" },
    changedPaths: writer ? owned : [],
    unownedChangedPaths: [],
    acceptance: checks.map((command) => ({ command, passed: true })),
    effectivePower: {
      writerPolicy: downgrade ? "read-only" : (writer ? "one-writer" : "read-only"),
      topology: { requested: "solo", observation: "configured" },
    },
    finalOutput: (writer ? "pi wrote " : "pi reviewed ") + basename(worker),
  }));
}
`, { mode: 0o700 });
	await chmod(piRunner, 0o700);

	const workers = [];
	for (const name of ["wt-a", "wt-b", "wt-c", "wt-d"]) {
		const path = join(root, name);
		await mkdir(path);
		workers.push(path);
	}
	return { openCodeRunner, piRunner, workers, echoDir, root };
}

async function runHerd(fixture, planDocument, extra = [], extraEnv = {}) {
	const planPath = join(fixture.root, `plan-${Math.random().toString(16).slice(2)}.json`);
	await writeFile(planPath, JSON.stringify(planDocument));
	const state = await trackedMkdtemp(join(tmpdir(), "ox-pi-writer-state-"));
	const env = {
		...process.env,
		XDG_STATE_HOME: state,
		OX_DRIVER_HERD_RUNNER: fixture.openCodeRunner,
		OX_DRIVER_PI_LANE_RUNNER: fixture.piRunner,
		OX_LANE_ECHO_DIR: fixture.echoDir,
		...extraEnv,
	};
	try {
		const result = await execFileAsync(process.execPath, ["scripts/ox_herd.mjs", "--lane-spec", planPath, ...extra], {
			cwd: process.cwd(),
			env,
			maxBuffer: 8 * 1024 * 1024,
		});
		return { code: 0, receipt: JSON.parse(result.stdout), stderr: result.stderr };
	} catch (error) {
		let receipt;
		try { receipt = JSON.parse(error.stdout); } catch { /* the failure happened before any receipt */ }
		return { code: error.code, receipt, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
	}
}

async function echoed(fixture, prefix, workerPath) {
	return JSON.parse(await readFile(join(fixture.echoDir, `${prefix}-${basename(workerPath)}.json`), "utf8"));
}

test("a herd dispatches parallel Pi writer lanes with owned paths and controller acceptance", async (t) => {
	if (!OX_DRIVER_SUPPORTS_PI_LANES) return t.skip("this distribution cannot dispatch Pi lanes");
	const fixture = await piHerdFixture();
	const result = await runHerd(fixture, { version: 1, lanes: [
		{ id: "pi-a", role: "pi-a", objective: "implement the loader", workerPath: fixture.workers[0], harness: "pi", writerPolicy: "one-writer", ownedPaths: ["src/loader.ts"], checks: ["loader-check"] },
		{ id: "pi-b", role: "pi-b", objective: "implement the parser", workerPath: fixture.workers[1], harness: "pi", writerPolicy: "one-writer", ownedPaths: ["src/parser.ts"], checks: ["parser-check"] },
		{ id: "pi-c", role: "pi-c", objective: "implement the printer", workerPath: fixture.workers[2], harness: "pi", writerPolicy: "one-writer", ownedPaths: ["src/printer.ts"] },
	] }, ["--check", "shared-check"]);

	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.receipt.status, "completed");
	assert.equal(result.receipt.completedWorkers, 3);
	assert.deepEqual(result.receipt.workers.map((worker) => worker.harness), ["pi", "pi", "pi"]);
	assert.deepEqual(result.receipt.runners.map((identity) => identity.harness), ["pi"]);

	// Each lane reached the Pi runner as an explicit writer owning only its own
	// path, and every lane ran its own plan check plus the shared one.
	const a = await echoed(fixture, "pi", fixture.workers[0]);
	const b = await echoed(fixture, "pi", fixture.workers[1]);
	const c = await echoed(fixture, "pi", fixture.workers[2]);
	assert.deepEqual([a.writer, b.writer, c.writer], [true, true, true]);
	assert.deepEqual(a.owned, ["src/loader.ts"]);
	assert.deepEqual(b.owned, ["src/parser.ts"]);
	assert.deepEqual(c.owned, ["src/printer.ts"]);
	assert.deepEqual(a.checks, ["loader-check", "shared-check"]);
	assert.deepEqual(c.checks, ["shared-check"]);
	assert.deepEqual(a.agent, []);
	assert.ok(a.excluded.includes(".env") && a.excluded.includes(".git"));

	// The receipt keeps the full per-lane contract, not a thinner writer record.
	for (const worker of result.receipt.workers) {
		assert.equal(worker.status, "completed");
		assert.equal(worker.requestedRouteProfile, "pi-default");
		assert.match(worker.routeProfileSha256, /^[0-9a-f]{64}$/);
		assert.deepEqual(worker.configuredRoute, { provider: "route-provider", model: "route-model", reasoning: "max" });
		assert.equal(worker.effectivePower.writerPolicy, "one-writer");
		assert.equal(worker.observedCostUsdMicros, 3_000);
		assert.deepEqual(worker.unownedChangedPaths, []);
		assert.ok(worker.changedPaths.length > 0);
		assert.equal(worker.acceptance.every((check) => check.passed === true), true);
		assert.match(worker.finalOutputPreview, /^pi wrote /);
	}
	assert.equal(result.receipt.aggregateCostUsdMicros, 9_000);
	assert.equal(result.receipt.reportOnlyCeilingUsdMicros, 250_000);
	assert.equal(result.receipt.integrationRecommendation, "review-worker-diffs-and-integrate-selected-changes");

	// The effective plan records the writer selector so a retry cannot silently
	// continue the lane as a review.
	assert.deepEqual(result.receipt.effectivePlan.lanes.map((lane) => lane.writerPolicy), ["one-writer", "one-writer", "one-writer"]);
	assert.deepEqual(result.receipt.effectivePlan.lanes.map((lane) => lane.ownedPaths), [["src/loader.ts"], ["src/parser.ts"], ["src/printer.ts"]]);
	assert.deepEqual(result.receipt.effectivePlan.lanes[0].checks, ["loader-check", "shared-check"]);
	assert.equal(new Set(result.receipt.effectivePlan.lanes.map((lane) => lane.workerPath)).size, 3);
});

test("a herd mixes an OpenCode writer, a Pi writer, and a Pi reviewer in one run", async (t) => {
	if (!OX_DRIVER_SUPPORTS_PI_LANES) return t.skip("this distribution cannot dispatch Pi lanes");
	const fixture = await piHerdFixture();
	const result = await runHerd(fixture, { version: 1, lanes: [
		{ id: "oc", role: "oc", objective: "build the parser", workerPath: fixture.workers[0], harness: "opencode", checks: ["oc-check"] },
		{ id: "pi-writer", role: "pi-writer", objective: "document the parser", workerPath: fixture.workers[1], harness: "pi", writerPolicy: "one-writer", ownedPaths: ["docs/parser.md"], checks: ["docs-check"] },
		{ id: "pi-review", role: "pi-review", objective: "review the parser", workerPath: fixture.workers[2], harness: "pi" },
	] });

	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.receipt.status, "completed");
	assert.deepEqual(result.receipt.workers.map((worker) => worker.harness), ["opencode", "pi", "pi"]);

	const writer = await echoed(fixture, "pi", fixture.workers[1]);
	const reviewer = await echoed(fixture, "pi", fixture.workers[2]);
	assert.equal(writer.writer, true);
	assert.deepEqual(writer.owned, ["docs/parser.md"]);
	assert.deepEqual(writer.checks, ["docs-check"]);
	// The read-only lane keeps its old contract exactly: no writer flag, no
	// owned paths, and no shell acceptance.
	assert.equal(reviewer.writer, false);
	assert.deepEqual(reviewer.owned, []);
	assert.deepEqual(reviewer.checks, []);
	assert.equal(result.receipt.workers[2].effectivePower.writerPolicy, "read-only");
	assert.deepEqual(result.receipt.effectivePlan.lanes.map((lane) => lane.writerPolicy), ["one-writer", "one-writer", "read-only"]);
	assert.deepEqual(result.receipt.effectivePlan.lanes.map((lane) => lane.ownedPaths), [["."], ["docs/parser.md"], []]);
});

test("a Pi writer lane that returns a read-only receipt fails instead of reporting a writer", async (t) => {
	if (!OX_DRIVER_SUPPORTS_PI_LANES) return t.skip("this distribution cannot dispatch Pi lanes");
	const fixture = await piHerdFixture();
	const result = await runHerd(fixture, { version: 1, lanes: [
		{ id: "pi-a", role: "pi-a", objective: "implement the loader", workerPath: fixture.workers[0], harness: "pi", writerPolicy: "one-writer", ownedPaths: ["src/loader.ts"], checks: ["loader-check"] },
		{ id: "pi-b", role: "pi-b", objective: "implement the parser", workerPath: fixture.workers[1], harness: "pi", writerPolicy: "one-writer", ownedPaths: ["src/parser.ts"], checks: ["parser-check"] },
	] }, [], { OX_PI_FAKE_DOWNGRADE: basename(fixture.workers[1]) });

	assert.equal(result.code, 1);
	assert.equal(result.receipt.status, "failed");
	assert.equal(result.receipt.workers[0].status, "completed");
	assert.equal(result.receipt.workers[1].status, "failed");
	assert.match(result.receipt.workers[1].controllerError, /dispatched with writer policy one-writer and returned a read-only receipt/);
	assert.equal(result.receipt.workers[1].expectedWriterPolicy, "one-writer");
	assert.equal(result.receipt.workers[1].observedWriterPolicy, "read-only");
	assert.equal(result.receipt.integrationRecommendation, "do-not-integrate-until-failures-are-resolved");
});

test("a herd refuses Pi writer lanes that would share one workspace", async (t) => {
	if (!OX_DRIVER_SUPPORTS_PI_LANES) return t.skip("this distribution cannot dispatch Pi lanes");
	const fixture = await piHerdFixture();
	const duplicatePath = await runHerd(fixture, { version: 1, lanes: [
		{ id: "pi-a", role: "pi-a", objective: "implement the loader", workerPath: fixture.workers[0], harness: "pi", writerPolicy: "one-writer", ownedPaths: ["src/loader.ts"], checks: ["loader-check"] },
		{ id: "pi-b", role: "pi-b", objective: "implement the parser", workerPath: fixture.workers[0], harness: "pi", writerPolicy: "one-writer", ownedPaths: ["src/parser.ts"], checks: ["parser-check"] },
	] });
	assert.equal(duplicatePath.code, 1);
	assert.match(duplicatePath.stderr, /duplicates lane worker path/);
	assert.equal(duplicatePath.stderr.includes("OX_DRIVER_ORCHESTRATION_ID"), false);

	// Two distinct declared paths that resolve to one real directory are also
	// refused, before any lane starts.
	const link = join(fixture.root, "wt-a-link");
	await execFileAsync("ln", ["-s", fixture.workers[0], link]);
	const aliasedPath = await runHerd(fixture, { version: 1, lanes: [
		{ id: "pi-a", role: "pi-a", objective: "implement the loader", workerPath: fixture.workers[0], harness: "pi", writerPolicy: "one-writer", ownedPaths: ["src/loader.ts"], checks: ["loader-check"] },
		{ id: "pi-b", role: "pi-b", objective: "implement the parser", workerPath: link, harness: "pi", writerPolicy: "one-writer", ownedPaths: ["src/parser.ts"], checks: ["parser-check"] },
	] });
	assert.equal(aliasedPath.code, 1);
	assert.match(aliasedPath.stderr, /resolve to the same worktree without a dependency ordering/);
	assert.equal(aliasedPath.stderr.includes("OX_DRIVER_ORCHESTRATION_ID"), false);
});

test("a herd rejects an unowned or uncheckable Pi writer lane before allocation", async (t) => {
	if (!OX_DRIVER_SUPPORTS_PI_LANES) return t.skip("this distribution cannot dispatch Pi lanes");
	const fixture = await piHerdFixture();
	const unowned = await runHerd(fixture, { version: 1, lanes: [
		{ id: "pi-a", role: "pi-a", objective: "implement", workerPath: fixture.workers[0], harness: "pi", writerPolicy: "one-writer", checks: ["check"] },
		{ id: "pi-b", role: "pi-b", objective: "implement", workerPath: fixture.workers[1], harness: "pi", writerPolicy: "one-writer", ownedPaths: ["src"], checks: ["check-b"] },
	] });
	assert.equal(unowned.code, 1);
	assert.match(unowned.stderr, /writerPolicy "one-writer" requires at least one ownedPaths entry on a Pi lane/);
	assert.equal(unowned.stderr.includes("OX_DRIVER_ORCHESTRATION_ID"), false);

	// A Pi writer is a writer: it needs a check or an explicit --no-check, the
	// same rule an OpenCode writer follows.
	const uncheckedWriter = await runHerd(fixture, { version: 1, lanes: [
		{ id: "pi-a", role: "pi-a", objective: "implement", workerPath: fixture.workers[0], harness: "pi", writerPolicy: "one-writer", ownedPaths: ["src"] },
		{ id: "pi-review", role: "pi-review", objective: "review", workerPath: fixture.workers[1], harness: "pi" },
	] });
	assert.equal(uncheckedWriter.code, 1);
	assert.match(uncheckedWriter.stderr, /lane pi-a requires at least one plan check/);
	assert.equal(uncheckedWriter.stderr.includes("OX_DRIVER_ORCHESTRATION_ID"), false);

	// The same plan runs once the operator states the decision explicitly.
	const accepted = await runHerd(fixture, { version: 1, lanes: [
		{ id: "pi-a", role: "pi-a", objective: "implement", workerPath: fixture.workers[0], harness: "pi", writerPolicy: "one-writer", ownedPaths: ["src"] },
		{ id: "pi-review", role: "pi-review", objective: "review", workerPath: fixture.workers[1], harness: "pi" },
	] }, ["--no-check"]);
	assert.equal(accepted.code, 0, accepted.stderr);
	assert.equal(accepted.receipt.checksDeclared, false);
});
