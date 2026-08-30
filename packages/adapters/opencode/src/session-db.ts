import { createHash } from "node:crypto";

import type { BudgetUsage, ConfiguredRoute, RunSpec, UsagePrincipal } from "@ox-driver/core";

const SESSION_ID = /^ses_[A-Za-z0-9]+$/;

type Row = Record<string, unknown>;

interface SessionRow {
	kind: "session";
	id: string;
	parentId: string | null;
	directory: string;
	projectId: string;
	agent: string;
	provider: string;
	model: string;
	reasoning: string;
	createdAt: number;
	updatedAt: number;
	providerRequests: number;
	toolCalls: number;
	childrenStarted: number;
	reportedCostUsdMicros: number;
	sessionCostUsdMicros: number;
	missingCostCount: number;
	routeMismatchCount: number;
	terminalReason: string;
	errorCount: number;
	tokensInput: number;
	tokensOutput: number;
	tokensReasoning: number;
	tokensCacheRead: number;
	tokensCacheWrite: number;
	objectiveMatches: boolean;
}

interface TaskRow {
	kind: "task";
	id: string;
	ownerSessionId: string;
	parentSessionId: string;
	childId: string;
	requestedProfile: string;
	requestedProvider: string;
	requestedModel: string;
	status: string;
	truncated: boolean;
	startedAt: number;
	finishedAt: number;
}

export interface OpenCodeDelegationInspection {
	usage: BudgetUsage;
	observedPrimaryProfile: string;
	evidence: {
		version: 1;
		source: "opencode-db-v1";
		rootSessionId: string;
		sha256: string;
		sessions: Array<{
			principalId: string;
			sessionId: string;
			parentPrincipalId?: string;
			taskCallId?: string;
			requestedProfile?: string;
			observedProfile: string;
			route: ConfiguredRoute;
			providerRequests: number;
			toolCalls: number;
			childrenStarted: number;
			reportedCostUsdMicros: number;
			createdAt: number;
			updatedAt: number;
			terminalReason: string;
			outputTruncated?: boolean;
			tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
		}>;
	};
}

function sqlLiteral(value: string): string {
	if (!SESSION_ID.test(value)) throw new Error("OpenCode session id is not canonical");
	return `'${value}'`;
}

export function delegationProbeQuery(): string {
	return `SELECT CASE WHEN
  (SELECT COUNT(*) FROM pragma_table_info('session') WHERE name IN ('id','parent_id','directory','project_id','agent','model','time_created','time_updated','cost','tokens_input','tokens_output','tokens_reasoning','tokens_cache_read','tokens_cache_write'))=14
  AND (SELECT COUNT(*) FROM pragma_table_info('message') WHERE name IN ('id','session_id','time_created','data'))=4
  AND (SELECT COUNT(*) FROM pragma_table_info('part') WHERE name IN ('id','message_id','session_id','time_created','data'))=5
  AND json_extract('{"contract":"opencode-db-v1"}', '$.contract')='opencode-db-v1'
THEN 'opencode-db-v1' ELSE 'unsupported' END AS contract`;
}

function sqlTextLiteral(value: string): string {
	if (value.includes("\0")) throw new Error("OpenCode objective contains a null byte");
	return `'${value.replaceAll("'", "''")}'`;
}

