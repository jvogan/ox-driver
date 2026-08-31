import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { ManagedWorktreeStore } from "../../packages/core/dist/managed-worktrees.js";
import { trackedMkdtemp } from "./helpers/tracked-temp.mjs";

const execFileAsync = promisify(execFile);

async function sourceFixture() {
	const source = await trackedMkdtemp(join(tmpdir(), "ox-driver-worktree-source-"));
	await execFileAsync("git", ["init", "--quiet"], { cwd: source });
	await writeFile(join(source, "tracked.txt"), "base\n");
	await execFileAsync("git", ["add", "tracked.txt"], { cwd: source });
	await execFileAsync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "--quiet", "-m", "base"], { cwd: source });
	return source;
}

test("creates, lists, inspects, and exactly removes a clean detached managed worktree", async () => {
	const source = await sourceFixture();
	const state = await trackedMkdtemp(join(tmpdir(), "ox-driver-worktree-state-"));
	const store = new ManagedWorktreeStore(state);
	const created = await store.create(source);
	assert.equal(created.source, source);
	assert.equal(created.status, "ready");
	assert.match(created.baseCommit, /^[0-9a-f]{40,64}$/);
	await assert.rejects(execFileAsync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: created.path }));
	assert.deepEqual((await store.list()).map((item) => item.id), [created.id]);
	assert.equal((await store.inspect(created.id)).status, "ready");

	await writeFile(join(created.path, "tracked.txt"), "dirty\n");
	assert.equal((await store.inspect(created.id)).status, "dirty");
	await assert.rejects(store.remove(created.id), /status dirty/);
	await execFileAsync("git", ["checkout", "--", "tracked.txt"], { cwd: created.path });
	const removed = await store.remove(created.id);
	assert.equal(removed.status, "removed");
	assert.equal(removed.discarded, false);
	assert.deepEqual(removed.discardedChangedPaths, []);
	assert.deepEqual(removed.discardedCommits, []);
	await assert.rejects(access(created.path));
	assert.deepEqual(await store.list(), []);
});

test("records a descendant commit without treating the managed identity as drift", async () => {
	const source = await sourceFixture();
	const state = await trackedMkdtemp(join(tmpdir(), "ox-driver-worktree-drift-state-"));
	const store = new ManagedWorktreeStore(state);
	const created = await store.create(source);
	await writeFile(join(created.path, "second.txt"), "second\n");
	await execFileAsync("git", ["add", "second.txt"], { cwd: created.path });
	await execFileAsync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "--quiet", "-m", "drift"], { cwd: created.path });
	assert.equal((await store.inspect(created.id)).status, "advanced");
	await assert.rejects(store.remove(created.id), /status advanced/);
	const removed = await store.remove(created.id, { discard: true });
	assert.equal(removed.status, "removed");
	assert.deepEqual(removed.discardedChangedPaths, ["second.txt"]);
	assert.equal(removed.discardedCommits.length, 1);
	assert.equal(removed.discardedCommits[0], removed.currentCommit);
});

test("explicitly discards a dirty exact managed worktree and reports Git-visible changed paths", async () => {
	const source = await sourceFixture();
	const state = await trackedMkdtemp(join(tmpdir(), "ox-driver-worktree-discard-state-"));
	const store = new ManagedWorktreeStore(state);
	const created = await store.create(source);
	await writeFile(join(created.path, "tracked.txt"), "discarded tracked change\n");
	await writeFile(join(created.path, "untracked file.txt"), "discarded untracked file\n");
	assert.equal((await store.inspect(created.id)).status, "dirty");

	const removed = await store.remove(created.id, { discard: true });
	assert.equal(removed.status, "removed");
	assert.equal(removed.discarded, true);
	assert.deepEqual(removed.discardedChangedPaths, ["tracked.txt", "untracked file.txt"]);
	assert.deepEqual(removed.discardedCommits, []);
	await assert.rejects(access(created.path));
	assert.deepEqual(await store.list(), []);
});

test("discard recovers missing records and refuses unregistered path identities", async () => {
	const source = await sourceFixture();
	const state = await trackedMkdtemp(join(tmpdir(), "ox-driver-worktree-identity-state-"));
	const store = new ManagedWorktreeStore(state);

	const missing = await store.create(source);
	await execFileAsync("git", ["worktree", "remove", "--force", missing.path], { cwd: source });
	assert.equal((await store.inspect(missing.id)).status, "missing");
	const removedMissing = await store.remove(missing.id, { discard: true });
	assert.equal(removedMissing.status, "removed");
	assert.deepEqual(removedMissing.discardedChangedPaths, []);
	assert.deepEqual(removedMissing.discardedCommits, []);

	const unregistered = await store.create(source);
	await execFileAsync("git", ["worktree", "remove", "--force", unregistered.path], { cwd: source });
	await mkdir(unregistered.path);
	assert.equal((await store.inspect(unregistered.id)).status, "unregistered");
	await assert.rejects(store.remove(unregistered.id, { discard: true }), /discard.*status unregistered/);
});

test("standalone workspace command returns lifecycle JSON", async () => {
	const source = await sourceFixture();
	const state = await trackedMkdtemp(join(tmpdir(), "ox-driver-worktree-script-state-"));
	const script = join(process.cwd(), "scripts", "ox_workspace.mjs");
	const created = JSON.parse((await execFileAsync(process.execPath, [script, "create", source, "--state-dir", state])).stdout);
	assert.equal(created.status, "ready");
	assert.equal(created.source, source);
	const inspected = JSON.parse((await execFileAsync(process.execPath, [script, "inspect", created.id, "--state-dir", state])).stdout);
	assert.equal(inspected.path, created.path);
	assert.equal(inspected.baseCommit, created.baseCommit);
	const listed = JSON.parse((await execFileAsync(process.execPath, [script, "list", "--state-dir", state])).stdout);
	assert.deepEqual(listed.map((item) => item.id), [created.id]);
	await writeFile(join(created.path, "script output.txt"), "discard me\n");
	const removed = JSON.parse((await execFileAsync(process.execPath, [script, "remove", created.id, "--discard", "--state-dir", state])).stdout);
	assert.equal(removed.status, "removed");
	assert.equal(removed.discarded, true);
	assert.deepEqual(removed.discardedChangedPaths, ["script output.txt"]);
	assert.deepEqual(removed.discardedCommits, []);
});
