import { readdirSync } from "node:fs";
import { join } from "node:path";

function secretName(name: string): boolean {
	const lower = name.toLowerCase();
	return lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".pem") ||
		lower.endsWith(".key") || [
			".netrc", ".npmrc", ".pypirc", ".git-credentials", "auth.json", "credentials.json",
			"id_rsa", "id_ed25519",
		].includes(lower);
}

function secretDirectory(target: string): boolean {
	const normalized = target.toLowerCase();
	const base = normalized.split("/").pop();
	return [".ssh", ".aws", ".gnupg", ".kube", ".codex", ".agents", ".claude", ".azure", ".docker"].includes(base ?? "") ||
		normalized.endsWith("/.config/gh") || normalized.endsWith("/.config/gcloud") ||
		normalized.endsWith("/.config/opencode");
}

export function discoverProjectSecrets(cwd: string): string[] {
	const found: string[] = [];
	const pending = [cwd];
	let visited = 0;
	while (pending.length > 0) {
		const directory = pending.pop() as string;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			visited += 1;
			if (visited > 100_000) throw new Error("project secret scan exceeded 100000 entries");
			const target = join(directory, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (secretDirectory(target)) found.push(target);
				else if (![".git", "node_modules", ".venv", "vendor"].includes(entry.name)) pending.push(target);
			} else if (secretName(entry.name)) {
				found.push(target);
			}
		}
	}
	return found;
}
