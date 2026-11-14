import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
	compactWorkerReceipt,
	ManagedWorktreeStore,
	OrchestrationReceiptStore,
	RunStore,
} from "../../packages/core/dist/index.js";
import { trackedMkdtemp } from "./helpers/tracked-temp.mjs";

const execFileAsync = promisify(execFile);

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

async function git(cwd, ...args) {
	return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function fixture() {
	const stateHome = await trackedMkdtemp(join(tmpdir(), "ox-integrate-state-"));
	const stateRoot = join(stateHome, "ox-driver");
	const workspaceState = join(stateHome, "workspaces");
	const orchestrationStore = new OrchestrationReceiptStore(join(stateRoot, "orchestrations"));
	const runStore = new RunStore(stateRoot, join(stateRoot, "leases"));
	const workerRoot = join(stateHome, "workers");
	await mkdir(workerRoot);
	const allocation = await orchestrationStore.allocate();
	const env = {
		...process.env,
		XDG_STATE_HOME: stateHome,
		OX_DRIVER_STATE_DIR: stateRoot,
		OX_DRIVER_WORKSPACE_STATE_DIR: workspaceState,
	};
	return { stateHome, stateRoot, workspaceState, orchestrationStore, runStore, workerRoot, allocation, env };
}

async function sourceRepository() {
	const cwd = await trackedMkdtemp(join(tmpdir(), "ox-integrate-source-"));
	await git(cwd, "init", "--quiet");
	await git(cwd, "config", "user.email", "fixture@example.invalid");
	await git(cwd, "config", "user.name", "Ox Integrate Fixture");
	await mkdir(join(cwd, "src"));
	await writeFile(join(cwd, "src", "a.txt"), "alpha\n");
	await writeFile(join(cwd, "src", "b.txt"), "beta\n");
	await git(cwd, "add", ".");
	await git(cwd, "commit", "--quiet", "-m", "fixture");
	return { cwd, baseCommit: await git(cwd, "rev-parse", "HEAD") };
}

// Produce a real patch the way the controller does: mutate a clone of the
// source and diff its staged state against the base commit.
async function lanePatch(source, mutate) {
	const clone = await trackedMkdtemp(join(tmpdir(), "ox-integrate-clone-"));
	await execFileAsync("git", ["clone", "--quiet", source.cwd, clone]);
	await mutate(clone);
	await execFileAsync("git", ["add", "-A"], { cwd: clone });
	const { stdout } = await execFileAsync(
		"git",
		["diff", "--cached", "--binary", source.baseCommit],
		{ cwd: clone, maxBuffer: 16 * 1024 * 1024 },
	);
	return stdout;
}

async function childReceipt(value, { runId, changedPaths, patch, baseCommit, harness = "opencode", tamper = false }) {
	await value.runStore.create(runId, {});
	let patchFields = {};
	if (patch !== undefined) {
		const relativePath = join("runs", runId, "artifacts", "harness.patch");
		await writeFile(join(value.stateRoot, relativePath), patch);
		patchFields = {
			patchPath: relativePath,
			patchSha256: tamper ? sha256(`${patch}tampered`) : sha256(patch),
			...(baseCommit ? { patchBaseCommit: baseCommit } : {}),
		};
	}
	const receipt = {
		version: 1,
		runId,
		harness,
		status: "completed",
		finishedAt: new Date().toISOString(),
		costReport: { observedUsdMicros: 1000 },
		changedPaths,
		unownedChangedPaths: [],
		acceptance: [{ command: "fixture", passed: true }],
		finalOutput: "useful lane output",
		...patchFields,
	};
	await value.runStore.writeReceipt(receipt);
	return receipt;
}

async function persistHerd(value, lanes) {
	const workers = [];
	for (const lane of lanes) {
		const workerPath = join(value.workerRoot, lane.laneId);
		await mkdir(workerPath, { recursive: true });
		workers.push({
			...compactWorkerReceipt(lane.receipt, workerPath, lane.laneId),
			laneId: lane.laneId,
			...(lane.worktreeId ? { worktreeId: lane.worktreeId } : {}),
		});
	}
	return value.orchestrationStore.persist({
		version: 1,
		kind: "herd",
		orchestrationId: value.allocation.orchestrationId,
		receiptPath: value.allocation.receiptPath,
		objective: "Integrate selected lane changes",
		status: "completed",
		failurePolicy: "collect",
		checksDeclared: true,
		concurrency: lanes.length,
		workerCount: workers.length,
		completedWorkers: workers.length,
		workers,
		integrationRecommendation: "review-worker-diffs-and-integrate-selected-changes",
		autoMerged: false,
	});
}

async function integrate(value, args) {
	try {
		const result = await execFileAsync(
			process.execPath,
			["scripts/ox_integrate.mjs", ...args],
			{ cwd: process.cwd(), env: value.env, maxBuffer: 16 * 1024 * 1024 },
		);
		return { code: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		return { code: error.code, stdout: error.stdout, stderr: error.stderr };
	}
}

test("integrate proposes, exports, and applies Pi and OpenCode changes with passing checks", async () => {
	const value = await fixture();
	const source = await sourceRepository();
	const patchA = await lanePatch(source, (clone) => writeFile(join(clone, "src", "a.txt"), "alpha changed by lane-a\n"));
	const patchB = await lanePatch(source, async (clone) => {
		await writeFile(join(clone, "src", "b.txt"), "beta changed by lane-b\n");
		await writeFile(join(clone, "src", "b-new.txt"), "created by lane-b\n");
	});
	const patchC = await lanePatch(source, (clone) => writeFile(join(clone, "src", "a.txt"), "alpha changed by lane-c\n"));
	const receiptA = await childReceipt(value, { runId: randomUUID(), changedPaths: ["src/a.txt"], patch: patchA, baseCommit: source.baseCommit, harness: "pi" });
	const receiptB = await childReceipt(value, { runId: randomUUID(), changedPaths: ["src/b-new.txt", "src/b.txt"], patch: patchB, baseCommit: source.baseCommit });
	const receiptC = await childReceipt(value, { runId: randomUUID(), changedPaths: ["src/a.txt"], patch: patchC, baseCommit: source.baseCommit });
	await persistHerd(value, [
		{ laneId: "lane-a", receipt: receiptA },
		{ laneId: "lane-b", receipt: receiptB },
		{ laneId: "lane-c", receipt: receiptC },
	]);
	const id = value.allocation.orchestrationId;

	const proposed = await integrate(value, ["propose", id]);
	assert.equal(proposed.code, 2);
	const proposal = JSON.parse(proposed.stdout);
	assert.deepEqual(proposal.overlaps, [{ laneIds: ["lane-a", "lane-c"], paths: ["src/a.txt"] }]);
	assert.deepEqual(proposal.conflictLaneIds, ["lane-a", "lane-c"]);
	assert.deepEqual(proposal.applyOrder, ["lane-b"]);
	assert.deepEqual(proposal.unavailableLaneIds, []);
	const laneB = proposal.lanes.find((lane) => lane.laneId === "lane-b");
	assert.equal(laneB.source, "receipt");
	assert.equal(laneB.baseCommit, source.baseCommit);
	assert.deepEqual(laneB.diffstat.files.map((file) => file.path).sort(), ["src/b-new.txt", "src/b.txt"]);

	const outA = join(value.stateHome, "lane-a.patch");
	const exportedA = await integrate(value, ["export", id, "--lane", "lane-a", "--out", outA]);
	assert.equal(exportedA.code, 0);
	assert.equal(JSON.parse(exportedA.stdout).patchSha256, sha256(patchA));
	assert.equal(await readFile(outA, "utf8"), patchA);
	const exportedB = await integrate(value, ["export", id, "--lane", "lane-b"]);
	assert.equal(exportedB.code, 0);
	assert.equal(exportedB.stdout, patchB);
	const filtered = await integrate(value, ["export", id, "--lane", "lane-b", "--path", "src/b-new.txt"]);
	assert.equal(filtered.code, 0);
	assert.match(filtered.stdout, /b-new\.txt/);
	assert.ok(!filtered.stdout.includes("diff --git a/src/b.txt"));
	const overwrite = await integrate(value, ["export", id, "--lane", "lane-b", "--out", outA]);
	assert.equal(overwrite.code, 1);
	assert.match(overwrite.stderr, /EEXIST/);

	// A conflict with the unselected lane-c must not block applying lane-a.
	const applied = await integrate(value, [
		"apply", id, "--lane", "lane-a", "--lane", "lane-b", "--repo", source.cwd,
		"--check", "grep -q lane-a src/a.txt && grep -q lane-b src/b.txt && test -f src/b-new.txt",
	]);
	assert.equal(applied.code, 0);
	const outcome = JSON.parse(applied.stdout);
	assert.equal(outcome.status, "integrated");
	assert.equal(outcome.workspace.baseCommit, source.baseCommit);
	assert.deepEqual(outcome.applied.map((item) => item.laneId), ["lane-a", "lane-b"]);
	assert.equal(outcome.checks.length, 1);
	assert.equal(outcome.checks[0].passed, true);
	assert.ok(outcome.cleanupCommand.includes(outcome.workspace.id));
	assert.equal(outcome.kind, "integration");
	assert.match(outcome.finalWorkspaceSha256, /^[0-9a-f]{64}$/);
	assert.deepEqual(outcome.selectedLanes.map((lane) => lane.runId), [receiptA.runId, receiptB.runId]);
	const inspected = await integrate(value, ["inspect", outcome.integrationId, "--expected-sha256", outcome.receiptSha256]);
	assert.equal(inspected.code, 0, inspected.stderr);
	assert.deepEqual(JSON.parse(inspected.stdout), outcome);
	const storedEnvelope = JSON.parse(await readFile(outcome.receiptPath, "utf8"));
	storedEnvelope.receipt.finalWorkspaceSha256 = "0".repeat(64);
	await writeFile(outcome.receiptPath, JSON.stringify(storedEnvelope));
	const tampered = await integrate(value, ["inspect", outcome.integrationId]);
	assert.notEqual(tampered.code, 0);
	assert.match(tampered.stderr, /digest mismatch/);
	assert.equal(await readFile(join(outcome.workspace.path, "src", "a.txt"), "utf8"), "alpha changed by lane-a\n");
	assert.equal(await readFile(join(outcome.workspace.path, "src", "b-new.txt"), "utf8"), "created by lane-b\n");

	const conflicting = await integrate(value, ["apply", id, "--lane", "lane-a", "--lane", "lane-c", "--repo", source.cwd, "--no-check"]);
	assert.equal(conflicting.code, 1);
	assert.match(conflicting.stderr, /overlap/);

	const failing = await integrate(value, ["apply", id, "--lane", "lane-b", "--repo", source.cwd, "--check", "false"]);
	assert.equal(failing.code, 1);
	const failure = JSON.parse(failing.stdout);
	assert.equal(failure.status, "checks-failed");
	assert.equal(failure.checks[0].passed, false);
});

test("integrate reports no-change, tampered, missing, and live-worktree lanes honestly", async () => {
	const value = await fixture();
	const source = await sourceRepository();
	const patchA = await lanePatch(source, (clone) => writeFile(join(clone, "src", "a.txt"), "alpha tampered lane\n"));
	const noChange = await childReceipt(value, { runId: randomUUID(), changedPaths: [] });
	const tampered = await childReceipt(value, { runId: randomUUID(), changedPaths: ["src/a.txt"], patch: patchA, baseCommit: source.baseCommit, tamper: true });
	const missing = await childReceipt(value, { runId: randomUUID(), changedPaths: ["src/b.txt"] });
	const worktrees = new ManagedWorktreeStore(value.workspaceState);
	const workspace = await worktrees.create(source.cwd);
	await writeFile(join(workspace.path, "src", "b.txt"), "beta changed live\n");
	const live = await childReceipt(value, { runId: randomUUID(), changedPaths: ["src/b.txt"] });
	await persistHerd(value, [
		{ laneId: "lane-none", receipt: noChange },
		{ laneId: "lane-tampered", receipt: tampered },
		{ laneId: "lane-missing", receipt: missing },
		{ laneId: "lane-live", receipt: live, worktreeId: workspace.id },
	]);
	const id = value.allocation.orchestrationId;

	const proposed = await integrate(value, ["propose", id]);
	assert.equal(proposed.code, 2);
	const proposal = JSON.parse(proposed.stdout);
	const byLane = Object.fromEntries(proposal.lanes.map((lane) => [lane.laneId, lane]));
	assert.equal(byLane["lane-none"].source, "none");
	assert.equal(byLane["lane-none"].noChanges, true);
	assert.equal(byLane["lane-tampered"].source, "unavailable");
	assert.match(byLane["lane-tampered"].reason, /digest/);
	assert.equal(byLane["lane-missing"].source, "unavailable");
	assert.equal(byLane["lane-live"].source, "worktree");
	assert.equal(byLane["lane-live"].baseCommit, workspace.baseCommit);
	assert.deepEqual(byLane["lane-live"].diffstat.files.map((file) => file.path), ["src/b.txt"]);
	assert.deepEqual(proposal.unavailableLaneIds.sort(), ["lane-missing", "lane-tampered"]);
	assert.deepEqual(proposal.applyOrder, ["lane-live"]);

	const applied = await integrate(value, ["apply", id, "--lane", "lane-live", "--repo", source.cwd, "--check", "grep -q live src/b.txt"]);
	assert.equal(applied.code, 0);
	assert.equal(JSON.parse(applied.stdout).status, "integrated");
});

test("integrate refuses mixed base commits and reports a mid-sequence apply failure", async () => {
	const value = await fixture();
	const source = await sourceRepository();
	const patchA = await lanePatch(source, (clone) => writeFile(join(clone, "src", "a.txt"), "alpha changed\n"));
	const patchB = await lanePatch(source, (clone) => writeFile(join(clone, "src", "b.txt"), "beta changed\n"));
	// A context-corrupted patch passes its digest check and fails at git apply.
	const corrupted = patchB.replaceAll("beta", "gamma");
	const receiptA = await childReceipt(value, { runId: randomUUID(), changedPaths: ["src/a.txt"], patch: patchA, baseCommit: source.baseCommit });
	const receiptB = await childReceipt(value, { runId: randomUUID(), changedPaths: ["src/b.txt"], patch: corrupted, baseCommit: "f".repeat(40) });
	await persistHerd(value, [
		{ laneId: "lane-a", receipt: receiptA },
		{ laneId: "lane-b", receipt: receiptB },
	]);
	const id = value.allocation.orchestrationId;

	const mixed = await integrate(value, ["apply", id, "--lane", "lane-a", "--lane", "lane-b", "--repo", source.cwd, "--no-check"]);
	assert.equal(mixed.code, 1);
	assert.match(mixed.stderr, /share one recorded base commit/);

	// Repair the recorded base so the corrupted patch reaches git apply.
	const repaired = { ...receiptB, patchBaseCommit: source.baseCommit };
	await writeFile(join(value.stateRoot, "runs", receiptB.runId, "receipt.json"), JSON.stringify(repaired));
	const applied = await integrate(value, ["apply", id, "--lane", "lane-a", "--lane", "lane-b", "--repo", source.cwd, "--no-check"]);
	assert.equal(applied.code, 1);
	const outcome = JSON.parse(applied.stdout);
	assert.equal(outcome.status, "apply-failed");
	assert.deepEqual(outcome.applied.map((item) => item.laneId), ["lane-a"]);
	assert.equal(outcome.applyFailure.laneId, "lane-b");
	assert.deepEqual(outcome.checks, []);
});

test("integration checks reject redirected background descendants and report timeouts", { skip: process.platform === "win32", timeout: 20_000 }, async (t) => {
	const value = await fixture();
	const source = await sourceRepository();
	const patch = await lanePatch(source, (clone) => writeFile(join(clone, "src", "a.txt"), "changed by lane\n"));
	const receipt = await childReceipt(value, { runId: randomUUID(), changedPaths: ["src/a.txt"], patch, baseCommit: source.baseCommit });
	const noChange = await childReceipt(value, { runId: randomUUID(), changedPaths: [] });
	await persistHerd(value, [{ laneId: "lane-a", receipt }, { laneId: "lane-b", receipt: noChange }]);
	const pidPath = join(value.stateHome, "descendant.pid");
	const scriptPath = join(value.stateHome, "background-check.cjs");
	const childCode = "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);";
	await writeFile(scriptPath, `
		const { spawn } = require('node:child_process');
		const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
		child.once('message', () => {
			require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
			process.exit(0);
		});
	`);
	t.after(async () => {
		const pid = Number(await readFile(pidPath, "utf8").catch(() => "0"));
		if (pid) {
			try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
		}
	});
	const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
	const args = ["apply", value.allocation.orchestrationId, "--lane", "lane-a", "--repo", source.cwd];
	const background = await integrate(value, [...args, "--check", `${quote(process.execPath)} ${quote(scriptPath)}`]);
	assert.equal(background.code, 1);
	const failed = JSON.parse(background.stdout);
	assert.equal(failed.status, "checks-failed");
	assert.equal(failed.checks[0].passed, false);
	assert.equal(failed.checks[0].exitCode, 0);
	assert.equal(failed.checks[0].backgroundProcessesDetected, true);
	assert.equal(failed.checks[0].processTreeReaped, true);
	assert.equal(failed.checks[0].terminationEscalated, true);
	const pid = Number(await readFile(pidPath, "utf8"));
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	const timeout = await integrate(value, [...args, "--timeout", "1", "--check", "exec sleep 60"]);
	assert.equal(timeout.code, 1);
	const expired = JSON.parse(timeout.stdout);
	assert.equal(expired.status, "checks-failed");
	assert.equal(expired.checks[0].timedOut, true);
	assert.equal(expired.checks[0].passed, false);
	assert.equal(expired.checks[0].processTreeReaped, true);
});

async function oneWriterIntegration() {
	const value = await fixture();
	const source = await sourceRepository();
	const patch = await lanePatch(source, (clone) => writeFile(join(clone, "src", "a.txt"), "changed by writer\n"));
	const writer = await childReceipt(value, { runId: randomUUID(), changedPaths: ["src/a.txt"], patch, baseCommit: source.baseCommit });
	const reviewer = await childReceipt(value, { runId: randomUUID(), changedPaths: [] });
	await persistHerd(value, [{ laneId: "writer", receipt: writer }, { laneId: "reviewer", receipt: reviewer }]);
	return { value, source, args: ["apply", value.allocation.orchestrationId, "--lane", "writer", "--repo", source.cwd] };
}

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function gitShim(value, body) {
	const directory = join(value.stateHome, "bin");
	await mkdir(directory);
	const executable = (await execFileAsync("/bin/sh", ["-c", "command -v git"])).stdout.trim();
	const script = join(directory, "git-fixture.cjs");
	await writeFile(script, `
		const { spawnSync, spawn } = require('node:child_process');
		const fs = require('node:fs');
		const args = process.argv.slice(2);
		const realGit = ${JSON.stringify(executable)};
		${body}
	`);
	await writeFile(join(directory, "git"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`);
	await chmod(join(directory, "git"), 0o700);
	value.env.PATH = `${directory}:${value.env.PATH}`;
}

for (const stage of ["apply", "check"]) {
	test(`integration cancellation reaps the active ${stage} group before preserving its receipt`, { skip: process.platform === "win32", timeout: 20_000 }, async (t) => {
		const { value, args } = await oneWriterIntegration();
		const pidPath = join(value.stateHome, "active-processes.json");
		const childCode = "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);";
		const blocking = `
			const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: ['ignore', 1, 2, 'ipc'] });
			descendant.once('message', () => fs.writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ leader: process.pid, descendant: descendant.pid })));
		`;
		let check = "true";
		if (stage === "apply") {
			await gitShim(value, `if (args[0] === 'apply' && args.includes('--index')) { ${blocking} }
				else { const result = spawnSync(realGit, args, { stdio: 'inherit' }); process.exit(result.status ?? 1); }`);
		} else {
			const scriptPath = join(value.stateHome, "blocking-check.cjs");
			await writeFile(scriptPath, `const { spawn } = require('node:child_process'); const fs = require('node:fs'); ${blocking}`);
			check = `exec ${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
		}
		const child = spawn(process.execPath, ["scripts/ox_integrate.mjs", ...args, "--check", check], { env: value.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		const finished = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
		t.after(async () => {
			const identities = JSON.parse(await readFile(pidPath, "utf8").catch(() => "{}"));
			if (identities.leader) {
				try { process.kill(-identities.leader, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
			}
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await finished;
		});
		const deadline = Date.now() + 8_000;
		while (!(await readFile(pidPath, "utf8").catch(() => ""))) {
			assert.ok(Date.now() < deadline, `process did not become ready: ${stderr}`);
			assert.equal(child.exitCode, null, stderr);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const identities = JSON.parse(await readFile(pidPath, "utf8"));
		const signal = stage === "apply" ? "SIGTERM" : "SIGINT";
		child.kill(signal);
		const termination = await finished;
		assert.equal(termination.signal, null);
		assert.equal(termination.code, 1, stderr);
		const outcome = JSON.parse(stdout);
		assert.equal(outcome.status, "evidence-failed");
		assert.equal(outcome.cancellationSignal, signal);
		assert.equal(outcome.finalWorkspaceSha256, null);
		assert.match(outcome.evidenceError, /cancelled/);
		const cleanup = stage === "apply" ? outcome.applyFailure : outcome.checks[0];
		assert.equal(cleanup.backgroundProcessesDetected, true);
		assert.equal(cleanup.processTreeReaped, true);
		assert.equal(cleanup.terminationEscalated, true);
		assert.throws(() => process.kill(identities.leader, 0), { code: "ESRCH" });
		assert.throws(() => process.kill(identities.descendant, 0), { code: "ESRCH" });
		await access(outcome.workspace.path);
		const inspected = await integrate(value, ["inspect", outcome.integrationId, "--expected-sha256", outcome.receiptSha256]);
		assert.equal(inspected.code, 0, inspected.stderr);
		assert.deepEqual(JSON.parse(inspected.stdout), outcome);
	});
}

test("integration reports its allocated workspace when scratch creation fails", { skip: process.platform === "win32" }, async () => {
	const { value, args } = await oneWriterIntegration();
	const scratchRoot = join(value.stateHome, "scratch");
	await mkdir(scratchRoot);
	value.env.TMPDIR = scratchRoot;
	await gitShim(value, `
		const result = spawnSync(realGit, args, { stdio: 'inherit' });
		const command = args.indexOf('worktree');
		if (result.status === 0 && command >= 0 && args[command + 1] === 'add') fs.rmSync(${JSON.stringify(scratchRoot)}, { recursive: true });
		process.exit(result.status ?? 1);
	`);
	const failed = await integrate(value, [...args, "--no-check"]);
	assert.equal(failed.code, 1);
	const outcome = JSON.parse(failed.stdout);
	assert.equal(outcome.status, "evidence-failed");
	assert.match(outcome.evidenceError, /ENOENT/);
	assert.equal(outcome.finalWorkspaceSha256, null);
	assert.deepEqual(outcome.applied, []);
	await access(outcome.workspace.path);
	assert.match(outcome.cleanupCommand, new RegExp(outcome.workspace.id));
	assert.equal(JSON.parse((await integrate(value, ["inspect", outcome.integrationId])).stdout).status, "evidence-failed");
});

test("integration validates its destination before allocation and preserves snapshot failure evidence", async () => {
	const { value, args } = await oneWriterIntegration();
	const destination = join(value.orchestrationStore.root, "integrations");
	await writeFile(destination, "occupied by a regular file");
	const blocked = await integrate(value, [...args, "--no-check"]);
	assert.equal(blocked.code, 1);
	await assert.rejects(access(value.workspaceState));
	const { value: fresh, args: freshArgs } = await oneWriterIntegration();
	const failed = await integrate(fresh, [...freshArgs, "--check", "rm .git"]);
	assert.equal(failed.code, 1);
	const outcome = JSON.parse(failed.stdout);
	assert.equal(outcome.status, "evidence-failed");
	assert.equal(outcome.finalWorkspaceSha256, null);
	assert.equal(outcome.checks[0].passed, true);
	assert.ok(outcome.evidenceError);
	await access(outcome.workspace.path);
	assert.equal(JSON.parse((await integrate(fresh, ["inspect", outcome.integrationId])).stdout).status, "evidence-failed");
});