export function delegationEvidenceQuery(rootSessionId: string, objective: string): string {
	const root = sqlLiteral(rootSessionId);
	const storedObjective = sqlTextLiteral(JSON.stringify(objective));
	return `WITH RECURSIVE family(id) AS (
  SELECT ${root}
  UNION
  SELECT child.id FROM session child JOIN family parent ON child.parent_id = parent.id
)
SELECT
  'session' AS kind,
  s.id AS id,
  s.parent_id AS parentId,
  s.directory AS directory,
  s.project_id AS projectId,
  s.agent AS agent,
  json_extract(s.model, '$.providerID') AS provider,
  json_extract(s.model, '$.id') AS model,
  json_extract(s.model, '$.variant') AS reasoning,
  s.time_created AS createdAt,
  s.time_updated AS updatedAt,
  (SELECT COUNT(*) FROM message m WHERE m.session_id=s.id AND json_extract(m.data, '$.role')='assistant') AS providerRequests,
  (SELECT COUNT(*) FROM part p WHERE p.session_id=s.id AND json_extract(p.data, '$.type')='tool') AS toolCalls,
  (SELECT COUNT(*) FROM session c WHERE c.parent_id=s.id) AS childrenStarted,
  (SELECT COALESCE(SUM(CAST(ROUND(json_extract(m.data, '$.cost') * 1000000) AS INTEGER)), 0) FROM message m WHERE m.session_id=s.id AND json_extract(m.data, '$.role')='assistant') AS reportedCostUsdMicros,
  CAST(ROUND(s.cost * 1000000) AS INTEGER) AS sessionCostUsdMicros,
  (SELECT COUNT(*) FROM message m WHERE m.session_id=s.id AND json_extract(m.data, '$.role')='assistant' AND (json_type(m.data, '$.cost') IS NULL OR json_type(m.data, '$.cost') NOT IN ('integer','real') OR json_extract(m.data, '$.cost') < 0)) AS missingCostCount,
  (SELECT COUNT(*) FROM message m WHERE m.session_id=s.id AND json_extract(m.data, '$.role')='assistant' AND (json_extract(m.data, '$.agent') IS NULL OR (json_extract(m.data, '$.agent') != s.agent AND json_extract(m.data, '$.agent') != 'compaction') OR json_extract(m.data, '$.providerID') IS NULL OR json_extract(m.data, '$.providerID') != json_extract(s.model, '$.providerID') OR json_extract(m.data, '$.modelID') IS NULL OR json_extract(m.data, '$.modelID') != json_extract(s.model, '$.id') OR json_extract(m.data, '$.variant') IS NULL OR json_extract(m.data, '$.variant') != json_extract(s.model, '$.variant'))) AS routeMismatchCount,
  (SELECT json_extract(m.data, '$.finish') FROM message m WHERE m.session_id=s.id AND json_extract(m.data, '$.role')='assistant' AND json_extract(m.data, '$.agent')=s.agent ORDER BY m.time_created DESC, m.id DESC LIMIT 1) AS terminalReason,
  (SELECT COUNT(*) FROM message m WHERE m.session_id=s.id AND json_extract(m.data, '$.role')='assistant' AND json_type(m.data, '$.error') IS NOT NULL) AS errorCount,
  s.tokens_input AS tokensInput,
  s.tokens_output AS tokensOutput,
  s.tokens_reasoning AS tokensReasoning,
  s.tokens_cache_read AS tokensCacheRead,
  s.tokens_cache_write AS tokensCacheWrite,
  CASE WHEN s.id=${root} AND (SELECT json_extract(p.data, '$.text') FROM message m JOIN part p ON p.message_id=m.id WHERE m.session_id=s.id AND json_extract(m.data, '$.role')='user' AND json_extract(p.data, '$.type')='text' ORDER BY m.time_created, p.time_created, p.id LIMIT 1)=${storedObjective} THEN 1 ELSE 0 END AS objectiveMatches,
  NULL AS parentSessionId,
  NULL AS childId,
  NULL AS requestedProfile,
  NULL AS requestedProvider,
  NULL AS requestedModel,
  NULL AS status,
  NULL AS truncated,
  NULL AS startedAt,
  NULL AS finishedAt
FROM session s JOIN family f ON f.id=s.id
UNION ALL
SELECT
  'task' AS kind,
  json_extract(p.data, '$.callID') AS id,
  p.session_id AS parentId, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL,
  json_extract(p.data, '$.state.metadata.parentSessionId') AS parentSessionId,
  json_extract(p.data, '$.state.metadata.sessionId') AS childId,
  json_extract(p.data, '$.state.input.subagent_type') AS requestedProfile,
  json_extract(p.data, '$.state.metadata.model.providerID') AS requestedProvider,
  json_extract(p.data, '$.state.metadata.model.modelID') AS requestedModel,
  json_extract(p.data, '$.state.status') AS status,
  json_extract(p.data, '$.state.metadata.truncated') AS truncated,
  json_extract(p.data, '$.state.time.start') AS startedAt,
  json_extract(p.data, '$.state.time.end') AS finishedAt
FROM part p JOIN family f ON f.id=p.session_id
WHERE json_extract(p.data, '$.type')='tool' AND json_extract(p.data, '$.tool')='task'
ORDER BY kind, id`;
}

