import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { trackedMkdtemp } from "./helpers/tracked-temp.mjs";

const execFileAsync = promisify(execFile);

async function fixture() {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-task-workflow-"));
	const source = join(root, "source");
	const profiles = join(root, "profiles");
	await mkdir(source);
	await mkdir(profiles);
	await execFileAsync("git", ["init", "--quiet"], { cwd: source });
	await writeFile(join(source, "base.txt"), "base\n");
	await execFileAsync("git", ["add", "base.txt"], { cwd: source });
	await execFileAsync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "--quiet", "-m", "base"], { cwd: source });
	const launcher = join(root, "opencode-task-fixture");
	await writeFile(launcher, `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --version) printf '%s\\n' 'opencode task fixture 1.0.0'; exit 0 ;;
  doctor) printf '%s\\n' 'task fixture ready'; exit 0 ;;
esac
[ "\${1:-}" = run ] || exit 20
shift
task_dir=""
objective=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir) task_dir="$2"; shift 2 ;;
    --agent|--model|--variant|--format) shift 2 ;;
    --auto) shift ;;
    *) objective="$1"; shift ;;
  esac
done
mkdir -p "$task_dir/owned"
printf '%s\\n' 'task fixture result' > "$task_dir/owned/result.txt"
case "$objective" in *unowned*) printf '%s\\n' 'outside ownership' > "$task_dir/unowned.txt" ;; esac
case "$objective" in *commit*)
  git -C "$task_dir" add owned/result.txt
  git -C "$task_dir" -c user.name=fixture -c user.email=fixture@invalid commit --quiet -m 'worker commit'
  ;;
esac
case "$objective" in *slow*) sleep 30 ;; esac
printf '%s\\n' \\
  '{"type":"step_start","part":{"type":"step-start"}}' \\
  '{"type":"tool_use","part":{"type":"tool","tool":"write"}}' \\
  '{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls","cost":0.001}}' \\
  '{"type":"step_start","part":{"type":"step-start"}}' \\
  '{"type":"text","part":{"type":"text","text":"task fixture complete"}}' \\
  '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","cost":0.002}}'
`, { mode: 0o700 });
	await chmod(launcher, 0o700);
	await writeFile(join(profiles, "task-route.json"), `${JSON.stringify({
		version: 1,
		id: "task-route",
		status: "active",
		harness: "opencode",
		tier: "trusted-host",
		launcher: {
			command: launcher,
			versionArgs: ["--version"],
			doctor: { args: ["doctor"], requiredText: ["task fixture ready"] },
		},
		route: { source: "explicit", provider: "fixture-provider", model: "fixture-model", reasoning: "high" },
		agent: { defaultProfile: "builder", allowedProfiles: ["builder"] },
		pricingPolicy: "report-only",
		credentialPolicy: "fixture",
	}, null, 2)}\n`);
	const env = {
		...process.env,
		XDG_STATE_HOME: join(root, "xdg-state"),
		OX_DRIVER_WORKSPACE_STATE_DIR: join(root, "workspace-state"),
		OX_DRIVER_STATE_DIR: join(root, "run-state"),
		OX_DRIVER_ROUTE_PROFILE_DIR: profiles,
		OX_DRIVER_OPENCODE_PROFILE: "task-route",
	};
	return { root, source, profiles, env };
}

async function sourceEvidence(source) {
	return {
		head: (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim(),
		status: (await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: source })).stdout,
		base: await readFile(join(source, "base.txt"), "utf8"),
	};
}

async function invokeTask(fixtureValue, objective, checks, extra = []) {
	const bin = join(process.cwd(), "packages", "opencode-cli", "bin", "ox-driver.mjs");
	const args = ["task", fixtureValue.source, objective, "--owned", "owned", "--profile-dir", fixtureValue.profiles,
		...checks.flatMap((command) => ["--check", command]), ...extra];
	try {
		const result = await execFileAsync(bin, args, { cwd: process.cwd(), env: fixtureValue.env, maxBuffer: 8 * 1024 * 1024 });
		return { code: 0, stdout: result.stdout, stderr: result.stderr, receipt: JSON.parse(result.stdout) };
	} catch (error) {
		return { code: error.code, stdout: error.stdout, stderr: error.stderr, receipt: error.stdout ? JSON.parse(error.stdout) : undefined };
	}
}

