import { createHash } from "node:crypto";

export interface RedactedEvidence {
	redacted: true;
	bytes: number;
	sha256: string;
}

function digest(bytes: Buffer): RedactedEvidence {
	return {
		redacted: true,
		bytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

export function redactedTextEvidence(text: string): RedactedEvidence {
	return digest(Buffer.from(text, "utf8"));
}

export function redactedValueEvidence(value: unknown): RedactedEvidence {
	let serialized: string;
	try {
		serialized = JSON.stringify(value) ?? String(value);
	} catch {
		serialized = String(value);
	}
	return redactedTextEvidence(serialized);
}

function finiteNumberTree(value: unknown, depth = 0): unknown {
	if (depth > 8) return undefined;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		const normalized = finiteNumberTree(item, depth + 1);
		if (normalized !== undefined) result[key] = normalized;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
	return value as string[];
}

function messageEvidence(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const message = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const key of ["role", "provider", "model", "stopReason"] as const) {
		if (typeof message[key] === "string") result[key] = message[key];
	}
	const usage = finiteNumberTree(message.usage);
	if (usage !== undefined) result.usage = usage;
	if (Array.isArray(message.content)) {
		result.content = message.content.map((item) => {
			const type = item && typeof item === "object" && !Array.isArray(item)
				? (item as Record<string, unknown>).type
				: undefined;
			return {
				...(typeof type === "string" ? { type } : {}),
				payload: redactedValueEvidence(item),
			};
		});
	}
	result.payload = redactedValueEvidence(message);
	return result;
}

function stateEvidence(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const data = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	if (typeof data.protocolVersion === "number") result.protocolVersion = data.protocolVersion;
	if (typeof data.agentInvoked === "boolean") result.agentInvoked = data.agentInvoked;
	if (typeof data.thinkingLevel === "string") result.thinkingLevel = data.thinkingLevel;
	result.sessionFilePresent = data.sessionFile !== undefined;
	if (data.model && typeof data.model === "object" && !Array.isArray(data.model)) {
		const model = data.model as Record<string, unknown>;
		result.model = {
			...(typeof model.provider === "string" ? { provider: model.provider } : {}),
			...(typeof model.id === "string" ? { id: model.id } : {}),
		};
	}
	const toolNames = stringArray(data.toolNames);
	if (toolNames) result.toolNames = toolNames;
	if (Array.isArray(data.dumpTools)) {
		result.toolNames = data.dumpTools.flatMap((tool) => {
			if (!tool || typeof tool !== "object" || Array.isArray(tool)) return [];
			const name = (tool as Record<string, unknown>).name;
			return typeof name === "string" ? [name] : [];
		});
	}
	if (data.systemPrompt !== undefined) result.systemPrompt = redactedValueEvidence(data.systemPrompt);
	result.payload = redactedValueEvidence(data);
	return result;
}

/**
 * Convert an untrusted harness frame into bounded evidence. Raw model text,
 * hidden reasoning, tool arguments/results, errors, paths, prompts, session
 * identifiers, and signatures are represented only by byte counts and hashes.
 */
export function normalizedHarnessEvent(event: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {
		type: typeof event.type === "string" ? event.type : "unknown",
		payload: redactedValueEvidence(event),
	};
	for (const key of ["protocolVersion", "maxFrameBytes", "maxReassembledFrameBytes"] as const) {
		if (typeof event[key] === "number" && Number.isFinite(event[key])) result[key] = event[key];
	}
	const supported = Array.isArray(event.supportedProtocolVersions)
		? event.supportedProtocolVersions.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
		: undefined;
	if (supported) result.supportedProtocolVersions = supported;
	for (const key of ["command", "method", "toolName", "stopReason"] as const) {
		if (typeof event[key] === "string") result[key] = event[key];
	}
	for (const key of ["success", "isTerminal", "willRetry", "isError"] as const) {
		if (typeof event[key] === "boolean") result[key] = event[key];
	}
	if (event.id !== undefined) result.id = redactedValueEvidence(event.id);
	const message = messageEvidence(event.message);
	if (message) result.message = message;
	const data = stateEvidence(event.data);
	if (data) result.data = data;
	const usage = finiteNumberTree(event.usage);
	if (usage !== undefined) result.usage = usage;
	for (const key of ["assistantMessageEvent", "arguments", "result", "toolResults", "messages", "error"] as const) {
		if (event[key] !== undefined) result[key] = redactedValueEvidence(event[key]);
	}
	const toolCall = event.toolCall && typeof event.toolCall === "object" && !Array.isArray(event.toolCall)
		? event.toolCall as Record<string, unknown>
		: undefined;
	const tool = event.tool && typeof event.tool === "object" && !Array.isArray(event.tool)
		? event.tool as Record<string, unknown>
		: undefined;
	const toolIdentity = [event.toolName, toolCall?.name, tool?.name].find((item) => typeof item === "string");
	if (typeof toolIdentity === "string") result.toolName = toolIdentity;
	return result;
}
