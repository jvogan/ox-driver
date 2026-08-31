import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { OpenCodeAdapter } from "../../packages/adapters/opencode/dist/index.js";
import { inspectDelegationEvidence } from "../../packages/adapters/opencode/dist/session-db.js";
import { AdapterRegistry, OxController, RunStore } from "../../packages/core/dist/index.js";
import { trackedMkdtemp } from "./helpers/tracked-temp.mjs";

const execFileAsync = promisify(execFile);

async function launcherFixture({ delegates = false, databaseEvidence = false, nativeTask = true, childWritable = false, unboundText = false } = {}) {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-driver-opencode-profile-launcher-"));
	const launcher = join(root, "opencode");
	await writeFile(launcher, `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --version) printf '%s\n' 'opencode 1.2.3'; exit 0 ;;
  doctor) printf '%s\n' 'generic route contract ready'; exit 0 ;;
  debug)
    [ "\${2:-}" = agent ] || exit 23
    [ -n "\${3:-}" ] || exit 24
    if [ "\${3:-}" = builder-a ]; then
      printf '%s\n' '{"name":"builder-a","tools":{"task":${nativeTask ? "true" : "false"}}}'
    else
      printf '{"name":"%s","tools":{"task":false,"write":${childWritable ? "true" : "false"},"edit":false,"bash":false}}\n' "\${3}"
    fi
    exit 0
    ;;
  db)
    ${databaseEvidence ? ":" : "exit 22"}
    if [[ "\${2:-}" == *"pragma_table_info"* ]]; then
      printf '%s\n' '[{"contract":"opencode-db-v1"}]'
      exit 0
    fi
    ${databaseEvidence ? "cat \"$PWD/opencode-db-evidence.json\"; exit 0" : "exit 22"}
    ;;
esac
[ "\${1:-}" = run ] || exit 20
original="$*"
shift
task_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir) task_dir="$2"; shift 2 ;;
    --agent|--model|--variant|--format) shift 2 ;;
    --auto) shift ;;
    *) shift ;;
  esac
done
[ -n "$task_dir" ] || exit 21
printf '%s\n' "$original" > "$task_dir/argv.txt"
printf '%s\n' 'fixture output' > "$task_dir/result.txt"
${databaseEvidence ? `now="$(node -e 'process.stdout.write(String(Date.now()))')"
cat > "$task_dir/opencode-db-evidence.json" <<EOF
[
  {"kind":"session","id":"ses_ROOT123","parentId":null,"directory":"$task_dir","projectId":"project-fixture","agent":"builder-a","provider":"provider-a","model":"model-a","reasoning":"max","createdAt":$now,"updatedAt":$now,"providerRequests":2,"toolCalls":2,"childrenStarted":1,"reportedCostUsdMicros":3000,"sessionCostUsdMicros":3000,"missingCostCount":0,"routeMismatchCount":0,"terminalReason":"stop","errorCount":0,"tokensInput":100,"tokensOutput":20,"tokensReasoning":30,"tokensCacheRead":40,"tokensCacheWrite":0,"objectiveMatches":1,"parentSessionId":null,"childId":null,"requestedProfile":null,"requestedProvider":null,"requestedModel":null,"status":null,"truncated":null,"startedAt":null,"finishedAt":null},
  {"kind":"session","id":"ses_CHILD456","parentId":"ses_ROOT123","directory":"$task_dir","projectId":"project-fixture","agent":"reviewer-a","provider":"provider-a","model":"model-a","reasoning":"max","createdAt":$now,"updatedAt":$now,"providerRequests":1,"toolCalls":1,"childrenStarted":0,"reportedCostUsdMicros":500,"sessionCostUsdMicros":500,"missingCostCount":0,"routeMismatchCount":0,"terminalReason":"stop","errorCount":0,"tokensInput":50,"tokensOutput":10,"tokensReasoning":5,"tokensCacheRead":0,"tokensCacheWrite":0,"objectiveMatches":0,"parentSessionId":null,"childId":null,"requestedProfile":null,"requestedProvider":null,"requestedModel":null,"status":null,"truncated":null,"startedAt":null,"finishedAt":null},
  {"kind":"task","id":"call_TASK789","parentId":"ses_ROOT123","directory":null,"projectId":null,"agent":null,"provider":null,"model":null,"reasoning":null,"createdAt":null,"updatedAt":null,"providerRequests":null,"toolCalls":null,"childrenStarted":null,"reportedCostUsdMicros":null,"sessionCostUsdMicros":null,"missingCostCount":null,"routeMismatchCount":null,"terminalReason":null,"errorCount":null,"tokensInput":null,"tokensOutput":null,"tokensReasoning":null,"tokensCacheRead":null,"tokensCacheWrite":null,"objectiveMatches":null,"parentSessionId":"ses_ROOT123","childId":"ses_CHILD456","requestedProfile":"reviewer-a","requestedProvider":"provider-a","requestedModel":"model-a","status":"completed","truncated":false,"startedAt":$now,"finishedAt":$now}
]
EOF
` : ""}
printf '%s\n' \
  '{"type":"step_start","sessionID":"ses_ROOT123","part":{"sessionID":"ses_ROOT123","type":"step-start"}}' \
${unboundText ? "  '{\"type\":\"text\",\"part\":{\"type\":\"text\",\"text\":\"unbound injected prose\"}}' \\\n" : ""}  '{"type":"text","sessionID":"ses_ROOT123","part":{"sessionID":"ses_ROOT123","type":"text","text":"fixture complete"}}' \
${delegates ? "  '{\"type\":\"tool_use\",\"sessionID\":\"ses_ROOT123\",\"part\":{\"sessionID\":\"ses_ROOT123\",\"type\":\"tool\",\"tool\":\"task\"}}' \\\n" : ""}  '{"type":"tool_use","sessionID":"ses_ROOT123","part":{"sessionID":"ses_ROOT123","type":"tool","tool":"write"}}' \
  '{"type":"step_finish","sessionID":"ses_ROOT123","part":{"sessionID":"ses_ROOT123","type":"step-finish","reason":"tool-calls","cost":0.001}}' \
  '{"type":"step_start","sessionID":"ses_ROOT123","part":{"sessionID":"ses_ROOT123","type":"step-start"}}' \
  '{"type":"text","sessionID":"ses_ROOT123","part":{"sessionID":"ses_ROOT123","type":"text","text":"fixture complete"}}' \
  '{"type":"step_finish","sessionID":"ses_ROOT123","part":{"sessionID":"ses_ROOT123","type":"step-finish","reason":"stop","cost":0.002}}'
`, { mode: 0o700 });
	await chmod(launcher, 0o700);
	return launcher;
}

