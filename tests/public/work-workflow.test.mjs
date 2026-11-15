import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { trackedMkdtemp } from "../controller/helpers/tracked-temp.mjs";

const execFileAsync = promisify(execFile);
const workModule = new URL("../../packages/cli/dist/work.js", import.meta.url).href;

async function fixture(overrides = {}) {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-work-workflow-"));
	const source = join(root, "source");
	const profiles = join(root, "profiles");
	await mkdir(source);
	await mkdir(profiles);
	const preset = {
		route: "work-builder", ownedPaths: ["owned"], excludedPaths: [".env"],
		checks: ["test -f owned/result.txt"], timeoutSeconds: 45, reportOnlyCostUsdMicros: 75_123,
		...overrides,
	};
	await writeFile(join(source, "base.txt"), "base\n");
	await writeFile(join(source, "ox-driver.json"), JSON.stringify({ version: 1, defaultPreset: "default", presets: { default: preset } }));
	await execFileAsync("git", ["init", "--quiet"], { cwd: source });
	await execFileAsync("git", ["add", "."], { cwd: source });
	await execFileAsync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "--quiet", "-m", "base"], { cwd: source });
	const launcher = join(root, "opencode-fixture.mjs");
	await writeFile(launcher, `#!${process.execPath}
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("OpenCode fixture 1.0.0"); process.exit(0); }
if (args[0] === "doctor") { console.log("work fixture ready"); process.exit(0); }
if (args[0] !== "run") process.exit(20);
const cwd = args[args.indexOf("--dir") + 1];
const objective = args.at(-1);
appendFileSync(process.env.WORK_FIXTURE_BUILDS, "builder\\n");
mkdirSync(join(cwd, "owned"), { recursive: true });
writeFileSync(join(cwd, "owned/result.txt"), "work result\\n");
for (const event of [
 { type: "step_start", part: { type: "step-start" } },
 { type: "text", part: { type: "text", text: "work fixture complete" } },
 { type: "step_finish", part: { type: "step-finish", reason: "stop", cost: 0.002 } },
]) console.log(JSON.stringify(event));
setTimeout(() => {}, objective.includes("slow") ? 30000 : 150);
`, { mode: 0o700 });
	await writeFile(join(profiles, "work-builder.json"), JSON.stringify({
		version: 1, id: "work-builder", status: "active", harness: "opencode", tier: "trusted-host",
		launcher: { command: launcher, versionArgs: ["--version"], doctor: { args: ["doctor"], requiredText: ["work fixture ready"] } },
		route: { source: "explicit", provider: "fixture-provider", model: "fixture-model", reasoning: "high" },
		agent: { defaultProfile: "builder", allowedProfiles: ["builder"] }, pricingPolicy: "report-only",
	}));
	const reviewerLauncher = join(root, "pi-fixture.mjs");
	await writeFile(reviewerLauncher, `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("Pi 1.2.3"); process.exit(0); }
if (!existsSync("owned/result.txt")) process.exit(21);
if (process.argv.includes("--approve")) process.exit(22);
appendFileSync(process.env.WORK_FIXTURE_REVIEWS, "reviewer\\n");
for (const event of [
 { type: "agent_start" },
 { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fixture review complete" }], stopReason: "stop", usage: { cost: { total: 0.001 } } } },
 { type: "agent_end" }, { type: "agent_settled" },
]) console.log(JSON.stringify(event));
setTimeout(() => {}, 150);
`, { mode: 0o700 });
	await writeFile(join(profiles, "work-reviewer.json"), JSON.stringify({
		version: 1, id: "work-reviewer", status: "active", harness: "pi", tier: "trusted-host",
		launcher: { command: reviewerLauncher, versionArgs: ["--version"] },
		route: { source: "explicit", provider: "fixture-provider", model: "fixture-reviewer", reasoning: "max" },
		runtime: { mode: "direct", expectedVersion: "1.2.3" }, pricingPolicy: "report-only",
	}));
	const runner = join(root, "work-runner.mjs");
	await writeFile(runner, `import { runWork, workRuntime } from ${JSON.stringify(workModule)};
const runtime = workRuntime();
if (process.env.WORK_FIXTURE_INTERRUPT === "builder-checkpoint") {
 runtime.afterBuilderCheckpoint = () => { throw new Error("fixture checkpoint interruption"); };
}
try {
 const result = await runWork(process.argv.slice(2), runtime);
 console.log(JSON.stringify(result.receipt));
 process.exitCode = result.exitCode;
} catch (error) { console.error(error.message); process.exitCode = 1; }
`);
	const env = {
		...process.env,
		XDG_STATE_HOME: join(root, "xdg-state"), OX_DRIVER_WORKSPACE_STATE_DIR: join(root, "workspace-state"),
		OX_DRIVER_STATE_DIR: join(root, "run-state"), OX_DRIVER_ROUTE_PROFILE_DIR: profiles,
		WORK_FIXTURE_BUILDS: join(root, "builds.txt"), WORK_FIXTURE_REVIEWS: join(root, "reviews.txt"),
	};
	delete env.OX_DRIVER_OPENCODE_LAUNCHER;
	return { root, source, profiles, runner, env, preset };
}

