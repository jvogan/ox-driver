import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export const OMP_READ_ONLY_TOOLS = ["read", "grep", "glob"] as const;

// Audited against OMP 18.0.6 and the 18.0.7 source candidate's
// packages/coding-agent/src/discovery/index.ts.
// The overlay disables every registered ambient capability provider. Model
// providers use separate ids; a route whose provider collides with this list is
// rejected because enabling it would reopen ambient discovery.
export const OMP_AMBIENT_PROVIDER_IDS = [
	"agent-plugins",
	"agents-md",
	"agents",
	"builtin-defaults",
	"claude",
	"claude-plugins",
	"cline",
	"codex",
	"cursor",
	"gemini",
	"github",
	"mcp-json",
	"native",
	"omp-plugins",
	"opencode",
	"ssh-json",
	"vscode",
	"windsurf",
] as const;

export const OMP_ISOLATION_SETTINGS = {
	extensions: [],
	disabledProviders: [...OMP_AMBIENT_PROVIDER_IDS],
	includeModelInPrompt: false,
	advisor: { enabled: false },
	prewalk: { enabled: false },
	git: { enabled: false },
	retry: { enabled: false, modelFallback: false },
	recap: { enabled: false },
	contextPromotion: { enabled: false },
	compaction: { asyncEnabled: false, idleEnabled: false, autoContinue: false },
	memory: { backend: "off" },
	memories: { enabled: false },
	autolearn: { enabled: false, autoContinue: false },
	read: { summarize: { enabled: false } },
	bash: {
		autoBackground: { enabled: false },
		direnv: "off",
		patterns: [{ match: "*", approval: "deny" }],
	},
	eval: {
		py: false,
		js: false,
		rb: false,
		jl: false,
		autoBackground: { enabled: false },
	},
	async: { enabled: false },
	todo: { enabled: false },
	tools: {
		approvalMode: "always-ask",
		approval: {
			bash: "deny",
			computer: "deny",
			edit: "deny",
			eval: "deny",
			task: "deny",
			write: "deny",
		},
		xdev: false,
	},
	mcp: { enableProjectConfig: false },
} as const;

export const OMP_ISOLATION_OVERLAY = `${JSON.stringify(OMP_ISOLATION_SETTINGS, null, 2)}\n`;
export const OMP_ISOLATION_OVERLAY_SHA256 = createHash("sha256").update(OMP_ISOLATION_OVERLAY).digest("hex");

export const OMP_MODEL_CONFIG_NAMES = ["models.yml", "models.yaml", "models.json", "models.jsonc"] as const;

export interface OmpRuntimeIsolation {
	root: string;
	homeDirectory: string;
	agentDirectory: string;
	temporaryDirectory: string;
	writableDirectories: readonly string[];
	overlayPath: string;
	overlaySha256: string;
	modelConfig?: {
		name: string;
		sha256: string;
	};
	environment: NodeJS.ProcessEnv;
}

function stableMetadata(before: BigIntStats, after: BigIntStats): boolean {
	return before.dev === after.dev
		&& before.ino === after.ino
		&& before.mode === after.mode
		&& before.size === after.size
		&& before.mtimeNs === after.mtimeNs
		&& before.ctimeNs === after.ctimeNs;
}

