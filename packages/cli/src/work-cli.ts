import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { StoredOrchestrationReceipt } from "@ox-driver/core";
import { initProject, type InitProjectOptions } from "./project-config.js";
import { runWork } from "./work.js";
import { buildWorkResult, exportWorkPatch, formatWorkResult, getWorkResult } from "./work-result.js";

export const workUsage = `Usage:
  ox-driver init --route PROFILE (--check COMMAND ... | --no-check) [--repo DIR]
                 [--reviewer pi|omp --reviewer-route PROFILE] [--preset NAME]
                 [--owned PATH ...] [--exclude PATH ...] [--agent PROFILE]
                 [--child-agent PROFILE ...] [--timeout SECONDS] [--cost-ceiling USD]
                 [--reviewer-timeout SECONDS] [--reviewer-cost-ceiling USD] [--json]
  ox-driver work "OBJECTIVE" [--repo DIR] [--preset NAME] [--dry-run] [--json]
  ox-driver work resume CHECKPOINT_ID [--json]
  ox-driver result ORCHESTRATION_ID [--json]
  ox-driver patch ORCHESTRATION_ID [--out FILE]
  ox-driver route list | check [options]
  ox-driver route init-opencode|init-pi|init-omp [options]

init saves route IDs, scope, and checks in ox-driver.json at the Git repository root.
work uses an OpenCode writer and an optional Pi or OMP reviewer from that preset.
Workers start from committed HEAD; uncommitted and untracked source files are excluded.
--dry-run checks the selected routes without creating a worktree or making a model request.
--json preserves structured output. patch writes verified builder patch bytes.
Cost ceilings compare reported cost after execution; they are not spending caps.`;

function jsonRequested(args: string[]): boolean {
	const sentinel = args.indexOf("--");
	return (sentinel < 0 ? args : args.slice(0, sentinel)).includes("--json");
}

function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

export function terminalText(value: string): string {
	return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}

function cost(value: string, flag: string): number {
	const dollars = Number(value);
	const micros = Math.round(dollars * 1_000_000);
	if (!Number.isFinite(dollars) || dollars < 0 || !Number.isSafeInteger(micros)) throw new Error(`${flag} requires a non-negative dollar amount`);
	return micros;
}

function initOptions(args: string[]): InitProjectOptions {
	const options: InitProjectOptions = {};
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index += 1) {
		const flag = args[index]!;
		const repeated = ["--check", "--owned", "--exclude", "--child-agent"].includes(flag);
		if (!repeated && seen.has(flag)) throw new Error(`init option must not repeat: ${flag}`);
		seen.add(flag);
		if (flag === "--json") continue;
		if (flag === "--no-check") { options.noCheck = true; continue; }
		const valueFlags = ["--route", "--repo", "--preset", "--check", "--owned", "--exclude", "--reviewer", "--reviewer-route", "--agent", "--child-agent", "--timeout", "--cost-ceiling", "--reviewer-timeout", "--reviewer-cost-ceiling"];
		if (!valueFlags.includes(flag)) throw new Error(`unknown init option: ${flag}`);
		const value = args[++index];
		if (!value?.trim() || value.startsWith("--")) throw new Error(`${flag} requires a value`);
		switch (flag) {
			case "--route": options.route = value; break;
			case "--repo": options.repository = resolve(value); break;
			case "--preset": options.presetName = value; break;
			case "--check": (options.checks ??= []).push(value); break;
			case "--owned": (options.ownedPaths ??= []).push(value); break;
			case "--exclude": (options.excludedPaths ??= []).push(value); break;
			case "--agent": options.agent = value; break;
			case "--child-agent": (options.childAgents ??= []).push(value); break;
			case "--reviewer":
				if (value !== "pi" && value !== "omp") throw new Error("--reviewer requires pi or omp");
				options.reviewer = value; break;
			case "--reviewer-route": options.reviewerRoute = value; break;
			case "--timeout": options.timeoutSeconds = Number(value); break;
			case "--reviewer-timeout": options.reviewerTimeoutSeconds = Number(value); break;
			case "--cost-ceiling": options.reportOnlyCostUsdMicros = cost(value, flag); break;
			case "--reviewer-cost-ceiling": options.reviewerReportOnlyCostUsdMicros = cost(value, flag); break;
		}
	}
	return options;
}

