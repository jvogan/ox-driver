import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readFile, readdir, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
	normalizedHarnessEvent,
	reapDetachedProcessGroup,
	redactedTextEvidence,
	type AdapterRunContext,
	type AdapterRunResult,
	type ConfiguredRoute,
	type HarnessAdapter,
	type HarnessCapabilities,
	type ProcessTreeCleanup,
	type PreflightIssue,
	type ResolvedRouteProfile,
	type RunReceipt,
	type RunSpec,
} from "@ox-driver/core";

import { verifyPiReadPolicyExtensionV1, writePiReadPolicyExtensionV1 } from "./read-policy.js";
import {
	ensurePiGuardRuntimeDirectory,
	inspectPiPackageTree,
	piDispatchEnforcementSha256,
	systemPiProcessContainmentProvider,
	validatePiContainmentScope,
	type PiProcessContainmentProvider,
} from "./process-containment.js";
import {
	PiUsefulnessObserver,
	configuredPiUsefulnessCase,
	finalizePiUsefulnessEvidence,
	loadPiUsefulnessCase,
	validatePiUsefulnessSpec,
	type PiUsefulnessCaseConfig,
	type PiUsefulnessEvidenceResult,
	type PiUsefulnessObservationDraft,
} from "./usefulness-observer.js";
import {
	PI_CREDENTIAL_BROKER_CONTRACT_SHA256,
	startPiCredentialBroker,
	type PiCredentialBroker,
} from "./credential-broker.js";

const execFileAsync = promisify(execFile);

interface GuardIdentity {
	provider?: string;
	model?: string;
	reasoning?: string;
}

interface TeamRuntime {
	capable: boolean;
	version?: string;
}

interface PiInstallation {
	launcher: string;
	protectedRouter: string;
	protectedRouterSha256: string;
	harnessExecutable: string;
	harnessExecutableSha256: string;
	harnessPackageRoot: string;
	harnessPackageRootDevice: string;
	harnessPackageRootInode: string;
	harnessPackageTreeSha256: string;
	harnessPackageTreeEntries: number;
	harnessPackageTreeBytes: number;
	agentDirectory: string;
	containmentReadPaths: readonly string[];
	credentialHelper: string;
	credentialHelperReference: string;
	credentialHelperSha256: string;
	nodeInterpreter: string;
	agentSettings: string;
	agentSettingsSha256: string;
	agentModels: string;
	agentModelsSha256: string;
	grepExecutable: string;
	grepExecutableSha256: string;
	findExecutable: string;
	findExecutableSha256: string;
	identity: GuardIdentity;
	binarySha256: string;
	enforcementSha256: string;
	enforcementComplete: boolean;
	harnessVersion?: string;
}

interface DirectPiInstallation {
	launcher: string;
	binarySha256: string;
	harnessVersion: string;
	identity: ConfiguredRoute;
}

async function updateTreeDigest(digest: ReturnType<typeof createHash>, root: string, label: string): Promise<boolean> {
	let complete = true;
	const walk = async (directory: string, prefix: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			digest.update(label).update("\0missing-directory\0");
			complete = false;
			return;
		}
		for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
			const path = join(directory, entry.name);
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			let metadata;
			try {
				metadata = await lstat(path);
			} catch {
				digest.update(label).update("\0unreadable\0").update(relativePath).update("\0");
				complete = false;
				continue;
			}
			digest.update(label).update("\0").update(relativePath).update("\0").update(String(metadata.mode & 0o7777)).update("\0");
			if (metadata.isSymbolicLink()) {
				digest.update("link\0").update(await readlink(path)).update("\0");
			} else if (metadata.isDirectory()) {
				digest.update("directory\0");
				await walk(path, relativePath);
			} else if (metadata.isFile()) {
				digest.update("file\0").update(await readFile(path)).update("\0");
			} else {
				digest.update("special\0");
				complete = false;
			}
		}
	};
	await walk(root, "");
	return complete;
}

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const REVIEWED_PI_VERSION = "0.84.4";
const CONTROLLER_PI_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const PI_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const PI_READ_ONLY_ARGS = [
	"--print",
	"--mode", "json",
	"--no-extensions",
	// The one controller-generated read-policy extension is inserted here.
	"--no-builtin-tools",
	"--tools", PI_READ_ONLY_TOOLS.join(","),
	"--no-skills",
	"--no-prompt-templates",
	"--no-context-files",
	"--no-approve",
	"--no-session",
] as const;
const PI_TRUSTED_HOST_WRITER_ARGS = [
	"--print",
	"--mode", "json",
	// A trusted-host writer intentionally preserves the normal guarded Pi
	// extension, skill, prompt-template, repository-context, and builtin-tool
	// surface. The solo contract still removes both delegation tools
	// mechanically, in addition to the /solo prompt-template instruction.
	"--approve",
	"--exclude-tools", "subagent,subagent_wait",
	"--no-session",
] as const;
const PI_ADAPTER_ENFORCEMENT_MODULE_NAMES = [
	"index.js",
	"read-policy.js",
	"excluded-paths.js",
	"process-containment.js",
	"credential-broker.js",
	"usefulness-observer.js",
] as const;
const PI_READ_ONLY_RESIDUAL = "Pi's argv tool allowlist and per-run read-policy extension deny write/exec tools plus outside, excluded, and workspace-escaping symlink reads; a symlink is admitted only when it resolves, at check time, to an unexcluded regular file inside the workspace. The guarded launcher and protected router are deterministically staged, then the whole process tree runs inside a digest-pinned macOS Seatbelt profile: host and workspace writes, declared excluded reads, unrelated Unix sockets, inbound listeners, non-HTTPS destination ports, ambient Mach-service lookups beyond system.sb, broad POSIX IPC, and signals to unrelated processes are denied. Residuals remain: configured remote TCP port 443 egress (including loopback port 443, which Seatbelt cannot exclude under this rule), process execution inside admitted runtime roots, and system.sb's narrow named read-only Apple IPC are open; unexcluded workspace and approved system-runtime paths are readable, the in-process path check precedes the builtin tool's open, and read-path identity is not a stable-handle handoff. Use only a disposable nonsensitive workspace with no concurrent writer.";
const PI_TRUSTED_HOST_READ_ONLY_RESIDUAL = "Trusted-host Pi read-only runs the selected launcher directly with an ephemeral solo session, a read-only tool allowlist, ignored project approval, disabled project context and skills, and a controller-owned workspace read policy. It does not stage or digest-pin the runtime and does not add the attested Seatbelt process boundary. Provider cost is reported after execution rather than hard-capped by Ox Driver. Use only a disposable nonsensitive workspace with no concurrent writer.";
const PI_TRUSTED_HOST_WRITER_RESIDUAL = "Trusted-host Pi writer runs the selected launcher with its normal extensions, skills, prompt templates, repository context, Bash, edit, and write tools. /solo plus an explicit delegation-tool exclusion prohibits child agents. There is no additional Ox Driver OS sandbox: the root process can read files and use the configured network under the user's account, and approved project-local Pi resources execute on the host. Git snapshots classify changes after execution; owned and excluded paths are reconciliation evidence rather than an access boundary. Use a disposable, secret-free worktree and declare every permitted output with task.ownedPaths. Provider cost is reported after execution rather than hard-capped by Ox Driver.";

function trustedHostResidual(spec: RunSpec): string {
	return spec.execution.writerPolicy === "one-writer"
		? PI_TRUSTED_HOST_WRITER_RESIDUAL
		: PI_TRUSTED_HOST_READ_ONLY_RESIDUAL;
}

function piReadOnlyArgs(policyPath: string): string[] {
	const extensionIndex = PI_READ_ONLY_ARGS.indexOf("--no-extensions") + 1;
	return [
		...PI_READ_ONLY_ARGS.slice(0, extensionIndex),
		"--extension",
		policyPath,
		...PI_READ_ONLY_ARGS.slice(extensionIndex),
	];
}

function controllerPiEnvironment(additional: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		HOME: homedir(),
		PATH: CONTROLLER_PI_PATH,
		LANG: process.env.LANG?.trim() || "C.UTF-8",
		LC_ALL: process.env.LC_ALL?.trim() || "C.UTF-8",
		// These disable Pi's ambient startup reporting without disabling the
		// configured provider/model request or tool networking for the task.
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		// Pi's builtin grep/find resolver must never download a missing tool in
		// a qualification run. Exact staged rg/fd copies are supplied instead.
		PI_OFFLINE: "1",
	};
	for (const name of ["USER", "LOGNAME", "SHELL", "TERM", "COLORTERM", "NO_COLOR", "TZ"] as const) {
		const value = process.env[name];
		if (value?.trim()) environment[name] = value;
	}
	for (const [name, value] of Object.entries(additional)) environment[name] = value;
	return environment;
}

function appendBounded(current: Buffer, chunk: Buffer): Buffer {
	if (current.length >= OUTPUT_LIMIT) return current;
	return Buffer.concat([current, chunk.subarray(0, OUTPUT_LIMIT - current.length)]);
}

function configuredLauncher(): string {
	if (process.env.OX_DRIVER_PI_LAUNCHER?.trim()) return process.env.OX_DRIVER_PI_LAUNCHER;
	return "pi";
}

function configuredReadOnlyOptIn(): boolean {
	return process.env.OX_DRIVER_PI_READ_ONLY?.trim() === "1";
}

function configuredTrustedHostOptIn(): boolean {
	return process.env.OX_DRIVER_PI_TRUSTED_HOST?.trim() === "1";
}

function configuredDigest(name: "OX_DRIVER_PI_LAUNCHER_SHA256" | "OX_DRIVER_PI_ENFORCEMENT_SHA256"): string | undefined {
	const value = process.env[name]?.trim();
	return value || undefined;
}

function directProfileRoute(profile: Readonly<ResolvedRouteProfile>): ConfiguredRoute {
	if (profile.harness !== "pi" || profile.tier !== "trusted-host" || profile.runtime?.mode !== "direct") {
		throw new Error("a direct Pi profile must target the trusted-host pi harness with runtime.mode direct");
	}
	if (profile.route.source !== "explicit") {
		throw new Error("a direct Pi profile must declare an explicit provider, model, and reasoning route");
	}
	return { provider: profile.route.provider, model: profile.route.model, reasoning: profile.route.reasoning };
}