async function invoke(value, args, extraEnv = {}) {
	try {
		const result = await execFileAsync(process.execPath, [value.runner, ...args], { cwd: value.source, env: { ...value.env, ...extraEnv }, maxBuffer: 8 * 1024 * 1024 });
		return { code: 0, ...result, receipt: result.stdout ? JSON.parse(result.stdout) : undefined };
	} catch (error) {
		return { code: error.code, stdout: error.stdout, stderr: error.stderr, receipt: error.stdout ? JSON.parse(error.stdout) : undefined };
	}
}

async function entries(path) { return readdir(path).catch((error) => { if (error.code === "ENOENT") return []; throw error; }); }
async function text(path) { return readFile(path, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; }); }

async function assertNoAllocation(value) {
	assert.deepEqual(await entries(value.env.OX_DRIVER_STATE_DIR), []);
	assert.deepEqual(await entries(value.env.OX_DRIVER_WORKSPACE_STATE_DIR), []);
	assert.deepEqual(await entries(value.env.XDG_STATE_HOME), []);
	assert.equal(await text(value.env.WORK_FIXTURE_BUILDS), "");
	assert.equal(await text(value.env.WORK_FIXTURE_REVIEWS), "");
}

test("work uses the current repository preset and preserves the objective in a durable task receipt", async () => {
	const value = await fixture();
	const objective = "--repair  the quoted 'result'\nwithout changing the request";
	const result = await invoke(value, ["--", objective]);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.receipt.kind, "task");
	assert.equal(result.receipt.status, "completed");
	assert.equal(result.receipt.objective, objective);
	assert.equal(result.receipt.effectivePlan.lanes[0].route, "work-builder");
	assert.equal(result.receipt.effectivePlan.lanes[0].timeoutSeconds, 45);
	assert.equal(result.receipt.effectivePlan.lanes[0].reportOnlyCostUsdMicros, 75_123);
	assert.deepEqual(result.receipt.workers[0].changedPaths, ["owned/result.txt"]);
	assert.equal(await text(join(result.receipt.workspace.path, "owned/result.txt")), "work result\n");
	assert.equal(await text(join(value.source, "owned/result.txt")), "");
	assert.equal((await execFileAsync("git", ["status", "--porcelain"], { cwd: value.source })).stdout, "");
	assert.deepEqual(JSON.parse(await readFile(result.receipt.receiptPath, "utf8")), result.receipt);
});

test("work preserves failed acceptance and the managed change for inspection", async () => {
	const value = await fixture({ checks: ["test -f missing-output"] });
	const result = await invoke(value, ["write the result"]);
	assert.equal(result.code, 1);
	assert.equal(result.receipt.status, "failed");
	assert.equal(result.receipt.workers[0].acceptance[0].passed, false);
	assert.equal(await text(join(result.receipt.workspace.path, "owned/result.txt")), "work result\n");
	assert.equal(result.receipt.autoMerged, false);
});

test("work requires a resume checkpoint before resolving routes or starting controllers", async () => {
	const value = await fixture();
	const { runWork } = await import(workModule);
	let profilesResolved = 0;
	let controllersCreated = 0;
	const runtime = {
		resolveProfile: async () => { profilesResolved += 1; throw new Error("unexpected route resolution"); },
		createController: async () => { controllersCreated += 1; throw new Error("unexpected controller creation"); },
	};
	for (const args of [["resume"], ["resume", "--json"], ["resume", "--dry-run"], ["resume", "--repo", value.source], ["resume", "checkpoint", "--json", "--json"]]) {
		await assert.rejects(runWork(args, runtime), /work resume requires exactly one handoff checkpoint id/);
		const result = await invoke(value, args);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /work resume requires exactly one handoff checkpoint id/);
		assert.equal(result.receipt, undefined);
	}
	assert.equal(profilesResolved, 0);
	assert.equal(controllersCreated, 0);
	await assertNoAllocation(value);
});

