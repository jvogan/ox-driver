import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { trackedMkdtemp } from "./helpers/tracked-temp.mjs";

const execFileAsync = promisify(execFile);

async function launcherFixture() {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-driver-script-launcher-"));
	const launcher = join(root, "opencode-fixture");
	await writeFile(launcher, `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  doctor) printf '%s\\n' 'opencode doctor: OK' 'default model: openrouter/z-ai/glm-5.3-flash'; exit 0 ;;
  --version) printf '%s\\n' '1.18.23'; exit 0 ;;
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
printf 'verified output\\n' > "$task_dir/result.txt"
printf '%s\\n' \\
  '{"type":"step_start","part":{"type":"step-start"}}' \\
  '{"type":"tool_use","part":{"type":"tool","tool":"write"}}' \\
  '{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls","cost":0.001}}' \\
  '{"type":"step_start","part":{"type":"step-start"}}' \\
  '{"type":"text","part":{"type":"text","text":"fixture complete"}}' \\
  '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","cost":0.002}}'
`, { mode: 0o700 });
	await chmod(launcher, 0o700);
	return launcher;
}

async function projectFixture() {
	const cwd = await trackedMkdtemp(join(tmpdir(), "ox-driver-script-project-"));
	await execFileAsync("git", ["init", "--quiet"], { cwd });
	return cwd;
}

async function profileFixture(launcher) {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-driver-script-profile-"));
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "opencode-default.json"), `${JSON.stringify({
		version: 1,
		id: "opencode-default",
		status: "active",
		harness: "opencode",
		tier: "trusted-host",
		launcher: {
			command: launcher,
			versionArgs: ["--version"],
			doctor: { args: ["doctor"], requiredText: ["opencode doctor: OK"] },
		},
		route: { source: "explicit", provider: "openrouter", model: "z-ai/glm-5.3-flash", reasoning: "max" },
		defaults: { timeoutSeconds: 3_600, reportOnlyCostUsdMicros: 50_000 },
		pricingPolicy: "report-only",
		credentialPolicy: "fixture",
	})}\n`, { mode: 0o600 });
	return root;
}

test("OpenCode helper runs repeated controller-owned checks and returns their receipt", async () => {
	const cwd = await projectFixture();
	const state = await trackedMkdtemp(join(tmpdir(), "ox-driver-script-state-"));
	const launcher = await launcherFixture();
	const profiles = await profileFixture(launcher);
	const result = await execFileAsync(process.execPath, [
		"scripts/ox_opencode.mjs", cwd, "Create result.txt",
		"--check", "test -f result.txt",
		"--check", "grep -q 'verified output' result.txt",
	], {
		cwd: process.cwd(),
		env: { ...process.env, OX_DRIVER_ROUTE_PROFILE_DIR: profiles, OX_DRIVER_STATE_DIR: state },
		maxBuffer: 8 * 1024 * 1024,
	});
	const receipt = JSON.parse(result.stdout);
	assert.equal(receipt.status, "completed");
	assert.deepEqual(receipt.acceptance.map((item) => item.passed), [true, true]);
	assert.deepEqual(receipt.harnessChangedPaths, ["result.txt"]);
	assert.deepEqual(receipt.acceptanceChangedPaths, []);
});

test("OpenCode helper preserves the failed receipt on stdout", async () => {
	const cwd = await projectFixture();
	const state = await trackedMkdtemp(join(tmpdir(), "ox-driver-script-failed-state-"));
	const launcher = await launcherFixture();
	const profiles = await profileFixture(launcher);
	await assert.rejects(execFileAsync(process.execPath, [
		"scripts/ox_opencode.mjs", cwd, "Create result.txt", "--check", "exit 9",
	], {
		cwd: process.cwd(),
		env: { ...process.env, OX_DRIVER_ROUTE_PROFILE_DIR: profiles, OX_DRIVER_STATE_DIR: state },
		maxBuffer: 8 * 1024 * 1024,
	}), (error) => {
		const receipt = JSON.parse(error.stdout);
		assert.equal(receipt.status, "failed");
		assert.equal(receipt.acceptance[0].exitCode, 9);
		return true;
	});
});