function marker(stderr, name) {
	return stderr.match(new RegExp(`^${name}=([0-9a-f-]{36})$`, "m"))?.[1];
}

test("installed task help documents its complete useful surface", async () => {
	const bin = join(process.cwd(), "packages", "opencode-cli", "bin", "ox-driver.mjs");
	const result = await execFileAsync(bin, ["task", "--help"], { cwd: process.cwd() });
	for (const flag of ["--ref", "--owned", "--exclude", "--check", "--no-check", "--route", "--profile-dir", "--agent", "--child-agent", "--timeout", "--cost-ceiling"]) {
		assert.match(result.stdout, new RegExp(flag.replace("--", "--")));
	}
});

test("installed task command leaves a passing managed-worktree change with linked durable ids", async () => {
	const value = await fixture();
	const sourceBefore = await sourceEvidence(value.source);
	const result = await invokeTask(value, "write the owned result", ["test -f owned/result.txt"]);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.receipt.kind, "task");
	assert.equal(result.receipt.status, "completed");
	assert.equal(result.receipt.orchestrationId, marker(result.stderr, "OX_DRIVER_TASK_ID"));
	assert.equal(result.receipt.requestedWorktreeId, marker(result.stderr, "OX_DRIVER_WORKTREE_ID"));
	assert.equal(result.receipt.requestedRunId, marker(result.stderr, "OX_DRIVER_RUN_ID"));
	assert.equal(result.receipt.workspace.id, result.receipt.requestedWorktreeId);
	assert.equal(result.receipt.workspace.status, "dirty");
	assert.equal(result.receipt.workers[0].runId, result.receipt.requestedRunId);
	assert.equal(result.receipt.workers[0].status, "completed");
	assert.equal(result.receipt.workers[0].worktreeId, result.receipt.requestedWorktreeId);
	assert.equal(result.receipt.workers[0].baseCommit, result.receipt.workspace.baseCommit);
	assert.deepEqual(result.receipt.workers[0].changedPaths, ["owned/result.txt"]);
	assert.deepEqual(result.receipt.workers[0].unownedChangedPaths, []);
	assert.equal(result.receipt.workers[0].acceptance[0].passed, true);
	assert.equal(result.receipt.autoMerged, false);
	assert.equal(await readFile(join(result.receipt.workspace.path, "owned", "result.txt"), "utf8"), "task fixture result\n");
	assert.deepEqual(await sourceEvidence(value.source), sourceBefore);
	assert.deepEqual(JSON.parse(await readFile(result.receipt.receiptPath, "utf8")), result.receipt);
	const inspected = JSON.parse((await execFileAsync(process.execPath, [
		"scripts/ox_orchestration.mjs", "inspect", result.receipt.orchestrationId,
	], { cwd: process.cwd(), env: value.env })).stdout);
	assert.deepEqual(inspected, result.receipt);
});

test("task preserves a failed-check worktree and durable failed receipts", async () => {
	const value = await fixture();
	const result = await invokeTask(value, "write output then fail acceptance", ["test -f never-created"]);
	assert.equal(result.code, 1);
	assert.equal(result.receipt.status, "failed");
	assert.equal(result.receipt.workspace.status, "dirty");
	assert.equal(result.receipt.workers[0].status, "failed");
	assert.equal(result.receipt.workers[0].acceptance[0].passed, false);
	assert.equal(await readFile(join(result.receipt.workspace.path, "owned", "result.txt"), "utf8"), "task fixture result\n");
	assert.match(result.receipt.integrationRecommendation, /resolve-failures/);
});

test("task accepts a worker commit that advances the admitted base", async () => {
	const value = await fixture();
	const result = await invokeTask(value, "write and commit the owned result", ["test -f owned/result.txt"]);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.receipt.status, "completed");
	assert.equal(result.receipt.workspace.status, "advanced");
	assert.ok(result.receipt.workers[0].changedPaths.includes(".git/HEAD"));
	assert.deepEqual(result.receipt.workers[0].unownedChangedPaths, []);
});

