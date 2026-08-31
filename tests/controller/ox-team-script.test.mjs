import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { ManagedWorktreeStore } from "../../packages/core/dist/index.js";
import { trackedMkdtemp } from "./helpers/tracked-temp.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
	return execFileAsync("git", ["-c", "user.name=Ox Team Test", "-c", "user.email=ox-team@example.invalid", "-C", cwd, ...args]);
}

async function runner(root, harness) {
	const path = join(root, `${harness}-runner.mjs`);
	await writeFile(path, `
import { mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const harness = ${JSON.stringify(harness)};
const workerPath = process.argv[2];
const objective = process.argv[3];
const flags = process.argv.slice(4);
const values = (name) => flags.flatMap((value, index) => value === name ? [flags[index + 1]] : []);
const writer = harness === "opencode" || flags.includes("--writer");
const status = objective.includes("force failure") ? "failed" : "completed";
mkdirSync(process.env.OX_TEAM_ECHO_DIR, { recursive: true });
writeFileSync(process.env.OX_TEAM_ECHO_DIR + "/" + harness + "-" + basename(workerPath) + ".json", JSON.stringify({
  harness, workerPath, objective, writer,
  owned: values("--owned"), checks: values("--check"),
  expectedWorkspaceSha256: values("--expected-workspace-sha256")[0] ?? null,
}));
process.stdout.write(JSON.stringify({
  runId: process.env.OX_DRIVER_REQUESTED_RUN_ID,
  harness,
  status,
  costReport: { observedUsdMicros: harness === "omp" ? 500 : 1000 },
  changedPaths: writer ? values("--owned") : [],
  unownedChangedPaths: [],
  acceptance: values("--check").map((command) => ({ command, passed: true })),
  finalWorkspaceSha256: "a".repeat(64),
  effectivePower: { writerPolicy: writer ? "one-writer" : "read-only", topology: { requested: "solo", observation: "configured" } },
  finalOutput: harness + " completed " + basename(workerPath),
}));
if (status !== "completed") process.exitCode = 1;
`, { mode: 0o700 });
	await chmod(path, 0o700);
	return path;
}

async function fixture() {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-team-"));
	const echoDir = join(root, "echo");
	const workers = [];
	for (const name of ["one", "two", "three", "four"]) {
		const path = join(root, name);
		await mkdir(path);
		workers.push(path);
	}
	return {
		root,
		echoDir,
		workers,
		runners: {
			opencode: await runner(root, "opencode"),
			pi: await runner(root, "pi"),
			omp: await runner(root, "omp"),
		},
	};
}

async function runTeam(fixture, lanes, extra = [], environment = {}) {
	const planPath = join(fixture.root, `plan-${Math.random().toString(16).slice(2)}.json`);
	await writeFile(planPath, JSON.stringify({ version: 1, lanes }));
	const state = await trackedMkdtemp(join(tmpdir(), "ox-team-state-"));
	try {
		const result = await execFileAsync(process.execPath, ["scripts/ox_team.mjs", "run", planPath, ...extra], {
			cwd: process.cwd(),
			env: {
				...process.env,
				XDG_STATE_HOME: state,
				OX_DRIVER_OPENCODE_LANE_RUNNER: fixture.runners.opencode,
				OX_DRIVER_PI_LANE_RUNNER: fixture.runners.pi,
				OX_DRIVER_OMP_LANE_RUNNER: fixture.runners.omp,
				OX_TEAM_ECHO_DIR: fixture.echoDir,
				...environment,
			},
			maxBuffer: 8 * 1024 * 1024,
		});
		return { code: 0, receipt: JSON.parse(result.stdout), stderr: result.stderr };
	} catch (error) {
		const stdout = error.stdout ?? "";
		return { code: error.code, stdout, receipt: stdout.trim() ? JSON.parse(stdout) : undefined, stderr: error.stderr ?? "" };
	}
}

async function echo(fixture, harness, workerPath) {
	return JSON.parse(await readFile(join(fixture.echoDir, `${harness}-${basename(workerPath)}.json`), "utf8"));
}