function profile(id, launcher, provider, model, reasoning, agent) {
	return {
		version: 1,
		id,
		status: "active",
		harness: "opencode",
		tier: "trusted-host",
		launcher: {
			command: launcher,
			versionArgs: ["--version"],
			doctor: { args: ["doctor"], requiredText: ["generic route contract ready"] },
		},
		route: { source: "explicit", provider, model, reasoning },
		agent: { defaultProfile: agent, allowedProfiles: [agent] },
		pricingPolicy: "report-only",
		credentialPolicy: "harness-managed",
		filePath: `/profiles/${id}.json`,
		sha256: id === "route-a" ? "a".repeat(64) : "b".repeat(64),
	};
}

function spec(cwd, profileId, agent) {
	return {
		version: 1,
		tier: "trusted-host",
		harness: "opencode",
		routeProfile: profileId,
		task: { objective: "Create result.txt", cwd, ownedPaths: ["."], excludedPaths: [".git", ".env"] },
		execution: {
			session: "new",
			agentProfile: agent,
			topology: "solo",
			writerPolicy: "one-writer",
			network: "configured",
			timeoutSeconds: 30,
			reportOnlyCostUsdMicros: 50_000,
		},
		acceptance: { commands: [], requireCleanUnownedPaths: true },
	};
}

async function runProfile(routeProfile) {
	const cwd = await trackedMkdtemp(join(tmpdir(), `ox-driver-${routeProfile.id}-project-`));
	await execFileAsync("git", ["init", "--quiet"], { cwd });
	const stateRoot = await trackedMkdtemp(join(tmpdir(), `ox-driver-${routeProfile.id}-state-`));
	const adapter = new OpenCodeAdapter({ profile: routeProfile });
	const doctor = await adapter.doctor();
	assert.equal(doctor.probe.modelCalls, 0);
	assert.equal(doctor.probe.executionQualified, true);
	assert.equal(doctor.capabilities["approval.bridge"], false);
	const registry = new AdapterRegistry();
	registry.register(adapter);
	const receipt = await new OxController(registry, new RunStore(stateRoot, join(stateRoot, "leases")))
		.run(spec(cwd, routeProfile.id, routeProfile.agent.defaultProfile));
	return { cwd, receipt };
}

