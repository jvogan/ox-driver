import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
// Assembled from parts so the fixture carries no literal run identifier.
const REQUESTED_RUN_ID = `${"1".repeat(8)}-1111-4111-8111-${"1".repeat(12)}`;
const ABSENT_RUN_ID = `${"2".repeat(8)}-2222-4222-8222-${"2".repeat(12)}`;

test("public OpenCode CLI doctors, preflights, runs, and inspects through a portable profile", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ox-driver-public-cli-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const project = join(root, "project");
	const profiles = join(root, "profiles");
	const state = join(root, "state");
	await mkdir(project);
	await mkdir(profiles);
	await execFileAsync("git", ["init", "--quiet"], { cwd: project });
	const launcher = join(root, "opencode-fixture");
	await writeFile(launcher, `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --version) printf '%s\\n' 'opencode fixture 1.0.0'; exit 0 ;;
  doctor) printf '%s\\n' 'fixture doctor ready'; exit 0 ;;
esac
[ "\${1:-}" = run ] || exit 20
shift
task_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir) task_dir="$2"; shift 2 ;;
    --agent|--model|--variant|--format) shift 2 ;;
    --auto) shift ;;
    *) shift ;;
  esac
done
printf '%s\\n' 'public fixture result' > "$task_dir/result.txt"
printf '%s\\n' \\
  '{"type":"step_start","part":{"type":"step-start"}}' \\
  '{"type":"tool_use","part":{"type":"tool","tool":"write"}}' \\
  '{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls","cost":0.001}}' \\
  '{"type":"step_start","part":{"type":"step-start"}}' \\
  '{"type":"text","part":{"type":"text","text":"public fixture complete"}}' \\
  '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","cost":0.002}}'
`, { mode: 0o700 });
	await chmod(launcher, 0o700);
	await writeFile(join(profiles, "fixture-route.json"), `${JSON.stringify({
		version: 1,
		id: "fixture-route",
		status: "active",
		harness: "opencode",
		tier: "trusted-host",
		launcher: {
			command: launcher,
			versionArgs: ["--version"],
			doctor: { args: ["doctor"], requiredText: ["fixture doctor ready"] },
		},
		route: { source: "explicit", provider: "fixture-provider", model: "fixture-model", reasoning: "high" },
		agent: { defaultProfile: "builder", allowedProfiles: ["builder"] },
		pricingPolicy: "report-only",
		credentialPolicy: "fixture",
	}, null, 2)}\n`);
	const specPath = join(root, "run.json");
	await writeFile(specPath, `${JSON.stringify({
		version: 1,
		tier: "trusted-host",
		harness: "opencode",
		routeProfile: "fixture-route",
		task: { objective: "Create result.txt", cwd: project, ownedPaths: ["."], excludedPaths: [".git", ".env"] },
		execution: {
			session: "new",
			topology: "solo",
			writerPolicy: "one-writer",
			network: "configured",
			timeoutSeconds: 30,
			reportOnlyCostUsdMicros: 50_000,
		},
		acceptance: { commands: ["test -f result.txt"], requireCleanUnownedPaths: true },
	}, null, 2)}\n`);
	const cli = join(process.cwd(), "packages", "opencode-cli", "dist", "main.js");
	const env = {
		...process.env,
		OX_DRIVER_ROUTE_PROFILE_DIR: profiles,
		OX_DRIVER_OPENCODE_PROFILE: "fixture-route",
		OX_DRIVER_STATE_DIR: state,
		OX_DRIVER_REQUESTED_RUN_ID: REQUESTED_RUN_ID,
	};
	const invoke = async (...args) => JSON.parse((await execFileAsync(process.execPath, [cli, ...args], { env })).stdout);

	assert.equal((await invoke("validate", specPath)).valid, true);
	const doctor = await invoke("doctor");
	assert.equal(doctor[0].harness, "opencode");
	assert.equal(doctor[0].probe.modelCalls, 0);
	assert.equal((await invoke("preflight", specPath)).ok, true);
	const runResult = await execFileAsync(process.execPath, [cli, "run", specPath], { env });
	const receipt = JSON.parse(runResult.stdout);
	assert.equal(runResult.stderr, `OX_DRIVER_RUN_ID=${receipt.runId}\n`);
	assert.equal(receipt.status, "completed");
	assert.deepEqual(receipt.configuredRoute, { provider: "fixture-provider", model: "fixture-model", reasoning: "high" });
	assert.deepEqual(receipt.changedPaths, ["result.txt"]);
	assert.deepEqual(receipt.acceptance.map((item) => item.passed), [true]);
	assert.equal(await readFile(join(project, "result.txt"), "utf8"), "public fixture result\n");
	const inspected = await invoke("inspect", receipt.runId);
	assert.equal(inspected.receipt.runId, receipt.runId);
	assert.equal(inspected.status.status, "completed");

	const stateOnlyEnv = { ...env, OX_DRIVER_ROUTE_PROFILE_DIR: join(root, "missing-profiles"), OX_DRIVER_OPENCODE_PROFILE: "missing" };
	const stateOnlyInspect = JSON.parse((await execFileAsync(process.execPath, [cli, "inspect", receipt.runId], { env: stateOnlyEnv })).stdout);
	assert.equal(stateOnlyInspect.receipt.runId, receipt.runId);
	await assert.rejects(
		execFileAsync(process.execPath, [cli, "cancel", ABSENT_RUN_ID], { env: stateOnlyEnv }),
		(error) => {
			assert.match(error.stderr, /ENOENT|not found/i);
			assert.equal(error.stdout, "");
			return true;
		},
	);
	await assert.rejects(
		execFileAsync(process.execPath, [cli, "run", specPath], { env: { ...env, OX_DRIVER_REQUESTED_RUN_ID: "not-a-uuid" } }),
		(error) => {
			assert.equal(error.stdout, "");
			assert.equal(error.stderr, "OX_DRIVER_REQUESTED_RUN_ID must be a canonical UUID\n");
			return true;
		},
	);

	const help = (await execFileAsync(process.execPath, [cli, "--help"], { env })).stdout;
	for (const command of ["validate", "doctor", "preflight", "run", "inspect", "cancel", "recover"]) {
		assert.match(help, new RegExp(`\\b${command}\\b`));
	}
});