function object(value: unknown, label: string): Row {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Row;
}

function text(row: Row, key: string): string {
	const value = row[key];
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`OpenCode DB evidence ${key} is invalid`);
	return value;
}

function integer(row: Row, key: string): number {
	const value = row[key];
	if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`OpenCode DB evidence ${key} is invalid`);
	return Number(value);
}

function parseSession(row: Row): SessionRow {
	const id = text(row, "id");
	if (!SESSION_ID.test(id)) throw new Error("OpenCode DB evidence contains a noncanonical session id");
	const parent = row.parentId;
	if (parent !== null && (typeof parent !== "string" || !SESSION_ID.test(parent))) throw new Error(`OpenCode session ${id} has an invalid parent`);
	const result: SessionRow = {
		kind: "session",
		id,
		parentId: parent,
		directory: text(row, "directory"),
		projectId: text(row, "projectId"),
		agent: text(row, "agent"),
		provider: text(row, "provider"),
		model: text(row, "model"),
		reasoning: text(row, "reasoning"),
		createdAt: integer(row, "createdAt"),
		updatedAt: integer(row, "updatedAt"),
		providerRequests: integer(row, "providerRequests"),
		toolCalls: integer(row, "toolCalls"),
		childrenStarted: integer(row, "childrenStarted"),
		reportedCostUsdMicros: integer(row, "reportedCostUsdMicros"),
		sessionCostUsdMicros: integer(row, "sessionCostUsdMicros"),
		missingCostCount: integer(row, "missingCostCount"),
		routeMismatchCount: integer(row, "routeMismatchCount"),
		terminalReason: text(row, "terminalReason"),
		errorCount: integer(row, "errorCount"),
		tokensInput: integer(row, "tokensInput"),
		tokensOutput: integer(row, "tokensOutput"),
		tokensReasoning: integer(row, "tokensReasoning"),
		tokensCacheRead: integer(row, "tokensCacheRead"),
		tokensCacheWrite: integer(row, "tokensCacheWrite"),
		objectiveMatches: row.objectiveMatches === true || row.objectiveMatches === 1,
	};
	if (result.updatedAt < result.createdAt) throw new Error(`OpenCode session ${id} has inverted timestamps`);
	if (result.providerRequests < 1 || result.terminalReason !== "stop" || result.errorCount !== 0) throw new Error(`OpenCode session ${id} is not terminally complete`);
	if (result.missingCostCount !== 0 || result.routeMismatchCount !== 0) throw new Error(`OpenCode session ${id} has incomplete or drifting message evidence`);
	if (Math.abs(result.sessionCostUsdMicros - result.reportedCostUsdMicros) > result.providerRequests) {
		throw new Error(`OpenCode session ${id} cost does not reconcile`);
	}
	return result;
}

function parseTask(row: Row): TaskRow {
	const id = text(row, "id");
	const parentSessionId = text(row, "parentSessionId");
	const childId = text(row, "childId");
	if (!SESSION_ID.test(parentSessionId) || !SESSION_ID.test(childId)) throw new Error(`OpenCode task ${id} has invalid session lineage`);
	if (![true, false, 0, 1].includes(row.truncated as boolean | number)) throw new Error(`OpenCode task ${id} lacks a truncation verdict`);
	return {
		kind: "task",
		id,
		ownerSessionId: text(row, "parentId"),
		parentSessionId,
		childId,
		requestedProfile: text(row, "requestedProfile"),
		requestedProvider: text(row, "requestedProvider"),
		requestedModel: text(row, "requestedModel"),
		status: text(row, "status"),
		truncated: row.truncated === true || row.truncated === 1,
		startedAt: integer(row, "startedAt"),
		finishedAt: integer(row, "finishedAt"),
	};
}

function routesEqual(left: ConfiguredRoute, right: ConfiguredRoute): boolean {
	return left.provider === right.provider && left.model === right.model && left.reasoning === right.reasoning;
}