test("work accepts resume as a literal objective after the option sentinel", async () => {
	const value = await fixture();
	const result = await invoke(value, ["--", "resume"]);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.receipt.objective, "resume");
	assert.equal(result.receipt.kind, "task");
	const preview = await invoke(value, ["--dry-run", "--", "resume"]);
	assert.equal(preview.code, 0, preview.stderr);
	assert.equal(preview.receipt.objective, "resume");
});

test("work rejects an unborn repository before preview or execution allocation", async () => {
	const value = await fixture();
	await rm(join(value.source, ".git"), { recursive: true });
	await execFileAsync("git", ["init", "--quiet"], { cwd: value.source });
	for (const args of [["preview initial work", "--dry-run"], ["initial work"]]) {
		const result = await invoke(value, args);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /requires a committed HEAD.*initial commit/);
		assert.equal(result.receipt, undefined);
	}
	await assertNoAllocation(value);
});

test("work dry-run performs launcher preflight without worker, check, receipt, or worktree allocation", async () => {
	const value = await fixture({ checks: ["touch check-must-not-run"] });
	const result = await invoke(value, ["preview result", "--dry-run", "--json"]);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.receipt.kind, "work-preview");
	assert.equal(result.receipt.status, "ready");
	assert.equal(result.receipt.executionStarted, false);
	assert.match(result.receipt.sourceBaseCommit, /^[0-9a-f]{40,64}$/);
	assert.ok(result.receipt.notices.some((notice) => /Uncommitted source changes and untracked files are not copied/.test(notice)));
	assert.equal(result.receipt.lanes[0].preflight.ok, true);
	assert.equal(result.receipt.lanes[0].spec.routeProfile, "work-builder");
	assert.deepEqual(result.receipt.lanes[0].spec.acceptance.commands, ["touch check-must-not-run"]);
	assert.equal(await access(join(value.source, "check-must-not-run")).then(() => true, () => false), false);
	await assertNoAllocation(value);
});

test("work dry-run reports a blocked launcher without allocating execution state", async () => {
	const value = await fixture();
	const path = join(value.profiles, "work-builder.json");
	const profile = JSON.parse(await readFile(path, "utf8"));
	profile.launcher.command = join(value.root, "missing-launcher");
	await writeFile(path, JSON.stringify(profile));
	const result = await invoke(value, ["preview result", "--dry-run"]);
	assert.equal(result.code, 1);
	assert.equal(result.receipt.status, "blocked");
	assert.equal(result.receipt.lanes[0].preflight.ok, false);
	await assertNoAllocation(value);
});

test("work rejects an unsupported writer profile without substituting its harness", async () => {
	const value = await fixture({ route: "work-reviewer" });
	const result = await invoke(value, ["write with the selected route"]);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /harness|OpenCode|opencode/);
	assert.equal(result.receipt, undefined);
	await assertNoAllocation(value);
});

test("work rejects unknown options and missing presets before allocation", async () => {
	const value = await fixture();
	for (const args of [["objective", "--route", "work-builder"], ["objective", "--preset", "missing"], ["resume", "checkpoint", "--dry-run"]]) {
		const result = await invoke(value, args);
		assert.equal(result.code, 1);
		assert.equal(result.receipt, undefined);
	}
	await assertNoAllocation(value);
});

test("work rejects a reviewer harness mismatch before starting the builder", async () => {
	const value = await fixture({ reviewer: { harness: "omp", route: "work-reviewer" } });
	const result = await invoke(value, ["build and review"]);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /harness|omp|tier/);
	await assertNoAllocation(value);
});

test("work rejects a cost target that dollar conversion would silently round", async () => {
	const value = await fixture({ reportOnlyCostUsdMicros: Number.MAX_SAFE_INTEGER });
	const result = await invoke(value, ["preserve cost target", "--dry-run"]);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /cannot preserve.*reported-cost target/);
	await assertNoAllocation(value);
});

