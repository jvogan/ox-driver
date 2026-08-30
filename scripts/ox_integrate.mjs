#!/usr/bin/env node

// Integration proposals for terminal orchestration receipts: per-lane diff
// statistics, a file-overlap matrix, a deterministic apply order, patch
// export, and an explicit host-invoked apply into a disposable integration
// worktree. Nothing here runs a harness or contacts a provider.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import {
	captureWorkspacePatch,
	ManagedWorktreeStore,
	OrchestrationReceiptStore,
	RunStore,
} from "../packages/core/dist/index.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const CHECK_OUTPUT_TAIL_BYTES = 4 * 1024;
const USAGE = `usage:
  ox_integrate.mjs propose ID
  ox_integrate.mjs export ID --lane LANE_ID [--path RELATIVE_PATH ...] [--out FILE]
  ox_integrate.mjs apply ID --lane LANE_ID [--lane LANE_ID ...] --repo SOURCE
                    (--check COMMAND ... | --no-check) [--timeout SECONDS]`;

function fail(message) {
	throw new Error(message);
}

function runStore() {
	const explicit = process.env.OX_DRIVER_STATE_DIR?.trim();
	return explicit ? new RunStore(explicit) : new RunStore();
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function laneIdOf(worker) {
	return typeof worker.laneId === "string" && worker.laneId ? worker.laneId : String(worker.role ?? "");
}

// Resolve every lane's change to a patch. Preference order: the durable patch
// the run receipt recorded, then a fresh capture from the lane's intact
// managed worktree, then an explicit "unavailable" marker.
async function resolveLanePatches(receipt) {
	const store = runStore();
	const worktrees = new ManagedWorktreeStore();
	const lanes = [];
	for (const worker of receipt.workers) {
		const lane = {
			laneId: laneIdOf(worker),
			role: worker.role,
			workerPath: worker.workerPath,
			status: worker.status,
			changedPaths: Array.isArray(worker.changedPaths) ? worker.changedPaths : [],
		};
		const runId = typeof worker.runId === "string" && worker.runId ? worker.runId : undefined;
		const runReceipt = runId ? await store.readReceipt(runId).catch(() => undefined) : undefined;
		if (lane.changedPaths.length === 0 && (runReceipt?.changedPaths ?? []).length === 0) {
			lanes.push({ ...lane, source: "none", noChanges: true });
			continue;
		}
		if (typeof runReceipt?.patchPath === "string" && typeof runReceipt?.patchSha256 === "string") {
			const patch = await readFile(join(store.root, runReceipt.patchPath), "utf8").catch(() => undefined);
			if (patch !== undefined) {
				if (sha256(patch) !== runReceipt.patchSha256) {
					lanes.push({ ...lane, source: "unavailable", reason: "the durable patch does not match its receipt digest" });
					continue;
				}
				lanes.push({
					...lane,
					source: "receipt",
					patch,
					patchSha256: runReceipt.patchSha256,
					...(typeof runReceipt.patchBaseCommit === "string" ? { baseCommit: runReceipt.patchBaseCommit } : {}),
				});
				continue;
			}
		}
		if (typeof worker.worktreeId === "string") {
			const captured = await captureFromWorktree(worktrees, worker.worktreeId);
			if (captured) {
				if (captured.patch.length === 0) lanes.push({ ...lane, source: "none", noChanges: true });
				else lanes.push({ ...lane, source: "worktree", patch: captured.patch, patchSha256: sha256(captured.patch), baseCommit: captured.baseCommit });
				continue;
			}
		}
		lanes.push({ ...lane, source: "unavailable", reason: "no durable patch and no intact managed worktree" });
	}
	return lanes;
}

async function captureFromWorktree(worktrees, worktreeId) {
	let workspace;
	try {
		workspace = await worktrees.inspect(worktreeId);
	} catch {
		return undefined;
	}
	if (workspace.status === "missing" || workspace.status === "removed" || workspace.status === "unregistered") return undefined;
	const scratch = await mkdtemp(join(tmpdir(), "ox-integrate-index-"));
	try {
		const captured = await captureWorkspacePatch(workspace.path, join(scratch, "patch.index"), workspace.baseCommit);
		if (captured.patch === null) return undefined;
		return { patch: captured.patch, baseCommit: workspace.baseCommit };
	} catch {
		return undefined;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

// git apply --numstat parses the patch without a repository and reports
// renames and binary changes ("-" counts) uniformly.
async function patchStatistics(patch) {
	const scratch = await mkdtemp(join(tmpdir(), "ox-integrate-stat-"));
	try {
		const patchPath = join(scratch, "lane.patch");
		await writeFile(patchPath, patch, { mode: 0o600 });
		const result = await execFileAsync("git", ["apply", "--numstat", patchPath], { cwd: scratch, maxBuffer: MAX_GIT_OUTPUT_BYTES });
		const files = [];
		for (const line of result.stdout.split("\n")) {
			if (!line.trim()) continue;
			const [added, deleted, ...rest] = line.split("\t");
			const path = rest.join("\t");
			if (!path) continue;
			files.push({
				path,
				added: added === "-" ? null : Number(added),
				deleted: deleted === "-" ? null : Number(deleted),
			});
		}
		return files;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

function overlapMatrix(changedLanes) {
	const overlaps = [];
	for (let left = 0; left < changedLanes.length; left += 1) {
		for (let right = left + 1; right < changedLanes.length; right += 1) {
			const rightPaths = new Set(changedLanes[right].diffstat.map((file) => file.path));
			const paths = changedLanes[left].diffstat.map((file) => file.path).filter((path) => rightPaths.has(path)).sort();
			if (paths.length > 0) overlaps.push({ laneIds: [changedLanes[left].laneId, changedLanes[right].laneId], paths });
		}
	}
	return overlaps;
}

async function proposal(receipt) {
	const lanes = await resolveLanePatches(receipt);
	const changedLanes = [];
	for (const lane of lanes) {
		if (lane.patch === undefined) continue;
		changedLanes.push({ ...lane, diffstat: await patchStatistics(lane.patch) });
	}
	const overlaps = overlapMatrix(changedLanes);
	// Path overlap is the deterministic v1 conflict definition; an apply-time
	// failure on non-overlapping patches is still caught by apply itself.
	const conflictLaneIds = [...new Set(overlaps.flatMap((overlap) => overlap.laneIds))].sort();
	const applyOrder = changedLanes.map((lane) => lane.laneId).filter((laneId) => !conflictLaneIds.includes(laneId));
	return {
		lanes: lanes.map((lane) => {
			const changed = changedLanes.find((candidate) => candidate.laneId === lane.laneId);
			return {
				laneId: lane.laneId,
				role: lane.role,
				workerPath: lane.workerPath,
				status: lane.status,
				source: lane.source,
				...(lane.noChanges ? { noChanges: true } : {}),
				...(lane.reason ? { reason: lane.reason } : {}),
				...(lane.baseCommit ? { baseCommit: lane.baseCommit } : {}),
				...(lane.patchSha256 ? { patchSha256: lane.patchSha256 } : {}),
				...(changed ? {
					diffstat: {
						files: changed.diffstat,
						totalAdded: changed.diffstat.reduce((sum, file) => sum + (file.added ?? 0), 0),
						totalDeleted: changed.diffstat.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
					},
				} : {}),
			};
		}),
		changedLanes,
		overlaps,
		conflictLaneIds,
		applyOrder,
		unavailableLaneIds: lanes.filter((lane) => lane.source === "unavailable").map((lane) => lane.laneId),
	};
}

// Keep sections of a patch whose old or new path matches a selected path
// exactly or by directory prefix. Sections start at "diff --git" headers, so
// binary hunks stay intact.
function filterPatch(patch, selectedPaths) {
	const sections = patch.split(/^(?=diff --git )/m).filter((section) => section.trim());
	const matches = (path) => selectedPaths.some((candidate) => path === candidate || path.startsWith(`${candidate}/`));
	const kept = sections.filter((section) => {
		const header = section.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
		if (!header) return false;
		return matches(header[1]) || matches(header[2]);
	});
	return kept.join("");
}

function relativeScope(value, flag) {
	if (!value || isAbsolute(value) || value.includes("\0") || value.split(/[\\/]+/).includes("..")) {
		fail(`${flag} must be a relative path that stays inside the repository`);
	}
	return value;
}

function runCheck(command, cwd, timeoutSeconds) {
	return new Promise((resolveCheck) => {
		const startedAt = Date.now();
		const child = spawn("/bin/sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
		let stdoutTail = "";
		let stderrTail = "";
		const keepTail = (current, chunk) => `${current}${chunk}`.slice(-CHECK_OUTPUT_TAIL_BYTES);
		child.stdout.on("data", (chunk) => { stdoutTail = keepTail(stdoutTail, chunk.toString("utf8")); });
		child.stderr.on("data", (chunk) => { stderrTail = keepTail(stderrTail, chunk.toString("utf8")); });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
		}, timeoutSeconds * 1000);
		child.once("close", (exitCode) => {
			clearTimeout(timer);
			resolveCheck({
				command,
				exitCode,
				timedOut,
				passed: exitCode === 0 && !timedOut,
				durationMs: Date.now() - startedAt,
				stdoutTail,
				stderrTail,
			});
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			resolveCheck({ command, exitCode: null, timedOut, passed: false, durationMs: Date.now() - startedAt, stdoutTail, stderrTail: `${stderrTail}${error.message}` });
		});
	});
}

function print(value) {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
	const [command, id, ...rest] = process.argv.slice(2);
	if (!command || command === "help" || command === "--help" || command === "-h") {
		process.stdout.write(`${USAGE}\n`);
		return;
	}
	if (!id) fail(USAGE);
	const receipt = await new OrchestrationReceiptStore().inspect(id);

	if (command === "propose") {
		if (rest.length > 0) fail("usage: ox_integrate.mjs propose ID");
		const result = await proposal(receipt);
		print({
			orchestrationId: receipt.orchestrationId,
			kind: receipt.kind,
			status: receipt.status,
			lanes: result.lanes,
			overlaps: result.overlaps,
			conflictLaneIds: result.conflictLaneIds,
			applyOrder: result.applyOrder,
			unavailableLaneIds: result.unavailableLaneIds,
		});
		if (result.conflictLaneIds.length > 0 || result.unavailableLaneIds.length > 0) process.exitCode = 2;
		return;
	}

	if (command === "export") {
		let laneId;
		const paths = [];
		let out;
		for (let index = 0; index < rest.length; index += 1) {
			const argument = rest[index];
			if (argument === "--lane") laneId = rest[++index]?.trim() || fail("--lane requires a lane id");
			else if (argument === "--path") paths.push(relativeScope(rest[++index], "--path"));
			else if (argument === "--out") out = rest[++index]?.trim() || fail("--out requires a file path");
			else fail(`unknown export option: ${argument}`);
		}
		if (!laneId) fail("usage: ox_integrate.mjs export ID --lane LANE_ID [--path RELATIVE_PATH ...] [--out FILE]");
		const lanes = await resolveLanePatches(receipt);
		const lane = lanes.find((candidate) => candidate.laneId === laneId) ?? fail(`lane ${laneId} is not in orchestration ${id}`);
		if (lane.patch === undefined) fail(`lane ${laneId} has no exportable change (source: ${lane.source}${lane.reason ? `; ${lane.reason}` : ""})`);
		const patch = paths.length > 0 ? filterPatch(lane.patch, paths) : lane.patch;
		if (!patch) fail(`no patch section matches the selected paths for lane ${laneId}`);
		if (out) {
			await writeFile(out, patch, { mode: 0o600, flag: "wx" });
			print({ orchestrationId: receipt.orchestrationId, laneId, out, patchSha256: sha256(patch), ...(lane.baseCommit ? { baseCommit: lane.baseCommit } : {}) });
		} else {
			process.stdout.write(patch);
		}
		return;
	}

	if (command === "apply") {
		const laneIds = [];
		const checks = [];
		let source;
		let noCheck = false;
		let timeoutSeconds = 1800;
		for (let index = 0; index < rest.length; index += 1) {
			const argument = rest[index];
			if (argument === "--lane") laneIds.push(rest[++index]?.trim() || fail("--lane requires a lane id"));
			else if (argument === "--repo") source = rest[++index]?.trim() || fail("--repo requires an absolute repository path");
			else if (argument === "--check") checks.push(rest[++index]?.trim() || fail("--check requires a command"));
			else if (argument === "--no-check") noCheck = true;
			else if (argument === "--timeout") {
				timeoutSeconds = Number(rest[++index]);
				if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) fail("--timeout must be an integer from 1 to 86400 seconds");
			} else fail(`unknown apply option: ${argument}`);
		}
		if (laneIds.length === 0 || !source) fail("usage: ox_integrate.mjs apply ID --lane LANE_ID [--lane LANE_ID ...] --repo SOURCE (--check COMMAND ... | --no-check)");
		if (!isAbsolute(source)) fail("--repo requires an absolute repository path");
		if (new Set(laneIds).size !== laneIds.length) fail("apply lanes must be distinct");
		if (checks.length === 0 && !noCheck) fail("apply requires at least one --check or explicit --no-check");
		if (checks.length > 0 && noCheck) fail("--check and --no-check are mutually exclusive");

		const result = await proposal(receipt);
		const selected = laneIds.map((laneId) =>
			result.changedLanes.find((lane) => lane.laneId === laneId)
				?? fail(`lane ${laneId} has no applicable change in orchestration ${id}`));
		const selectedConflicts = result.overlaps.filter((overlap) => overlap.laneIds.every((laneId) => laneIds.includes(laneId)));
		if (selectedConflicts.length > 0) {
			fail(`selected lanes overlap on ${selectedConflicts.map((overlap) => `${overlap.laneIds.join("+")}: ${overlap.paths.join(", ")}`).join("; ")}; select non-conflicting lanes or export and reconcile manually`);
		}
		const baseCommits = [...new Set(selected.map((lane) => lane.baseCommit).filter(Boolean))];
		if (baseCommits.length !== 1) fail(`selected lanes must share one recorded base commit (saw: ${baseCommits.join(", ") || "none"})`);
		// Order over the selected set in receipt worker order; a conflict with an
		// unselected lane must not exclude a selected lane.
		const ordered = result.changedLanes.filter((lane) => laneIds.includes(lane.laneId));

		// create() rev-parses the recorded base commit in the source repository,
		// which is the milestone's base-commit verification.
		const workspace = await new ManagedWorktreeStore().create(source, { ref: baseCommits[0] });
		const applied = [];
		let applyFailure;
		const scratch = await mkdtemp(join(tmpdir(), "ox-integrate-apply-"));
		try {
			for (const lane of ordered) {
				const patchPath = join(scratch, `${applied.length}.patch`);
				await writeFile(patchPath, lane.patch, { mode: 0o600 });
				try {
					await execFileAsync("git", ["apply", "--index", patchPath], { cwd: workspace.path, maxBuffer: MAX_GIT_OUTPUT_BYTES });
					applied.push({ laneId: lane.laneId, patchSha256: lane.patchSha256 });
				} catch (error) {
					applyFailure = { laneId: lane.laneId, error: (error.stderr || error.message || String(error)).trim().slice(0, 4096) };
					break;
				}
			}
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
		const checkResults = [];
		if (!applyFailure) {
			for (const check of checks) {
				const outcome = await runCheck(check, workspace.path, timeoutSeconds);
				checkResults.push(outcome);
				if (!outcome.passed) break;
			}
		}
		const checksPassed = checkResults.length === checks.length && checkResults.every((outcome) => outcome.passed);
		const status = applyFailure ? "apply-failed" : checksPassed ? "integrated" : "checks-failed";
		// The worktree stays in place on success (the deliverable) and on
		// failure (the evidence); removal is an explicit separate step.
		print({
			orchestrationId: receipt.orchestrationId,
			status,
			workspace: { id: workspace.id, path: workspace.path, source: workspace.source, baseCommit: workspace.baseCommit },
			applied,
			...(applyFailure ? { applyFailure } : {}),
			checks: checkResults,
			checksDeclared: checks.length > 0,
			cleanupCommand: `node scripts/ox_workspace.mjs remove ${workspace.id} --discard`,
		});
		if (status !== "integrated") process.exitCode = 1;
		return;
	}

	fail(USAGE);
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