async function runFlatProfile(routeProfile) {
	const cwd = await trackedMkdtemp(join(tmpdir(), `ox-driver-${routeProfile.id}-flat-project-`));
	await execFileAsync("git", ["init", "--quiet"], { cwd });
	const stateRoot = await trackedMkdtemp(join(tmpdir(), `ox-driver-${routeProfile.id}-flat-state-`));
	const adapter = new OpenCodeAdapter({ profile: routeProfile });
	const registry = new AdapterRegistry();
	registry.register(adapter);
	const input = spec(cwd, routeProfile.id, routeProfile.agent.defaultProfile);
	input.execution.topology = "flat";
	input.execution.childPolicy = {
		allowedProfiles: ["reviewer-a"],
		allowedRoutes: [{ provider: "provider-a", model: "model-a", reasoning: "max" }],
	};
	const receipt = await new OxController(registry, new RunStore(stateRoot, join(stateRoot, "leases"))).run(input);
	return { cwd, stateRoot, receipt };
}

test("dispatches two explicit generic OpenCode profiles with exact independent routes", async () => {
	const launcher = await launcherFixture();
	const first = await runProfile(profile("route-a", launcher, "provider-a", "model-a", "max", "builder-a"));
	const second = await runProfile(profile("route-b", launcher, "provider-b", "model-b", "high", "builder-b"));
	assert.deepEqual(first.receipt.configuredRoute, { provider: "provider-a", model: "model-a", reasoning: "max" });
	assert.deepEqual(second.receipt.configuredRoute, { provider: "provider-b", model: "model-b", reasoning: "high" });
	assert.equal(first.receipt.status, "completed");
	assert.equal(second.receipt.status, "completed");
	assert.equal(first.receipt.routeProfileSha256, "a".repeat(64));
	assert.equal(first.receipt.harnessEnforcementSha256, undefined);
	assert.equal(first.receipt.agentIdentity.observedProfile, undefined);
	assert.equal(first.receipt.agentIdentity.configuredProfile, "builder-a");
	const firstArgv = await import("node:fs/promises").then((fs) => fs.readFile(join(first.cwd, "argv.txt"), "utf8"));
	const secondArgv = await import("node:fs/promises").then((fs) => fs.readFile(join(second.cwd, "argv.txt"), "utf8"));
	assert.match(firstArgv, /--agent builder-a/);
	assert.match(firstArgv, /--model provider-a\/model-a --variant max/);
	assert.match(firstArgv, /--auto/);
	assert.match(secondArgv, /--agent builder-b/);
	assert.match(secondArgv, /--model provider-b\/model-b --variant high/);
});

test("rejects wrong profile boundaries and leaves launcher-derived routes unqualified", async () => {
	const launcher = await launcherFixture();
	const active = profile("route-a", launcher, "provider-a", "model-a", "max", "builder-a");
	assert.throws(() => new OpenCodeAdapter({ profile: { ...active, status: "retired" } }), /must be active/);
	assert.throws(() => new OpenCodeAdapter({ profile: { ...active, harness: "pi" } }), /targets pi/);
	assert.throws(() => new OpenCodeAdapter({ profile: { ...active, tier: "attested" } }), /trusted-host/);
	const derived = { ...active, route: { source: "launcher" } };
	const doctor = await new OpenCodeAdapter({ profile: derived }).doctor();
	assert.equal(doctor.probe.executionQualified, false);
	assert.equal(doctor.configuredRoute, undefined);
});

test("enforces the route profile agent allowlist", async () => {
	const launcher = await launcherFixture();
	const routeProfile = profile("route-a", launcher, "provider-a", "model-a", "max", "builder-a");
	const adapter = new OpenCodeAdapter({ profile: routeProfile });
	const cwd = await trackedMkdtemp(join(tmpdir(), "ox-driver-opencode-agent-policy-"));
	const issues = await adapter.preflight(spec(cwd, routeProfile.id, "unlisted-agent"), await adapter.doctor());
	assert.ok(issues.some((issue) => issue.code === "OPENCODE_AGENT_NOT_ALLOWED"));
});

test("refuses to misreport delegated OpenCode work as a solo run", async () => {
	const launcher = await launcherFixture({ delegates: true });
	const result = await runProfile(profile("route-a", launcher, "provider-a", "model-a", "max", "builder-a"));
	assert.equal(result.receipt.status, "failed");
	assert.match(result.receipt.notices.join("\n"), /cannot claim complete child lineage/);
});

