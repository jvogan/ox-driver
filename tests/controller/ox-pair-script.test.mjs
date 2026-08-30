import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { trackedMkdtemp } from "./helpers/tracked-temp.mjs";

const execFileAsync = promisify(execFile);
const PAIR_STDERR_SECRET = "PAIR_STDERR_SECRET_MUST_NOT_REACH_AGGREGATE";

async function fixtureRunner() {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-pair-runner-"));
	const runner = join(root, "runner.mjs");
	await writeFile(runner, `
import { basename } from "node:path";
const worker = process.argv[2];
const name = basename(worker);
if (name.includes("slow")) {
  const runId = process.env.OX_DRIVER_REQUESTED_RUN_ID;
  process.stderr.write("OX_DRIVER_RUN_ID=" + runId + "\\n");
  const finish = () => {
    process.stdout.write(JSON.stringify({
      runId, harness: "opencode", status: "cancelled", costReport: { observedUsdMicros: 0 },
      changedPaths: [], unownedChangedPaths: [], acceptance: []
    }));
    process.exit(1);
  };
  process.on("SIGTERM", finish);
  process.on("SIGINT", finish);
  setInterval(() => {}, 1000);
}
else if (name.includes("invalid")) {
  process.stdout.write("not json\\n");
  process.stderr.write(name.includes("secret") ? "${PAIR_STDERR_SECRET}\\n" : "fixture failed before receipt\\n");
  process.exitCode = 1;
}
else {
  const failed = name.includes("failed");
  const cancelled = name.includes("cancelled");
  const cost = name.includes("expensive") ? 90000 : 10000;
  const receipt = {
    version: 1,
    runId: name.includes("wrong-run-id") ? "11111111-1111-4111-8111-111111111111" : process.env.OX_DRIVER_REQUESTED_RUN_ID,
    ...(name.includes("missing-harness") ? {} : { harness: name.includes("wrong-harness") ? "unsupported" : "opencode" }),
    status: cancelled ? "cancelled" : failed ? "failed" : "completed",
    ...(name.includes("nocost") ? {} : { costReport: { observedUsdMicros: cost } }),
    changedPaths: [name + ".txt"],
    unownedChangedPaths: [],
    acceptance: [{ command: "fixture", passed: !failed }],
    finalOutput: name.includes("oversized") ? "x".repeat(3 * 1024 * 1024) : "output " + name
  };
  if (name.includes("wrong-marker")) process.stderr.write("OX_DRIVER_RUN_ID=22222222-2222-4222-8222-222222222222\\n");
  if (name.includes("banner")) process.stdout.write('runner banner {"kind":"diagnostic"}\\n');
  process.stdout.write(JSON.stringify(receipt));
  if (receipt.status !== "completed") process.exitCode = 1;
}
`, { mode: 0o700 });
	await chmod(runner, 0o700);
	return runner;
}

async function workers(...names) {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-pair-workers-"));
	const paths = [];
	for (const name of names) {
		const path = join(root, name);
		await mkdir(path);
		paths.push(path);
	}
	return paths;
}

async function invoke(workerPaths, extra = []) {
	const args = ["scripts/ox_pair.mjs", "implement fixture",
		...workerPaths.flatMap((path) => ["--worker", path]),
		"--no-check",
		...extra,
	];
	const state = await trackedMkdtemp(join(tmpdir(), "ox-pair-state-"));
	const options = { cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: state, OX_DRIVER_PAIR_RUNNER: await fixtureRunner() }, maxBuffer: 8 * 1024 * 1024 };
	try {
		const result = await execFileAsync(process.execPath, args, options);
		return { code: 0, receipt: JSON.parse(result.stdout), stderr: result.stderr, state };
	} catch (error) {
		return { code: error.code, receipt: JSON.parse(error.stdout), stderr: error.stderr, state };
	}
}