test("public OpenCode CLI fails closed before any workspace or provider spend", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "ox-driver-public-cli-blocked-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const project = join(root, "project");
	const profiles = join(root, "profiles");
	await mkdir(project);
	await mkdir(profiles);
	await execFileAsync("git", ["init", "--quiet"], { cwd: project });
	const baseProfile = {
		version: 1,
		status: "active",
		harness: "opencode",
		tier: "trusted-host",
		pricingPolicy: "report-only",
		credentialPolicy: "fixture",
	};
	await writeFile(join(profiles, "blocked-route.json"), `${JSON.stringify({
		...baseProfile,
		id: "blocked-route",
		launcher: { command: join(root, "missing-launcher"), versionArgs: ["--version"] },
		route: { source: "explicit", provider: "fixture-provider", model: "fixture-model", reasoning: "high" },
	}, null, 2)}\n`);
	await writeFile(join(profiles, "launcher-route.json"), `${JSON.stringify({
		...baseProfile,
		id: "launcher-route",
		launcher: { command: join(root, "missing-launcher"), versionArgs: ["--version"] },
		route: { source: "launcher" },
	}, null, 2)}\n`);
	const cli = join(process.cwd(), "packages", "opencode-cli", "dist", "main.js");
	const env = {
		...process.env,
		OX_DRIVER_ROUTE_PROFILE_DIR: profiles,
		OX_DRIVER_OPENCODE_PROFILE: "blocked-route",
		OX_DRIVER_STATE_DIR: join(root, "state"),
		OX_DRIVER_ORCHESTRATION_STATE_DIR: join(root, "orchestration-state"),
		OX_DRIVER_WORKSPACE_STATE_DIR: join(root, "workspace-state"),
	};

	const doctorFailure = await execFileAsync(process.execPath, [cli, "doctor"], { env }).then(() => null, (error) => error);
	assert.ok(doctorFailure, "doctor must exit non-zero for a blocked launcher");
	assert.equal(doctorFailure.code, 2, doctorFailure.stderr);
	const reports = JSON.parse(doctorFailure.stdout);
	assert.equal(reports[0].available, false);

	const blockedTask = await execFileAsync(
		process.execPath,
		[cli, "task", project, "attempt a blocked dispatch", "--no-check"],
		{ env },
	).then(() => null, (error) => error);
	assert.ok(blockedTask, "task must exit non-zero for a blocked launcher");
	assert.equal(blockedTask.code, 1, blockedTask.stderr);
	assert.ok(blockedTask.stdout, blockedTask.stderr);
	const blockedReceipt = JSON.parse(blockedTask.stdout);
	assert.equal(blockedReceipt.status, "failed");
	assert.equal(blockedReceipt.failure.stage, "route-preflight");
	assert.equal(blockedReceipt.receiptPath, join(env.OX_DRIVER_ORCHESTRATION_STATE_DIR, `${blockedReceipt.orchestrationId}.json`));
	assert.equal(blockedReceipt.workspace, undefined);
	assert.deepEqual(blockedReceipt.workers, []);
	const records = await readdir(join(env.OX_DRIVER_WORKSPACE_STATE_DIR, "records")).catch(() => []);
	assert.deepEqual(records, [], "a blocked preflight must not register a managed worktree");
	const worktrees = (await execFileAsync("git", ["worktree", "list"], { cwd: project })).stdout.trim().split("\n");
	assert.equal(worktrees.length, 1, "a blocked preflight must not attach a Git worktree to the source");

	const ambientTask = await execFileAsync(
		process.execPath,
		[cli, "task", project, "attempt launcher-default dispatch", "--no-check"],
		{ env: { ...env, OX_DRIVER_OPENCODE_PROFILE: "launcher-route" } },
	).then(() => null, (error) => error);
	assert.ok(ambientTask, "task must reject launcher-default routing");
	assert.equal(ambientTask.code, 1, ambientTask.stderr);
	const ambientReceipt = JSON.parse(ambientTask.stdout);
	assert.equal(ambientReceipt.status, "failed");
	assert.equal(ambientReceipt.failure.stage, "route-resolving");
	assert.equal(ambientReceipt.receiptPath, join(env.OX_DRIVER_ORCHESTRATION_STATE_DIR, `${ambientReceipt.orchestrationId}.json`));
	assert.match(JSON.stringify(ambientReceipt.failure), /launcher-default routing/);
	assert.match(JSON.stringify(ambientReceipt.failure), /init-opencode/);
});