test("completes a flat OpenCode run only with stable exact child subreceipts", async () => {
	const launcher = await launcherFixture({ delegates: true, databaseEvidence: true });
	const result = await runFlatProfile(profile("route-a", launcher, "provider-a", "model-a", "max", "builder-a"));
	assert.equal(result.receipt.status, "completed");
	assert.equal(result.receipt.usage.childrenStarted, 1);
	assert.equal(result.receipt.usage.providerRequests, 3);
	assert.equal(result.receipt.usage.toolCalls, 3);
	assert.equal(result.receipt.usage.reportedCostUsdMicros, 3500);
	assert.equal(result.receipt.usage.principals.length, 2);
	assert.equal(result.receipt.usage.principals[1].observedProfile, "reviewer-a");
	assert.deepEqual(result.receipt.usage.principals[1].observedRoute, { provider: "provider-a", model: "model-a", reasoning: "max" });
	assert.equal(result.receipt.agentIdentity.observedProfile, "builder-a");
	const evidence = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(join(result.stateRoot, result.receipt.eventsPath.replace("events.jsonl", "artifacts/opencode-delegation.json")), "utf8")));
	assert.equal(evidence.source, "opencode-db-v1");
	assert.equal(evidence.sessions.length, 2);
});

test("keeps solo usable when a launcher lacks DB receipts and blocks flat preflight", async () => {
	const launcher = await launcherFixture();
	const routeProfile = profile("route-a", launcher, "provider-a", "model-a", "max", "builder-a");
	const adapter = new OpenCodeAdapter({ profile: routeProfile });
	const cwd = await trackedMkdtemp(join(tmpdir(), "ox-driver-opencode-no-db-"));
	await execFileAsync("git", ["init", "--quiet"], { cwd });
	const doctor = await adapter.doctor();
	assert.equal(doctor.capabilities["agents.children"], false);
	const input = spec(cwd, routeProfile.id, "builder-a");
	input.execution.topology = "flat";
	input.execution.childPolicy = { allowedProfiles: ["reviewer-a"], allowedRoutes: [{ provider: "provider-a", model: "model-a", reasoning: "max" }] };
	const registry = new AdapterRegistry();
	registry.register(adapter);
	const stateRoot = await trackedMkdtemp(join(tmpdir(), "ox-driver-opencode-no-db-state-"));
	const preflight = await new OxController(registry, new RunStore(stateRoot, join(stateRoot, "leases"))).preflight(input);
	assert.equal(preflight.ok, false);
	assert.ok(preflight.issues.some((issue) => issue.code === "CAPABILITY_UNAVAILABLE" && issue.message.includes("agents.children")));
});

test("blocks flat delegation before dispatch when the selected primary lacks the native task tool", async () => {
	const launcher = await launcherFixture({ databaseEvidence: true, nativeTask: false });
	const routeProfile = profile("route-a", launcher, "provider-a", "model-a", "max", "builder-a");
	const adapter = new OpenCodeAdapter({ profile: routeProfile });
	const cwd = await trackedMkdtemp(join(tmpdir(), "ox-driver-opencode-no-task-"));
	await execFileAsync("git", ["init", "--quiet"], { cwd });
	const input = spec(cwd, routeProfile.id, "builder-a");
	input.execution.topology = "flat";
	input.execution.childPolicy = { allowedProfiles: ["reviewer-a"], allowedRoutes: [{ provider: "provider-a", model: "model-a", reasoning: "max" }] };
	const issues = await adapter.preflight(input, await adapter.doctor());
	assert.ok(issues.some((issue) => issue.code === "OPENCODE_NATIVE_TASK_REQUIRED"));
});

test("rejects a raw flat spec that authorizes child route drift before dispatch", async () => {
	const launcher = await launcherFixture({ databaseEvidence: true });
	const routeProfile = profile("route-a", launcher, "provider-a", "model-a", "max", "builder-a");
	const adapter = new OpenCodeAdapter({ profile: routeProfile });
	const cwd = await trackedMkdtemp(join(tmpdir(), "ox-driver-opencode-child-route-drift-"));
	const input = spec(cwd, routeProfile.id, "builder-a");
	input.execution.topology = "flat";
	input.execution.childPolicy = { allowedProfiles: ["reviewer-a"], allowedRoutes: [{ provider: "provider-a", model: "model-a", reasoning: "high" }] };
	const issues = await adapter.preflight(input, await adapter.doctor());
	assert.ok(issues.some((issue) => issue.code === "OPENCODE_CHILD_ROUTE_INHERITANCE_REQUIRED"));
});

