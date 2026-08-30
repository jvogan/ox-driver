import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { trackedMkdtemp } from "./helpers/tracked-temp.mjs";

const execFileAsync = promisify(execFile);
const HERD_STDERR_SECRET = "HERD_STDERR_SECRET_MUST_NOT_REACH_AGGREGATE";

async function fixture() {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-herd-fixture-"));
	const runner = join(root, "runner.mjs");
	await writeFile(runner, `
import { basename } from "node:path";
const name = basename(process.argv[2]);
if (name.includes("invalid")) {
  process.stdout.write("not json\\n");
  process.stderr.write(name.includes("secret") ? "${HERD_STDERR_SECRET}\\n" : "fixture failed before receipt\\n");
  process.exitCode = 1;
}
else {
const status = name.includes("bad") ? "failed" : "completed";
const cost = name.includes("expensive") ? 90000 : 10000;
process.stdout.write(JSON.stringify({
  runId: process.env.OX_DRIVER_REQUESTED_RUN_ID,
  harness: "opencode",
  status,
  ...(name.includes("nocost") ? {} : { costReport: { observedUsdMicros: cost } }),
  changedPaths: [name + ".txt"],
  unownedChangedPaths: [],
  acceptance: [{ command: "fixture", passed: status === "completed" }],
  finalOutput: name.includes("oversized") ? "x".repeat(3 * 1024 * 1024) : "output " + name
}));
if (status !== "completed") process.exitCode = 1;
}
`, { mode: 0o700 });
	await chmod(runner, 0o700);
	const workers = [];
	for (const name of ["one", "two", "three"]) {
		const path = join(root, name);
		await mkdir(path);
		workers.push(path);
	}
	return { runner, workers, root };
}

async function invoke(paths, runner, extra = []) {
	const args = ["scripts/ox_herd.mjs", "implement bounded lanes", ...paths.flatMap((path) => ["--worker", path]), "--no-check", ...extra];
	const state = await trackedMkdtemp(join(tmpdir(), "ox-herd-state-"));
	try {
		const result = await execFileAsync(process.execPath, args, { cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: state, OX_DRIVER_HERD_RUNNER: runner }, maxBuffer: 4 * 1024 * 1024 });
		return { code: 0, receipt: JSON.parse(result.stdout), stderr: result.stderr, state };
	} catch (error) {
		return { code: error.code, receipt: JSON.parse(error.stdout), stderr: error.stderr, state };
	}
}

test("herd runs three full workers and aggregates their receipts", async () => {
	const { runner, workers } = await fixture();
	const result = await invoke(workers, runner, ["--role", "builder", "--role", "tester", "--role", "reviewer", "--concurrency", "2", "--cost-ceiling", "0.05"]);
	assert.equal(result.code, 0);
	assert.equal(result.receipt.kind, "herd");
	assert.equal(result.receipt.status, "completed");
	assert.equal(result.receipt.failurePolicy, "collect");
	assert.equal(result.receipt.workerCount, 3);
	assert.equal(result.receipt.completedWorkers, 3);
	assert.equal(result.receipt.aggregateCostUsdMicros, 30_000);
	assert.deepEqual(result.receipt.workers.map((item) => item.role), ["builder", "tester", "reviewer"]);
	assert.deepEqual(result.receipt.workers.map((item) => item.reportOnlyCeilingUsdMicros), [16_667, 16_667, 16_666]);
	assert.equal(result.receipt.autoMerged, false);
	assert.equal(result.stderr, `OX_DRIVER_ORCHESTRATION_ID=${result.receipt.orchestrationId}\n`);
	assert.deepEqual(JSON.parse(await readFile(result.receipt.receiptPath, "utf8")), result.receipt);
});

test("herd records an exceeded report-only cost target without invalidating completed work", async () => {
	const { runner, workers, root } = await fixture();
	const expensive = join(root, "expensive-four");
	await mkdir(expensive);
	const result = await invoke([workers[0], workers[1], expensive], runner, ["--cost-ceiling", "0.05"]);
	assert.equal(result.code, 0);
	assert.equal(result.receipt.aggregateCostUsdMicros, 110_000);
	assert.equal(result.receipt.costStatus, "exceeded");
	assert.equal(result.receipt.status, "completed");
});

test("herd retains known spend and names lanes whose cost telemetry is unavailable", async () => {
	const { runner, workers, root } = await fixture();
	const noCost = join(root, "nocost-four");
	await mkdir(noCost);
	const result = await invoke([workers[0], workers[1], noCost], runner, ["--role", "build", "--role", "test", "--role", "review"]);
	assert.equal(result.code, 0);
	assert.equal(result.receipt.aggregateCostUsdMicros, null);
	assert.equal(result.receipt.knownCostUsdMicros, 20_000);
	assert.equal(result.receipt.costEvidence, "partial");
	assert.deepEqual(result.receipt.unavailableCostLaneIds, ["review"]);
	assert.equal(result.receipt.costStatus, "partial");
});

