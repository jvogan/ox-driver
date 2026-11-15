import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { trackedMkdtemp } from "../controller/helpers/tracked-temp.mjs";

const execute = promisify(execFile);
const coreModule = new URL("../../packages/core/dist/index.js", import.meta.url).href;
const fakeModule = new URL("../../packages/adapters/fake/dist/index.js", import.meta.url).href;

test("acceptance uses system or controller Node before inherited shims while isolating HOME and credentials", { skip: process.platform === "win32" }, async () => {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-acceptance-runtime-"));
	const repository = join(root, "repository");
	const ambientHome = join(root, "ambient-home");
	const shims = join(root, "shims");
	await Promise.all([repository, ambientHome, shims].map((path) => mkdir(path)));
	await writeFile(join(ambientHome, ".npmrc"), "fixture-auth-marker\n");
	await writeFile(join(shims, "node"), "#!/bin/sh\nprintf '%s\\n' 'inherited node shim cannot use isolated HOME' >&2\nexit 91\n", { mode: 0o700 });
	const runtimeDirectory = dirname(process.execPath);
	let expectedNode = process.execPath;
	for (const directory of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
		const candidate = join(directory, "node");
		if (await access(candidate, constants.X_OK).then(() => true, () => false)) {
			expectedNode = candidate;
			break;
		}
	}
	expectedNode = await realpath(expectedNode);
	await writeFile(join(repository, "runtime-check.test.mjs"), `
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";
test("runtime and isolated environment", () => {
 assert.equal(realpathSync(process.execPath), ${JSON.stringify(expectedNode)});
 const directories = process.env.PATH.split(delimiter);
 assert.ok(directories.indexOf(${JSON.stringify(runtimeDirectory)}) < directories.indexOf(${JSON.stringify(shims)}));
 assert.notEqual(process.env.HOME, ${JSON.stringify(ambientHome)});
 assert.equal(existsSync(join(process.env.HOME, ".npmrc")), false);
 assert.equal(process.env.NPM_TOKEN, undefined);
 assert.equal(process.env.OPENAI_API_KEY, undefined);
 assert.equal(process.env.NODE_OPTIONS, undefined);
 assert.notEqual(process.env.XDG_CONFIG_HOME, ${JSON.stringify(ambientHome)});
 console.log("isolated runtime verified");
});
`);
	await execute("git", ["init", "--quiet"], { cwd: repository });
	await execute("git", ["add", "."], { cwd: repository });
	await execute("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "--quiet", "-m", "base"], { cwd: repository });
	const runner = join(root, "runner.mjs");
	await writeFile(runner, `
import { AdapterRegistry, OxController, RunStore } from ${JSON.stringify(coreModule)};
import { FakeAdapter } from ${JSON.stringify(fakeModule)};
const registry = new AdapterRegistry();
registry.register(new FakeAdapter());
const controller = new OxController(registry, new RunStore(${JSON.stringify(join(root, "state"))}));
const receipt = await controller.run({
 version: 1, tier: "trusted-host", harness: "fake",
 task: { objective: "Verify acceptance runtime isolation", cwd: ${JSON.stringify(repository)}, ownedPaths: [], excludedPaths: [] },
 execution: { session: "ephemeral", topology: "solo", writerPolicy: "read-only", network: "configured", timeoutSeconds: 30 },
 acceptance: { commands: ["node --test runtime-check.test.mjs"], requireCleanUnownedPaths: true },
});
console.log(JSON.stringify(receipt));
`);
	const result = await execute(process.execPath, [runner], {
		env: {
			...process.env,
			PATH: [shims, ...String(process.env.PATH ?? "").split(delimiter).filter((path) => path !== runtimeDirectory)].join(delimiter),
			HOME: ambientHome, XDG_CONFIG_HOME: ambientHome,
			NPM_TOKEN: "fixture-token", OPENAI_API_KEY: "fixture-key", NODE_OPTIONS: "--no-warnings",
		},
		maxBuffer: 4 * 1024 * 1024,
	});
	const receipt = JSON.parse(result.stdout);
	assert.equal(receipt.status, "completed", JSON.stringify(receipt.acceptance));
	assert.equal(receipt.acceptance[0].passed, true);
	assert.match(receipt.acceptance[0].stdout, /isolated runtime verified/);
	assert.doesNotMatch(receipt.acceptance[0].stderr, /inherited node shim/);
	assert.equal(await readFile(join(ambientHome, ".npmrc"), "utf8"), "fixture-auth-marker\n");
});
