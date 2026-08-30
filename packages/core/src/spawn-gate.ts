/**
 * A tiny controller-owned process leader that waits for one stdin byte before
 * launching the harness. This lets an adapter durably bind the process-group
 * identity before untrusted harness code can execute.
 */
const SOURCE = `
import { spawn } from "node:child_process";
const [command, ...args] = process.argv.slice(1);
if (!command) process.exit(125);
let child;
let started = false;
const forward = (signal) => { if (child && child.exitCode === null) child.kill(signal); };
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => forward(signal));
process.stdin.once("data", () => {
  started = true;
  child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
  child.once("error", (error) => { process.stderr.write(String(error) + "\\n"); process.exitCode = 126; });
  child.once("close", (code) => { process.exitCode = code === null ? 1 : code; });
});
process.stdin.once("end", () => { if (!started) process.exitCode = 125; });
process.stdin.resume();
`;

export function gatedProcessArguments(command: string, args: readonly string[]): string[] {
	if (!command.trim() || command.includes("\0")) throw new Error("gated process command must be non-empty");
	return ["--input-type=module", "--eval", SOURCE, command, ...args];
}
