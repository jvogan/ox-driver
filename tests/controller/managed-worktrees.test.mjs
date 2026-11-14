import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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

test("duplicate allocation preserves the original record and dirty worktree", async () => {
	const source = await sourceFixture();
	const state = await trackedMkdtemp(join(tmpdir(), "ox-driver-worktree-duplicate-"));
	const store = new ManagedWorktreeStore(state);
	const original = await store.create(source);
	const recordPath = join(state, "records", `${original.id}.json`);
	const originalRecord = await readFile(recordPath);
	await writeFile(join(original.path, "tracked.txt"), "keep existing changes\n");
	await assert.rejects(store.create(source, { id: original.id }), { code: "EEXIST" });
	assert.deepEqual(await readFile(recordPath), originalRecord);
	assert.equal(await readFile(join(original.path, "tracked.txt"), "utf8"), "keep existing changes\n");
	assert.equal((await store.inspect(original.id)).status, "dirty");
	assert.deepEqual(await readdir(join(state, "records")), [`${original.id}.json`]);
});

test("concurrent allocation admits one owner and preserves pre-existing unrecorded paths", async () => {
	const source = await sourceFixture();
	const state = await trackedMkdtemp(join(tmpdir(), "ox-driver-worktree-concurrent-"));
	const store = new ManagedWorktreeStore(state);
	const id = "11111111-1111-4111-8111-111111111111";
	const results = await Promise.allSettled([store.create(source, { id }), store.create(source, { id })]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(results.filter((result) => result.status === "rejected").length, 1);
	assert.equal((await store.inspect(id)).status, "ready");
	const otherId = "22222222-2222-4222-8222-222222222222";
	const existingPath = join(state, "worktrees", otherId);
	await mkdir(existingPath);
	await writeFile(join(existingPath, "keep.txt"), "keep unrecorded files\n");
	await assert.rejects(store.create(source, { id: otherId }), { code: "EEXIST" });
	assert.equal(await readFile(join(existingPath, "keep.txt"), "utf8"), "keep unrecorded files\n");
	await assert.rejects(access(join(state, "records", `${otherId}.json`)));
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

for (const scenario of ["partial-path", "registration-only", "clean-failure", "replaced-path"]) {
	test(`failed allocation preserves discoverable cleanup evidence: ${scenario}`, { skip: process.platform === "win32" }, async () => {
		const source = await sourceFixture();
		const state = await trackedMkdtemp(join(tmpdir(), "ox-driver-worktree-rollback-"));
		const fixture = await trackedMkdtemp(join(tmpdir(), "ox-driver-worktree-git-"));
		const realGit = (await execFileAsync("/bin/sh", ["-c", "command -v git"])).stdout.trim();
		const wrapper = join(fixture, "git-fixture.cjs");
		const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
		await writeFile(wrapper, `
			const { spawnSync } = require('node:child_process');
			const { writeFileSync, rmSync, renameSync, mkdirSync } = require('node:fs');
			const args = process.argv.slice(2);
			const command = args.indexOf('worktree');
			const scenario = ${JSON.stringify(scenario)};
			if (command >= 0 && args[command + 1] === 'add') {
				if (scenario === 'clean-failure') process.exit(1);
				const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
				if (result.status !== 0) process.exit(result.status ?? 1);
				const path = args[command + 3];
				if (scenario === 'registration-only') rmSync(path, { recursive: true });
				else if (scenario === 'replaced-path') {
					renameSync(path, path + '.owned');
					mkdirSync(path);
					writeFileSync(path + '/foreign.txt', 'preserve replacement');
				} else writeFileSync(path + '/partial.txt', 'preserve partial checkout');
				process.exit(1);
			}
			if (command >= 0 && args[command + 1] === 'remove' && scenario !== 'clean-failure') process.exit(1);
			const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
			process.exit(result.status ?? 1);
		`);
		const shim = join(fixture, "git");
		await writeFile(shim, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(wrapper)} "$@"\n`);
		await chmod(shim, 0o700);
		const id = "33333333-3333-4333-8333-333333333333";
		const moduleUrl = new URL("../../packages/core/dist/managed-worktrees.js", import.meta.url).href;
		const program = `
			import { ManagedWorktreeStore } from ${JSON.stringify(moduleUrl)};
			try { await new ManagedWorktreeStore(${JSON.stringify(state)}).create(${JSON.stringify(source)}, { id: ${JSON.stringify(id)} }); process.exitCode = 2; }
			catch (error) { process.stdout.write(JSON.stringify({ message: error.message })); }
		`;
		const result = await execFileAsync(process.execPath, ["--input-type=module", "-e", program], { env: { ...process.env, PATH: `${fixture}:${process.env.PATH ?? "/usr/bin:/bin"}` } });
		const recordPath = join(state, "records", `${id}.json`);
		const path = join(state, "worktrees", id);
		if (scenario === "clean-failure") {
			await assert.rejects(access(recordPath));
			await assert.rejects(access(path));
			assert.doesNotMatch(JSON.parse(result.stdout).message, /cleanup is incomplete/);
		} else {
			assert.match(JSON.parse(result.stdout).message, /cleanup is incomplete and its record remains/);
			assert.equal(JSON.parse(await readFile(recordPath, "utf8")).path, path);
			if (scenario === "registration-only") {
				assert.equal((await new ManagedWorktreeStore(state).inspect(id)).status, "missing");
				assert.ok((await execFileAsync(realGit, ["worktree", "list", "--porcelain"], { cwd: source })).stdout.includes(path));
			} else if (scenario === "partial-path") {
				assert.equal((await new ManagedWorktreeStore(state).list())[0].status, "dirty");
				assert.equal(await readFile(join(path, "partial.txt"), "utf8"), "preserve partial checkout");
			} else {
				assert.equal(await readFile(join(path, "foreign.txt"), "utf8"), "preserve replacement");
				await access(`${path}.owned`);
			}
		}
	});
}
