import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { PiAdapter } from "../../packages/adapters/pi/dist/index.js";
import { AdapterRegistry, OxController, RunStore } from "../../packages/core/dist/index.js";
import { trackedMkdtemp } from "./helpers/tracked-temp.mjs";

const execFileAsync = promisify(execFile);

async function fixture() {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-driver-pi-public-"));
	const repository = join(root, "repository");
	const launcher = join(root, "pi");
	await mkdir(join(repository, "src"), { recursive: true });
	await writeFile(join(repository, "src", "input.txt"), "input\n");
	await execFileAsync("git", ["init", "--quiet"], { cwd: repository });
	await execFileAsync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repository });
	await execFileAsync("git", ["config", "user.name", "Ox Driver Fixture"], { cwd: repository });
	await execFileAsync("git", ["add", "."], { cwd: repository });
	await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repository });
	await writeFile(launcher, `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.includes("--version")) { process.stdout.write("Pi 1.2.3\\n"); process.exit(0); }
for (const [flag, value] of [["--provider", "provider-a"], ["--model", "model-a"], ["--thinking", "max"]]) {
  const index = process.argv.indexOf(flag);
  if (index < 0 || process.argv[index + 1] !== value) process.exit(41);
}
const writer = process.argv.includes("--approve");
if (writer) writeFileSync(join(process.cwd(), "src", "generated.txt"), "generated\\n");
for (const event of [
  { type: "agent_start" },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: writer ? "writer complete" : "review complete" }], stopReason: "stop", usage: { cost: { total: 0.001 } } } },
  { type: "agent_end" },
  { type: "agent_settled" },
]) process.stdout.write(JSON.stringify(event) + "\\n");
`, { mode: 0o700 });
	await chmod(launcher, 0o700);
	return { root, repository, launcher };
}

function profile(value) {
	return {
		version: 1,
		id: "pi-default",
		status: "active",
		harness: "pi",
		tier: "trusted-host",
		launcher: { command: value.launcher, versionArgs: ["--version"] },
		route: { source: "explicit", provider: "provider-a", model: "model-a", reasoning: "max" },
		runtime: { mode: "direct", expectedVersion: "1.2.3" },
		pricingPolicy: "report-only",
		filePath: join(value.root, "pi-default.json"),
		sha256: "a".repeat(64),
	};
}

function spec(value, writerPolicy) {
	const writer = writerPolicy === "one-writer";
	return {
		version: 1,
		tier: "trusted-host",
		harness: "pi",
		routeProfile: "pi-default",
		task: {
			objective: writer ? "Create src/generated.txt" : "Review the repository",
			cwd: value.repository,
			ownedPaths: writer ? ["src/generated.txt"] : [],
			excludedPaths: [".git"],
		},
		execution: {
			session: "ephemeral",
			topology: "solo",
			writerPolicy,
			network: "configured",
			timeoutSeconds: 60,
			reportOnlyCostUsdMicros: 50_000,
		},
		acceptance: {
			commands: writer ? ["test \"$(cat src/generated.txt)\" = generated"] : [],
			requireCleanUnownedPaths: true,
			continueOnFailure: true,
		},
	};
}

test("public Pi adapter preserves the selected route for review and writing", async () => {
	const value = await fixture();
	const adapter = new PiAdapter({ profile: profile(value), enableTrustedHostDispatch: true });
	const doctor = await adapter.doctor();
	assert.equal(doctor.compatibility, "verified");
	assert.deepEqual(doctor.configuredRoute, { provider: "provider-a", model: "model-a", reasoning: "max" });

	const registry = new AdapterRegistry();
	registry.register(adapter);
	const controller = new OxController(registry, new RunStore(join(value.root, "state")));
	const review = await controller.run(spec(value, "read-only"));
	assert.equal(review.status, "completed");
	assert.equal(review.finalOutput, "review complete");
	assert.deepEqual(review.changedPaths, []);

	const writer = await controller.run(spec(value, "one-writer"));
	assert.equal(writer.status, "completed");
	assert.equal(writer.finalOutput, "writer complete");
	assert.deepEqual(writer.changedPaths, ["src/generated.txt"]);
	assert.deepEqual(writer.unownedChangedPaths, []);
	assert.equal(writer.acceptance[0].passed, true);
	assert.match(writer.patchPath ?? "", /harness\.patch$/);
	assert.match(writer.patchSha256 ?? "", /^[0-9a-f]{64}$/);
	assert.match(writer.patchBaseCommit ?? "", /^[0-9a-f]{40}$/);
	assert.equal(await readFile(join(value.repository, "src", "generated.txt"), "utf8"), "generated\n");
});
