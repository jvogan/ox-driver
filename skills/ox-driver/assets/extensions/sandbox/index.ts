/**
 * Bash sandbox derived from Pi 0.84.3's MIT-licensed example extension.
 * This copy preserves Pi's injected execution environment and fails bash closed
 * when a requested sandbox cannot initialize.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type BashOperations, createBashTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { discoverProjectSecrets } from "./sensitive-paths.ts";

interface SandboxConfig extends SandboxRuntimeConfig {
	enabled?: boolean;
	networkMode?: "open" | "restricted";
}

const DEFAULT_CONFIG: SandboxConfig = {
	enabled: false,
	networkMode: "open",
	network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
	filesystem: {
		denyRead: [
			"~",
			"~/.ssh", "~/.aws", "~/.gnupg", "~/.kube", "~/.docker",
			"~/.codex", "~/.agents", "~/.claude", "~/.azure", "~/.config/gh", "~/.config/gcloud",
			"~/.config/opencode", "~/.pi/agent/auth.json",
			".ssh", ".aws", ".gnupg", ".kube", ".docker", ".codex", ".agents",
			".claude", ".azure", ".config/gh", ".config/gcloud", ".config/opencode",
			".env", ".env.*", "*.pem", "*.key", ".netrc", ".npmrc", ".pypirc",
			"auth.json", "credentials.json", "id_rsa", "id_ed25519",
		],
		allowRead: ["."],
		allowWrite: ["."],
		denyWrite: [
			".env", ".env.*", "*.pem", "*.key", ".git", ".git/**", ".pi", ".pi/**",
			".ssh", ".aws", ".gnupg", ".kube", ".docker", ".codex", ".agents",
			".claude", ".azure", ".config/gh", ".config/gcloud", ".config/opencode",
		],
	},
};

let runtimeTmp: string | undefined;
const PRIVATE_PROXY_ENV = new Set([
	"OX_DRIVER_RUNTIME_TMP",
	"HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
	"https_proxy", "http_proxy", "all_proxy", "no_proxy",
]);

function createRuntimeTmp(): string {
	if (runtimeTmp) return runtimeTmp;
	const created = mkdtempSync(join("/tmp", "ox-driver-"));
	chmodSync(created, 0o700);
	runtimeTmp = realpathSync(created);
	return runtimeTmp;
}

function mergeConfig(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
	return {
		...base,
		...overrides,
		network: { ...base.network, ...overrides.network },
		filesystem: { ...base.filesystem, ...overrides.filesystem },
	};
}

function readConfig(path: string): Partial<SandboxConfig> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Partial<SandboxConfig>;
	} catch (error) {
		throw new Error(`Invalid sandbox configuration at ${path}: ${error}`);
	}
}

function loadConfig(cwd: string, runtimePath: string): SandboxConfig {
	const agentDir = realpathSync(getAgentDir());
	const systemTmp = realpathSync("/tmp");
	const globalPath = join(agentDir, "extensions", "sandbox.json");
	const linuxSeccompHelper = join(
		agentDir,
		"extensions", "sandbox", "node_modules", "@anthropic-ai", "sandbox-runtime",
		"vendor", "seccomp", process.arch, "apply-seccomp",
	);
	const config = mergeConfig(DEFAULT_CONFIG, readConfig(globalPath));
	const secrets = discoverProjectSecrets(cwd);
	const protectedAgentPaths = [agentDir, join(agentDir, "**")];
	const denyRead = [...(config.filesystem?.denyRead ?? []), ...secrets, ...protectedAgentPaths];
	let denyWrite = [...(config.filesystem?.denyWrite ?? []), ...secrets, ...protectedAgentPaths];
	if (process.platform === "linux") {
		const readDenySet = new Set(denyRead);
		denyWrite = denyWrite.filter((entry) => !readDenySet.has(entry));
	}
	config.filesystem = {
		...config.filesystem,
		allowRead: [
			...(config.filesystem?.allowRead ?? []),
			...(process.platform === "linux" ? [linuxSeccompHelper] : []),
		],
		allowWrite: [...new Set([...(config.filesystem?.allowWrite ?? []), systemTmp, runtimePath])],
		denyRead,
		denyWrite,
	};
	return config;
}

function sandboxedOperations(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
			if (!runtimeTmp) throw new Error("Sandbox runtime temporary directory is unavailable");
			const wrapped = await SandboxManager.wrapWithSandbox(command);
			const bashEnv = {
				...Object.fromEntries(
					Object.entries(env ?? {}).filter(([name]) =>
						!name.startsWith("PI_SUBAGENT_") &&
						!name.startsWith("PI_SUBAGENTS_") &&
						!name.startsWith("PI_INTERCOM_") &&
						!["PI_CODING_AGENT_DIR", "OX_DRIVER_ROOT_CWD", "OX_DRIVER_ROOT_GIT_COMMON_DIR"].includes(name) &&
						!PRIVATE_PROXY_ENV.has(name),
					),
				),
				TMPDIR: runtimeTmp,
			};
			return new Promise((resolve, reject) => {
				const child = spawn("bash", ["-c", wrapped], {
					cwd,
					detached: true,
					env: bashEnv,
					stdio: ["ignore", "pipe", "pipe"],
				});
				let timedOut = false;
				let timer: ReturnType<typeof setTimeout> | undefined;
				if (timeout !== undefined && timeout > 0) {
					timer = setTimeout(() => {
						timedOut = true;
						if (child.pid) {
							try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
						}
					}, timeout * 1000);
				}
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				child.on("error", (error) => {
					if (timer) clearTimeout(timer);
					reject(error);
				});
				const abort = () => {
					if (child.pid) {
						try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
					}
				};
				signal?.addEventListener("abort", abort, { once: true });
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", abort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			});
		},
	};
}

export default function sandboxExtension(pi: ExtensionAPI) {
	// Raw Pi remains untouched. The protected launcher sets this marker before
	// loading the sandbox explicitly.
	if (process.env.OX_DRIVER_GUARD_READY !== "1") return;

	pi.registerFlag("sandbox", {
		description: "Require OS-level sandboxing for bash commands",
		type: "boolean",
		default: false,
	});

	const localBash = createBashTool(process.cwd());
	let enabled = false;
	let failure: string | undefined;

	pi.registerTool({
		...localBash,
		label: "bash",
		async execute(id, params, signal, onUpdate, ctx) {
			if (failure) throw new Error(`Required bash sandbox unavailable: ${failure}`);
			if (!enabled) return localBash.execute(id, params, signal, onUpdate, ctx);
			const tool = createBashTool(process.cwd(), { operations: sandboxedOperations() });
			return tool.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.on("user_bash", () => {
		if (failure) throw new Error(`Required bash sandbox unavailable: ${failure}`);
		if (enabled) return { operations: sandboxedOperations() };
		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		const required = pi.getFlag("sandbox") as boolean;
		let config: SandboxConfig;
		try {
			const runtimePath = createRuntimeTmp();
			process.env.CLAUDE_CODE_TMPDIR = runtimePath;
			process.env.CLAUDE_TMPDIR = runtimePath;
			config = loadConfig(ctx.cwd, runtimePath);
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(failure, "error");
			if (required) ctx.shutdown();
			return;
		}
		if (!required && !config.enabled) return;
		if (process.platform !== "darwin" && process.platform !== "linux") {
			failure = `unsupported platform ${process.platform}`;
			ctx.ui.notify(failure, "error");
			if (required) ctx.shutdown();
			return;
		}
		try {
			const runtimeConfig: SandboxRuntimeConfig = {
				filesystem: config.filesystem,
			};
			const openNetwork = config.networkMode === "open";
			if (openNetwork) {
				runtimeConfig.network = {
					allowedDomains: [],
					deniedDomains: [],
					strictAllowlist: false,
				};
			} else {
				runtimeConfig.network = config.network;
			}
			await SandboxManager.initialize(
				runtimeConfig,
				openNetwork ? async () => true : undefined,
			);
			enabled = true;
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", "Sandbox required"));
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Sandbox initialization failed: ${failure}`, "error");
			if (required) ctx.shutdown();
		}
	});

	pi.on("session_shutdown", async () => {
		if (enabled) await SandboxManager.reset().catch(() => undefined);
		if (runtimeTmp) {
			const owned = runtimeTmp;
			runtimeTmp = undefined;
			rmSync(owned, { recursive: true, force: true });
		}
	});
}