test("task fails on an unowned path and leaves the exact worktree for inspection", async () => {
	const value = await fixture();
	const result = await invokeTask(value, "write an unowned path", ["test -f owned/result.txt"]);
	assert.equal(result.code, 1);
	assert.equal(result.receipt.status, "failed");
	assert.equal(result.receipt.workers[0].status, "failed");
	assert.deepEqual(result.receipt.workers[0].unownedChangedPaths, ["unowned.txt"]);
	assert.equal(await readFile(join(result.receipt.workspace.path, "unowned.txt"), "utf8"), "outside ownership\n");
});

test("task requires checks or an explicit no-check decision before allocating ids", async () => {
	const value = await fixture();
	const result = await invokeTask(value, "missing check decision", []);
	assert.equal(result.code, 1);
	assert.equal(result.stdout, "");
	assert.doesNotMatch(result.stderr, /OX_DRIVER_(?:TASK|WORKTREE|RUN)_ID=/);
	assert.match(result.stderr, /at least one --check or explicit --no-check/);
	const allowed = await invokeTask(value, "explicitly omit checks", [], ["--no-check"]);
	assert.equal(allowed.code, 0, allowed.stderr);
	assert.equal(allowed.receipt.checksDeclared, false);
	const childWithoutPrimary = await invokeTask(value, "delegate without a primary", ["test -f owned/result.txt"], ["--child-agent", "researcher"]);
	assert.equal(childWithoutPrimary.code, 1);
	assert.equal(childWithoutPrimary.stdout, "");
	assert.doesNotMatch(childWithoutPrimary.stderr, /OX_DRIVER_(?:TASK|WORKTREE|RUN)_ID=/);
	assert.match(childWithoutPrimary.stderr, /requires an explicit delegation-capable --agent primary/);
});

test("task resolves its route before creating a managed worktree", async () => {
	const value = await fixture();
	const result = await invokeTask(value, "use a missing route", ["test -f owned/result.txt"], ["--route", "missing-route"]);
	assert.equal(result.code, 1);
	assert.equal(result.receipt.status, "failed");
	assert.equal(result.receipt.workspace, undefined);
	assert.deepEqual(result.receipt.workers, []);
	const records = await access(join(value.env.OX_DRIVER_WORKSPACE_STATE_DIR, "records"))
		.then(() => readdir(join(value.env.OX_DRIVER_WORKSPACE_STATE_DIR, "records")))
		.catch(() => []);
	assert.deepEqual(records, []);
});

test("task cancellation preserves its managed worktree and terminal linked receipt", async () => {
	const value = await fixture();
	const bin = join(process.cwd(), "packages", "opencode-cli", "bin", "ox-driver.mjs");
	const child = spawn(bin, [
		"task", value.source, "slow task", "--owned", "owned", "--check", "test -f owned/result.txt",
		"--profile-dir", value.profiles,
	], { cwd: process.cwd(), env: value.env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	for (let attempt = 0; attempt < 50 && !stderr.includes("OX_DRIVER_WORKTREE_ID="); attempt += 1) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
	const worktreeId = marker(stderr, "OX_DRIVER_WORKTREE_ID");
	assert.ok(worktreeId, stderr);
	const writtenPath = join(value.env.OX_DRIVER_WORKSPACE_STATE_DIR, "worktrees", worktreeId, "owned", "result.txt");
	let enteredHarness = false;
	for (let attempt = 0; attempt < 100 && !enteredHarness; attempt += 1) {
		enteredHarness = await access(writtenPath).then(() => true, () => false);
		if (!enteredHarness) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
	assert.equal(enteredHarness, true, stderr);
	child.kill("SIGINT");
	const { code, signal } = await new Promise((resolveClose, rejectClose) => {
		child.once("error", rejectClose);
		child.once("close", (exitCode, exitSignal) => resolveClose({ code: exitCode, signal: exitSignal }));
	});
	assert.equal(signal, null, stderr);
	assert.equal(code, 1, stderr);
	const receipt = JSON.parse(stdout);
	assert.equal(receipt.status, "cancelled");
	assert.equal(receipt.workspace.status, "dirty");
	assert.equal(receipt.workers[0].status, "cancelled");
	assert.equal(receipt.workers[0].runId, receipt.requestedRunId);
	assert.equal(await readFile(join(receipt.workspace.path, "owned", "result.txt"), "utf8"), "task fixture result\n");
	assert.deepEqual(JSON.parse(await readFile(receipt.receiptPath, "utf8")), receipt);
});
