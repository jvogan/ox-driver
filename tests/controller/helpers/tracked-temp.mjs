import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { after } from "node:test";

let privateRoot;

function sameIdentity(left, right) {
	return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

async function inspectPrivateDirectory(path) {
	const status = await lstat(path);
	const owner = process.getuid?.();
	if (!status.isDirectory() || status.isSymbolicLink()
		|| (owner !== undefined && status.uid !== owner)
		|| (status.mode & 0o077) !== 0
		|| await realpath(path) !== path) {
		throw new Error(`tracked test temporary root is not a private stable directory: ${path}`);
	}
	return {
		path,
		dev: status.dev,
		ino: status.ino,
		uid: status.uid,
	};
}

async function ensurePrivateRoot() {
	if (privateRoot) return privateRoot;
	const base = await realpath(process.platform === "win32" ? tmpdir() : "/tmp");
	const path = await mkdtemp(join(base, "oxt-"));
	try {
		if (dirname(path) !== base) {
			throw new Error("tracked test temporary root escaped the configured temporary directory");
		}
		await chmod(path, 0o700);
		privateRoot = await inspectPrivateDirectory(path);
		return privateRoot;
	} catch (error) {
		await rm(path, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

export async function trackedMkdtemp(prefix) {
	if (typeof prefix === "string" && isAbsolute(prefix)) {
		if (dirname(prefix) !== tmpdir()) {
			throw new Error("tracked temporary template must use the configured temporary directory");
		}
		prefix = basename(prefix);
	}
	if (typeof prefix !== "string" || prefix.length === 0 || prefix.includes("/") || prefix.includes("\\")) {
		throw new Error("tracked temporary prefix must be one non-empty path component");
	}
	const root = await ensurePrivateRoot();
	const path = await mkdtemp(join(root.path, prefix));
	await chmod(path, 0o700);
	const status = await lstat(path);
	if (!status.isDirectory() || status.isSymbolicLink() || status.uid !== root.uid
		|| (status.mode & 0o077) !== 0 || await realpath(path) !== path) {
		throw new Error(`tracked temporary directory failed identity checks: ${path}`);
	}
	return path;
}

async function makeOwnedDirectoriesRemovable(path, expectedUid) {
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	} catch (error) {
		if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) return;
		throw error;
	}
	try {
		const status = await handle.stat();
		if (!status.isDirectory() || status.uid !== expectedUid) {
			throw new Error(`tracked test cleanup refused a foreign directory: ${path}`);
		}
		await handle.chmod(0o700);
	} finally {
		await handle.close();
	}

	let entries;
	try {
		entries = await readdir(path, { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) {
		if (entry.isDirectory() && !entry.isSymbolicLink()) {
			await makeOwnedDirectoriesRemovable(join(path, entry.name), expectedUid);
		}
	}
}

async function cleanupPrivateRoot() {
	const expected = privateRoot;
	if (!expected) return;
	privateRoot = undefined;
	let observed;
	try {
		observed = await inspectPrivateDirectory(expected.path);
	} catch (error) {
		if (error.code === "ENOENT") return;
		throw error;
	}
	if (!sameIdentity(observed, expected)) {
		throw new Error(`tracked test cleanup refused a replaced temporary root: ${expected.path}`);
	}
	await makeOwnedDirectoriesRemovable(expected.path, expected.uid);
	const finalStatus = await lstat(expected.path);
	if (!sameIdentity(finalStatus, expected) || !finalStatus.isDirectory() || finalStatus.isSymbolicLink()) {
		throw new Error(`tracked test cleanup refused a changed temporary root: ${expected.path}`);
	}
	await rm(expected.path, { recursive: true, force: false });
}

after(async () => {
	await cleanupPrivateRoot();
});