async function copyReviewedModelConfig(
	sourceDirectory: string,
	targetDirectory: string,
): Promise<{ name: string; sha256: string } | undefined> {
	const sourceEntries = new Set(await readdir(sourceDirectory));
	const present = OMP_MODEL_CONFIG_NAMES.filter(name => sourceEntries.has(name));
	if (present.length > 1) throw new Error("OMP route contains multiple model configuration files");
	const name = present[0];
	if (!name) return undefined;
	const source = join(sourceDirectory, name);
	const target = join(targetDirectory, name);
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	let sourceHandle: Awaited<ReturnType<typeof open>>;
	try {
		sourceHandle = await open(source, constants.O_RDONLY | noFollow);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
		if (code === "ELOOP") throw new Error(`OMP model configuration is not a regular file: ${basename(source)}`);
		throw error;
	}
	try {
		const before = await sourceHandle.stat({ bigint: true });
		if (!before.isFile()) throw new Error(`OMP model configuration is not a regular file: ${basename(source)}`);
		if (before.size > 4n * 1024n * 1024n) throw new Error("OMP model configuration exceeds 4 MiB");
		const bytes = await sourceHandle.readFile();
		const [afterHandle, afterPath] = await Promise.all([
			sourceHandle.stat({ bigint: true }),
			lstat(source, { bigint: true }),
		]);
		if (!stableMetadata(before, afterHandle) || !stableMetadata(before, afterPath) || afterPath.isSymbolicLink()) {
			throw new Error("OMP model configuration changed while it was copied");
		}
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const targetHandle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		try {
			await targetHandle.writeFile(bytes);
			await targetHandle.sync();
		} finally {
			await targetHandle.close();
		}
		await chmod(target, 0o600);
		const copied = await open(target, constants.O_RDONLY | noFollow);
		try {
			const copiedBytes = await copied.readFile();
			if (createHash("sha256").update(copiedBytes).digest("hex") !== sha256) {
				throw new Error("OMP isolated model configuration differs from reviewed source bytes");
			}
		} finally {
			await copied.close();
		}
		return { name, sha256 };
	} finally {
		await sourceHandle.close();
	}
}

export async function createOmpRuntimeIsolation(
	routeAgentDirectory: string,
	runDirectory: string,
): Promise<OmpRuntimeIsolation> {
	const root = join(runDirectory, "omp-isolation");
	const homeDirectory = join(root, "home");
	const agentDirectory = join(root, "agent");
	const temporaryDirectory = join(root, "tmp");
	const xdgConfigDirectory = join(root, "xdg-config");
	const xdgCacheDirectory = join(root, "xdg-cache");
	const xdgDataDirectory = join(root, "xdg-data");
	const xdgStateDirectory = join(root, "xdg-state");
	const overlayPath = join(root, "controller-overlay.json");
	await mkdir(root, { mode: 0o700 });
	await Promise.all([
		mkdir(homeDirectory, { mode: 0o700 }),
		mkdir(agentDirectory, { mode: 0o700 }),
		mkdir(temporaryDirectory, { mode: 0o700 }),
		mkdir(xdgConfigDirectory, { mode: 0o700 }),
		mkdir(xdgCacheDirectory, { mode: 0o700 }),
		mkdir(xdgDataDirectory, { mode: 0o700 }),
		mkdir(xdgStateDirectory, { mode: 0o700 }),
	]);
	const modelConfig = await copyReviewedModelConfig(routeAgentDirectory, agentDirectory);
	await writeFile(overlayPath, OMP_ISOLATION_OVERLAY, { encoding: "utf8", flag: "wx", mode: 0o400 });
	if ((await stat(overlayPath)).mode & 0o222) throw new Error("OMP controller overlay is writable");
	return {
		root,
		homeDirectory,
		agentDirectory,
		temporaryDirectory,
		writableDirectories: Object.freeze([
			homeDirectory,
			agentDirectory,
			temporaryDirectory,
			xdgConfigDirectory,
			xdgCacheDirectory,
			xdgDataDirectory,
			xdgStateDirectory,
		]),
		overlayPath,
		overlaySha256: OMP_ISOLATION_OVERLAY_SHA256,
		...(modelConfig ? { modelConfig } : {}),
		environment: {
			HOME: homeDirectory,
			TMPDIR: temporaryDirectory,
			PI_CODING_AGENT_DIR: agentDirectory,
			PI_CONFIG_DIR: ".ox-driver-omp",
			PI_PY: "0",
			PI_JS: "0",
			PI_NO_PTY: "1",
			PI_NO_TITLE: "1",
			XDG_CONFIG_HOME: xdgConfigDirectory,
			XDG_CACHE_HOME: xdgCacheDirectory,
			XDG_DATA_HOME: xdgDataDirectory,
			XDG_STATE_HOME: xdgStateDirectory,
		},
	};
}