function formatPreview(value: Record<string, unknown>): string {
	const lines = [`Work preflight: ${String(value.status)}`, `Repository: ${String(value.source)}`, `Preset: ${String(value.presetName)}`, `Workflow: ${String(value.workflow)}`];
	for (const raw of Array.isArray(value.lanes) ? value.lanes : []) {
		const lane = raw as { role: string; spec: { routeProfile?: string; acceptance?: { commands?: string[] } }; preflight: { ok: boolean; doctor?: { configuredRoute?: { provider: string; model: string; reasoning: string }; notices?: string[] }; issues?: Array<{ severity: string; message: string }> } };
		lines.push(`${lane.role}: ${lane.spec.routeProfile ?? "unknown route"} (${lane.preflight.ok ? "ready" : "blocked"})`);
		const route = lane.preflight.doctor?.configuredRoute;
		if (route) lines.push(`  Route: ${route.provider}/${route.model}, reasoning ${route.reasoning}`);
		for (const command of lane.spec.acceptance?.commands ?? []) lines.push(`  Check: ${command}`);
		for (const issue of lane.preflight.issues ?? []) lines.push(`  ${issue.severity}: ${issue.message}`);
		for (const notice of lane.preflight.doctor?.notices ?? []) lines.push(`  Notice: ${notice}`);
	}
	lines.push("No worktree created. No model request made. Checks have not run.");
	for (const notice of Array.isArray(value.notices) ? value.notices : []) lines.push(String(notice));
	return terminalText(lines.join("\n"));
}

export async function runWorkCommand(argv: string[]): Promise<number | undefined> {
	const [command, ...args] = argv;
	if (command === "route") {
		return new Promise<number>((resolveExit, rejectExit) => {
			const script = fileURLToPath(new URL("../../../scripts/ox_route.mjs", import.meta.url));
			const child = spawn(process.execPath, [script, ...args], { stdio: "inherit" });
			child.once("error", rejectExit);
			child.once("close", (code) => resolveExit(code ?? 1));
		});
	}
	if (!["init", "work", "result", "patch"].includes(command ?? "")) return undefined;
	if (["--help", "-h", "help"].includes(args[0] ?? "")) { process.stdout.write(`${workUsage}\n`); return 0; }
	if (command === "init") {
		const configured = await initProject(initOptions(args));
		if (jsonRequested(args)) print(configured);
		else process.stdout.write(terminalText(`Saved preset ${configured.presetName} in ox-driver.json.\nRepository: ${configured.repository}\nFrom that repository:\n  ox-driver work "Describe a bounded change" --dry-run\n  ox-driver work "Describe a bounded change"\n`));
		return 0;
	}
	if (command === "work") {
		const result = await runWork(args);
		if (result.preview) {
			if (jsonRequested(args)) print(result.preview);
			else process.stdout.write(`${formatPreview(result.preview)}\n`);
		} else {
			const report = await buildWorkResult(result.receipt as StoredOrchestrationReceipt);
			if (jsonRequested(args)) print(report);
			else process.stdout.write(`${formatWorkResult(report)}\n`);
		}
		return result.exitCode;
	}
	const id = args[0];
	if (!id || id.startsWith("--")) throw new Error(`${command} requires an orchestration id`);
	if (command === "result") {
		if (args.length > 2 || (args[1] !== undefined && args[1] !== "--json")) throw new Error("usage: ox-driver result ORCHESTRATION_ID [--json]");
		const result = await getWorkResult(id);
		if (jsonRequested(args)) print(result);
		else process.stdout.write(`${formatWorkResult(result)}\n`);
		return result.report.childReceiptsComplete ? 0 : 2;
	}
	if (args.length !== 1 && (args.length !== 3 || args[1] !== "--out" || !args[2])) throw new Error("usage: ox-driver patch ORCHESTRATION_ID [--out FILE]");
	const bytes = await exportWorkPatch(id, args[2]);
	if (args[2]) process.stdout.write(terminalText(`Saved verified patch to ${args[2]}.\n`));
	else process.stdout.write(bytes);
	return 0;
}
