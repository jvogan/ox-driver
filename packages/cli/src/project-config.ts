import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const CONFIG_FILE = "ox-driver.json";
const MAX_CONFIG_BYTES = 256 * 1024;
const RESERVED = new Set(["__proto__", "prototype", "constructor"]);
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SECRET = /(?:\b(?:sk-(?:proj-|ant-)?|gh[pousr]_|github_pat_|hf_)[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[^\s"']{8,})/i;

export interface ProjectWorkPreset {
	route: string;
	ownedPaths: string[];
	excludedPaths: string[];
	checks: string[];
	noCheck?: true;
	reviewer?: { harness: "pi" | "omp"; route: string };
	agent?: string;
	childAgents?: string[];
	timeoutSeconds?: number;
	reportOnlyCostUsdMicros?: number;
	reviewerTimeoutSeconds?: number;
	reviewerReportOnlyCostUsdMicros?: number;
}

export interface LoadedProjectPreset {
	repository: string;
	configPath: string;
	presetName: string;
	preset: ProjectWorkPreset;
}

export interface InitProjectOptions {
	repository?: string;
	presetName?: string;
	route?: string;
	checks?: string[];
	noCheck?: boolean;
	ownedPaths?: string[];
	excludedPaths?: string[];
	reviewer?: "pi" | "omp";
	reviewerRoute?: string;
	agent?: string;
	childAgents?: string[];
	timeoutSeconds?: number;
	reportOnlyCostUsdMicros?: number;
	reviewerTimeoutSeconds?: number;
	reviewerReportOnlyCostUsdMicros?: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	for (const key of Object.keys(value)) {
		if (RESERVED.has(key) || !allowed.includes(key)) throw new Error(`${label} has unsupported field ${key}`);
	}
}

function text(value: unknown, label: string, maxBytes = 4096): string {
	if (typeof value !== "string" || !value || value.trim() !== value
		|| Buffer.byteLength(value, "utf8") > maxBytes || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) {
		throw new Error(`${label} must be a non-empty bounded string without control characters or surrounding whitespace`);
	}
	if (SECRET.test(value)) throw new Error(`${label} must not contain credentials or secret-shaped values`);
	return value;
}

function identifier(value: unknown, label: string): string {
	const result = text(value, label, 128);
	if (!IDENTIFIER.test(result) || RESERVED.has(result)) {
		throw new Error(`${label} must be a canonical lowercase identifier, not a path or credential`);
	}
	return result;
}

function strings(value: unknown, label: string, parse: (value: unknown, label: string) => string, nonempty = false): string[] {
	if (!Array.isArray(value) || value.length > 256 || (nonempty && value.length === 0)) {
		throw new Error(`${label} must be ${nonempty ? "a non-empty" : "a"} bounded array`);
	}
	const result = value.map((item, index) => parse(item, `${label}[${index}]`));
	if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicate values`);
	return result;
}

function scope(value: unknown, label: string): string {
	const path = text(value, label);
	if (path.startsWith("/") || path.includes("\\") || path.includes(":")
		|| path.split("/").includes("..") || /[\t\n\r]/.test(path)) {
		throw new Error(`${label} must be a portable relative path that stays inside the repository`);
	}
	return path;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
	}
	return Number(value);
}

function validatePreset(value: unknown, label: string): ProjectWorkPreset {
	const input = record(value, label);
	keys(input, ["route", "ownedPaths", "excludedPaths", "checks", "noCheck", "reviewer", "agent", "childAgents",
		"timeoutSeconds", "reportOnlyCostUsdMicros", "reviewerTimeoutSeconds", "reviewerReportOnlyCostUsdMicros"], label);
	const checks = strings(input.checks, `${label}.checks`, (value, field) => text(value, field, 16 * 1024));
	if (input.noCheck !== undefined && input.noCheck !== true) throw new Error(`${label}.noCheck must be true when present`);
	if (checks.length === 0 && input.noCheck !== true) throw new Error(`${label} requires checks or explicit noCheck: true`);
	if (checks.length > 0 && input.noCheck === true) throw new Error(`${label}.checks and noCheck are mutually exclusive`);
	const excludedPaths = strings(input.excludedPaths, `${label}.excludedPaths`, scope);
	const result: ProjectWorkPreset = {
		route: identifier(input.route, `${label}.route`),
		ownedPaths: strings(input.ownedPaths, `${label}.ownedPaths`, scope, true),
		excludedPaths: excludedPaths.includes(".env") ? excludedPaths : [".env", ...excludedPaths],
		checks,
		...(input.noCheck === true ? { noCheck: true as const } : {}),
	};
	if (input.reviewer !== undefined) {
		const reviewer = record(input.reviewer, `${label}.reviewer`);
		keys(reviewer, ["harness", "route"], `${label}.reviewer`);
		if (reviewer.harness !== "pi" && reviewer.harness !== "omp") throw new Error(`${label}.reviewer.harness must be pi or omp`);
		result.reviewer = { harness: reviewer.harness, route: identifier(reviewer.route, `${label}.reviewer.route`) };
	}
	if (input.agent !== undefined) result.agent = identifier(input.agent, `${label}.agent`);
	if (input.childAgents !== undefined) {
		result.childAgents = strings(input.childAgents, `${label}.childAgents`, identifier, true);
		if (!result.agent) throw new Error(`${label}.childAgents requires an explicit agent`);
	}
	for (const field of ["timeoutSeconds", "reviewerTimeoutSeconds"] as const) {
		if (input[field] !== undefined) result[field] = integer(input[field], `${label}.${field}`, 1, 86_400);
	}
	for (const field of ["reportOnlyCostUsdMicros", "reviewerReportOnlyCostUsdMicros"] as const) {
		if (input[field] !== undefined) result[field] = integer(input[field], `${label}.${field}`, 0, Number.MAX_SAFE_INTEGER);
	}
	if (!result.reviewer && (result.reviewerTimeoutSeconds !== undefined || result.reviewerReportOnlyCostUsdMicros !== undefined)) {
		throw new Error(`${label} reviewer settings require a reviewer`);
	}
	return result;
}

// JSON.parse discards duplicate keys. Scan the grammar first so a reviewed value
// cannot be silently replaced by a later spelling, including an escaped key.
function parseConfig(source: string): unknown {
	let offset = 0;
	const json = (part: string): unknown => {
		try { return JSON.parse(part) as unknown; }
		catch { throw new Error("project config must contain valid JSON"); }
	};
	const whitespace = (): void => { while (/\s/.test(source[offset] ?? "") && offset < source.length) offset += 1; };
	const string = (): string => {
		const start = offset++;
		while (offset < source.length) {
			const char = source[offset++];
			if (char === "\\") offset += 1;
			else if (char === '"') return json(source.slice(start, offset)) as string;
		}
		throw new Error("unterminated JSON string");
	};
	const value = (depth: number): void => {
		if (depth > 16) throw new Error("project config nesting exceeds 16 levels");
		whitespace();
		const char = source[offset];
		if (char === "{") {
			offset += 1;
			whitespace();
			const seen = new Set<string>();
			if (source[offset] === "}") { offset += 1; return; }
			while (offset < source.length) {
				whitespace();
				if (source[offset] !== '"') throw new Error("JSON object key must be a string");
				const key = string();
				if (seen.has(key)) throw new Error("project config contains a duplicate JSON key");
				if (RESERVED.has(key)) throw new Error("project config contains a reserved JSON key");
				seen.add(key);
				whitespace();
				if (source[offset++] !== ":") throw new Error("JSON object key requires a colon");
				value(depth + 1);
				whitespace();
				const separator = source[offset++];
				if (separator === "}") return;
				if (separator !== ",") throw new Error("invalid JSON object separator");
			}
			throw new Error("unterminated JSON object");
		}
		if (char === "[") {
			offset += 1;
			whitespace();
			if (source[offset] === "]") { offset += 1; return; }
			while (offset < source.length) {
				value(depth + 1);
				whitespace();
				const separator = source[offset++];
				if (separator === "]") return;
				if (separator !== ",") throw new Error("invalid JSON array separator");
			}
			throw new Error("unterminated JSON array");
		}
		if (char === '"') { string(); return; }
		const start = offset;
		while (offset < source.length && !/[\s,}\]]/.test(source[offset]!)) offset += 1;
		if (start === offset) throw new Error("invalid JSON value");
	};
	value(0);
	whitespace();
	if (offset !== source.length) throw new Error("unexpected content after JSON value");
	return json(source);
}

export async function resolveProjectRepository(directory = process.cwd()): Promise<string> {
	const requested = await realpath(resolve(directory));
	if (!(await lstat(requested)).isDirectory()) throw new Error("project repository must be a directory");
	try {
		const { stdout } = await execute("git", ["--no-optional-locks", "-C", requested, "rev-parse", "--show-toplevel"], {
			encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024,
		});
		return await realpath(stdout.trim());
	} catch {
		throw new Error("project commands require a Git repository; run git init or select one with --repo DIR");
	}
}

export async function loadProjectPreset(repository: string, presetName?: string): Promise<LoadedProjectPreset> {
	const root = await resolveProjectRepository(repository);
	const configPath = join(root, CONFIG_FILE);
	let handle;
	try {
		handle = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error("ox-driver.json was not found; run ox-driver init --route ROUTE --check COMMAND (or explicit --no-check)");
		}
		throw new Error("ox-driver.json must be a readable regular file without a symlink", { cause: error });
	}
	let source: string;
	try {
		const status = await handle.stat();
		if (!status.isFile() || status.size > MAX_CONFIG_BYTES || status.size === 0
			|| (process.getuid !== undefined && status.uid !== process.getuid()) || (status.mode & 0o022) !== 0) {
			throw new Error("ox-driver.json must be an owned, non-writable-by-others regular file of 1 to 262144 bytes");
		}
		const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > MAX_CONFIG_BYTES) throw new Error("ox-driver.json exceeds 262144 bytes");
		const after = await handle.stat();
		if (after.size !== status.size || after.mtimeMs !== status.mtimeMs || after.ctimeMs !== status.ctimeMs || bytesRead !== status.size) {
			throw new Error("ox-driver.json changed while reading; retry after the file is stable");
		}
		source = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
	} finally {
		await handle.close();
	}
	const config = record(parseConfig(source), "project config");
	keys(config, ["version", "defaultPreset", "presets"], "project config");
	if (config.version !== 1) throw new Error("project config version must be 1");
	const defaultPreset = identifier(config.defaultPreset, "project config defaultPreset");
	const raw = record(config.presets, "project config presets");
	const names = Object.keys(raw);
	if (names.length === 0 || names.length > 64) throw new Error("project config requires 1 to 64 presets");
	const presets = new Map<string, ProjectWorkPreset>();
	for (const name of names) presets.set(identifier(name, "project preset name"), validatePreset(raw[name], `preset ${name}`));
	if (!presets.has(defaultPreset)) throw new Error("project config defaultPreset must name an existing preset");
	const selected = presetName === undefined ? defaultPreset : identifier(presetName, "requested preset");
	const preset = presets.get(selected);
	if (!preset) throw new Error(`project preset ${selected} was not found; available presets: ${names.join(", ")}`);
	return { repository: root, configPath, presetName: selected, preset };
}

export async function initProject(options: InitProjectOptions): Promise<LoadedProjectPreset> {
	if (!options.route) throw new Error("init requires --route ROUTE; select an installed machine-local route profile");
	if ((options.checks?.length ?? 0) === 0 && options.noCheck !== true) {
		throw new Error("init requires --check COMMAND or explicit --no-check; select the repository acceptance command");
	}
	if (options.reviewerRoute !== undefined && options.reviewer === undefined) throw new Error("--reviewer-route requires --reviewer pi or omp");
	if (options.reviewer !== undefined && !options.reviewerRoute) throw new Error("--reviewer requires an explicit --reviewer-route ROUTE");
	const presetName = identifier(options.presetName ?? "default", "project preset name");
	const preset = validatePreset({
		route: options.route,
		ownedPaths: options.ownedPaths ?? ["."],
		excludedPaths: options.excludedPaths ?? [".env"],
		checks: options.checks ?? [],
		...(options.noCheck === true ? { noCheck: true } : {}),
		...(options.reviewer === undefined ? {} : { reviewer: { harness: options.reviewer, route: options.reviewerRoute } }),
		...Object.fromEntries((["agent", "childAgents", "timeoutSeconds", "reportOnlyCostUsdMicros", "reviewerTimeoutSeconds", "reviewerReportOnlyCostUsdMicros"] as const)
			.filter((field) => options[field] !== undefined).map((field) => [field, options[field]])),
	}, `preset ${presetName}`);
	const repository = await resolveProjectRepository(options.repository);
	const configPath = join(repository, CONFIG_FILE);
	const temporary = join(repository, `.${CONFIG_FILE}.${randomUUID()}.tmp`);
	const body = `${JSON.stringify({ version: 1, defaultPreset: presetName, presets: { [presetName]: preset } }, null, 2)}\n`;
	if (Buffer.byteLength(body, "utf8") > MAX_CONFIG_BYTES) throw new Error("project config exceeds 262144 bytes");
	const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
	try {
		await handle.writeFile(body, "utf8");
		await handle.sync();
		await handle.close();
		try {
			await link(temporary, configPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("ox-driver.json already exists; edit its presets explicitly to preserve the existing configuration");
			throw error;
		}
	} finally {
		await handle.close().catch(() => undefined);
		await unlink(temporary);
	}
	return { repository, configPath, presetName, preset };
}