test("pair completes only after two independent completed receipts", async () => {
	const result = await invoke(await workers("alpha", "beta"), ["--role", "builder", "--role", "reviewer", "--cost-ceiling", "0.05"]);
	assert.equal(result.code, 0);
	assert.equal(result.receipt.status, "completed");
	assert.equal(result.receipt.failurePolicy, "collect");
	assert.equal(result.receipt.aggregateCostUsdMicros, 20_000);
	assert.equal(result.receipt.costStatus, "within-ceiling");
	assert.deepEqual(result.receipt.workers.map((item) => item.role), ["builder", "reviewer"]);
	assert.deepEqual(result.receipt.workers.map((item) => item.reportOnlyCeilingUsdMicros), [25_000, 25_000]);
	assert.equal(result.receipt.runners[0].harness, "opencode");
	assert.equal(result.receipt.runners[0].source, "environment-override");
	assert.match(result.receipt.runners[0].sha256, /^[0-9a-f]{64}$/);
	assert.equal(result.receipt.autoMerged, false);
	assert.equal(result.receipt.integrationRecommendation, "review-both-diffs-and-integrate");
	assert.match(result.receipt.orchestrationId, /^[0-9a-f-]{36}$/);
	assert.equal(result.stderr, `OX_DRIVER_ORCHESTRATION_ID=${result.receipt.orchestrationId}\n`);
	assert.deepEqual(JSON.parse(await readFile(result.receipt.receiptPath, "utf8")), result.receipt);
	const inspected = JSON.parse((await execFileAsync(process.execPath, [
		"scripts/ox_orchestration.mjs", "inspect", result.receipt.orchestrationId,
	], { cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: result.state } })).stdout);
	assert.deepEqual(inspected, result.receipt);
	const listed = JSON.parse((await execFileAsync(process.execPath, [
		"scripts/ox_orchestration.mjs", "list",
	], { cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: result.state } })).stdout);
	assert.deepEqual(listed.orchestrations.map((item) => item.orchestrationId), [result.receipt.orchestrationId]);
	assert.deepEqual(listed.unreadable, []);
});

test("pair requires an explicit acceptance decision before allocation", async () => {
	const workerPaths = await workers("alpha", "beta");
	const state = await trackedMkdtemp(join(tmpdir(), "ox-pair-state-"));
	await assert.rejects(
		execFileAsync(process.execPath, ["scripts/ox_pair.mjs", "implement fixture", ...workerPaths.flatMap((path) => ["--worker", path])], {
			cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: state, OX_DRIVER_PAIR_RUNNER: await fixtureRunner() },
		}),
		/pair requires at least one --check or explicit --no-check/,
	);
});

test("pair preserves a failed child receipt and refuses integration", async () => {
	const result = await invoke(await workers("alpha", "failed-beta"));
	assert.equal(result.code, 1);
	assert.equal(result.receipt.status, "failed");
	assert.match(result.receipt.workers[1].runId, /^[0-9a-f-]{36}$/);
	assert.equal(result.receipt.workers[1].status, "failed");
	assert.equal(result.receipt.workers[1].finalOutput, undefined);
	assert.equal(result.receipt.workers[1].finalOutputEvidence.redacted, true);
	assert.equal(result.receipt.integrationRecommendation, "do-not-integrate-until-failures-are-resolved");
});

test("pair records invalid runner output without inventing a child receipt", async () => {
	const result = await invoke(await workers("alpha", "invalid-beta"));
	assert.equal(result.code, 1);
	assert.equal(result.receipt.workers[1].status, "failed");
	assert.match(result.receipt.workers[1].controllerError, /valid Ox receipt|JSON/);
	assert.equal("runnerStderr" in result.receipt.workers[1], false);
	assert.equal(result.receipt.workers[1].runnerStderrEvidence.redacted, true);
	assert.equal(result.receipt.workers[1].runnerStderrEvidence.bytes, Buffer.byteLength("fixture failed before receipt\n"));
	assert.equal("runId" in result.receipt.workers[1], false);
	assert.equal(result.receipt.aggregateCostUsdMicros, null);
	assert.equal(result.receipt.knownCostUsdMicros, 10_000);
	assert.equal(result.receipt.costEvidence, "partial");
	assert.deepEqual(result.receipt.unavailableCostLaneIds, ["worker-2"]);
	assert.equal(result.receipt.costStatus, "partial");
});

test("pair rejects missing or wrong harness identity and any run-id mismatch", async () => {
	for (const name of ["missing-harness-beta", "wrong-harness-beta", "wrong-run-id-beta", "wrong-marker-beta"]) {
		const result = await invoke(await workers("alpha", name));
		assert.equal(result.code, 1, name);
		assert.equal(result.receipt.workers[1].status, "failed", name);
		assert.equal(result.receipt.workers[1].expectedHarness, "opencode", name);
		assert.match(result.receipt.workers[1].controllerError, /valid Ox receipt|harness|run id/, name);
	}
});

