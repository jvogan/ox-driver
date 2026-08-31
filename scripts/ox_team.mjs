#!/usr/bin/env node

import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HERD = resolve(ROOT, "scripts", "ox_herd.mjs");
const ORCHESTRATION = resolve(ROOT, "scripts", "ox_orchestration.mjs");
const INTEGRATE = resolve(ROOT, "scripts", "ox_integrate.mjs");

function fail(message) {
	throw new Error(message);
}

function command(args) {
	const action = args[0];
	if (action === "run") {
		const plan = args[1]?.trim() || fail("ox_team.mjs run requires a plan file");
		return [HERD, "--lane-spec", resolve(plan), ...args.slice(2)];
	}
	if (action === "inspect" || action === "report" || action === "list") {
		return [ORCHESTRATION, action, ...args.slice(1)];
	}
	if (action === "retry") {
		const id = args[1]?.trim() || fail("ox_team.mjs retry requires an orchestration id");
		return [ORCHESTRATION, "retry", id, ...args.slice(2)];
	}
	if (action === "propose" || action === "apply") return [INTEGRATE, action, ...args.slice(1)];
	fail("usage: ox_team.mjs run PLAN.json | inspect ID | report ID | retry ID [options] | propose ID | apply ID [options] | list");
}

async function main() {
	const [script, ...args] = command(process.argv.slice(2));
	if (!isAbsolute(script)) fail("resolved Ox team command must be absolute");
	const exitCode = await new Promise((resolveExit, rejectExit) => {
		const child = spawn(process.execPath, [script, ...args], {
			cwd: ROOT,
			env: process.env,
			stdio: "inherit",
		});
		const forward = (signal) => child.kill(signal);
		const onInt = () => forward("SIGINT");
		const onTerm = () => forward("SIGTERM");
		process.on("SIGINT", onInt);
		process.on("SIGTERM", onTerm);
		child.once("error", rejectExit);
		child.once("close", (code) => {
			process.off("SIGINT", onInt);
			process.off("SIGTERM", onTerm);
			resolveExit(code ?? 1);
		});
	});
	process.exitCode = exitCode;
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
