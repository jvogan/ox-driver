import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const RECURSIVE_SEARCH_TOOLS = new Set(["grep", "find"]);
const DIRECT_SUBAGENT_FIELDS = new Set([
	"agent", "agentScope", "task", "async", "context", "worktree",
]);
const EXPECTED_PROVIDER = "openrouter";
const EXPECTED_MODEL = "stealth/ox-alpha";
const EXPECTED_THINKING = "max";
type PermissionProfile = "power" | "edit-only" | "review-only";

function loadPolicy(): { fileScope: "home" | "project"; permissionProfile: PermissionProfile } {
	try {
		const configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "pi-safety.json");
		const value = JSON.parse(readFileSync(configPath, "utf8"));
		const permissionProfile = ["power", "edit-only", "review-only"].includes(value.permissionProfile)
			? value.permissionProfile as PermissionProfile
			: "review-only";
		return {
			fileScope: value.fileScope === "home" ? "home" : "project",
			permissionProfile,
		};
	} catch {
		return { fileScope: "project", permissionProfile: "review-only" };
	}
}

const POLICY = loadPolicy();
const FILE_SCOPE = POLICY.fileScope;
const PROTECTED_AGENT_DIR = (() => {
	const configured = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	try {
		return realpathSync(configured);
	} catch {
		return path.resolve(configured);
	}
})();
const SAFE_ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);