test("pair preserves known spend when one completed lane lacks cost telemetry", async () => {
	const result = await invoke(await workers("alpha", "nocost-beta"), ["--cost-ceiling", "0.05"]);
	assert.equal(result.code, 0);
	assert.equal(result.receipt.aggregateCostUsdMicros, null);
	assert.equal(result.receipt.knownCostUsdMicros, 10_000);
	assert.equal(result.receipt.costEvidence, "partial");
	assert.deepEqual(result.receipt.unavailableCostLaneIds, ["worker-2"]);
	assert.equal(result.receipt.costStatus, "partial");
});

test("pair stores only redacted evidence for child stderr", async () => {
	const result = await invoke(await workers("alpha", "invalid-secret-beta"));
	const worker = result.receipt.workers[1];
	const expected = Buffer.from(`${PAIR_STDERR_SECRET}\n`, "utf8");
	assert.equal(worker.status, "failed");
	assert.equal("runnerStderr" in worker, false);
	assert.deepEqual(worker.runnerStderrEvidence, {
		redacted: true,
		bytes: expected.length,
		sha256: createHash("sha256").update(expected).digest("hex"),
	});
	const persisted = await readFile(result.receipt.receiptPath, "utf8");
	assert.doesNotMatch(JSON.stringify(result.receipt), new RegExp(PAIR_STDERR_SECRET));
	assert.doesNotMatch(persisted, new RegExp(PAIR_STDERR_SECRET));
});

test("pair extracts the final receipt after unrelated runner JSON", async () => {
	const result = await invoke(await workers("banner-alpha", "beta"));
	assert.equal(result.code, 0);
	assert.match(result.receipt.workers[0].runId, /^[0-9a-f-]{36}$/);
});

test("pair splits an odd aggregate micro ceiling exactly", async () => {
	const result = await invoke(await workers("alpha", "beta"), ["--cost-ceiling", "0.000021"]);
	assert.deepEqual(result.receipt.workers.map((item) => item.reportOnlyCeilingUsdMicros), [10, 11]);
	assert.equal(result.receipt.workers.reduce((sum, item) => sum + item.reportOnlyCeilingUsdMicros, 0), 21);
});

test("pair records an exceeded report-only cost target without invalidating completed work", async () => {
	const result = await invoke(await workers("expensive-alpha", "beta"), ["--cost-ceiling", "0.05"]);
	assert.equal(result.code, 0);
	assert.equal(result.receipt.aggregateCostUsdMicros, 100_000);
	assert.equal(result.receipt.costStatus, "exceeded");
	assert.equal(result.receipt.status, "completed");
});

test("pair turns SIGINT into child cancellation and a final aggregate receipt", async () => {
	const workerPaths = await workers("slow-alpha", "slow-beta");
	const runner = await fixtureRunner();
	const state = await trackedMkdtemp(join(tmpdir(), "ox-pair-cancel-state-"));
	const child = spawn(process.execPath, [
		"scripts/ox_pair.mjs", "wait for cancellation",
		...workerPaths.flatMap((path) => ["--worker", path]),
		"--no-check",
	], {
		cwd: process.cwd(),
		env: { ...process.env, XDG_STATE_HOME: state, OX_DRIVER_PAIR_RUNNER: runner },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	// A fixed delay races module loading under suite load and the signal kills
	// the process before its handlers exist. The allocation marker is printed
	// only after the signal handlers are installed.
	for (let attempt = 0; attempt < 400 && !stderr.includes("OX_DRIVER_ORCHESTRATION_ID="); attempt += 1) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	assert.ok(stderr.includes("OX_DRIVER_ORCHESTRATION_ID="), `pair never allocated: ${stderr}`);
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
	child.kill("SIGINT");
	const { code, signal } = await new Promise((resolveClose, rejectClose) => {
		child.once("error", rejectClose);
		child.once("close", (exitCode, exitSignal) => resolveClose({ code: exitCode, signal: exitSignal }));
	});
	assert.equal(signal, null, stderr);
	assert.equal(code, 1);
	const receipt = JSON.parse(stdout);
	assert.equal(receipt.status, "cancelled");
	assert.deepEqual(receipt.workers.map((item) => item.status), ["cancelled", "cancelled"]);
	assert.ok(receipt.workers.every((item) => typeof item.runId === "string"));
	assert.deepEqual(JSON.parse(await readFile(receipt.receiptPath, "utf8")), receipt);
});