async function discoverDirectInstallation(profile: Readonly<ResolvedRouteProfile>): Promise<DirectPiInstallation> {
	const launcher = await resolveExecutable(profile.launcher.command);
	const binarySha256 = createHash("sha256").update(await readFile(launcher)).digest("hex");
	if (profile.runtime?.expectedSha256 && profile.runtime.expectedSha256 !== binarySha256) {
		throw new Error("Pi launcher digest differs from the route profile");
	}
	const version = await execFileAsync(launcher, profile.launcher.versionArgs, {
		encoding: "utf8",
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
	});
	const output = `${version.stdout}\n${version.stderr}`.trim();
	if (!output) throw new Error("Pi version probe returned no version");
	const expectedVersion = profile.runtime?.expectedVersion;
	if (expectedVersion && !output.includes(expectedVersion)) {
		throw new Error(`Pi version output did not contain ${expectedVersion}`);
	}
	return { launcher, binarySha256, harnessVersion: output, identity: directProfileRoute(profile) };
}

function shellAssignment(text: string, name: string): string | undefined {
	const match = text.match(new RegExp(`^(?:export\\s+)?${name}=["']?([^"'\\n]+)["']?$`, "m"));
	return match?.[1];
}

function requiredUniqueLauncherAssignment(text: string, name: string): string {
	const occurrences = text.match(new RegExp(`\\b${name}\\s*=`, "g")) ?? [];
	const value = shellAssignment(text, name);
	if (occurrences.length !== 1 || !value) {
		throw new Error(`Pi launcher must define ${name} exactly once as a static assignment`);
	}
	return value;
}

function requiredGuardCredentialHelper(text: string): string {
	const invocations = [...text.matchAll(/\bkey="\$\((\/[A-Za-z0-9._\/-]+)\)"/g)].map((match) => match[1]);
	const unique = [...new Set(invocations)];
	if (invocations.length !== 2 || unique.length !== 1 || !unique[0]) {
		throw new Error("Pi protected router must invoke one static absolute credential helper in both reviewed budget paths");
	}
	return unique[0];
}

function requireCanonicalLauncherShape(text: string): void {
	const statements = text.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
	const delegation = 'exec "$PI_PROTECTED" "$@"';
	if (statements.at(-1) !== delegation || statements.filter((line) => line === delegation).length !== 1) {
		throw new Error("Pi launcher must end in exactly one canonical PI_PROTECTED delegation");
	}
	const coreDelegation = 'exec "$PI_CORE" "$@"';
	if (statements.filter((line) => line === coreDelegation).length !== 2
		|| statements.filter((line) => /^exec\s/.test(line)).length !== 3) {
		throw new Error("Pi launcher must expose only the two reviewed PI_CORE diversions and the final protected delegation");
	}
	const adminDiversion = /case\s+"\$\{1:-\}"\s+in\s+update\|install\|remove\|uninstall\|list\|config\|auth\|--help\|-h\|--version\|-v\|--list-models\)\s+exec\s+"\$PI_CORE"\s+"\$@"\s+;;\s+esac/s;
	// The acknowledgement value is operator-owned. Require a static,
	// non-trivial token comparison without embedding one workstation's token in
	// the adapter. The gate, failure branch, cleanup, and exact diversion remain
	// mechanically checked.
	const acknowledgedRouteDiversion = /for\s+arg\s+in\s+"\$@";\s+do\s+case\s+"\$arg"\s+in\s+--provider\|--provider=\*\|--model\|-m\|--model=\*\|-m=\*\|--thinking\|--thinking=\*\)\s+\[\[\s+"\$\{AI_ROUTE_OVERRIDE_ACK:-\}"\s+==\s+"[A-Za-z0-9][A-Za-z0-9._-]{7,127}"\s+\]\]\s+\|\|\s+\{\s+echo\s+"[^"\n]+"\s+>&2;?\s+exit\s+4;?\s+\}\s+unset\s+AI_ROUTE_OVERRIDE_ACK\s+exec\s+"\$PI_CORE"\s+"\$@"\s+;;\s+esac\s+done\s+unset\s+AI_ROUTE_OVERRIDE_ACK/s;
	if (!adminDiversion.test(text) || !acknowledgedRouteDiversion.test(text)) {
		throw new Error("Pi launcher PI_CORE diversion branches differ from the reviewed admin and explicit-route selectors");
	}
}

function piCoreDiversion(args: readonly string[]): string | undefined {
	const admin = new Set(["update", "install", "remove", "uninstall", "list", "config", "auth", "--help", "-h", "--version", "-v", "--list-models"]);
	if (args[0] && admin.has(args[0])) return `admin selector ${args[0]}`;
	const route = args.find((arg) => arg === "--provider" || arg.startsWith("--provider=")
		|| arg === "--model" || arg === "-m" || arg.startsWith("--model=") || arg.startsWith("-m=")
		|| arg === "--thinking" || arg.startsWith("--thinking="));
	return route ? `route selector ${route}` : undefined;
}

function extractGuardIdentity(text: string): GuardIdentity {
	const provider = shellAssignment(text, "EXPECTED_PROVIDER") ?? shellAssignment(text, "PROVIDER_ID");
	const model = shellAssignment(text, "EXPECTED_MODEL") ?? shellAssignment(text, "MODEL_ID");
	const reasoning = shellAssignment(text, "EXPECTED_THINKING")
		?? shellAssignment(text, "REASONING_ID")
		?? text.match(/--thinking\s+([A-Za-z0-9_-]+)/)?.[1];
	return {
		...(provider ? { provider } : {}),
		...(model ? { model } : {}),
		...(reasoning ? { reasoning } : {}),
	};
}

async function resolveExecutable(command: string, searchPath = process.env.PATH ?? ""): Promise<string> {
	const candidates = command.includes("/")
		? [command]
		: searchPath.split(delimiter).filter(Boolean).map((directory) => join(directory, command));
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.R_OK | constants.X_OK);
			return await realpath(candidate);
		} catch {
			continue;
		}
	}
	throw new Error(`command is not readable and executable: ${command}`);
}

async function executableInterpreterArtifacts(label: string, executable: string): Promise<readonly (readonly [string, string])[]> {
	const bytes = await readFile(executable);
	const newline = bytes.indexOf(0x0a);
	const firstLine = bytes.subarray(0, newline === -1 ? Math.min(bytes.length, 4096) : newline).toString("utf8").trim();
	if (!firstLine.startsWith("#!")) return [];
	const tokens = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) throw new Error(`Pi executable ${label} has an empty shebang`);
	if (tokens[0] === "/usr/bin/env") {
		if (tokens.length !== 2 || !/^[A-Za-z0-9._+-]+$/.test(tokens[1] ?? "")) {
			throw new Error(`Pi executable ${label} uses an unsupported env shebang`);
		}
		return [
			[`interpreter:${label}:env`, await resolveExecutable("/usr/bin/env", CONTROLLER_PI_PATH)],
			[`interpreter:${label}:${tokens[1]}`, await resolveExecutable(tokens[1] as string, CONTROLLER_PI_PATH)],
		];
	}
	if (tokens.length !== 1 || !isAbsolute(tokens[0] as string)) {
		throw new Error(`Pi executable ${label} uses an unsupported shebang`);
	}
	return [[`interpreter:${label}`, await resolveExecutable(tokens[0] as string, CONTROLLER_PI_PATH)]];
}

async function machoRuntimePaths(executables: readonly string[]): Promise<readonly string[]> {
	if (process.platform !== "darwin") return [];
	const isMachO = async (path: string): Promise<boolean> => {
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const magic = Buffer.alloc(4);
			const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
			if (bytesRead !== magic.length) return false;
			return new Set([
				"feedface", "cefaedfe", "feedfacf", "cffaedfe",
				"cafebabe", "bebafeca", "cafebabf", "bfbafeca",
			]).has(magic.toString("hex"));
		} finally {
			await handle.close();
		}
	};
	const runOtool = async (flag: "-L" | "-l", path: string): Promise<string> => {
		try {
			const { stdout } = await execFileAsync("/usr/bin/otool", [flag, path], {
				encoding: "utf8",
				timeout: 5_000,
				maxBuffer: 1024 * 1024,
				env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
			});
			return stdout;
		} catch {
			throw new Error(`Pi Mach-O runtime inspection failed closed (${flag}): ${path}`);
		}
	};
	const expandToken = (token: string, loaderDirectory: string, executableDirectory: string): string | undefined => {
		if (token === "@loader_path") return loaderDirectory;
		if (token === "@executable_path") return executableDirectory;
		if (token.startsWith("@loader_path/")) return resolve(loaderDirectory, token.slice("@loader_path/".length));
		if (token.startsWith("@executable_path/")) return resolve(executableDirectory, token.slice("@executable_path/".length));
		return isAbsolute(token) ? resolve(token) : undefined;
	};
	const initial = [...new Set(executables.map(path => resolve(path)))];
	const pending = initial.map(path => ({ path, executableDirectory: dirname(path) }));
	const visited = new Set<string>();
	const paths = new Set<string>();
	while (pending.length > 0) {
		const current = pending.pop() as { path: string; executableDirectory: string };
		const key = `${current.path}\0${current.executableDirectory}`;
		if (visited.has(key)) continue;
		visited.add(key);
		if (!(await isMachO(current.path))) continue;
		const stdout = await runOtool("-L", current.path);
		const loadCommands = await runOtool("-l", current.path);
		const rpaths: string[] = [];
		const lines = loadCommands.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			if (lines[index]?.trim() !== "cmd LC_RPATH") continue;
			for (let offset = index + 1; offset <= Math.min(index + 6, lines.length - 1); offset += 1) {
				const token = lines[offset]?.trim().match(/^path\s+(\S+)\s+\(offset\s+\d+\)$/)?.[1];
				if (!token) continue;
				const expanded = expandToken(token, dirname(current.path), current.executableDirectory);
				if (!expanded) throw new Error(`Pi interpreter has an unsupported LC_RPATH ${token}: ${current.path}`);
				rpaths.push(expanded);
				break;
			}
		}
		for (const line of stdout.split("\n").slice(1)) {
			const dependency = line.match(/^\s+([^\s(]+)\s+\(/)?.[1];
			if (!dependency || dependency.startsWith("/System/") || dependency.startsWith("/usr/lib/")) continue;
			const candidates = dependency.startsWith("@loader_path/") || dependency.startsWith("@executable_path/")
				? [expandToken(dependency, dirname(current.path), current.executableDirectory)].filter((path): path is string => Boolean(path))
				: dependency.startsWith("@rpath/")
					? rpaths.map(path => resolve(path, dependency.slice("@rpath/".length)))
					: isAbsolute(dependency) ? [dependency] : [];
			let selected: string | undefined;
			for (const candidate of candidates) {
				try {
					await access(candidate, constants.R_OK);
					selected = candidate;
					break;
				} catch {
					continue;
				}
			}
			if (!selected) throw new Error(`Pi interpreter dependency is unresolved: ${dependency} from ${current.path}`);
			let canonical: string;
			try {
				canonical = await realpath(selected);
			} catch {
				throw new Error(`Pi interpreter dependency is missing: ${selected}`);
			}
			paths.add(selected);
			paths.add(canonical);
			pending.push({ path: canonical, executableDirectory: current.executableDirectory });
		}
	}
	return Object.freeze([...paths].sort());
}

