#!/usr/bin/env node

import { isAbsolute, resolve } from "node:path";

import { ManagedWorktreeStore } from "../packages/core/dist/managed-worktrees.js";

function fail(message) {
	throw new Error(message);
}

function parse(args) {
	let stateDir;
	let ref;
	let discard = false;
	const positional = [];
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--state-dir") {
			stateDir = args[++index] ?? fail("--state-dir requires an absolute path");
			if (!isAbsolute(stateDir)) fail("--state-dir requires an absolute path");
		} else if (argument === "--ref") ref = args[++index] ?? fail("--ref requires a Git revision");
		else if (argument === "--discard") discard = true;
		else if (argument?.startsWith("--")) fail(`unknown option: ${argument}`);
		else positional.push(argument);
	}
	return { stateDir: stateDir ? resolve(stateDir) : undefined, ref, discard, positional };
}

async function main() {
	const [command, ...rest] = process.argv.slice(2);
	const options = parse(rest);
	const store = options.stateDir ? new ManagedWorktreeStore(options.stateDir) : new ManagedWorktreeStore();
	let result;
	if (command === "create") {
		if (options.positional.length !== 1 || options.discard) fail("usage: ox_workspace.mjs create <source> [--ref REV] [--state-dir PATH]");
		result = await store.create(options.positional[0], { ...(options.ref ? { ref: options.ref } : {}) });
	} else if (command === "list") {
		if (options.positional.length !== 0 || options.ref || options.discard) fail("usage: ox_workspace.mjs list [--state-dir PATH]");
		result = await store.list();
	} else if (command === "inspect") {
		if (options.positional.length !== 1 || options.ref || options.discard) fail("usage: ox_workspace.mjs inspect <id> [--state-dir PATH]");
		result = await store.inspect(options.positional[0]);
	} else if (command === "remove") {
		if (options.positional.length !== 1 || options.ref) fail("usage: ox_workspace.mjs remove <id> [--discard] [--state-dir PATH]");
		result = await store.remove(options.positional[0], { discard: options.discard });
	} else fail("usage: ox_workspace.mjs <create|list|inspect|remove> ...");
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