test("herd persists more than eight completed workers", async () => {
	const { runner, root } = await fixture();
	const paths = [];
	for (let index = 0; index < 9; index += 1) {
		const path = join(root, `wide-${index}`);
		await mkdir(path);
		paths.push(path);
	}
	const result = await invoke(paths, runner, ["--concurrency", "4"]);
	assert.equal(result.code, 0);
	assert.equal(result.receipt.status, "completed");
	assert.equal(result.receipt.workerCount, 9);
	assert.equal(result.receipt.workers.length, 9);
	assert.deepEqual(JSON.parse(await readFile(result.receipt.receiptPath, "utf8")), result.receipt);
});

test("herd reaches its 32-worker capability limit with bounded default concurrency", async () => {
	const { runner, root } = await fixture();
	const paths = [];
	for (let index = 0; index < 32; index += 1) {
		const path = join(root, `wide-limit-${index}`);
		await mkdir(path);
		paths.push(path);
	}
	const result = await invoke(paths, runner);
	assert.equal(result.code, 0);
	assert.equal(result.receipt.status, "completed");
	assert.equal(result.receipt.workerCount, 32);
	assert.equal(result.receipt.concurrency, 8);
	assert.equal(result.receipt.workers.length, 32);
});

test("herd stores only redacted evidence for child stderr", async () => {
	const { runner, workers, root } = await fixture();
	const invalid = join(root, "invalid-secret-four");
	await mkdir(invalid);
	const result = await invoke([workers[0], workers[1], invalid], runner);
	const worker = result.receipt.workers[2];
	const expected = Buffer.from(`${HERD_STDERR_SECRET}\n`, "utf8");
	assert.equal(worker.status, "failed");
	assert.equal("runnerStderr" in worker, false);
	assert.deepEqual(worker.runnerStderrEvidence, {
		redacted: true,
		bytes: expected.length,
		sha256: createHash("sha256").update(expected).digest("hex"),
	});
	assert.doesNotMatch(await readFile(result.receipt.receiptPath, "utf8"), new RegExp(HERD_STDERR_SECRET));
});

test("herd compacts eight oversized valid child outputs into a durable terminal aggregate", async () => {
	const { runner, root } = await fixture();
	const oversized = [];
	for (let index = 0; index < 8; index += 1) {
		const path = join(root, `oversized-${index}`);
		await mkdir(path);
		oversized.push(path);
	}
	const result = await invoke(oversized, runner, ["--concurrency", "8"]);
	assert.equal(result.code, 0);
	assert.equal(result.receipt.status, "completed");
	assert.equal(result.receipt.workers.length, 8);
	for (const worker of result.receipt.workers) {
		assert.equal(worker.finalOutput, undefined);
		assert.equal(Buffer.byteLength(worker.finalOutputPreview, "utf8"), 16 * 1024);
		assert.deepEqual(worker.finalOutputEvidence, {
			redacted: true,
			bytes: 3 * 1024 * 1024,
			sha256: createHash("sha256").update("x".repeat(3 * 1024 * 1024)).digest("hex"),
			previewBytes: 16 * 1024,
			truncated: true,
		});
	}
	assert.deepEqual(JSON.parse(await readFile(result.receipt.receiptPath, "utf8")), result.receipt);
});

test("herd preserves failed lanes and blocks integration", async () => {
	const { runner, workers, root } = await fixture();
	const bad = join(root, "bad-four");
	await mkdir(bad);
	const result = await invoke([workers[0], workers[1], bad], runner);
	assert.equal(result.code, 1);
	assert.equal(result.receipt.status, "failed");
	assert.equal(result.receipt.completedWorkers, 2);
	assert.match(result.receipt.workers[2].runId, /^[0-9a-f-]{36}$/);
	assert.equal(result.receipt.workers[2].status, "failed");
	assert.equal(result.receipt.integrationRecommendation, "do-not-integrate-until-failures-are-resolved");
});

test("herd does not start queued lanes after an earlier lane fails", async () => {
	const { runner, workers, root } = await fixture();
	const bad = join(root, "bad-first");
	await mkdir(bad);
	const result = await invoke([bad, workers[0], workers[1]], runner, ["--concurrency", "1", "--failure-policy", "fail-fast"]);
	assert.equal(result.code, 1);
	assert.deepEqual(result.receipt.workers.map((item) => item.status), ["failed", "cancelled", "cancelled"]);
	assert.match(result.receipt.workers[1].controllerError, /not started/);
	assert.match(result.receipt.workers[2].controllerError, /not started/);
});