export function inspectDelegationEvidence(input: {
	firstJson: string;
	secondJson: string;
	rootSessionId: string;
	processStartedAt: number;
	processFinishedAt: number;
	spec: RunSpec;
	primaryProfile: string;
	primaryRoute: ConfiguredRoute;
	stream: { providerRequests: number; toolCalls: number; taskCalls: number; reportedCostUsdMicros: number };
}): OpenCodeDelegationInspection {
	if (input.firstJson.trim() !== input.secondJson.trim()) throw new Error("OpenCode delegation evidence changed between stable DB reads");
	let parsed: unknown;
	try { parsed = JSON.parse(input.firstJson); } catch { throw new Error("OpenCode delegation DB output is not valid JSON"); }
	if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("OpenCode delegation DB output is empty");
	const sessions: SessionRow[] = [];
	const tasks: TaskRow[] = [];
	for (const [index, value] of parsed.entries()) {
		const row = object(value, `OpenCode DB row ${index}`);
		if (row.kind === "session") sessions.push(parseSession(row));
		else if (row.kind === "task") tasks.push(parseTask(row));
		else throw new Error(`OpenCode DB row ${index} has an unknown kind`);
	}
	const byId = new Map<string, SessionRow>();
	for (const session of sessions) {
		if (byId.has(session.id)) throw new Error(`OpenCode delegation evidence duplicates session ${session.id}`);
		byId.set(session.id, session);
	}
	const root = byId.get(input.rootSessionId);
	if (!root || root.parentId !== null) throw new Error("OpenCode root session is missing or has a parent");
	if (root.directory !== input.spec.task.cwd || !root.objectiveMatches) {
		throw new Error("OpenCode root session task binding drifted");
	}
	if (root.createdAt < input.processStartedAt || root.updatedAt > input.processFinishedAt + 5_000) throw new Error("OpenCode root session falls outside this process lifetime");
	if (root.agent !== input.primaryProfile) throw new Error("OpenCode primary agent profile drifted");
	const rootRoute = { provider: root.provider, model: root.model, reasoning: root.reasoning };
	if (!routesEqual(rootRoute, input.primaryRoute)) throw new Error("OpenCode primary DB route drifted");
	if (root.providerRequests !== input.stream.providerRequests || root.toolCalls !== input.stream.toolCalls
		|| tasks.filter((task) => task.parentSessionId === root.id).length !== input.stream.taskCalls
		|| root.reportedCostUsdMicros !== input.stream.reportedCostUsdMicros) {
		throw new Error("OpenCode primary stream counters do not reconcile to DB evidence");
	}
	const taskIds = new Set<string>();
	const childIds = new Set<string>();
	const taskByChild = new Map<string, TaskRow>();
	for (const task of tasks) {
		if (taskIds.has(task.id) || childIds.has(task.childId)) throw new Error("OpenCode delegation task evidence is duplicated");
		taskIds.add(task.id);
		childIds.add(task.childId);
		taskByChild.set(task.childId, task);
		if (task.status !== "completed" || task.startedAt > task.finishedAt) throw new Error(`OpenCode task ${task.id} did not complete`);
		if (task.ownerSessionId !== task.parentSessionId) throw new Error(`OpenCode task ${task.id} is not owned by its declared parent session`);
	}
	const children = sessions.filter((session) => session.id !== root.id);
	if (children.length !== tasks.length || root.childrenStarted !== children.length) {
		throw new Error("OpenCode flat run did not produce one complete task receipt per child session");
	}
	const childPolicy = input.spec.execution.childPolicy;
	if (!childPolicy) throw new Error("OpenCode flat run lacks a child policy");
	const principals: UsagePrincipal[] = [{
		id: "primary",
		role: "primary",
		providerRequests: root.providerRequests,
		toolCalls: root.toolCalls,
		childrenStarted: root.childrenStarted,
		reportedCostUsdMicros: root.reportedCostUsdMicros,
	}];
	const evidenceSessions: OpenCodeDelegationInspection["evidence"]["sessions"] = [{
		principalId: "primary",
		sessionId: root.id,
		observedProfile: root.agent,
		route: rootRoute,
		providerRequests: root.providerRequests,
		toolCalls: root.toolCalls,
		childrenStarted: root.childrenStarted,
		reportedCostUsdMicros: root.reportedCostUsdMicros,
		createdAt: root.createdAt,
		updatedAt: root.updatedAt,
		terminalReason: root.terminalReason,
		tokens: { input: root.tokensInput, output: root.tokensOutput, reasoning: root.tokensReasoning, cacheRead: root.tokensCacheRead, cacheWrite: root.tokensCacheWrite },
	}];
	for (const child of children) {
		const task = taskByChild.get(child.id);
		if (!task || child.parentId !== root.id || task.parentSessionId !== root.id) throw new Error(`OpenCode child ${child.id} has incomplete parent lineage`);
		if (child.directory !== root.directory || child.projectId !== root.projectId) throw new Error(`OpenCode child ${child.id} escaped the root workspace identity`);
		// OpenCode persists the child session and task state in separate writes.
		// A small symmetric tolerance covers the observed 1-2 ms ordering skew
		// without accepting a child outside the task's actual lifetime.
		if (child.createdAt < task.startedAt - 5_000 || child.updatedAt > task.finishedAt + 5_000) throw new Error(`OpenCode child ${child.id} timestamps do not fit its task call`);
		if (child.childrenStarted !== 0 || tasks.some((candidate) => candidate.parentSessionId === child.id)) throw new Error(`OpenCode flat child ${child.id} started a grandchild`);
		if (task.requestedProfile !== child.agent || !childPolicy.allowedProfiles.includes(task.requestedProfile)) throw new Error(`OpenCode child ${child.id} used an unadmitted agent profile`);
		const observedRoute = { provider: child.provider, model: child.model, reasoning: child.reasoning };
		if (task.requestedProvider !== observedRoute.provider || task.requestedModel !== observedRoute.model
			|| !childPolicy.allowedRoutes.some((route) => routesEqual(route, observedRoute))) {
			throw new Error(`OpenCode child ${child.id} used an unadmitted route`);
		}
		principals.push({
			id: child.id,
			role: "child",
			parentId: "primary",
			requestedProfile: task.requestedProfile,
			observedProfile: child.agent,
			requestedRoute: observedRoute,
			observedRoute,
			providerRequests: child.providerRequests,
			toolCalls: child.toolCalls,
			childrenStarted: 0,
			reportedCostUsdMicros: child.reportedCostUsdMicros,
		});
		evidenceSessions.push({
			principalId: child.id,
			sessionId: child.id,
			parentPrincipalId: "primary",
			taskCallId: task.id,
			requestedProfile: task.requestedProfile,
			observedProfile: child.agent,
			route: observedRoute,
			providerRequests: child.providerRequests,
			toolCalls: child.toolCalls,
			childrenStarted: 0,
			reportedCostUsdMicros: child.reportedCostUsdMicros,
			createdAt: child.createdAt,
			updatedAt: child.updatedAt,
			terminalReason: child.terminalReason,
			...(task.truncated ? { outputTruncated: true } : {}),
			tokens: { input: child.tokensInput, output: child.tokensOutput, reasoning: child.tokensReasoning, cacheRead: child.tokensCacheRead, cacheWrite: child.tokensCacheWrite },
		});
	}
	const aggregate = principals.reduce((total, principal) => ({
		providerRequests: total.providerRequests + principal.providerRequests,
		toolCalls: total.toolCalls + principal.toolCalls,
		childrenStarted: total.childrenStarted + principal.childrenStarted,
		reportedCostUsdMicros: total.reportedCostUsdMicros + (principal.reportedCostUsdMicros ?? 0),
	}), { providerRequests: 0, toolCalls: 0, childrenStarted: 0, reportedCostUsdMicros: 0 });
	const canonical = `${input.firstJson.trim()}\n`;
	return {
		usage: {
			...aggregate,
			complete: true,
			sources: ["harness"],
			principals,
			terminationReason: "OpenCode live JSON and two stable official DB metadata reads reconciled the complete flat session family.",
		},
		observedPrimaryProfile: root.agent,
		evidence: {
			version: 1,
			source: "opencode-db-v1",
			rootSessionId: root.id,
			sha256: createHash("sha256").update(canonical).digest("hex"),
			sessions: evidenceSessions,
		},
	};
}