test("public OpenCode CLI tails a run's status, budget, and recent events", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ox-driver-public-tail-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = join(root, "state");
	const runId = "tail-fixture";
	const runDirectory = join(state, "runs", runId);
	await mkdir(runDirectory, { recursive: true });
	await writeFile(join(runDirectory, "status.json"), JSON.stringify({
		version: 1,
		runId,
		status: "running",
		updatedAt: "2026-08-29T00:00:00.000Z",
	}));
	await writeFile(join(runDirectory, "budget-ledger.json"), JSON.stringify({ providerRequests: 2, toolCalls: 5 }));
	const events = [];
	for (let sequence = 1; sequence <= 30; sequence += 1) {
		events.push(JSON.stringify({
			version: 1,
			sequence,
			time: "2026-08-29T00:00:01.000Z",
			runId,
			adapterId: "opencode-v2",
			type: "adapter.event",
			data: { sequence },
		}));
	}
	await writeFile(join(runDirectory, "events.jsonl"), `${events.join("\n")}\n`);
	const cli = join(process.cwd(), "packages", "opencode-cli", "dist", "main.js");
	const env = { ...process.env, OX_DRIVER_STATE_DIR: state };
	const tail = JSON.parse((await execFileAsync(
		process.execPath,
		[cli, "tail", runId, "--events", "5"],
		{ env, maxBuffer: 4 * 1024 * 1024 },
	)).stdout);
	assert.equal(tail.runId, runId);
	assert.equal(tail.status, "running");
	assert.deepEqual(tail.budget, { providerRequests: 2, toolCalls: 5 });
	assert.deepEqual(tail.events.map((event) => event.data.sequence), [26, 27, 28, 29, 30]);
	assert.equal(tail.eventsSkipped, 25);
	assert.equal(tail.tailOnly, false);

	const missing = await execFileAsync(process.execPath, [cli, "tail", "no-such-run"], { env })
		.then(() => null, (error) => error);
	assert.ok(missing, "tail of a missing run must fail");
	assert.equal(missing.code, 1);
});
