import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { access, lstat, mkdtemp, readdir, readlink, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import type {
	AdapterRunContext,
	AdapterRunResult,
	HarnessAdapter,
	HarnessCapabilities,
	PreflightIssue,
	RunSpec,
} from "@ox-driver/core";

export interface ProbeEvidencePath {
	label: string;
	path: string;
	kind?: "file" | "tree";
	expectedSha256?: string;
}

export interface ProbeOnlyAdapterOptions {
	id: string;
	harness: string;
	launcher: string;
	reason: string;
	expectedVersion: string;
	versionCommand?: string;
	versionArgs?: string[];
	expectedLauncherSha256?: string;
	expectedVersionCommandSha256?: string;
	invokeVersionProbe?: boolean;
	evidencePaths?: ProbeEvidencePath[];
	additionalProbes?: Array<{
		label: string;
		args: string[];
		expectedStdoutSha256?: string;
	}>;
	observations?: string[];
}

interface ProbeCapture {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

async function sha256(path: string): Promise<string> {
	return new Promise((resolveHash, rejectHash) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.once("error", rejectHash);
		stream.once("end", () => resolveHash(hash.digest("hex")));
	});
}

async function treeSha256(root: string): Promise<string> {
	const entries: string[] = [];
	const visit = async (directory: string, prefix: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			entries.push(relative);
			if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(join(directory, entry.name), relative);
		}
	};
	await visit(root, "");
	entries.sort();
	const digest = createHash("sha256");
	for (const relative of entries) {
		const path = join(root, ...relative.split("/"));
		const metadata = await lstat(path);
		const mode = `0o${(metadata.mode & 0o7777).toString(8)}`;
		if (metadata.isSymbolicLink()) {
			digest.update("L\0").update(relative).update("\0").update(await readlink(path)).update("\0");
		} else if (metadata.isDirectory()) {
			digest.update("D\0").update(relative).update("\0").update(mode).update("\0");
		} else if (metadata.isFile()) {
			digest.update("F\0").update(relative).update("\0").update(mode).update("\0");
			await new Promise<void>((resolveHash, rejectHash) => {
				const stream = createReadStream(path);
				stream.on("data", (chunk) => digest.update(chunk));
				stream.once("error", rejectHash);
				stream.once("end", resolveHash);
			});
			digest.update("\0");
		} else {
			throw new Error(`tree evidence contains a special filesystem object: ${relative}`);
		}
	}
	return digest.digest("hex");
}

async function captureVersion(command: string, args: string[]): Promise<ProbeCapture> {
	const root = await mkdtemp(join(tmpdir(), "ox-driver-cli-probe-"));
	try {
		return await new Promise((resolveCapture, rejectCapture) => {
			const child = spawn(command, args, {
				cwd: root,
				env: {
					HOME: root,
					PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
					TMPDIR: root,
					LANG: "C.UTF-8",
					LC_ALL: "C.UTF-8",
					DSH_HOME: join(root, "dsh-home"),
					DSH_AGENTS_HOME: join(root, "dsh-agents-home"),
					DSH_TELEMETRY_DISABLED: "1",
					XDG_CONFIG_HOME: join(root, "xdg-config"),
					XDG_CACHE_HOME: join(root, "xdg-cache"),
					XDG_DATA_HOME: join(root, "xdg-data"),
					XDG_STATE_HOME: join(root, "xdg-state"),
				},
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
			let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
			let timedOut = false;
			let settled = false;
			const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer): Buffer<ArrayBufferLike> => Buffer.concat([current, chunk.subarray(0, Math.max(0, 1024 * 1024 - current.length))]);
			const timer = setTimeout(() => {
				timedOut = true;
				if (!child.pid) return;
				try {
					if (process.platform === "win32") child.kill("SIGKILL");
					else process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}, 10_000);
			child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
			child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
			child.once("error", (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				rejectCapture(error);
			});
			child.once("close", (exitCode) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolveCapture({ exitCode, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), timedOut });
			});
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function resolveExecutable(command: string): Promise<string | undefined> {
	const candidates = command.includes("/")
		? [command]
		: (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, command));
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.R_OK | constants.X_OK);
			const path = await realpath(candidate);
			if ((await stat(path)).isFile()) return path;
		} catch {
			continue;
		}
	}
	return undefined;
}

/**
 * A fail-closed adapter for installed harnesses whose execution contract has not
 * completed qualification. Doctor is intentionally model-free: it hashes the
 * exact launch surface before optionally running a version command under a
 * scrubbed home. A quarantined harness may use artifact-only mode.
 */
export class ProbeOnlyAdapter implements HarnessAdapter {
	readonly id: string;
	readonly harness: string;
	readonly #options: ProbeOnlyAdapterOptions;

	constructor(options: ProbeOnlyAdapterOptions) {
		this.id = options.id;
		this.harness = options.harness;
		this.#options = options;
	}

