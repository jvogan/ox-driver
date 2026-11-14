import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureProcessIdentity, runOwnedProcess, terminateProcessIdentity, RunStore } from "../../packages/core/dist/index.js";

import { trackedMkdtemp } from "../controller/helpers/tracked-temp.mjs";

const posix = { skip: process.platform === "win32", timeout: 15_000 };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function temporary() {
	return trackedMkdtemp(join(tmpdir(), "ox-process-lifecycle-"));
}

async function waitUntil(predicate) {
	const deadline = Date.now() + 5_000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error("fixture readiness deadline exceeded");
		await delay(20);
	}
}

function killGroup(pid) {
	try { process.kill(-pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

function alive(pid) {
	try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

function descendantProgram(pidPath, { redirected = false, wait = false } = {}) {
	const descendant = `process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);`;
	return `
		const { spawn } = require('node:child_process');
		const { writeFileSync } = require('node:fs');
		const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
			stdio: ['ignore', ${redirected ? "'ignore', 'ignore'" : "1, 2"}, 'ipc']
		});
		child.once('message', () => {
			writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
			${wait ? "process.stdin.once('data', () => process.exit(0));" : "process.exit(0);"}
		});
	`;
}

for (const redirected of [false, true]) {
	test(`owned checks reap TERM-resistant descendants with ${redirected ? "redirected" : "inherited"} pipes`, posix, async (t) => {
		const directory = await temporary(t);
		const pidPath = join(directory, "descendant.pid");
		t.after(async () => {
			const pid = Number(await readFile(pidPath, "utf8").catch(() => "0"));
			if (pid && alive(pid)) process.kill(pid, "SIGKILL");
		});
		const started = Date.now();
		const result = await runOwnedProcess(process.execPath, ["-e", descendantProgram(pidPath, { redirected })], { cwd: directory });
		assert.equal(result.exitCode, 0);
		assert.equal(result.backgroundProcessesDetected, true);
		assert.equal(result.terminationEscalated, true);
		assert.equal(result.processTreeReaped, true);
		assert.ok(Date.now() - started < 5_000);
		const pid = Number(await readFile(pidPath, "utf8"));
		await waitUntil(() => !alive(pid));
	});
}

for (const leaderMissing of [true, false]) {
	test(`recovery retains admissions when ${leaderMissing ? "a missing leader leaves" : "TERM leaves"} an unverifiable group`, posix, async (t) => {
		const directory = await temporary(t);
		const pidPath = join(directory, "descendant.pid");
		const child = spawn(process.execPath, ["-e", descendantProgram(pidPath, { redirected: true, wait: true })], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
		t.after(() => killGroup(child.pid));
		await waitUntil(async () => Boolean(await readFile(pidPath, "utf8").catch(() => "")));
		const descendantPid = Number(await readFile(pidPath, "utf8"));
		const identity = await captureProcessIdentity(child.pid);
		const exit = once(child, "exit");
		if (leaderMissing) {
			child.stdin.end("exit");
			await exit;
		}
		const result = await terminateProcessIdentity(identity, { detachedProcessGroup: true, graceMilliseconds: 50 });
		assert.equal(result.status, leaderMissing ? "already-exited" : "terminated");
		await exit;
		assert.equal(result.processTreeReaped, false);
		assert.equal(alive(descendantPid), true);
		const store = new RunStore(join(directory, "state"));
		const runId = randomUUID();
		const admissionId = randomUUID();
		await store.create(runId, {});
		await store.writeJson(runId, "admission.json", { version: 1, runId, processes: [{ admissionId, status: "running", identity, detachedProcessGroup: true }] });
		const cleanup = await store.terminateAdmittedProcesses(runId, "fixture-cleanup");
		assert.deepEqual(cleanup.unresolvedAdmissionIds, [admissionId]);
		assert.equal((await store.readAdmissionState(runId)).processes[0].status, "running");
		assert.equal(alive(descendantPid), true);
		killGroup(child.pid);
		await waitUntil(() => !alive(descendantPid));
		const final = await store.terminateAdmittedProcesses(runId, "fixture-cleanup");
		assert.deepEqual(final.unresolvedAdmissionIds, []);
		assert.equal((await store.readAdmissionState(runId)).processes[0].status, "exited");
	});
}

test("durable cleanup never signals a mismatched birth marker", posix, async (t) => {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
	t.after(async () => { const exit = once(child, "exit"); killGroup(child.pid); await exit; });
	const identity = await captureProcessIdentity(child.pid);
	const result = await terminateProcessIdentity({ ...identity, birthMarkerSha256: "0".repeat(64) }, { detachedProcessGroup: true });
	assert.equal(result.status, "identity-mismatch");
	assert.equal(result.processTreeReaped, false);
	assert.equal(alive(child.pid), true);
});

test("normal checks preserve bounded output and report an empty process group", async () => {
	const result = await runOwnedProcess(process.execPath, ["-e", "process.stdout.write('abcdefgh'); process.stderr.write('warning')"], { cwd: tmpdir(), outputLimitBytes: 4, outputMode: "tail" });
	assert.equal(result.exitCode, 0);
	assert.equal(result.stdout, "efgh");
	assert.equal(result.stderr, "ning");
	assert.equal(result.stdoutTruncated, true);
	assert.equal(result.stderrTruncated, true);
	assert.equal(result.backgroundProcessesDetected, false);
	assert.equal(result.processTreeReaped, true);
	assert.equal(result.terminationEscalated, false);
});

test("cancellation escalates a TERM-resistant leader and settles within its cleanup deadline", posix, async (t) => {
	const directory = await temporary(t);
	const pidPath = join(directory, "leader.pid");
	const abort = new AbortController();
	const task = runOwnedProcess(process.execPath, ["-e", `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`], { cwd: directory, signal: abort.signal });
	t.after(async () => { const pid = Number(await readFile(pidPath, "utf8").catch(() => "0")); if (pid) killGroup(pid); });
	await waitUntil(async () => Boolean(await readFile(pidPath, "utf8").catch(() => "")));
	abort.abort();
	const result = await task;
	assert.equal(result.exitCode, null);
	assert.equal(result.terminationEscalated, true);
	assert.equal(result.processTreeReaped, true);
});

test("already cancelled checks do not spawn a child", async () => {
	const result = await runOwnedProcess("unavailable-fixture-command", [], { cwd: tmpdir(), signal: AbortSignal.abort() });
	assert.equal(result.exitCode, null);
	assert.equal(result.processTreeReaped, true);
});