const BLOCKED_COMMANDS: Array<[RegExp, string]> = [
	[/\bsudo\b/i, "sudo is disabled"],
	[/\brm\b[^\n]*(?:--recursive\b|\s-[A-Za-z]*r[A-Za-z]*(?=\s|$))/i, "recursive filesystem deletion is disabled"],
	[/\brm\s+(?:-[^\s]+\s+)*(?:\/|~|\$HOME|\.|\.\.)(?:\/|\s|$)/i, "broad filesystem deletion is disabled"],
	[/\bfind\b[^\n]*(?:-delete\b|-(?:exec|execdir)\s+(?:rm|rmdir)\b)/i, "recursive filesystem deletion is disabled"],
	[/\bgit\s+reset\b[^\n]*--hard\b/i, "irreversible Git operations are disabled"],
	[/\bgit\s+clean\b(?![^\n]*\s(?:-n|--dry-run)(?:\s|$))/i, "irreversible Git operations are disabled"],
	[/\bgit\s+branch\s+-D\b/, "irreversible Git operations are disabled"],
	[/\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?\b|--delete\b|--mirror\b|--all\b[^\n]*--prune\b|--prune\b[^\n]*--all\b|\s-f(?:\s|$)|\s\+\S+|\s:\S+)/i, "irreversible Git remote operations are disabled"],
	[/\b(?:printenv|export\s+-p)\b|^\s*(?:env|set)\s*$/i, "environment dumps are disabled"],
	[/\b(?:OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|NPM_TOKEN|AWS_SECRET_ACCESS_KEY)\b/i, "credential variable access is disabled"],
	[/\bPI_SUBAGENT_[A-Z0-9_]*\b/i, "subagent guard state access is disabled"],
	[/(?:^|[;&|]|\$\()\s*(?:command\s+|exec\s+|env\s+)*(?:[^\s;&|]*\/)?(?:pi(?:-child|-ox)?|claude|codex|opencode)(?:\s|$)/i, "nested agent runtimes are disabled"],
	[/(?:^|[;&|]|\$\()\s*(?:command\s+|exec\s+)?env(?:\s+-[^\s]+)*\s+(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(?:[^\s;&|]*\/)?(?:pi(?:-child|-ox)?|claude|codex|opencode)(?:\s|$)/i, "nested agent runtimes are disabled"],
	[/\b(?:bash|sh|zsh)\s+(?:-[^\s]+\s+)*-c\s+["']\s*(?:(?:command|exec)\s+|env(?:\s+[A-Za-z_][A-Za-z0-9_]*=[^\s]+)*\s+)*(?:[^\s;&|]*\/)?(?:pi(?:-child|-ox)?|claude|codex|opencode)(?:\s|["'])/i, "nested agent runtimes are disabled"],
];

const CONFIRM_COMMANDS: Array<[RegExp, string]> = [
	[/\brm\b/i, "delete files"],
	[/\bgit\s+(push|commit|reset|restore|checkout|stash|clean|remote|add)\b/i, "change Git state or contact a remote"],
	[/\b(?:pkill|killall)\b/i, "terminate processes broadly"],
	[/\b(?:npm|pnpm|yarn)\s+publish\b/i, "publish a package"],
	[/\bgh\s+(?:pr\s+(?:create|merge)|release\s+create|repo\s+(?:create|delete))\b/i, "mutate GitHub state"],
	[/\bcurl\b[^\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s+(?:POST|PUT|PATCH|DELETE)|--data(?:-binary|-raw)?\b|--upload-file\b|\s-T\s)/i, "send a mutating HTTP request"],
];

function isWithin(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveCandidate(candidate: string, cwd: string): string {
	const expanded = candidate === "~" || candidate.startsWith("~/")
		? path.join(os.homedir(), candidate.slice(candidate === "~" ? 1 : 2))
		: candidate;
	return path.resolve(cwd, expanded);
}

export function canonicalCandidate(candidate: string, cwd: string): string {
	const resolved = resolveCandidate(candidate, cwd);
	let existing = resolved;
	const missing: string[] = [];
	while (!existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) throw new Error(`No existing parent for ${candidate}`);
		missing.unshift(path.basename(existing));
		existing = parent;
	}
	return path.join(realpathSync(existing), ...missing);
}

export function validateProjectPath(
	requested: string,
	cwd: string,
	write: boolean,
): string | undefined {
	let resolved: string;
	let root: string;
	try {
		resolved = canonicalCandidate(requested, cwd);
		root = realpathSync(cwd);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return `Could not validate path safely: ${detail}`;
	}
	if (isSensitive(resolved)) return `Sensitive path blocked: ${requested}`;
	if (isWithin(resolved, PROTECTED_AGENT_DIR)) {
		return `Protected Pi agent directory blocked: ${requested}`;
	}
	if (FILE_SCOPE === "project" && !isWithin(resolved, root)) {
		return `Paths outside the current project are blocked: ${requested}`;
	}
	if (
		FILE_SCOPE === "home" &&
		!isWithin(resolved, root) &&
		!isWithin(resolved, realpathSync(os.homedir())) &&
		!isWithin(resolved, realpathSync(os.tmpdir()))
	) {
		return `Path is outside the project, home, and temporary directories: ${requested}`;
	}
	if (write) {
		const normalized = resolved.toLowerCase();
		if (
			normalized.includes("/.git/") || normalized.endsWith("/.git") ||
			normalized.includes("/.pi/") || normalized.endsWith("/.pi") ||
			normalized.includes("/node_modules/")
		) return `Protected path blocked: ${requested}`;
	}
	return undefined;
}

function isSensitive(candidate: string): boolean {
	const normalized = candidate.toLowerCase();
	const base = path.basename(normalized);
	return (
		base === ".env" ||
		(base.startsWith(".env.") && !SAFE_ENV_TEMPLATES.has(base)) ||
		base === "auth.json" ||
		base === "credentials.json" ||
		base === ".netrc" ||
		base === ".npmrc" ||
		base === ".pypirc" ||
		base === ".git-credentials" ||
		base === "id_rsa" ||
		base === "id_ed25519" ||
		base.endsWith(".pem") ||
		base.endsWith(".key") ||
		normalized.includes("/.ssh/") ||
		normalized.endsWith("/.ssh") ||
		normalized.includes("/.aws/") ||
		normalized.endsWith("/.aws") ||
		normalized.includes("/.gnupg/") ||
		normalized.endsWith("/.gnupg") ||
		normalized.includes("/.kube/") ||
		normalized.endsWith("/.kube") ||
		normalized.includes("/.codex/") ||
		normalized.endsWith("/.codex") ||
		normalized.includes("/.agents/") ||
		normalized.endsWith("/.agents") ||
		normalized.includes("/.pi/") ||
		normalized.endsWith("/.pi") ||
		normalized.includes("/.claude/") ||
		normalized.endsWith("/.claude") ||
		normalized.includes("/.azure/") ||
		normalized.endsWith("/.azure") ||
		normalized.includes("/.config/gh/") ||
		normalized.endsWith("/.config/gh") ||
		normalized.includes("/.config/gcloud/") ||
		normalized.endsWith("/.config/gcloud") ||
		normalized.includes("/.docker/") ||
		normalized.endsWith("/.docker") ||
		normalized.endsWith("/.config/opencode") ||
		normalized.includes("/.config/opencode/") ||
		normalized.includes("/keychains/") ||
		normalized.endsWith("/keychains")
	);
}

function containsSensitiveDescendant(directory: string): boolean {
	const pending = [directory];
	let visited = 0;
	try {
		while (pending.length > 0) {
			const current = pending.pop() as string;
			for (const entry of readdirSync(current, { withFileTypes: true })) {
				visited += 1;
				if (visited > 100_000) return true;
				const target = path.join(current, entry.name);
				if (isSensitive(target)) return true;
				if (entry.isSymbolicLink()) continue;
				if (entry.isDirectory() && ![".git", "node_modules", ".venv", "vendor"].includes(entry.name)) {
					pending.push(target);
				}
			}
		}
		return false;
	} catch {
		return true;
	}
}

function requestedPath(input: Record<string, unknown>): string | undefined {
	for (const key of ["path", "file_path", "directory"]) {
		if (typeof input[key] === "string" && input[key]) return input[key] as string;
	}
	return undefined;
}

function blockFileCall(toolName: string, input: Record<string, unknown>, ctx: ExtensionContext) {
	const requested = requestedPath(input);
	if (!requested) return undefined;
	const reason = validateProjectPath(requested, ctx.cwd, WRITE_TOOLS.has(toolName));
	if (reason) return { block: true, reason };
	if (RECURSIVE_SEARCH_TOOLS.has(toolName)) {
		const resolved = canonicalCandidate(requested, ctx.cwd);
		if (existsSync(resolved) && statSync(resolved).isDirectory() && containsSensitiveDescendant(resolved)) {
			return {
				block: true,
				reason: "Recursive native search would cross a sensitive file. Narrow the path, or use sandboxed Bash in the power profile.",
			};
		}
	}
	return undefined;
}

export default function piSafety(pi: ExtensionAPI) {
	// Pi discovers user extensions during raw launches. Keep this policy inert
	// unless the reviewed launcher has established the protected environment.
	if (process.env.OX_DRIVER_GUARD_READY !== "1") return;

	let correctingRoute = false;

	async function enforceRoute(ctx: ExtensionContext): Promise<void> {
		const modelMatches = ctx.model?.provider === EXPECTED_PROVIDER && ctx.model?.id === EXPECTED_MODEL;
		if (!modelMatches) {
			const expected = ctx.modelRegistry.find(EXPECTED_PROVIDER, EXPECTED_MODEL);
			if (!expected || !(await pi.setModel(expected))) {
				ctx.abort();
				throw new Error("Protected Ox Driver route is unavailable");
			}
		}
		if (pi.getThinkingLevel() !== EXPECTED_THINKING) pi.setThinkingLevel(EXPECTED_THINKING);
	}

	pi.on("model_select", async (event, ctx) => {
		if (correctingRoute || (event.model.provider === EXPECTED_PROVIDER && event.model.id === EXPECTED_MODEL)) return;
		correctingRoute = true;
		try {
			await enforceRoute(ctx);
			ctx.ui.notify("Model change rejected by the Ox Driver route policy", "warning");
		} finally {
			correctingRoute = false;
		}
	});

	pi.on("thinking_level_select", (event) => {
		if (event.level !== EXPECTED_THINKING) pi.setThinkingLevel(EXPECTED_THINKING);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		await enforceRoute(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = (event.input ?? {}) as Record<string, unknown>;
		if (event.toolName === "subagent") {
			const unknown = Object.keys(input).filter((key) => !DIRECT_SUBAGENT_FIELDS.has(key));
			if (unknown.length > 0) {
				return { block: true, reason: `Protected direct child call rejects fields: ${unknown.join(", ")}.` };
			}
			if (input.agentScope !== "user") {
				return { block: true, reason: "Protected team launches require agentScope: user." };
			}
			const agent = typeof input.agent === "string" ? input.agent : "";
			const role = process.env.PI_SUBAGENT_CHILD_AGENT;
			const allowed = role === "pi-lead"
				? new Set(["pi-agent"])
				: role === "pi-agent" ? new Set<string>() : new Set(["pi-agent", "pi-lead"]);
			if (!allowed.has(agent)) {
				return { block: true, reason: "Protected execution is limited to the installed pi-agent and pi-lead profiles." };
			}
			if (typeof input.task !== "string" || input.task.trim() === "") {
				return { block: true, reason: "Protected child execution requires a non-empty task." };
			}
			if (input.async !== undefined && typeof input.async !== "boolean") {
				return { block: true, reason: "Protected child async must be a boolean." };
			}
			if (input.context !== undefined && !["fresh", "fork", "profile"].includes(String(input.context))) {
				return { block: true, reason: "Protected child context is invalid." };
			}
			if (input.worktree !== undefined && typeof input.worktree !== "boolean") {
				return { block: true, reason: "Protected child worktree must be a boolean." };
			}
			if (input.worktree === true && POLICY.permissionProfile === "review-only") {
				return { block: true, reason: "The review-only profile cannot create managed Git worktrees." };
			}
		}
		if (FILE_TOOLS.has(event.toolName)) {
			const blocked = blockFileCall(event.toolName, input, ctx);
			if (blocked) return blocked;
		}
		if (event.toolName !== "bash") return undefined;

		const command = typeof input.command === "string" ? input.command : "";
		for (const [pattern, reason] of BLOCKED_COMMANDS) {
			if (pattern.test(command)) return { block: true, reason };
		}
		for (const [pattern, action] of CONFIRM_COMMANDS) {
			if (!pattern.test(command)) continue;
			if (!ctx.hasUI) return { block: true, reason: `Approval required to ${action}` };
			const approved = await ctx.ui.confirm("Allow risky command?", `Pi wants to ${action}:\n\n${command}`);
			if (!approved) return { block: true, reason: `User declined permission to ${action}` };
			break;
		}
		return undefined;
	});
}