	async doctor(): Promise<HarnessCapabilities> {
		let launcher: string;
		try {
			launcher = await resolveExecutable(this.#options.launcher) as string;
			if (!launcher) throw new Error("launcher unavailable");
		} catch (error) {
			return {
				version: 1,
				adapterId: this.id,
				harness: this.harness,
				compatibility: "blocked",
				available: false,
				capabilities: {},
				notices: [`installed probe unavailable: ${error instanceof Error ? error.message : String(error)}`],
			};
		}
		const versionCommand = await resolveExecutable(this.#options.versionCommand ?? launcher);
		if (!versionCommand) {
			return {
				version: 1,
				adapterId: this.id,
				harness: this.harness,
				compatibility: "blocked",
				available: true,
				executable: launcher,
				binarySha256: await sha256(launcher),
				capabilities: {},
				notices: ["the model-free version probe command is unavailable", this.#options.reason],
			};
		}
		const launcherSha256 = await sha256(launcher);
		const versionCommandSha256 = await sha256(versionCommand);
		const evidenceHash = createHash("sha256");
		const evidenceNotices: string[] = [];
		for (const item of this.#options.evidencePaths ?? []) {
			try {
				if (!item.expectedSha256) throw new Error("evidence has no qualified expected digest");
				const digest = item.kind === "tree" ? await treeSha256(item.path) : await sha256(item.path);
				evidenceHash.update(item.label).update("\0").update(digest).update("\0");
				if (digest !== item.expectedSha256) evidenceNotices.push(`${item.label} digest drifted from the qualified snapshot`);
			} catch (error) {
				evidenceHash.update(item.label).update("\0missing\0");
				evidenceNotices.push(`${item.label} evidence is unavailable: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		evidenceHash.update("version-command\0").update(versionCommandSha256);
		const launcherMatches = this.#options.expectedLauncherSha256 !== undefined
			&& launcherSha256 === this.#options.expectedLauncherSha256;
		const versionCommandMatches = this.#options.expectedVersionCommandSha256 !== undefined
			&& versionCommandSha256 === this.#options.expectedVersionCommandSha256;
		const evidenceMatches = evidenceNotices.length === 0;
		if (!launcherMatches || !versionCommandMatches || !evidenceMatches) {
			return {
				version: 1,
				adapterId: this.id,
				harness: this.harness,
				compatibility: "blocked",
				available: true,
				executable: launcher,
				binarySha256: launcherSha256,
				enforcementSha256: evidenceHash.digest("hex"),
				probe: {
					version: 1,
					modelCalls: 0,
					contract: `${this.harness}-installed-cli-probe`,
					artifact: "drifted",
					executionQualified: false,
				},
				capabilities: {},
				notices: [
					`installed ${this.harness} failed artifact checks; doctor refused to execute it`,
					...(launcherMatches ? [] : [this.#options.expectedLauncherSha256 ? "launcher digest drifted from the qualified snapshot" : "launcher has no qualified expected digest"]),
					...(versionCommandMatches ? [] : [this.#options.expectedVersionCommandSha256 ? "version-probe binary digest drifted from the qualified snapshot" : "version-probe binary has no qualified expected digest"]),
					...evidenceNotices,
					"No version command, model command, or additional probe was executed.",
					...(this.#options.observations ?? []),
					this.#options.reason,
				],
			};
		}
		const invokeVersionProbe = this.#options.invokeVersionProbe ?? true;
		let observedVersion: string | undefined = invokeVersionProbe ? undefined : this.#options.expectedVersion;
		let versionMatches = !invokeVersionProbe;
		const additionalNotices: string[] = [];
		if (invokeVersionProbe) {
			try {
				const result = await captureVersion(versionCommand, this.#options.versionArgs ?? ["--version"]);
				observedVersion = `${result.stdout}\n${result.stderr}`.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1];
				versionMatches = result.exitCode === 0 && !result.timedOut && observedVersion === this.#options.expectedVersion;
			} catch (error) {
				additionalNotices.push(`version probe failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			for (const probe of this.#options.additionalProbes ?? []) {
				try {
					const captured = await captureVersion(versionCommand, probe.args);
					const outputSha256 = createHash("sha256").update(captured.stdout).update("\0").update(captured.stderr).digest("hex");
					evidenceHash.update(probe.label).update("\0").update(outputSha256).update("\0");
					if (captured.exitCode !== 0 || captured.timedOut) {
						additionalNotices.push(`${probe.label} failed its model-free command probe`);
					} else if (probe.expectedStdoutSha256 && outputSha256 !== probe.expectedStdoutSha256) {
						additionalNotices.push(`${probe.label} output drifted from the qualified snapshot`);
					}
				} catch (error) {
					additionalNotices.push(`${probe.label} probe failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
		const probeMatches = launcherMatches
			&& versionCommandMatches
			&& versionMatches
			&& evidenceMatches
			&& additionalNotices.length === 0;
		return {
			version: 1,
			adapterId: this.id,
			harness: this.harness,
			compatibility: "blocked",
			available: true,
			executable: launcher,
			binarySha256: launcherSha256,
			enforcementSha256: evidenceHash.digest("hex"),
			...(observedVersion ? { harnessVersion: observedVersion } : {}),
			probe: {
				version: 1,
				modelCalls: 0,
				contract: `${this.harness}-installed-cli-probe`,
				artifact: probeMatches ? "verified" : "drifted",
				executionQualified: false,
			},
			capabilities: {},
			notices: [
				probeMatches
					? invokeVersionProbe
						? `installed ${this.harness} ${observedVersion} matches the qualified artifact snapshot; no model call was made`
						: `installed ${this.harness} ${observedVersion} matches the qualified artifact snapshot; doctor executed no harness command or model call`
					: `installed ${this.harness} failed one or more artifact/version checks`,
				...(launcherMatches ? [] : ["launcher digest drifted from the qualified snapshot"]),
				...(versionCommandMatches ? [] : ["version-probe binary digest drifted from the qualified snapshot"]),
				...(versionMatches ? [] : [`expected version ${this.#options.expectedVersion}, observed ${observedVersion ?? "unknown"}`]),
				...evidenceNotices,
				...additionalNotices,
				...(this.#options.observations ?? []),
				this.#options.reason,
			],
		};
	}

	async preflight(_spec: RunSpec, _doctor: HarnessCapabilities): Promise<PreflightIssue[]> {
		return [{ severity: "error", code: "ADAPTER_QUARANTINED", message: this.#options.reason }];
	}

	async run(_spec: RunSpec, _context: AdapterRunContext): Promise<AdapterRunResult> {
		throw new Error(`${this.harness} execution is quarantined`);
	}
}