async function discoverInstallation(command: string): Promise<PiInstallation> {
	const launcher = await resolveExecutable(command);
	if (!(await stat(launcher)).isFile()) throw new Error("Pi launcher is not a file");
	const launcherText = await readFile(launcher, "utf8");
	requireCanonicalLauncherShape(launcherText);
	const coreSetting = requiredUniqueLauncherAssignment(launcherText, "PI_CORE");
	if (!isAbsolute(coreSetting)) throw new Error("Pi launcher does not expose an absolute PI_CORE path");
	const guardSetting = requiredUniqueLauncherAssignment(launcherText, "PI_PROTECTED");
	if (!guardSetting || !isAbsolute(guardSetting)) {
		throw new Error("Pi launcher does not expose an absolute PI_PROTECTED guard path");
	}
	const guard = await realpath(guardSetting);
	await access(guard, constants.R_OK | constants.X_OK);
	if (!(await stat(guard)).isFile()) throw new Error("Pi protected router is not a file");
	const guardText = await readFile(guard, "utf8");
	const harnessExecutableSetting = requiredUniqueLauncherAssignment(guardText, "PI_BIN");
	if (!isAbsolute(harnessExecutableSetting)) {
		throw new Error("Pi protected router does not pin an absolute PI_BIN path");
	}
	const harnessExecutable = await realpath(harnessExecutableSetting);
	await access(harnessExecutable, constants.R_OK | constants.X_OK);
	if (!(await stat(harnessExecutable)).isFile()) throw new Error("Pi protected router PI_BIN is not a file");
	const credentialHelperSetting = requiredGuardCredentialHelper(guardText);
	const credentialHelper = await realpath(credentialHelperSetting);
	await access(credentialHelper, constants.R_OK | constants.X_OK);
	if (!(await stat(credentialHelper)).isFile()) throw new Error("Pi protected router credential helper is not a file");
	const configuredAgentDirectory = requiredUniqueLauncherAssignment(launcherText, "PI_CODING_AGENT_DIR");
	if (!configuredAgentDirectory || !isAbsolute(configuredAgentDirectory)) {
		throw new Error("Pi launcher does not pin an absolute PI_CODING_AGENT_DIR");
	}
	const agentDirectory = configuredAgentDirectory;
	const agentSettings = await realpath(join(agentDirectory, "settings.json"));
	const agentModels = await realpath(join(agentDirectory, "models.json"));
	if (!(await stat(agentSettings)).isFile() || !(await stat(agentModels)).isFile()) {
		throw new Error("Pi protected agent settings and models must be regular files");
	}
	const grepExecutable = await resolveExecutable("rg", CONTROLLER_PI_PATH);
	const findExecutable = await realpath(join(agentDirectory, "bin", "fd"));
	await Promise.all([
		access(grepExecutable, constants.R_OK | constants.X_OK),
		access(findExecutable, constants.R_OK | constants.X_OK),
	]);
	if (!(await stat(grepExecutable)).isFile() || !(await stat(findExecutable)).isFile()) {
		throw new Error("Pi read-only grep/find tools must resolve to regular executables");
	}
	const binarySha256 = createHash("sha256").update(launcherText).digest("hex");
	let harnessVersion: string | undefined;
	const packageRootSetting = requiredUniqueLauncherAssignment(launcherText, "PI_CODING_AGENT_PACKAGE_ROOT");
	const childLauncher = requiredUniqueLauncherAssignment(launcherText, "PI_SUBAGENT_PI_BINARY");
	if (!packageRootSetting || !isAbsolute(packageRootSetting)) {
		throw new Error("Pi launcher does not pin an absolute PI_CODING_AGENT_PACKAGE_ROOT");
	}
	if (!childLauncher || !isAbsolute(childLauncher)) {
		throw new Error("Pi launcher does not pin an absolute PI_SUBAGENT_PI_BINARY");
	}
	const packageTree = await inspectPiPackageTree(packageRootSetting);
	const packageRoot = packageTree.rootPath;
	const packageExecutableRelative = relative(packageRoot, harnessExecutable);
	if (!packageExecutableRelative || packageExecutableRelative === ".."
		|| packageExecutableRelative.startsWith(`..${sep}`) || isAbsolute(packageExecutableRelative)) {
		throw new Error("Pi protected router PI_BIN must resolve strictly inside the reviewed package root");
	}
	const enforcementArtifacts = [
		["launcher", launcher],
		["protected-router", guard],
		["harness-executable", harnessExecutable],
		["credential-helper", credentialHelper],
		["agent-settings", agentSettings],
		["agent-models", agentModels],
		["harness-manifest", join(packageRoot, "package.json")],
		["harness-cli", join(packageRoot, "dist", "bundle", "cli.js")],
	] as const;
	const interpretedExecutables = [
		["launcher", launcher],
		["protected-router", guard],
		["harness-executable", harnessExecutable],
		["credential-helper", credentialHelper],
	] as const;
	const interpreterArtifacts = (await Promise.all(interpretedExecutables.map(
		async ([label, executable]) => executableInterpreterArtifacts(label, executable),
	))).flat();
	const containedInterpreterArtifacts = interpreterArtifacts.filter(([label]) => !label.includes("credential-helper"));
	const nodeInterpreter = containedInterpreterArtifacts.find(([label]) => label === "interpreter:harness-executable:node")?.[1]
		?? containedInterpreterArtifacts.find(([label]) => label.startsWith("interpreter:harness-executable")
			&& !label.endsWith(":env"))?.[1];
	if (!nodeInterpreter) throw new Error("Pi harness Node interpreter could not be pinned for the credential client");
	const machoPaths = await machoRuntimePaths([
		...containedInterpreterArtifacts.map(([, path]) => path),
		grepExecutable,
		findExecutable,
	]);
	// dyld requires directory traversal/read access at Homebrew's @rpath alias
	// location even when both the symlink and canonical dylib are literal
	// read roots. These are per-library `opt/<formula>/lib` directories, not a
	// Homebrew prefix root, and their complete trees are enforcement-hashed.
	const machoAliasDirectories = [...new Set(machoPaths.flatMap((path) =>
		/^\/opt\/homebrew\/opt\/[^/]+\/lib\//.test(path) ? [dirname(path)] : []))];
	const machoArtifacts = machoPaths.map((path, index) => [`interpreter-library:${index}`, path] as const);
	const runtimeConfigArtifacts: Array<readonly [string, string]> = [];
	if (containedInterpreterArtifacts.some(([, path]) => /\/(?:opt\/homebrew|usr\/local)\/Cellar\/node\//.test(path))) {
		for (const path of ["/opt/homebrew/etc/openssl@3/openssl.cnf", "/usr/local/etc/openssl@3/openssl.cnf"]) {
			try {
				await access(path, constants.R_OK);
				runtimeConfigArtifacts.push(["node-openssl-config", path]);
			} catch {
				// Only the installed package-manager prefix contributes a config file.
			}
		}
	}
	const enforcementHash = createHash("sha256");
	let enforcementComplete = true;
	const adapterModuleArtifacts = PI_ADAPTER_ENFORCEMENT_MODULE_NAMES.map((name) => [
		`adapter-enforcement-module:${name}`,
		fileURLToPath(new URL(name, import.meta.url)),
	] as const);
	const toolArtifacts = [
		["read-tool:grep", grepExecutable],
		["read-tool:find", findExecutable],
	] as const;
	for (const [label, path] of [
		...enforcementArtifacts,
		...interpreterArtifacts,
		...machoArtifacts,
		...runtimeConfigArtifacts,
		...toolArtifacts,
		...adapterModuleArtifacts,
	]) {
		enforcementHash.update(label).update("\0");
		try {
			enforcementHash.update(await readFile(path));
		} catch {
			enforcementHash.update("missing");
			enforcementComplete = false;
		}
		enforcementHash.update("\0");
	}
	enforcementHash.update("harness-package-tree\0").update(packageTree.sha256).update("\0");
	for (const path of machoAliasDirectories) {
		enforcementComplete = await updateTreeDigest(enforcementHash, path, `dyld-alias-directory:${path}`) && enforcementComplete;
	}
	const enforcementSha256 = enforcementHash.digest("hex");
	try {
		const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
		if (typeof manifest.version === "string" && manifest.version.trim()) harnessVersion = manifest.version;
	} catch {
		// Version evidence is optional; launcher and guard identity remain usable.
	}
	return {
		launcher,
		protectedRouter: guard,
		protectedRouterSha256: createHash("sha256").update(guardText).digest("hex"),
		harnessExecutable,
		harnessExecutableSha256: createHash("sha256").update(await readFile(harnessExecutable)).digest("hex"),
		harnessPackageRoot: packageRoot,
		harnessPackageRootDevice: packageTree.rootDevice,
		harnessPackageRootInode: packageTree.rootInode,
		harnessPackageTreeSha256: packageTree.sha256,
		harnessPackageTreeEntries: packageTree.entries,
		harnessPackageTreeBytes: packageTree.bytes,
		agentDirectory,
		containmentReadPaths: Object.freeze([...new Set([
			...containedInterpreterArtifacts.map(([, path]) => path),
			...machoPaths,
			...machoAliasDirectories,
			...runtimeConfigArtifacts.map(([, path]) => path),
		])]),
		credentialHelper,
		credentialHelperReference: credentialHelperSetting,
		credentialHelperSha256: createHash("sha256").update(await readFile(credentialHelper)).digest("hex"),
		nodeInterpreter,
		agentSettings,
		agentSettingsSha256: createHash("sha256").update(await readFile(agentSettings)).digest("hex"),
		agentModels,
		agentModelsSha256: createHash("sha256").update(await readFile(agentModels)).digest("hex"),
		grepExecutable,
		grepExecutableSha256: createHash("sha256").update(await readFile(grepExecutable)).digest("hex"),
		findExecutable,
		findExecutableSha256: createHash("sha256").update(await readFile(findExecutable)).digest("hex"),
		identity: extractGuardIdentity(guardText),
		binarySha256,
		enforcementSha256,
		enforcementComplete,
		...(harnessVersion ? { harnessVersion } : {}),
	};
}

async function inspectTeamRuntime(agentDirectory: string): Promise<TeamRuntime> {
	const required = [
		join(agentDirectory, "agents", "pi-agent.md"),
		join(agentDirectory, "agents", "pi-lead.md"),
	];
	try {
		await Promise.all(required.map(async (path) => access(path, constants.R_OK)));
		const manifest = JSON.parse(
			await readFile(join(agentDirectory, "npm", "node_modules", "pi-subagents", "package.json"), "utf8"),
		) as Record<string, unknown>;
		const version = typeof manifest.version === "string" ? manifest.version : undefined;
		return {
			capable: version === "0.56.0",
			...(version ? { version } : {}),
		};
	} catch {
		return { capable: false };
	}
}

function buildBrief(spec: RunSpec): string {
	const lines = [
		"# Objective",
		spec.task.objective,
		"",
		"# Scope",
		`Own: ${spec.task.ownedPaths.join(", ") || "none"}`,
		`Do not touch: ${spec.task.excludedPaths.join(", ") || "none"}`,
		`Writer policy: ${spec.execution.writerPolicy}`,
		...(spec.execution.topology === "solo"
			? ["Delegation: prohibited for this solo run."]
			: spec.execution.maxChildren !== undefined ? [`Maximum children: ${spec.execution.maxChildren}`] : []),
		...(spec.execution.writerPolicy === "read-only"
			? ["Read-only: do not edit, modify, write, or touch files."]
			: []),
		"",
		"# Time budget",
		`Controller timeout: ${spec.execution.timeoutSeconds} seconds. Use the available time as needed and still return a final answer before the hard timeout.`,
		"Match the depth of investigation to the objective, including an exhaustive audit when the objective asks for one.",
		"",
		"# Acceptance",
		...(spec.acceptance.commands.length > 0
			? spec.acceptance.commands.map((command) => `Run: ${command}`)
			: ["No acceptance commands are required."]),
		...(spec.execution.writerPolicy === "read-only"
			? ["Return a direct answer to the objective, cite the most relevant paths, and name unresolved uncertainty."]
			: ["Report changed files, command results, failed child receipts, and unresolved work."]),
	];
	const brief = lines.join("\n");
	if (spec.execution.topology === "solo") return `/solo ${brief}`;
	if (spec.execution.topology === "hierarchical") return `/team ${brief}`;
	return brief;
}

function assistantMessageEnd(event: Record<string, unknown>): { text: string; stopReason?: string } | undefined {
	if (event.type !== "message_end" || !event.message || typeof event.message !== "object") return undefined;
	const message = event.message as Record<string, unknown>;
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const text = message.content
		.flatMap((item) => {
			if (!item || typeof item !== "object") return [];
			const content = item as Record<string, unknown>;
			return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
		})
		.join("\n");
	return {
		text,
		...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
	};
}

function assistantUsageObservation(event: Record<string, unknown>): {
	providerTurn: boolean;
	toolCallAttempts: number;
	reportedCostUsd?: number;
} {
	if (event.type !== "message_end" || !event.message || typeof event.message !== "object") {
		return { providerTurn: false, toolCallAttempts: 0 };
	}
	const message = event.message as Record<string, unknown>;
	if (message.role !== "assistant") return { providerTurn: false, toolCallAttempts: 0 };
	const content = Array.isArray(message.content) ? message.content : [];
	const toolCallAttempts = content.filter((item) => item && typeof item === "object"
		&& (item as Record<string, unknown>).type === "toolCall").length;
	const usage = message.usage && typeof message.usage === "object"
		? message.usage as Record<string, unknown>
		: undefined;
	const cost = usage?.cost && typeof usage.cost === "object"
		? (usage.cost as Record<string, unknown>).total
		: undefined;
	return {
		providerTurn: true,
		toolCallAttempts,
		...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { reportedCostUsd: cost } : {}),
	};
}

async function runPi(
	command: string,
	args: string[],
	cwd: string,
	context: AdapterRunContext,
	usefulnessObserver?: PiUsefulnessObserver,
	additionalEnvironment: Readonly<Record<string, string>> = {},
	preserveAmbientEnvironment = false,
): Promise<ProcessTreeCleanup & {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	stdoutEvidence: { redacted: true; bytes: number; sha256: string; captureTruncated: boolean };
	stderrEvidence: { redacted: true; bytes: number; sha256: string; captureTruncated: boolean };
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	finalOutput?: string;
	agentEnded: boolean;
	agentSettled: boolean;
	terminalStopReason?: string;
		blockedMarker?: string;
		protocolError?: string;
	providerTurns: number;
	toolCallAttempts: number;
	reportedCostUsd?: number;
}> {
	const admission = await context.processes.admit({
		label: preserveAmbientEnvironment ? "direct Pi harness" : "guarded Pi harness",
		detachedProcessGroup: process.platform !== "win32",
	});
	return new Promise((resolveRun, rejectRun) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				cwd,
				env: preserveAmbientEnvironment
					? { ...process.env, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", ...additionalEnvironment }
					: controllerPiEnvironment(additionalEnvironment),
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
		} catch (error) {
			void admission.abandon("spawn-error").then(() => rejectRun(error), rejectRun);
			return;
		}
		const binding = child.pid === undefined
			? admission.abandon("spawn-error").then(() => { throw new Error("Pi process did not expose a pid"); })
			: admission.bind(child.pid).catch(async (error: unknown) => {
				try { child.kill("SIGKILL"); } catch { /* child already exited */ }
				await admission.abandon("bind-error");
				throw error;
			});
		void binding.catch(() => undefined);
		let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		const stdoutHash = createHash("sha256");
		const stderrHash = createHash("sha256");
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let buffered = "";
			const decoder = new TextDecoder("utf-8", { fatal: true });
		let finalOutput: string | undefined;
		let agentEnded = false;
		let agentSettled = false;
		let eventOrdinal = 0;
		let messageEndOrdinal = 0;
		let agentEndOrdinal = 0;
		let agentSettledOrdinal = 0;
		let terminalStopReason: string | undefined;
			let blockedMarker: string | undefined;
			let protocolError: string | undefined;
		let providerTurns = 0;
		let toolCallAttempts = 0;
		let reportedCostUsd = 0;
		let costEvidenceComplete = true;
		let settled = false;
		let forceKillTimer: NodeJS.Timeout | undefined;
		let eventWrite = Promise.resolve();
		let compactedMessageUpdates = 0;

		const terminate = (): void => {
			if (!child.pid) return;
			try {
				if (process.platform === "win32") child.kill("SIGTERM");
				else process.kill(-child.pid, "SIGTERM");
			} catch {
				child.kill("SIGTERM");
			}
			forceKillTimer = setTimeout(() => {
				if (child.exitCode !== null || !child.pid) return;
				try {
					if (process.platform === "win32") child.kill("SIGKILL");
					else process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}, 250);
			forceKillTimer.unref();
		};
		context.signal.addEventListener("abort", terminate, { once: true });
		if (context.signal.aborted) terminate();

		const consumeLine = (line: string): void => {
			if (line.trim() === "") return;
				try {
					const parsed = JSON.parse(line) as unknown;
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
						throw new Error("Pi protocol frame must be a JSON object");
					}
					const event = parsed as Record<string, unknown>;
					if (usefulnessObserver) {
						try {
							usefulnessObserver.observe(event, line);
						} catch {
							protocolError ??= "Pi usefulness qualification rejected the raw tool-event stream.";
							terminate();
						}
					}
				const observation = assistantUsageObservation(event);
				if (observation.providerTurn) {
					providerTurns += 1;
					toolCallAttempts += observation.toolCallAttempts;
					if (observation.reportedCostUsd === undefined) costEvidenceComplete = false;
					else reportedCostUsd += observation.reportedCostUsd;
				}
				eventOrdinal += 1;
				if (event.type === "message_update") {
					compactedMessageUpdates += 1;
				} else {
					eventWrite = eventWrite.then(async () => context.emit("harness.event", {
						event: normalizedHarnessEvent(event),
					})).then(() => undefined);
				}
				if (event.type === "agent_start") {
					agentEnded = false;
					agentSettled = false;
				}
				if (event.type === "agent_end") {
					agentEnded = true;
					agentEndOrdinal = eventOrdinal;
				}
				if (event.type === "agent_settled") {
					agentSettled = true;
					agentSettledOrdinal = eventOrdinal;
				}
				const message = assistantMessageEnd(event);
				if (message) {
					messageEndOrdinal = eventOrdinal;
					finalOutput = message.text;
					terminalStopReason = message.stopReason;
					blockedMarker = ["CAPABILITY_BLOCKED", "CONTROLLER_ACTION_REQUIRED"]
						.find((marker) => message.text.includes(marker));
				}
				} catch {
					protocolError ??= "Pi emitted a malformed JSON protocol frame.";
					eventWrite = eventWrite.then(async () => context.emit("harness.stdout", {
					payload: redactedTextEvidence(line),
				})).then(() => undefined);
			}
		};

			child.stdout!.on("data", (chunk: Buffer) => {
				stdoutHash.update(chunk);
				stdoutBytes += chunk.length;
				if (stdout.length + chunk.length > OUTPUT_LIMIT) stdoutTruncated = true;
				stdout = appendBounded(stdout, chunk);
				let text = "";
				try {
					text = decoder.decode(chunk, { stream: true });
				} catch {
					protocolError ??= "Pi emitted invalid UTF-8 on its JSON protocol stream.";
					return;
				}
			buffered += text;
			const lines = buffered.split("\n");
			buffered = lines.pop() ?? "";
			for (const line of lines) consumeLine(line);
			if (Buffer.byteLength(buffered, "utf8") > OUTPUT_LIMIT) {
				consumeLine(buffered.slice(0, OUTPUT_LIMIT));
				buffered = "";
			}
		});
		child.stderr!.on("data", (chunk: Buffer) => {
			stderrHash.update(chunk);
			stderrBytes += chunk.length;
			if (stderr.length + chunk.length > OUTPUT_LIMIT) stderrTruncated = true;
			stderr = appendBounded(stderr, chunk);
		});
		child.once("error", async (error) => {
			if (settled) return;
			settled = true;
			if (forceKillTimer) clearTimeout(forceKillTimer);
			context.signal.removeEventListener("abort", terminate);
			await binding.catch(() => undefined);
			rejectRun(error);
		});
		child.once("close", async (exitCode, terminationSignal) => {
			if (settled) return;
			settled = true;
			if (forceKillTimer) clearTimeout(forceKillTimer);
			context.signal.removeEventListener("abort", terminate);
				try {
					buffered += decoder.decode();
				} catch {
					protocolError ??= "Pi ended with invalid UTF-8 on its JSON protocol stream.";
				}
			if (buffered) consumeLine(buffered);
			try {
				await binding;
				await admission.complete({
					exitCode,
					...(terminationSignal ? { terminationSignal } : {}),
				});
				if (compactedMessageUpdates > 0) {
					eventWrite = eventWrite.then(async () => context.emit("harness.event", {
						event: {
							type: "message_update_compaction",
							omittedEvents: compactedMessageUpdates,
							fullStreamHashEvidence: "stdout.log",
						},
					})).then(() => undefined);
				}
				await eventWrite;
				const processTree = await reapDetachedProcessGroup(child.pid);
				resolveRun({
					exitCode,
					stdout: stdout.toString("utf8"),
					stderr: stderr.toString("utf8"),
					stdoutEvidence: {
						redacted: true,
						bytes: stdoutBytes,
						sha256: stdoutHash.digest("hex"),
						captureTruncated: stdoutTruncated,
					},
					stderrEvidence: {
						redacted: true,
						bytes: stderrBytes,
						sha256: stderrHash.digest("hex"),
						captureTruncated: stderrTruncated,
					},
					stdoutTruncated,
					stderrTruncated,
					...processTree,
					agentEnded: agentEnded && agentEndOrdinal > messageEndOrdinal,
						agentSettled: agentSettled
							&& agentSettledOrdinal > messageEndOrdinal
							&& agentSettledOrdinal > agentEndOrdinal
							&& agentSettledOrdinal === eventOrdinal,
					...(finalOutput !== undefined ? { finalOutput } : {}),
					...(terminalStopReason !== undefined ? { terminalStopReason } : {}),
						...(blockedMarker !== undefined ? { blockedMarker } : {}),
						...(protocolError !== undefined ? { protocolError } : {}),
					providerTurns,
					toolCallAttempts,
					...(costEvidenceComplete ? { reportedCostUsd } : {}),
				});
			} catch (error) {
				rejectRun(error);
			}
		});
	});
}

export interface PiAdapterOptions {
	launcher?: string;
	profile?: Readonly<ResolvedRouteProfile>;
	enableReadOnlyDispatch?: boolean;
	enableTrustedHostDispatch?: boolean;
	expectedLauncherSha256?: string;
	expectedEnforcementSha256?: string;
	processContainmentProvider?: Readonly<PiProcessContainmentProvider>;
	usefulnessCase?: Readonly<PiUsefulnessCaseConfig>;
}

export class PiAdapter implements HarnessAdapter {
	readonly id = "pi-v1";
	readonly harness = "pi";
	readonly #launcher: string;
	readonly #profile: Readonly<ResolvedRouteProfile> | undefined;
	readonly #enableReadOnlyDispatch: boolean;
	readonly #enableTrustedHostDispatch: boolean;
	readonly #expectedLauncherSha256: string | undefined;
	readonly #expectedEnforcementSha256: string | undefined;
	readonly #processContainment: Readonly<PiProcessContainmentProvider>;
	readonly #usefulnessCase: Readonly<PiUsefulnessCaseConfig> | undefined;
	readonly #usefulnessDrafts = new Map<string, PiUsefulnessObservationDraft>();

	constructor(options: PiAdapterOptions = {}) {
		this.#profile = options.profile;
		if (this.#profile?.runtime?.mode === "direct") directProfileRoute(this.#profile);
		this.#launcher = options.launcher ?? this.#profile?.launcher.command ?? configuredLauncher();
		this.#enableReadOnlyDispatch = options.enableReadOnlyDispatch ?? configuredReadOnlyOptIn();
		this.#enableTrustedHostDispatch = options.enableTrustedHostDispatch ?? configuredTrustedHostOptIn();
		this.#expectedLauncherSha256 = options.expectedLauncherSha256 ?? configuredDigest("OX_DRIVER_PI_LAUNCHER_SHA256");
		this.#expectedEnforcementSha256 = options.expectedEnforcementSha256 ?? configuredDigest("OX_DRIVER_PI_ENFORCEMENT_SHA256");
		this.#processContainment = options.processContainmentProvider ?? systemPiProcessContainmentProvider;
		this.#usefulnessCase = options.usefulnessCase ?? configuredPiUsefulnessCase();
	}

	async doctor(): Promise<HarnessCapabilities> {
		if (this.#profile?.runtime?.mode === "direct") {
			try {
				const installation = await discoverDirectInstallation(this.#profile);
				const executionQualified = this.#enableTrustedHostDispatch;
				return {
					version: 1,
					adapterId: this.id,
					harness: this.harness,
					compatibility: executionQualified ? "verified" : "degraded",
					available: true,
					executable: installation.launcher,
					binarySha256: installation.binarySha256,
					routeProfileSha256: this.#profile.sha256,
					harnessVersion: installation.harnessVersion,
					configuredRoute: installation.identity,
					probe: {
						version: 1,
						modelCalls: 0,
						contract: "pi-direct-trusted-host-profile-v1",
						artifact: "verified",
						executionQualified,
						protocol: { name: "pi-json-events" },
					},
					capabilities: {
						"session.ephemeral": executionQualified,
						"control.cancel": executionQualified,
						"events.structured": executionQualified,
						"route.configured": true,
						"telemetry.usage": executionQualified,
						"sandbox.filesystem": false,
						"agents.children": false,
						"agents.hierarchical": false,
						"agents.receipts": false,
						"worktree.native": false,
					},
					notices: [
						"Pi route identity comes from the selected route profile; the version probe made no model call.",
						"Direct Pi mode passes the selected provider, model, and reasoning to the installed launcher for each run.",
						...(!executionQualified ? ["Pi trusted-host dispatch is disabled until the controller selects this profile for a task."] : []),
						PI_TRUSTED_HOST_READ_ONLY_RESIDUAL,
						PI_TRUSTED_HOST_WRITER_RESIDUAL,
					],
				};
			} catch (error) {
				return {
					version: 1,
					adapterId: this.id,
					harness: this.harness,
					compatibility: "blocked",
					available: false,
					capabilities: {},
					notices: [`Pi launcher unavailable: ${error instanceof Error ? error.message : String(error)}`],
				};
			}
		}
		let installation: PiInstallation;
		try {
			installation = await discoverInstallation(this.#launcher);
		} catch (error) {
			return {
				version: 1,
				adapterId: this.id,
				harness: this.harness,
				compatibility: "blocked",
				available: false,
				capabilities: {},
				notices: [`guarded Pi launcher unavailable: ${error instanceof Error ? error.message : String(error)}`],
			};
		}

		const identity = installation.identity;
		const teamRuntime = await inspectTeamRuntime(installation.agentDirectory);
		const containment = await this.#processContainment.inspect();
		const identityComplete = Boolean(identity.provider && identity.model && identity.reasoning);
		const reviewedVersion = installation.harnessVersion === REVIEWED_PI_VERSION;
		const launcherPinned = this.#expectedLauncherSha256 !== undefined
			&& this.#expectedLauncherSha256 === installation.binarySha256;
		const dispatchEnforcement = containment.mechanismSha256
			? piDispatchEnforcementSha256(installation.enforcementSha256, containment.mechanismSha256)
			: undefined;
		const enforcementPinned = this.#expectedEnforcementSha256 !== undefined
			&& this.#expectedEnforcementSha256 === dispatchEnforcement;
		const attestedQualified = this.#enableReadOnlyDispatch
			&& reviewedVersion
			&& installation.enforcementComplete
			&& containment.available
			&& launcherPinned
			&& enforcementPinned
			&& identityComplete;
		const trustedHostQualified = this.#enableTrustedHostDispatch
			&& reviewedVersion
			&& installation.enforcementComplete
			&& identityComplete;
		const executionQualified = attestedQualified || trustedHostQualified;
		const notices = [identityComplete
			? "Pi guard identity was read from the canonical launcher and protected router; no model call was made."
			: "The protected Pi router does not expose a complete provider, model, and reasoning identity."];
		if (teamRuntime.version && !teamRuntime.capable) {
			notices.push(`Pi team runtime ${teamRuntime.version} is installed but has not passed this adapter's reviewed contract.`);
		} else if (teamRuntime.capable) {
			notices.push("Pi team files were discovered, but team execution remains disabled until writer and child-receipt controls pass adapter contract tests.");
		}
		notices.push("Per-run explicit network modes remain disabled until each mode passes a guarded-launcher integration test; configured network policy is supported.");
		notices.push(containment.notice);
		if (containment.available) {
			notices.push("The controller will deterministically stage the guarded Pi launcher, protected router, complete reviewed package tree, minimal agent configuration, and read tools with a private per-run runtime, then spawn all descendants through a generated process-bound macOS Seatbelt profile.");
		} else {
			notices.push("Pi dispatch remains blocked without the reviewed process-bound OS containment mechanism.");
		}
		if (!this.#enableReadOnlyDispatch) {
			notices.push("Pi attested read-only dispatch is disabled until the controller host explicitly opts in.");
		} else if (!this.#expectedLauncherSha256 || !this.#expectedEnforcementSha256) {
			notices.push("Pi read-only dispatch requires externally reviewed launcher and enforcement SHA-256 pins.");
		} else if (!launcherPinned || !enforcementPinned) {
			notices.push("Pi read-only dispatch pins do not match the discovered launcher and enforcement artifacts.");
		}
		if (!this.#enableTrustedHostDispatch) {
			notices.push("Pi trusted-host dispatch is disabled until the controller host explicitly opts in.");
		} else if (trustedHostQualified) {
			notices.push("Pi trusted-host solo read-only and one-writer dispatch are available through the selected route launcher without attested runtime staging.");
		}
		if (!reviewedVersion) notices.push(`Pi ${installation.harnessVersion ?? "unknown"} is not the reviewed ${REVIEWED_PI_VERSION} release.`);
		if (!installation.enforcementComplete) notices.push("Pi read-only enforcement evidence is incomplete.");
		if (trustedHostQualified) {
			notices.push(PI_TRUSTED_HOST_READ_ONLY_RESIDUAL, PI_TRUSTED_HOST_WRITER_RESIDUAL);
		} else {
			notices.push(PI_READ_ONLY_RESIDUAL);
		}
		return {
			version: 1,
			adapterId: this.id,
			harness: this.harness,
			compatibility: executionQualified ? "verified" : identityComplete ? "degraded" : "blocked",
			available: true,
			executable: installation.launcher,
			binarySha256: installation.binarySha256,
			...(dispatchEnforcement ? { enforcementSha256: dispatchEnforcement } : {}),
			...(installation.harnessVersion ? { harnessVersion: installation.harnessVersion } : {}),
			...(identityComplete ? {
				configuredRoute: {
					provider: identity.provider as string,
					model: identity.model as string,
					reasoning: identity.reasoning as string,
				},
			} : {}),
			probe: {
				version: 1,
				modelCalls: 0,
				contract: "guarded-pi-tiered-read-only-v1",
				artifact: executionQualified ? "verified" : "unverified",
				executionQualified,
				protocol: { name: "pi-json-events" },
			},
			capabilities: {
				"session.ephemeral": executionQualified,
				"session.new": false,
				"session.resume": false,
				"session.fork": false,
				"control.cancel": executionQualified,
				"control.steer": false,
				"approval.bridge": false,
				"events.structured": executionQualified,
				"output.schema": false,
				"route.configured": identityComplete,
				"agent.identity": false,
				"telemetry.usage": executionQualified,
				"limits.providerRequests": false,
				"limits.toolCalls": false,
				"limits.spend": false,
				"limits.children": false,
				"sandbox.filesystem": attestedQualified,
				"sandbox.network.open": false,
				"sandbox.network.restricted": false,
				"sandbox.network.none": false,
				"agents.children": false,
				"agents.hierarchical": false,
				"agents.receipts": false,
				"worktree.native": false,
			},
			notices,
		};
	}

	async preflight(spec: RunSpec, doctor: HarnessCapabilities): Promise<PreflightIssue[]> {
		const issues: PreflightIssue[] = [];
		const directProfile = this.#profile?.runtime?.mode === "direct" ? this.#profile : undefined;
		if (spec.tier === "attested" && this.#usefulnessCase) {
			try {
				const prepared = await loadPiUsefulnessCase(this.#usefulnessCase);
				await validatePiUsefulnessSpec(spec, prepared);
			} catch (error) {
				issues.push({
					severity: "error",
					code: "PI_USEFULNESS_CASE_REJECTED",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (spec.tier === "attested") {
			const attestedIdentityMatchesPins = this.#expectedLauncherSha256 !== undefined
				&& this.#expectedEnforcementSha256 !== undefined
				&& doctor.binarySha256 === this.#expectedLauncherSha256
				&& doctor.enforcementSha256 === this.#expectedEnforcementSha256;
			if (doctor.probe?.artifact !== "verified"
				|| doctor.probe.executionQualified !== true
				|| !this.#enableReadOnlyDispatch
				|| !attestedIdentityMatchesPins) {
				issues.push({
					severity: "error",
					code: "PI_EXECUTION_NOT_QUALIFIED",
					message: "Pi attested read-only dispatch requires explicit opt-in and exact reviewed launcher and enforcement digests",
				});
			}
			if (doctor.capabilities["sandbox.filesystem"] !== true) {
				issues.push({
					severity: "error",
					code: "PI_PROCESS_CONTAINMENT_UNVERIFIED",
					message: "Pi attested read-only dispatch requires the reviewed process-bound macOS Seatbelt mechanism",
				});
			} else {
				try {
					await validatePiContainmentScope(spec.task.cwd, spec.task.excludedPaths);
				} catch (error) {
					issues.push({
						severity: "error",
						code: "PI_CONTAINMENT_SCOPE_REJECTED",
						message: error instanceof Error ? error.message : String(error),
					});
				}
			}
		} else {
			if (!this.#enableTrustedHostDispatch || doctor.probe?.executionQualified !== true) {
				issues.push({
					severity: "error",
					code: "PI_TRUSTED_HOST_DISABLED",
					message: "Pi trusted-host dispatch requires explicit controller-host opt-in",
				});
			}
		}
		try {
			const status = await stat(spec.task.cwd);
			if (!status.isDirectory()) throw new Error("task cwd is not a directory");
		} catch (error) {
			issues.push({ severity: "error", code: "INVALID_CWD", message: error instanceof Error ? error.message : String(error) });
		}
		if (resolve(spec.task.cwd) === resolve("/", ".") || resolve(spec.task.cwd) === resolve(homedir())) {
			issues.push({ severity: "error", code: "BROAD_CWD", message: "Pi tasks cannot use the filesystem root or home directory" });
		}
		if (spec.execution.session !== "ephemeral") {
			issues.push({ severity: "error", code: "PI_SESSION_UNSUPPORTED", message: "Pi read-only dispatch is ephemeral and disables session persistence" });
		}
		if (spec.execution.writerPolicy === "read-only" && spec.execution.topology !== "solo") {
			issues.push({
				severity: "error",
				code: "READ_ONLY_TEAM_UNVERIFIED",
				message: "the Pi adapter currently enforces read-only tools only for solo runs",
			});
		}
		const trustedHostSoloWriter = spec.tier === "trusted-host"
			&& spec.execution.topology === "solo"
			&& spec.execution.writerPolicy === "one-writer";
		if (spec.execution.writerPolicy === "one-writer" && spec.execution.topology !== "solo") {
			issues.push({
				severity: "error",
				code: "ONE_WRITER_TEAM_UNVERIFIED",
				message: "the Pi adapter cannot yet mechanically limit a team to one writer",
			});
		}
		if (spec.execution.writerPolicy === "one-writer" && !trustedHostSoloWriter) {
			issues.push({
				severity: "error",
				code: "PI_WRITER_UNVERIFIED",
				message: "Pi one-writer dispatch is available only for a trusted-host solo run; the attested lane remains read-only",
			});
		}
		if (spec.execution.writerPolicy !== "read-only" && !trustedHostSoloWriter) {
			issues.push({ severity: "error", code: "PI_READ_ONLY_REQUIRED", message: "Pi argv dispatch permits read-only runs only" });
		}
		if (trustedHostSoloWriter && spec.task.ownedPaths.length === 0) {
			issues.push({ severity: "error", code: "PI_WRITER_OWNED_PATH_REQUIRED", message: "Pi trusted-host writer dispatch requires at least one declared owned path" });
		}
		if (spec.execution.writerPolicy === "managed-worktrees") {
			issues.push({ severity: "error", code: "PI_MANAGED_WORKTREES_UNVERIFIED", message: "Pi managed-worktree dispatch is not yet implemented through Ox Driver" });
		}
		if (spec.execution.network !== "configured") {
			issues.push({ severity: "error", code: "PI_NETWORK_UNSUPPORTED", message: "Pi dispatch preserves the selected launcher's configured network policy" });
		}
		if (directProfile ? spec.routeProfile !== directProfile.id : spec.routeProfile !== "pi-protected-inherited") {
			issues.push({
				severity: "error",
				code: spec.routeProfile ? "ROUTE_PROFILE_UNSUPPORTED" : "ROUTE_PROFILE_REQUIRED",
				message: spec.routeProfile
					? `the Pi adapter was configured for route profile ${directProfile?.id ?? "pi-protected-inherited"}, not ${spec.routeProfile}`
					: "Pi dispatch requires a selected route profile",
			});
		}
		if (doctor.compatibility === "degraded") {
			issues.push({ severity: "warning", code: "ROUTE_IDENTITY_DEGRADED", message: "route evidence may be incomplete" });
		}
		issues.push({
			severity: "warning",
			code: spec.tier === "attested" ? "PI_READ_ONLY_RESIDUAL_RISK" : "PI_TRUSTED_HOST_RESIDUAL_RISK",
			message: spec.tier === "attested" ? PI_READ_ONLY_RESIDUAL : trustedHostResidual(spec),
		});
		return issues;
	}

	async #runTrustedHost(spec: RunSpec, context: AdapterRunContext): Promise<AdapterRunResult> {
		if (!this.#enableTrustedHostDispatch
			|| spec.tier !== "trusted-host"
			|| spec.execution.session !== "ephemeral"
			|| spec.execution.topology !== "solo"
			|| !["read-only", "one-writer"].includes(spec.execution.writerPolicy)
			|| context.doctor.probe?.artifact !== "verified"
			|| context.doctor.probe.executionQualified !== true) {
			throw new Error("Pi trusted-host run was not explicitly enabled and qualified");
		}
		const writer = spec.execution.writerPolicy === "one-writer";
		const readPolicy = writer
			? undefined
			: await writePiReadPolicyExtensionV1(
				context.runDirectory,
				spec.task.cwd,
				spec.task.excludedPaths,
			);
		const directProfile = this.#profile?.runtime?.mode === "direct" ? this.#profile : undefined;
		const routeArgs = directProfile
			? ["--provider", directProfile.route.source === "explicit" ? directProfile.route.provider : "", "--model", directProfile.route.source === "explicit" ? directProfile.route.model : "", "--thinking", directProfile.route.source === "explicit" ? directProfile.route.reasoning : ""]
			: [];
		const args = [
			...(writer ? PI_TRUSTED_HOST_WRITER_ARGS : piReadOnlyArgs(readPolicy!.path)),
			...routeArgs,
		];
		const diversion = piCoreDiversion(args);
		if (!directProfile && diversion) throw new Error(`Pi trusted-host argv would select the unprotected PI_CORE path: ${diversion}`);
		const before = directProfile
			? await discoverDirectInstallation(directProfile)
			: await discoverInstallation(this.#launcher);
		const route: ConfiguredRoute | undefined = before.identity.provider && before.identity.model && before.identity.reasoning
			? { provider: before.identity.provider, model: before.identity.model, reasoning: before.identity.reasoning }
			: undefined;
		if (!route
			|| (!directProfile && before.harnessVersion !== REVIEWED_PI_VERSION)
			|| (!directProfile && "enforcementComplete" in before && !before.enforcementComplete)
			|| before.launcher !== context.doctor.executable
			|| before.binarySha256 !== context.doctor.binarySha256
			|| JSON.stringify(route) !== JSON.stringify(context.doctor.configuredRoute)) {
			throw new Error("Pi trusted-host launcher, reviewed version, enforcement discovery, or route evidence changed after preflight");
		}

		const brief = buildBrief(spec);
		await context.emit("adapter.process.started", {
			tier: "trusted-host",
			mode: writer ? "solo-writer" : "solo-read-only",
			argv: args,
			...(readPolicy ? { readPolicySha256: readPolicy.sha256 } : {}),
			prompt: redactedTextEvidence(brief),
		});
		const result = await runPi(before.launcher, [...args, brief], spec.task.cwd, context, undefined, {}, Boolean(directProfile));
		const stdoutEvidence = result.stdoutEvidence;
		const stderrEvidence = result.stderrEvidence;
		await Promise.all([
			writeFile(join(context.runDirectory, "stdout.log"), `${JSON.stringify(stdoutEvidence, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			}),
			writeFile(join(context.runDirectory, "stderr.log"), `${JSON.stringify(stderrEvidence, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			}),
		]);
		if (result.stderr.length > 0) await context.emit("harness.stderr", { payload: stderrEvidence });

		const notices = [trustedHostResidual(spec)];
		let status: AdapterRunResult["status"] = context.signal.aborted ? "cancelled" : "completed";
		if (!context.signal.aborted && result.blockedMarker) {
			status = "blocked";
			notices.push(`Pi requested controller action with ${result.blockedMarker}.`);
		}
		if (!context.signal.aborted && result.exitCode !== 0) {
			status = "failed";
			notices.push(`Pi exited with status ${result.exitCode ?? "unknown"}.`);
		}
		if (!context.signal.aborted && !result.finalOutput?.trim()) {
			status = "failed";
			notices.push("Pi exited without a final assistant message.");
		}
		if (!context.signal.aborted && result.terminalStopReason !== "stop") {
			status = "failed";
			notices.push(`Pi final assistant message used stop reason ${result.terminalStopReason ?? "missing"}.`);
		}
		if (!context.signal.aborted && !result.agentEnded) {
			status = "failed";
			notices.push("Pi exited without an authoritative agent_end after the final response.");
		}
		if (!context.signal.aborted && !result.agentSettled) {
			status = "failed";
			notices.push("Pi exited without a terminal agent_settled after agent_end.");
		}
		if (result.stdoutTruncated) {
			notices.push("Pi raw stdout retention exceeded 4 MiB; exact full-stream byte/hash evidence was retained and the complete structured stream was parsed.");
		}
		if (result.stderrTruncated) {
			status = "failed";
			notices.push("Pi stderr exceeded the bounded evidence limit.");
		}
		if (result.protocolError) {
			status = "failed";
			notices.push(result.protocolError);
		}
		if (result.backgroundProcessesDetected || !result.processTreeReaped) {
			status = "failed";
			notices.push("Pi left background processes after the guarded launcher exited.");
		}
		if (readPolicy) {
			try {
				await verifyPiReadPolicyExtensionV1(readPolicy.path, readPolicy.sha256);
			} catch {
				status = "failed";
				notices.push("Pi's controller-owned read policy changed during execution.");
			}
		}

		let postRunRoute = route;
		if (!context.signal.aborted) try {
			const after = directProfile
				? await discoverDirectInstallation(directProfile)
				: await discoverInstallation(this.#launcher);
			postRunRoute = after.identity.provider && after.identity.model && after.identity.reasoning
				? { provider: after.identity.provider, model: after.identity.model, reasoning: after.identity.reasoning }
				: route;
			if (after.launcher !== before.launcher
				|| after.binarySha256 !== before.binarySha256
				|| (!directProfile && "enforcementSha256" in after && "enforcementSha256" in before && after.enforcementSha256 !== before.enforcementSha256)
				|| after.harnessVersion !== before.harnessVersion
				|| JSON.stringify(postRunRoute) !== JSON.stringify(route)) {
				status = "failed";
				notices.push("Pi trusted-host launcher, discovered enforcement, version, or route evidence changed during execution.");
			}
		} catch {
			status = "failed";
			notices.push("Pi trusted-host launcher or route evidence could not be verified after execution.");
		}

		return {
			status,
			exitCode: result.exitCode,
			...(result.finalOutput !== undefined ? { finalOutput: result.finalOutput } : {}),
			configuredRoute: postRunRoute,
			usage: {
				providerRequests: result.providerTurns,
				toolCalls: result.toolCallAttempts,
				childrenStarted: 0,
				...(result.reportedCostUsd !== undefined
					? { reportedCostUsdMicros: Math.round(result.reportedCostUsd * 1_000_000) }
					: {}),
				complete: false,
				sources: ["harness"],
				terminationReason: "Trusted-host Pi reports assistant turns, tool-call attempts, and cost after execution; Ox Driver does not enforce a per-run provider or spend ceiling on this tier.",
			},
			notices,
		};
	}

	async run(spec: RunSpec, context: AdapterRunContext): Promise<AdapterRunResult> {
		if (spec.tier === "trusted-host") return this.#runTrustedHost(spec, context);
		if (!this.#enableReadOnlyDispatch
			|| spec.tier !== "attested"
			|| this.#expectedLauncherSha256 === undefined
			|| this.#expectedEnforcementSha256 === undefined
			|| context.doctor.binarySha256 !== this.#expectedLauncherSha256
			|| context.doctor.enforcementSha256 !== this.#expectedEnforcementSha256
			|| context.doctor.probe?.artifact !== "verified"
			|| context.doctor.probe.executionQualified !== true
			|| context.doctor.capabilities["sandbox.filesystem"] !== true
			|| spec.execution.session !== "ephemeral"
			|| spec.execution.topology !== "solo"
			|| spec.execution.writerPolicy !== "read-only"
			|| spec.execution.network !== "configured"
			|| spec.routeProfile !== "pi-protected-inherited") {
			throw new Error("Pi run received a spec or doctor result outside the qualified read-only contract");
		}
		const usefulnessPrepared = this.#usefulnessCase
			? await loadPiUsefulnessCase(this.#usefulnessCase)
			: undefined;
		if (usefulnessPrepared) await validatePiUsefulnessSpec(spec, usefulnessPrepared);
		const usefulnessObserver = usefulnessPrepared ? new PiUsefulnessObserver(usefulnessPrepared) : undefined;
		const readPolicy = await writePiReadPolicyExtensionV1(
			context.runDirectory,
			spec.task.cwd,
			spec.task.excludedPaths,
		);
		const args = piReadOnlyArgs(readPolicy.path);
		const diversion = piCoreDiversion(args);
		if (diversion) throw new Error(`Pi read-only argv would select the unprotected PI_CORE path: ${diversion}`);
		const before = await discoverInstallation(this.#launcher);
		const containmentInspection = await this.#processContainment.inspect();
		const route: ConfiguredRoute | undefined = before.identity.provider && before.identity.model && before.identity.reasoning
			? { provider: before.identity.provider, model: before.identity.model, reasoning: before.identity.reasoning }
			: undefined;
		if (!route
			|| before.launcher !== context.doctor.executable
			|| before.binarySha256 !== context.doctor.binarySha256
			|| before.binarySha256 !== this.#expectedLauncherSha256
			|| !containmentInspection.available
			|| !containmentInspection.mechanismSha256
			|| piDispatchEnforcementSha256(before.enforcementSha256, containmentInspection.mechanismSha256) !== context.doctor.enforcementSha256
			|| context.doctor.enforcementSha256 !== this.#expectedEnforcementSha256
			|| JSON.stringify(route) !== JSON.stringify(context.doctor.configuredRoute)) {
			throw new Error("Pi launcher, enforcement, or route evidence changed after preflight");
			}
			const guardRuntime = await ensurePiGuardRuntimeDirectory(context.runDirectory);
			let credentialBroker: PiCredentialBroker | undefined;
			credentialBroker = await startPiCredentialBroker({
				controllerRoot: context.runDirectory,
			credentialHelper: before.credentialHelper,
			credentialHelperSha256: before.credentialHelperSha256,
			lifetimeMs: Math.min(86_410_000, (spec.execution.timeoutSeconds + 10) * 1_000),
			signal: context.signal,
			});
			try {
			const containment = await this.#processContainment.create({
			inspection: containmentInspection,
			workspaceRoot: spec.task.cwd,
			excludedPaths: spec.task.excludedPaths,
			controllerRoot: context.runDirectory,
			writableRuntime: guardRuntime,
			readPaths: before.containmentReadPaths,
			executable: before.launcher,
			executableSha256: before.binarySha256,
			protectedRouter: before.protectedRouter,
				protectedRouterSha256: before.protectedRouterSha256,
				routeEnforcementSha256: before.enforcementSha256,
				credentialBroker: {
					contractSha256: PI_CREDENTIAL_BROKER_CONTRACT_SHA256,
				socketPath: credentialBroker.socketPath,
				socketDirectory: credentialBroker.socketDirectory,
				socketDirectoryDevice: credentialBroker.socketDirectoryDevice,
				socketDirectoryInode: credentialBroker.socketDirectoryInode,
				socketDevice: credentialBroker.socketDevice,
					socketInode: credentialBroker.socketInode,
					credentialHelper: before.credentialHelper,
					credentialHelperReference: before.credentialHelperReference,
					credentialHelperSha256: before.credentialHelperSha256,
					stagedCredentialHelper: credentialBroker.stagedCredentialHelperPath,
					stagedCredentialHelperSha256: credentialBroker.stagedCredentialHelperSha256,
					nodeInterpreter: before.nodeInterpreter,
					harnessExecutable: before.harnessExecutable,
					harnessExecutableSha256: before.harnessExecutableSha256,
					harnessPackageRoot: before.harnessPackageRoot,
					harnessPackageRootDevice: before.harnessPackageRootDevice,
					harnessPackageRootInode: before.harnessPackageRootInode,
					harnessPackageTreeSha256: before.harnessPackageTreeSha256,
					harnessPackageTreeEntries: before.harnessPackageTreeEntries,
					harnessPackageTreeBytes: before.harnessPackageTreeBytes,
					agentSettings: before.agentSettings,
					agentSettingsSha256: before.agentSettingsSha256,
					agentModels: before.agentModels,
					agentModelsSha256: before.agentModelsSha256,
					provider: route.provider,
					model: route.model,
					reasoning: route.reasoning,
					grepExecutable: before.grepExecutable,
					grepExecutableSha256: before.grepExecutableSha256,
					findExecutable: before.findExecutable,
					findExecutableSha256: before.findExecutableSha256,
				},
			});

		const brief = buildBrief(spec);
		await context.emit("adapter.process.started", {
			argv: [...containment.argsPrefix, containment.executablePath, ...args],
			targetArgv: args,
			readPolicySha256: readPolicy.sha256,
			containmentKind: containment.kind,
			containmentMechanismSha256: containment.mechanismSha256,
			containmentProfileSha256: containment.profileSha256,
			containmentEvidenceSha256: containment.evidenceSha256,
			prompt: redactedTextEvidence(brief),
		});
		const result = await runPi(
			containment.command,
			[...containment.argsPrefix, containment.executablePath, ...args, brief],
			spec.task.cwd,
				context,
				usefulnessObserver,
				credentialBroker.environment,
			);
		const stdoutEvidence = result.stdoutEvidence;
		const stderrEvidence = result.stderrEvidence;
		await Promise.all([
			writeFile(join(context.runDirectory, "stdout.log"), `${JSON.stringify(stdoutEvidence, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			}),
			writeFile(join(context.runDirectory, "stderr.log"), `${JSON.stringify(stderrEvidence, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			}),
		]);
		if (result.stderr.length > 0) {
			await context.emit("harness.stderr", { payload: stderrEvidence });
		}

			const notices = [
				PI_READ_ONLY_RESIDUAL,
				"The controller-side broker prevents direct access to other Keychain items, but does not claim to hide this route's provider key from the admitted Pi harness that must use it.",
			];
		let status: AdapterRunResult["status"] = context.signal.aborted ? "cancelled" : "completed";
		if (!context.signal.aborted && result.blockedMarker) {
			status = "blocked";
			notices.push(`Pi requested controller action with ${result.blockedMarker}.`);
		}
		if (!context.signal.aborted && result.exitCode !== 0) {
			status = "failed";
			notices.push(`Pi exited with status ${result.exitCode ?? "unknown"}.`);
		}
		if (!context.signal.aborted && !result.finalOutput?.trim()) {
			status = "failed";
			notices.push("Pi exited without a final assistant message.");
		}
		if (!context.signal.aborted && result.terminalStopReason !== "stop") {
			status = "failed";
			notices.push(`Pi final assistant message used stop reason ${result.terminalStopReason ?? "missing"}.`);
		}
		if (!context.signal.aborted && !result.agentEnded) {
			status = "failed";
			notices.push("Pi exited without an authoritative agent_end after the final response.");
		}
		if (!context.signal.aborted && !result.agentSettled) {
			status = "failed";
			notices.push("Pi exited without a terminal agent_settled after agent_end.");
		}
		if (result.stdoutTruncated) {
			notices.push("Pi raw stdout retention exceeded 4 MiB; exact full-stream byte/hash evidence was retained and the complete structured stream was parsed.");
		}
		if (result.stderrTruncated) {
			status = "failed";
			notices.push("Pi stderr exceeded the bounded evidence limit.");
		}
		if (result.protocolError) {
			status = "failed";
			notices.push(result.protocolError);
		}
		if (result.backgroundProcessesDetected || !result.processTreeReaped) {
			status = "failed";
			notices.push("Pi left background processes after the guarded launcher exited.");
		}
		let usefulnessDraft: PiUsefulnessObservationDraft | undefined;
		if (usefulnessObserver) {
			try {
				usefulnessDraft = usefulnessObserver.finish();
			} catch {
				status = "failed";
				notices.push("Pi usefulness qualification did not produce a complete controller-observed operation set.");
			}
		}
		try {
			await verifyPiReadPolicyExtensionV1(readPolicy.path, readPolicy.sha256);
		} catch {
			status = "failed";
			notices.push("Pi's controller-owned read policy changed during execution.");
		}
		try {
			await this.#processContainment.verify(containment);
		} catch {
			status = "failed";
			notices.push("Pi's process-bound containment evidence changed during execution.");
		}

		let postRunRoute = route;
		if (!context.signal.aborted) try {
			const after = await discoverInstallation(this.#launcher);
			const afterContainment = await this.#processContainment.inspect();
			postRunRoute = after.identity.provider && after.identity.model && after.identity.reasoning
				? { provider: after.identity.provider, model: after.identity.model, reasoning: after.identity.reasoning }
				: route;
			if (after.launcher !== before.launcher
				|| after.binarySha256 !== before.binarySha256
				|| after.enforcementSha256 !== before.enforcementSha256
				|| afterContainment.mechanismSha256 !== containment.mechanismSha256
				|| JSON.stringify(postRunRoute) !== JSON.stringify(route)) {
				status = "failed";
				notices.push("Pi launcher, enforcement, or route evidence changed during execution.");
			}
		} catch {
			status = "failed";
			notices.push("Pi launcher or enforcement evidence could not be verified after execution.");
		}
			notices.push(`Pi credential broker served ${credentialBroker.successfulRequests()} of at most 2 bounded route-key requests.`);

		if (status === "completed" && usefulnessDraft) this.#usefulnessDrafts.set(context.runId, usefulnessDraft);
		return {
			status,
			exitCode: result.exitCode,
			// Qualification consumes only controller-observed tool frames. Do not
			// retain the model's prose, which can repeat the ephemeral outside path.
			...(!usefulnessObserver && result.finalOutput !== undefined ? { finalOutput: result.finalOutput } : {}),
			configuredRoute: postRunRoute,
			usage: {
				providerRequests: result.providerTurns,
				toolCalls: result.toolCallAttempts,
				childrenStarted: 0,
				...(result.reportedCostUsd !== undefined
					? { reportedCostUsdMicros: Math.round(result.reportedCostUsd * 1_000_000) }
					: {}),
				complete: false,
				sources: ["harness"],
				terminationReason: "Pi events expose assistant turns, tool-call attempts, and reported cost after execution, but not independent transport retry admissions",
			},
				notices,
			};
			} finally {
				await credentialBroker.close();
			}
		}

	async finalizeUsefulnessEvidence(receipt: Readonly<RunReceipt>, runDirectory: string): Promise<PiUsefulnessEvidenceResult | undefined> {
		if (!this.#usefulnessCase) return undefined;
		const draft = this.#usefulnessDrafts.get(receipt.runId);
		this.#usefulnessDrafts.delete(receipt.runId);
		if (!draft) throw new Error("Pi usefulness qualification has no complete controller-observed draft");
		return finalizePiUsefulnessEvidence({
			config: this.#usefulnessCase,
			draft,
			receipt,
			runDirectory,
		});
	}
}

export {
	buildPiEnforcementManifestV2,
	readPiEnforcementManifestV2,
	serializePiEnforcementManifestV2,
	validatePiEnforcementManifestV2,
	verifyPiEnforcementCandidateV2,
	type PiEnforcementArtifactV2,
	type PiEnforcementEntryV2,
	type PiEnforcementManifestEnvelopeV2,
	type PiEnforcementManifestV2,
	type PiEnforcementObjectType,
	type PiEnforcementVerificationV2,
} from "./enforcement-manifest.js";
export {
	createPiExcludedPathManifestV1,
	validatePiExcludedPathManifestV1,
	validatePiPathAgainstExcludedManifest,
	type PiExcludedPathManifestEnvelopeV1,
	type PiExcludedPathManifestV1,
} from "./excluded-paths.js";
export {
	PI_DARWIN_SEATBELT_SHA256,
	PI_DARWIN_SYSTEM_PROFILE_SHA256,
	createPiProcessContainmentLaunch,
	ensurePiGuardRuntimeDirectory,
	inspectPiPackageTree,
	inspectPiProcessContainment,
	piDispatchEnforcementSha256,
	systemPiProcessContainmentProvider,
	validatePiContainmentScope,
	verifyPiProcessContainmentLaunch,
	type PiProcessContainmentInspection,
	type PiProcessContainmentLaunch,
	type PiProcessContainmentProvider,
	type PiPackageTreeInspection,
	type PiPackageTreeLinkEvidence,
} from "./process-containment.js";
export {
	PI_USEFULNESS_EVENT_CONTRACT,
	PiUsefulnessObserver,
	configuredPiUsefulnessCase,
	finalizePiUsefulnessEvidence,
	loadPiUsefulnessCase,
	validatePiUsefulnessSpec,
	type LoadedPiUsefulnessCase,
	type PiUsefulnessCaseConfig,
	type PiUsefulnessEvidenceResult,
	type PiUsefulnessObservation,
	type PiUsefulnessObservationDraft,
} from "./usefulness-observer.js";