test("a four-agent Pi-only team runs without resolving an OpenCode runner", async () => {
	const f = await fixture();
	const lanes = [
		{ id: "research", role: "researcher", objective: "inspect the design", workerPath: f.workers[0], harness: "pi" },
		{ id: "build", role: "builder", objective: "implement the design", workerPath: f.workers[1], harness: "pi", writerPolicy: "one-writer", dependsOn: ["research"], ownedPaths: ["src"], checks: ["npm test"] },
		{ id: "review", role: "reviewer", objective: "review the implementation", workerPath: f.workers[2], harness: "pi", dependsOn: ["build"] },
		{ id: "synthesis", role: "synthesizer", objective: "select the final result", workerPath: f.workers[3], harness: "pi", dependsOn: ["review"] },
	];
	const result = await runTeam(f, lanes);
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(result.receipt.runners.map((item) => item.harness), ["pi"]);
	assert.deepEqual(result.receipt.workers.map((item) => item.laneId), ["research", "build", "review", "synthesis"]);
	assert.ok(result.receipt.workers.every((item) => item.harness === "pi" && item.status === "completed"));
	assert.equal(result.receipt.workerCount, 4);
	const build = await echo(f, "pi", f.workers[1]);
	const synthesis = await echo(f, "pi", f.workers[3]);
	assert.match(build.objective, /Ox team inputs/);
	assert.match(build.objective, /pi completed one/);
	assert.match(synthesis.objective, /pi completed three/);
});

test("a four-agent OpenCode-only team uses the same dependency scheduler", async () => {
	const f = await fixture();
	const lanes = ["research", "build", "test", "synthesis"].map((id, index) => ({
		id,
		role: id,
		objective: `${id} the change`,
		workerPath: f.workers[index],
		harness: "opencode",
		...(index > 0 ? { dependsOn: [["research", "build", "test"][index - 1]] } : {}),
	}));
	const result = await runTeam(f, lanes, ["--no-check"]);
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(result.receipt.runners.map((item) => item.harness), ["opencode"]);
	assert.equal(result.receipt.completedWorkers, 4);
	const final = await echo(f, "opencode", f.workers[3]);
	assert.match(final.objective, /opencode completed three/);
});

test("a four-agent mixed team binds OMP review to a Pi writer workspace", async () => {
	const f = await fixture();
	const lanes = [
		{ id: "research", role: "researcher", objective: "research the change", workerPath: f.workers[0], harness: "opencode", checks: ["research-check"] },
		{ id: "build", role: "builder", objective: "implement the change", workerPath: f.workers[1], harness: "pi", writerPolicy: "one-writer", dependsOn: ["research"], ownedPaths: ["src"], checks: ["build-check"] },
		{ id: "review", role: "reviewer", objective: "review the exact implementation", workerPath: f.workers[1], harness: "omp", writerPolicy: "read-only", dependsOn: ["build"], checks: ["review-check"] },
		{ id: "synthesis", role: "synthesizer", objective: "report the accepted result", workerPath: f.workers[3], harness: "pi", dependsOn: ["review"] },
	];
	const result = await runTeam(f, lanes);
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(result.receipt.runners.map((item) => item.harness), ["opencode", "pi", "omp"]);
	assert.equal(result.receipt.completedWorkers, 4);
	const review = await echo(f, "omp", f.workers[1]);
	assert.equal(review.writer, false);
	assert.deepEqual(review.checks, ["review-check"]);
	assert.equal(review.expectedWorkspaceSha256, "a".repeat(64));
	assert.match(review.objective, /pi completed two/);
});

test("a failed managed-worktree dependency still persists a valid blocked team receipt", async () => {
	const f = await fixture();
	const source = join(f.root, "source");
	await mkdir(source);
	await git(source, "init");
	await writeFile(join(source, "README.md"), "seed\n");
	await git(source, "add", "README.md");
	await git(source, "commit", "-m", "seed");
	const workspaceState = join(f.root, "workspace-state");
	const workspace = await new ManagedWorktreeStore(workspaceState).create(source);
	const lanes = [
		{ id: "build", role: "builder", objective: "force failure", workerPath: workspace.path, harness: "opencode" },
		{ id: "review", role: "reviewer", objective: "review only after build", workerPath: workspace.path, harness: "pi", dependsOn: ["build"] },
	];
	const result = await runTeam(f, lanes, ["--no-check"], { OX_DRIVER_WORKSPACE_STATE_DIR: workspaceState });
	assert.notEqual(result.code, 0);
	assert.equal(result.receipt.status, "failed");
	assert.deepEqual(result.receipt.workers.map((worker) => worker.status), ["failed", "blocked"]);
	assert.ok(result.receipt.workers.every((worker) => worker.worktreeId === workspace.id && worker.baseCommit === workspace.baseCommit));
});