test("herd requires an explicit acceptance decision before allocation", async () => {
	const { runner, workers } = await fixture();
	const state = await trackedMkdtemp(join(tmpdir(), "ox-herd-state-"));
	await assert.rejects(
		execFileAsync(process.execPath, ["scripts/ox_herd.mjs", "implement bounded lanes", ...workers.flatMap((path) => ["--worker", path])], {
			cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: state, OX_DRIVER_HERD_RUNNER: runner },
		}),
		/herd requires at least one --check or explicit --no-check/,
	);
});

async function laneFixture() {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-herd-lane-"));
	const runner = join(root, "runner.mjs");
	await writeFile(runner, `
import { mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const worker = process.argv[2];
const objective = process.argv[3];
const flags = process.argv.slice(4);
const values = (name) => flags.flatMap((value, index) => value === name ? [flags[index + 1]] : []);
const value = (name) => values(name)[0] ?? null;
mkdirSync(process.env.OX_LANE_ECHO_DIR, { recursive: true });
writeFileSync(process.env.OX_LANE_ECHO_DIR + "/" + basename(worker) + ".json", JSON.stringify({
  objective, route: value("--route"), agent: value("--agent"), timeout: value("--timeout"),
  childAgents: values("--child-agent"), ceiling: value("--cost-ceiling"), checks: values("--check"),
}));
process.stdout.write(JSON.stringify({
  runId: process.env.OX_DRIVER_REQUESTED_RUN_ID, harness: "opencode", status: "completed",
  costReport: { observedUsdMicros: 0 }, changedPaths: [], unownedChangedPaths: [],
  acceptance: values("--check").map((command) => ({ command, passed: true })),
  finalOutput: objective,
}));
`, { mode: 0o700 });
	await chmod(runner, 0o700);
	const workers = [];
	for (const name of ["lane-one", "lane-two", "lane-three"]) {
		const path = join(root, name);
		await mkdir(path);
		workers.push(path);
	}
	return { runner, workers };
}

async function invokeLanes(planDocument, extra, runner, extraEnv = {}) {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-herd-lane-plan-"));
	const planPath = join(root, "plan.json");
	const echoDir = join(root, "echo");
	await writeFile(planPath, JSON.stringify(planDocument));
	const state = await trackedMkdtemp(join(tmpdir(), "ox-herd-lane-state-"));
	try {
		const result = await execFileAsync(process.execPath, ["scripts/ox_herd.mjs", "--lane-spec", planPath, ...extra], {
			cwd: process.cwd(),
			env: { ...process.env, XDG_STATE_HOME: state, OX_DRIVER_HERD_RUNNER: runner, OX_LANE_ECHO_DIR: echoDir, ...extraEnv },
			maxBuffer: 4 * 1024 * 1024,
		});
		return { code: 0, receipt: JSON.parse(result.stdout), stderr: result.stderr, echoDir };
	} catch (error) {
		return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "", echoDir };
	}
}

test("herd lane-spec runs distinct objectives, routes, agents, checks, timeouts, and ceilings", async () => {
	const { runner, workers } = await laneFixture();
	const result = await invokeLanes({ version: 1, lanes: [
		{ id: "build", role: "builder", objective: "build the parser", workerPath: workers[0], route: "route-a", agent: "agent-a", childAgents: ["researcher-a", "reviewer-a"], checks: ["build-check"], timeoutSeconds: 600, costCeilingUsd: 0.02 },
		{ id: "attack", role: "adversary", objective: "break the parser", workerPath: workers[1], route: "route-b", agent: "agent-b", checks: ["attack-check"], timeoutSeconds: 300, costCeilingUsd: 0.01 },
		{ id: "docs", role: "documenter", objective: "document the parser", workerPath: workers[2], route: "route-b", agent: "agent-doc", checks: ["docs-check"], timeoutSeconds: 900, costCeilingUsd: 0.02 },
	]}, [], runner);
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(result.receipt.workers.map((worker) => worker.laneId), ["build", "attack", "docs"]);
	assert.deepEqual(result.receipt.workers.map((worker) => worker.role), ["builder", "adversary", "documenter"]);
	assert.deepEqual(result.receipt.workers.map((worker) => worker.reportOnlyCeilingUsdMicros), [20_000, 10_000, 20_000]);
	const observed = await Promise.all(result.receipt.workers.map(async (worker) => JSON.parse(await readFile(join(result.echoDir, `${basename(worker.workerPath)}.json`), "utf8"))));
	assert.deepEqual(observed.map((item) => item.objective), ["Lane builder: build the parser", "Lane adversary: break the parser", "Lane documenter: document the parser"]);
	assert.deepEqual(observed.map((item) => item.route), ["route-a", "route-b", "route-b"]);
	assert.deepEqual(observed.map((item) => item.agent), ["agent-a", "agent-b", "agent-doc"]);
	assert.deepEqual(observed.map((item) => item.childAgents), [["researcher-a", "reviewer-a"], [], []]);
	assert.deepEqual(observed.map((item) => item.checks), [["build-check"], ["attack-check"], ["docs-check"]]);
});