test("work uses an explicitly selected named preset and repository", async () => {
	const value = await fixture();
	await writeFile(join(value.source, "ox-driver.json"), JSON.stringify({ version: 1, defaultPreset: "default", presets: {
		default: { ...value.preset, route: "missing-route" }, selected: value.preset,
	} }));
	const result = await invoke(value, ["preview selected", "--repo", value.source, "--preset", "selected", "--dry-run"]);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.receipt.presetName, "selected");
	assert.equal(result.receipt.lanes[0].spec.routeProfile, "work-builder");
	await assertNoAllocation(value);
});

test("work runs a configured Pi reviewer after the builder and preserves both route identities", async () => {
	const value = await fixture({ reviewer: { harness: "pi", route: "work-reviewer" }, reviewerTimeoutSeconds: 37, reviewerReportOnlyCostUsdMicros: 21_456 });
	const preview = await invoke(value, ["build and review", "--dry-run"]);
	assert.equal(preview.code, 0, preview.stderr);
	assert.equal(preview.receipt.workflow, "handoff");
	assert.equal(preview.receipt.lanes[1].spec.harness, "pi");
	assert.equal(preview.receipt.lanes[1].spec.execution.timeoutSeconds, 37);
	assert.equal(preview.receipt.lanes[1].spec.execution.reportOnlyCostUsdMicros, 21_456);
	await assertNoAllocation(value);
	const result = await invoke(value, ["build and review"]);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.receipt.kind, "handoff");
	assert.equal(result.receipt.status, "completed");
	assert.equal(result.receipt.reviewerHarness, "pi");
	assert.deepEqual(result.receipt.workers.map((worker) => worker.requestedRouteProfile), ["work-builder", "work-reviewer"]);
	assert.equal(result.receipt.evidence.reviewerReceivedExactBuilderState, true);
	assert.equal(result.receipt.evidence.reviewerChangedWorkspace, false);
	assert.equal(result.receipt.evidence.acceptancePassed, true);
	assert.equal(await text(value.env.WORK_FIXTURE_BUILDS), "builder\n");
	assert.equal(await text(value.env.WORK_FIXTURE_REVIEWS), "reviewer\n");
});

test("work resume reuses the admitted builder checkpoint without rerunning it", async () => {
	const value = await fixture({ reviewer: { harness: "pi", route: "work-reviewer" } });
	const objective = "--resume  the review\nwith the exact objective";
	const interrupted = await invoke(value, ["--", objective], { WORK_FIXTURE_INTERRUPT: "builder-checkpoint" });
	assert.equal(interrupted.code, 1);
	assert.equal(interrupted.receipt.status, "failed");
	assert.equal(await text(value.env.WORK_FIXTURE_BUILDS), "builder\n");
	assert.equal(await text(value.env.WORK_FIXTURE_REVIEWS), "");
	const resumed = await invoke(value, ["resume", interrupted.receipt.checkpointId, "--json"]);
	assert.equal(resumed.code, 0, resumed.stderr);
	assert.equal(resumed.receipt.status, "completed");
	assert.equal(resumed.receipt.resumed, true);
	assert.equal(resumed.receipt.objective, objective);
	assert.ok(resumed.receipt.reusedStages.includes("builder"));
	assert.equal(await text(value.env.WORK_FIXTURE_BUILDS), "builder\n");
	assert.equal(await text(value.env.WORK_FIXTURE_REVIEWS), "reviewer\n");
});

test("work cancellation reuses task signal handling and preserves its terminal receipt", async () => {
	const value = await fixture();
	const child = spawn(process.execPath, [value.runner, "slow work"], { cwd: value.source, env: value.env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const closed = new Promise((resolveClose, rejectClose) => {
		child.once("error", rejectClose);
		child.once("close", (code, signal) => resolveClose({ code, signal }));
	});
	try {
		for (let index = 0; index < 200 && !await text(value.env.WORK_FIXTURE_BUILDS); index += 1) await new Promise((done) => setTimeout(done, 25));
		assert.equal(await text(value.env.WORK_FIXTURE_BUILDS), "builder\n", stderr);
		child.kill("SIGINT");
		const result = await closed;
		assert.equal(result.signal, null, stderr);
		assert.equal(result.code, 1, stderr);
		const receipt = JSON.parse(stdout);
		assert.equal(receipt.status, "cancelled");
		assert.equal(receipt.workers[0].status, "cancelled");
		assert.deepEqual(JSON.parse(await readFile(receipt.receiptPath, "utf8")), receipt);
		assert.equal(await text(join(receipt.workspace.path, "owned/result.txt")), "work result\n");
	} finally { child.kill("SIGKILL"); }
});
