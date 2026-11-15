import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { trackedMkdtemp } from "../controller/helpers/tracked-temp.mjs";

const execute = promisify(execFile);
const cli = join(process.cwd(), "packages/cli/dist/main.js");

async function fixture() {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-work-cli-"));
	const repository = join(root, "repository");
	const profiles = join(root, "profiles");
	await mkdir(repository); await mkdir(profiles); await mkdir(join(repository, "src"));
	await writeFile(join(repository, "src", "add.mjs"), "export const add = (a, b) => a - b;\n");
	await writeFile(join(repository, "add.test.mjs"), 'import assert from "node:assert/strict"; import test from "node:test"; import { add } from "./src/add.mjs"; test("adds inputs", () => assert.equal(add(2, 3), 5));\n');
	await execute("git", ["init", "--quiet"], { cwd: repository });
	await execute("git", ["add", "."], { cwd: repository });
	await execute("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "seed"], { cwd: repository });
	const launcher = join(root, "writer.mjs");
	await writeFile(launcher, `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.19.5"); process.exit(0); }
if (args[0] === "models") { console.log("fixture-provider/fixture-model"); process.exit(0); }
if (args[0] !== "run") process.exit(2);
const cwd = args[args.indexOf("--dir") + 1];
appendFileSync(process.env.OX_WORK_TEST_CALLS, JSON.stringify(args) + "\\n");
writeFileSync(join(cwd, "src/add.mjs"), "export const add = (a, b) => a + b;\\n");
for (const event of [
 { type: "step_start", part: { type: "step-start" } },
 { type: "text", part: { type: "text", text: "Changed addition to sum its inputs." } },
 { type: "step_finish", part: { type: "step-finish", reason: "stop", cost: 0.001 } },
]) console.log(JSON.stringify(event));
setTimeout(() => {}, 150);
`, { mode: 0o700 });
	await writeFile(join(profiles, "example-writer.json"), JSON.stringify({
		version: 1, id: "example-writer", status: "active", harness: "opencode", tier: "trusted-host",
		launcher: { command: launcher, versionArgs: ["--version"] },
		route: { source: "explicit", provider: "fixture-provider", model: "fixture-model", reasoning: "high" },
		runtime: { expectedVersion: "1.19.5", expectedSha256: createHash("sha256").update(await readFile(launcher)).digest("hex") },
		pricingPolicy: "report-only", credentialPolicy: "fixture",
	}));
	const env = { ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), OX_DRIVER_ROUTE_PROFILE_DIR: profiles, OX_DRIVER_STATE_DIR: join(root, "runs"), OX_DRIVER_ORCHESTRATION_STATE_DIR: join(root, "orchestrations"), OX_DRIVER_WORKSPACE_STATE_DIR: join(root, "workspaces"), OX_WORK_TEST_CALLS: join(root, "calls.jsonl") };
	delete env.OX_DRIVER_OPENCODE_LAUNCHER;
	delete env.NODE_TEST_CONTEXT;
	const invoke = (...args) => execute(process.execPath, [cli, ...args], { cwd: repository, env, maxBuffer: 8 * 1024 * 1024 });
	return { root, repository, env, invoke };
}

test("one public workflow turns a failing task into a tested, inspectable patch", async () => {
	const f = await fixture();
	await assert.rejects(execute(process.execPath, ["--test"], { cwd: f.repository, env: f.env }));
	const before = await readFile(join(f.repository, "src/add.mjs"), "utf8");
	const initialized = await f.invoke("init", "--route", "example-writer", "--owned", "src", "--check", "node --test");
	assert.match(initialized.stdout, /Saved preset default/);
	const plan = JSON.parse((await f.invoke("work", "Fix addition", "--dry-run", "--json")).stdout);
	assert.equal(plan.status, "ready"); assert.equal(plan.executionStarted, false);
	const preview = await f.invoke("work", "Fix addition", "--dry-run");
	assert.match(preview.stdout, /model availability is verified/);
	await assert.rejects(access(f.env.OX_WORK_TEST_CALLS));
	await assert.rejects(access(f.env.OX_DRIVER_WORKSPACE_STATE_DIR));
	let executed;
	try { executed = await f.invoke("work", "Fix addition", "--json"); }
	catch (error) {
		const failed = JSON.parse(error.stdout);
		throw new Error(JSON.stringify(failed.report.workers.map((worker) => ({ status: worker.status, checks: worker.checks }))));
	}
	const result = JSON.parse(executed.stdout);
	assert.equal(result.kind, "work-result");
	assert.equal(result.report.status, "completed");
	assert.deepEqual(result.report.workers[0].changedPaths, ["src/add.mjs"]);
	assert.equal(result.report.workers[0].checks[0].passed, true);
	assert.equal(await readFile(join(f.repository, "src/add.mjs"), "utf8"), before);
	const args = JSON.parse((await readFile(f.env.OX_WORK_TEST_CALLS, "utf8")).trim());
	assert.equal(args[args.indexOf("--model") + 1], "fixture-provider/fixture-model");
	assert.equal(args[args.indexOf("--variant") + 1], "high");
	assert.equal(args.at(-1), "Fix addition");
	const id = result.report.orchestrationId;
	const saved = await f.invoke("result", id);
	assert.match(saved.stdout, /Work completed/); assert.match(saved.stdout, /Check: node --test — passed/);
	const patch = join(f.root, "result.patch");
	await f.invoke("patch", id, "--out", patch);
	await assert.rejects(f.invoke("patch", id, "--out", patch), /EEXIST/);
	await execute("git", ["apply", "--check", patch], { cwd: f.repository });
	await execute("git", ["apply", patch], { cwd: f.repository });
	await execute(process.execPath, ["--test"], { cwd: f.repository, env: f.env });
	const detachedEnv = { ...f.env, OX_DRIVER_ROUTE_PROFILE_DIR: join(f.root, "missing-routes"), OX_DRIVER_OPENCODE_PROFILE: "missing" };
	const detached = await execute(process.execPath, [cli, "result", id, "--json"], { env: detachedEnv, cwd: f.repository });
	assert.equal(JSON.parse(detached.stdout).report.workers[0].checks[0].passed, true);
});

test("public workflow help and route inspection require no repository setup", async () => {
	const f = await fixture();
	for (const command of ["init", "work", "result", "patch"]) assert.match((await f.invoke(command, "--help")).stdout, /ox-driver work/);
	const listed = JSON.parse((await f.invoke("route", "list")).stdout);
	assert.equal(listed.modelCalls, 0);
	assert.equal(listed.profiles[0].id, "example-writer");
	await assert.rejects(f.invoke("init", "--route", "example-writer"), /--check COMMAND or explicit --no-check/);
	await assert.rejects(access(join(f.repository, "ox-driver.json")));
	await assert.rejects(f.invoke("unknown-\x1b[31m"), (error) => {
		assert.doesNotMatch(error.stderr, /\x1b/);
		assert.match(error.stderr, /unknown command/);
		return true;
	});
});