test("herd lane-spec rejects an invalid plan before allocation or spawn", async () => {
	const { runner, workers } = await laneFixture();
	const result = await invokeLanes({ version: 1, lanes: [
		{ id: "same", role: "builder", objective: "build", workerPath: workers[0], checks: ["check"] },
		{ id: "same", role: "adversary", objective: "break", workerPath: workers[1], checks: ["check"] },
	]}, [], runner);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /duplicates lane id same/);
	assert.equal(result.stderr.includes("OX_DRIVER_ORCHESTRATION_ID"), false);
	assert.equal(existsSync(result.echoDir), false);
});

test("herd lane-spec appends shared checks and rejects mixed homogeneous selectors", async () => {
	const { runner, workers } = await laneFixture();
	const planDocument = { version: 1, lanes: [
		{ id: "build", role: "builder", objective: "build", workerPath: workers[0], checks: ["lane-check"] },
		{ id: "guard", role: "guardian", objective: "guard", workerPath: workers[1] },
	]};
	const result = await invokeLanes(planDocument, ["--check", "shared-check"], runner);
	assert.equal(result.code, 0, result.stderr);
	const observed = await Promise.all(result.receipt.workers.map(async (worker) => JSON.parse(await readFile(join(result.echoDir, `${basename(worker.workerPath)}.json`), "utf8"))));
	assert.deepEqual(observed.map((item) => item.checks), [["lane-check", "shared-check"], ["shared-check"]]);
	const mixed = await invokeLanes(planDocument, ["--worker", workers[2]], runner);
	assert.equal(mixed.code, 1);
	assert.match(mixed.stderr, /--worker cannot be combined with --lane-spec/);
});

test("herd exposes live per-lane status between allocation and its terminal receipt", async () => {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-herd-live-"));
	const runner = join(root, "runner.mjs");
	await writeFile(runner, `
await new Promise((resolve) => setTimeout(resolve, 3000));
process.stdout.write(JSON.stringify({
  runId: process.env.OX_DRIVER_REQUESTED_RUN_ID,
  harness: "opencode",
  status: "completed",
  costReport: { observedUsdMicros: 100 },
  changedPaths: [],
  unownedChangedPaths: [],
  acceptance: [{ command: "fixture", passed: true }],
  finalOutput: "slow output"
}));
`, { mode: 0o700 });
	await chmod(runner, 0o700);
	const workers = [];
	for (const name of ["one", "two"]) {
		const path = join(root, name);
		await mkdir(path);
		workers.push(path);
	}
	const state = await trackedMkdtemp(join(tmpdir(), "ox-herd-live-state-"));
	const env = { ...process.env, XDG_STATE_HOME: state, OX_DRIVER_HERD_RUNNER: runner };
	const list = async () => JSON.parse((await execFileAsync(
		process.execPath,
		["scripts/ox_orchestration.mjs", "list"],
		{ cwd: process.cwd(), env, maxBuffer: 4 * 1024 * 1024 },
	)).stdout);
	const herd = execFileAsync(
		process.execPath,
		["scripts/ox_herd.mjs", "run slowly", "--worker", workers[0], "--worker", workers[1], "--no-check"],
		{ cwd: process.cwd(), env, maxBuffer: 4 * 1024 * 1024 },
	);
	let observed;
	for (let attempt = 0; attempt < 120; attempt += 1) {
		const listing = await list();
		const running = listing.running?.[0];
		if (running && running.lanes.every((lane) => lane.status === "running" && lane.runId)) {
			observed = running;
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.ok(observed, "the herd never appeared in the running listing with active lanes");
	assert.equal(observed.kind, "herd");
	assert.equal(observed.phase, "running");
	assert.equal(observed.stale, false);
	assert.equal(observed.controller.status, "same");
	assert.equal(observed.workerCount, 2);

	const inspected = JSON.parse((await execFileAsync(
		process.execPath,
		["scripts/ox_orchestration.mjs", "inspect", observed.orchestrationId],
		{ cwd: process.cwd(), env, maxBuffer: 4 * 1024 * 1024 },
	)).stdout);
	assert.equal(inspected.inFlight, true);
	assert.equal(inspected.record.orchestrationId, observed.orchestrationId);
	assert.equal(inspected.stale, false);

	const receipt = JSON.parse((await herd).stdout);
	assert.equal(receipt.status, "completed");
	const after = await list();
	assert.deepEqual(after.running, []);
	assert.deepEqual(after.runningUnreadable, []);
	assert.deepEqual(after.orchestrations.map((item) => item.orchestrationId), [receipt.orchestrationId]);
});