test("rejects a direct-write child profile from a shared one-writer run", async () => {
	const launcher = await launcherFixture({ databaseEvidence: true, childWritable: true });
	const routeProfile = profile("route-a", launcher, "provider-a", "model-a", "max", "builder-a");
	const adapter = new OpenCodeAdapter({ profile: routeProfile });
	const cwd = await trackedMkdtemp(join(tmpdir(), "ox-driver-opencode-child-writer-"));
	const input = spec(cwd, routeProfile.id, "builder-a");
	input.execution.topology = "flat";
	input.execution.childPolicy = { allowedProfiles: ["reviewer-a"], allowedRoutes: [{ provider: "provider-a", model: "model-a", reasoning: "max" }] };
	const issues = await adapter.preflight(input, await adapter.doctor());
	assert.ok(issues.some((issue) => issue.code === "OPENCODE_CHILD_WRITER_UNQUALIFIED"));
});

test("fails flat receipts when structured prose is not bound to the root session", async () => {
	const launcher = await launcherFixture({ delegates: true, databaseEvidence: true, unboundText: true });
	const result = await runFlatProfile(profile("route-a", launcher, "provider-a", "model-a", "max", "builder-a"));
	assert.equal(result.receipt.status, "failed");
	assert.match(result.receipt.notices.join("\n"), /event without a session identity/);
});

function directDelegationEvidence(overrides = {}) {
	const now = Date.now();
	const cwd = join(tmpdir(), "ox-direct-evidence");
	const rows = [
		{ kind: "session", id: "ses_ROOT123", parentId: null, directory: cwd, projectId: "project", agent: "builder-a", provider: "provider-a", model: "model-a", reasoning: "max", createdAt: now, updatedAt: now, providerRequests: 1, toolCalls: 1, childrenStarted: 1, reportedCostUsdMicros: 1000, sessionCostUsdMicros: 1000, missingCostCount: 0, routeMismatchCount: 0, terminalReason: "stop", errorCount: 0, tokensInput: 10, tokensOutput: 5, tokensReasoning: 2, tokensCacheRead: 0, tokensCacheWrite: 0, objectiveMatches: 1 },
		{ kind: "session", id: "ses_CHILD456", parentId: "ses_ROOT123", directory: cwd, projectId: "project", agent: "reviewer-a", provider: "provider-a", model: "model-a", reasoning: "max", createdAt: now, updatedAt: now, providerRequests: 1, toolCalls: 0, childrenStarted: 0, reportedCostUsdMicros: 500, sessionCostUsdMicros: 500, missingCostCount: 0, routeMismatchCount: 0, terminalReason: "stop", errorCount: 0, tokensInput: 5, tokensOutput: 2, tokensReasoning: 1, tokensCacheRead: 0, tokensCacheWrite: 0, objectiveMatches: 0 },
		{ kind: "task", id: "call_TASK789", parentId: "ses_ROOT123", parentSessionId: "ses_ROOT123", childId: "ses_CHILD456", requestedProfile: "reviewer-a", requestedProvider: "provider-a", requestedModel: "model-a", status: "completed", truncated: false, startedAt: now, finishedAt: now },
	];
	Object.assign(rows[2], overrides.task ?? {});
	const input = spec(cwd, "route-a", "builder-a");
	input.execution.topology = "flat";
	input.execution.childPolicy = { allowedProfiles: ["reviewer-a"], allowedRoutes: [{ provider: "provider-a", model: "model-a", reasoning: "max" }] };
	return {
		rows,
		input: {
			firstJson: JSON.stringify(rows), secondJson: JSON.stringify(rows), rootSessionId: "ses_ROOT123",
			processStartedAt: now - 100, processFinishedAt: now + 100, spec: input, primaryProfile: "builder-a",
			primaryRoute: { provider: "provider-a", model: "model-a", reasoning: "max" },
			stream: { providerRequests: 1, toolCalls: 1, taskCalls: 1, reportedCostUsdMicros: 1000 },
		},
	};
}

test("binds task edges to their actual owning DB session", () => {
	const value = directDelegationEvidence({ task: { parentId: "ses_CHILD456" } });
	assert.throws(() => inspectDelegationEvidence(value.input), /not owned by its declared parent/);
});

test("rejects a delegation family that changes between the two DB snapshots", () => {
	const value = directDelegationEvidence();
	value.input.secondJson = value.input.secondJson.replace('"reportedCostUsdMicros":500', '"reportedCostUsdMicros":501');
	assert.throws(() => inspectDelegationEvidence(value.input), /changed between stable DB reads/);
});

test("retains parent-context truncation as telemetry without discarding structural child evidence", () => {
	const value = directDelegationEvidence({ task: { truncated: true } });
	const result = inspectDelegationEvidence(value.input);
	assert.equal(result.usage.complete, true);
	assert.equal(result.evidence.sessions[1].outputTruncated, true);
});
