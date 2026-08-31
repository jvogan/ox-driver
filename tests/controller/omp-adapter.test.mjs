import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	OMP_CONTROLLER_SYSTEM_PROMPT,
	OMP_POLICY_BUNDLE_SHA256,
	OmpAdapter,
	OmpUsageTracker,
	RpcFrameDecoder,
	createOmpProcessContainmentLaunch,
	inspectOmpProcessContainment,
	ompRuntimeStateIssue,
	ompRuntimeSystemPromptIssue,
	ompPolicyBundleSha256,
} from "../../packages/adapters/omp/dist/index.js";
import { createOmpRuntimeIsolation } from "../../packages/adapters/omp/dist/isolation.js";
import { AdapterRegistry, OxController, RunStore } from "../../packages/core/dist/index.js";
import { trackedMkdtemp } from "./helpers/tracked-temp.mjs";

const FIXTURE_USAGE = {
	input: 100,
	output: 20,
	cacheRead: 30,
	cacheWrite: 0,
	totalTokens: 150,
	reasoningTokens: 5,
	cost: { input: 0.0001, output: 0.0002, cacheRead: 0.00003, cacheWrite: 0, total: 0.00033 },
};

async function sha256(path) {
	const { createHash } = await import("node:crypto");
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

test("discounts only exact cumulative OMP update replay from the aggregate stream limit", () => {
	const decoder = new RpcFrameDecoder(1_024);
	const snapshot = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "x".repeat(700) }],
	};
	const update = `${JSON.stringify({
		type: "message_update",
		message: snapshot,
		assistantMessageEvent: { type: "thinking_delta", delta: "x", partial: snapshot },
	})}\n`;
	for (let index = 0; index < 8; index += 1) {
		assert.equal(decoder.push(Buffer.from(update)).length, 1);
	}
	const evidence = decoder.transportEvidence();
	assert.equal(evidence.messageUpdateFrames, 8);
	assert.ok(evidence.wireBytes > 1_024);
	assert.ok(evidence.replayAmplificationBytes > evidence.ordinaryWireBytes);
	assert.ok(evidence.ordinaryWireBytes <= 1_024);

	const chunked = new RpcFrameDecoder(1_024);
	const payload = Buffer.from(update.trimEnd());
	const middle = Math.ceil(payload.length / 2);
	for (const [index, part] of [payload.subarray(0, middle), payload.subarray(middle)].entries()) {
		const chunk = `${JSON.stringify({
			type: "rpc_chunk",
			chunkId: "replay-update",
			index,
			count: 2,
			byteLength: payload.length,
			data: part.toString("base64"),
		})}\n`;
		const frames = chunked.push(Buffer.from(chunk));
		assert.equal(frames.length, index === 0 ? 0 : 1);
	}
	const chunkedEvidence = chunked.transportEvidence();
	assert.equal(chunkedEvidence.messageUpdateFrames, 1);
	assert.ok(chunkedEvidence.replayAmplificationBytes > chunkedEvidence.ordinaryWireBytes);
	assert.ok(chunkedEvidence.ordinaryWireBytes <= 1_024);

	const ordinary = new RpcFrameDecoder(256);
	assert.throws(
		() => ordinary.push(Buffer.from(`${JSON.stringify({ type: "notice", payload: "x".repeat(300) })}\n`)),
		/OMP RPC non-replay stream exceeded the controller limit/,
	);

	const mismatched = new RpcFrameDecoder(512);
	assert.throws(
		() => mismatched.push(Buffer.from(`${JSON.stringify({
			type: "message_update",
			message: snapshot,
			assistantMessageEvent: { type: "thinking_delta", delta: "x", partial: { ...snapshot, role: "user" } },
		})}\n`)),
		/OMP RPC non-replay stream exceeded the controller limit/,
	);
});

test("aggregates only terminal assistant OMP usage frames and rejects route or accounting drift", () => {
	const route = { provider: "fixture-provider", model: "fixture-model", reasoning: "max" };
	const tracker = new OmpUsageTracker(route);
	tracker.observe({ type: "message_start", message: { role: "assistant", provider: route.provider, model: route.model, usage: FIXTURE_USAGE } });
	tracker.observe({ type: "message_end", message: { role: "assistant", provider: route.provider, model: route.model, usage: FIXTURE_USAGE } });
	tracker.observe({ type: "turn_end", message: { role: "assistant", provider: route.provider, model: route.model, usage: FIXTURE_USAGE } });
	tracker.observe({ type: "tool_execution_start", toolName: "read" });
	tracker.observe({ type: "message_end", message: { role: "assistant", provider: route.provider, model: route.model, usage: FIXTURE_USAGE } });
	assert.deepEqual(tracker.snapshot(true), {
		providerRequests: 2,
		toolCalls: 1,
		childrenStarted: 0,
		reportedCostUsdMicros: 660,
		tokens: { input: 200, output: 40, cacheRead: 60, cacheWrite: 0, reasoning: 10, total: 300 },
		complete: true,
		sources: ["harness"],
		terminationReason: "OMP terminal assistant message_end frames report exact per-turn route, token, tool, and cost telemetry.",
	});
	assert.throws(() => new OmpUsageTracker(route).observe({
		type: "message_end",
		message: { role: "assistant", provider: "fallback", model: route.model, usage: FIXTURE_USAGE },
	}), /usage route differs/);
	assert.throws(() => new OmpUsageTracker(route).observe({
		type: "message_end",
		message: { role: "assistant", provider: route.provider, model: route.model, usage: { ...FIXTURE_USAGE, totalTokens: 151 } },
	}), /total tokens do not reconcile/);
});

async function waitForPath(path, timeoutMs = 3_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			await access(path);
			return;
		} catch {
			if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
			await new Promise(resolve => setTimeout(resolve, 10));
		}
	}
}

const CONTAINMENT_MECHANISM_SHA256 = "c".repeat(64);
const OMP_FIXTURE_PROJECT_PROMPT = "PROJECT\n\n<workstation>\n- OS: fixture\n</workstation>\n\n<critical>fixture-owned</critical>";

const POSIX_SHM_PROBE_SOURCE = `
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
static const char sentinel[] = "OX_OMP_FAKE_SHM_SENTINEL";
static volatile sig_atomic_t stopped = 0;
static void stop_holder(int value) { (void)value; stopped = 1; }
int main(int argc, char **argv) {
  if (argc != 3) return 90;
  if (strcmp(argv[1], "hold") == 0) {
    int fd = shm_open(argv[2], O_CREAT | O_EXCL | O_RDWR, 0600);
    if (fd < 0 || ftruncate(fd, 64) != 0) return 91;
    void *view = mmap(NULL, 64, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (view == MAP_FAILED) return 92;
    memcpy(view, sentinel, sizeof(sentinel));
    signal(SIGTERM, stop_holder); puts("READY"); fflush(stdout);
    while (!stopped) pause();
    munmap(view, 64); close(fd); shm_unlink(argv[2]); return 0;
  }
  int fd = shm_open(argv[2], O_RDONLY, 0);
  if (fd < 0) return 94;
  void *view = mmap(NULL, 64, PROT_READ, MAP_SHARED, fd, 0);
  if (view == MAP_FAILED) return 95;
  int matched = memcmp(view, sentinel, sizeof(sentinel)) == 0;
  munmap(view, 64); close(fd); return matched ? 0 : 96;
}
`;

async function runCommand(command, args, cwd) {
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", chunk => { stdout += chunk; });
		child.stderr.on("data", chunk => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
	});
}

async function startShmHolder(executable, name, cwd) {
	const child = spawn(executable, ["hold", name], {
		cwd,
		env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`OMP shared-memory holder timed out: ${stderr}`)), 5_000);
		child.stdout.on("data", chunk => {
			stdout += chunk;
			if (stdout.includes("READY\n")) { clearTimeout(timer); resolve(); }
		});
		child.stderr.on("data", chunk => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", exitCode => {
			if (!stdout.includes("READY\n")) reject(new Error(`OMP shared-memory holder exited ${exitCode}: ${stderr}`));
		});
	});
	return child;
}

test("fails closed when the reviewed Seatbelt mechanism digest drifts", async () => {
	const inspection = await inspectOmpProcessContainment("0".repeat(64));
	assert.equal(inspection.available, false);
	assert.match(inspection.notice, process.platform === "darwin" ? /digest drifted/ : /unavailable/);
});

async function validContainmentProof() {
	throw new Error("legacy caller-supplied containment callback was invoked");
}

async function ompFixture({
	routeDrift = false,
	routeMutationMarkerName,
	chunkOutput = false,
	malformedChunk = false,
	oversizedChunk = false,
	malformedJson = false,
	invalidUtf8 = false,
	approval = false,
	unexpectedTool = false,
	unexpectedStateTool = false,
	persistedSession = false,
	ambientPrompt = false,
	systemPromptDrift = false,
	promptNotInvoked = false,
	promptAckOmitted = false,
	promptResultFalse = false,
	promptResponseFailure = false,
	promptResponseError = "OMP_PROVIDER_ERROR_SENTINEL",
	terminalStopReason = "stop",
	completionText = "OMP fixture complete",
	mutateOverlay = false,
	hostToolCallPath,
	hostToolResultCapture,
	missingAgentStart = false,
	duplicateReady = false,
	hang = false,
	executionSentinel,
	invocationCaptureName,
	backgroundPidName,
	containmentChecks,
	immutableModelConfigWrite = false,
} = {}) {
	const root = await trackedMkdtemp(join(tmpdir(), "ox-driver-omp-fixture-"));
	const executable = join(root, "omp");
	const fixturePython = process.platform === "darwin"
		? "/Library/Developer/CommandLineTools/usr/bin/python3"
		: "/usr/bin/python3";
	await writeFile(executable, `#!${fixturePython}
import base64
import errno
import json
import os
import stat
import subprocess
import sys
import time

${executionSentinel ? `open(${JSON.stringify(executionSentinel)}, "w", encoding="utf-8").write("executed")` : ""}
args = sys.argv[1:]
if "--version" in args:
    sys.stdout.write("omp/18.0.6\\n")
    sys.exit(0)

def arg_value(name, default=None):
    return args[args.index(name) + 1] if name in args else default

selected = arg_value("--model", "ox-driver-probe/no-network-probe")
provider, model = selected.split("/", 1)
thinking = arg_value("--thinking", "off")
selected_tools = arg_value("--tools", "").split(",") if "--tools" in args else []
overlay_path = arg_value("--config")

${invocationCaptureName ? `
environment_names = ["HOME", "TMPDIR", "PATH", "PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "PI_CONFIG_FILES", "PI_PY", "PI_JS", "PI_NO_PTY", "PI_NO_TITLE", "OMP_PROFILE", "NODE_OPTIONS", "HTTPS_PROXY", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]
capture = {
    "args": args,
    "environment": {name: os.environ[name] for name in environment_names if name in os.environ},
    "overlay": open(overlay_path, encoding="utf-8").read() if overlay_path else None,
    "overlayMode": stat.S_IMODE(os.stat(overlay_path).st_mode) if overlay_path else None,
}
with open(os.path.join(os.environ["TMPDIR"], ${JSON.stringify(invocationCaptureName)}), "a", encoding="utf-8") as stream:
    stream.write(json.dumps(capture, separators=(",", ":")) + "\\n")` : ""}

prompted = False
host_tool_pending = False

def send(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\\n")
    sys.stdout.flush()

def send_maybe_chunked(value):
    payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
    if not ${chunkOutput ? "True" : "False"}:
        send(value)
        return
    middle = (len(payload) + 1) // 2
    for index, part in enumerate((payload[:middle], payload[middle:])):
        send({"type": "rpc_chunk", "chunkId": "fixture-chunk", "index": index, "count": 2, "byteLength": len(payload), "data": base64.b64encode(part).decode("ascii")})

def error_code(error):
    return errno.errorcode.get(getattr(error, "errno", None), error.__class__.__name__)

def read_probe(target):
    try:
        with open(target, encoding="utf-8") as stream:
            return {"ok": True, "value": stream.read()}
    except OSError as error:
        return {"ok": False, "code": error_code(error)}

def metadata_probe(target):
    try:
        return {"ok": True, "size": os.stat(target).st_size}
    except OSError as error:
        return {"ok": False, "code": error_code(error)}

def write_probe(target):
    try:
        with open(target, "w", encoding="utf-8") as stream:
            stream.write("probe-write")
        return {"ok": True}
    except OSError as error:
        return {"ok": False, "code": error_code(error)}

send({"type": "ready", "protocolVersion": 1, "supportedProtocolVersions": [1, 2], "maxFrameBytes": 1048576, "maxReassembledFrameBytes": 67108864})
if ${duplicateReady ? "True" : "False"}:
    send({"type": "ready", "protocolVersion": 1, "supportedProtocolVersions": [1, 2]})

for line in sys.stdin:
    if not line.strip():
        continue
    command = json.loads(line)
    command_type = command.get("type")
    if command_type == "negotiate_protocol":
        send({"id": command["id"], "type": "response", "command": command_type, "success": True, "data": {"protocolVersion": 2}})
    elif command_type == "set_host_tools":
        host_tool_names = [tool["name"] for tool in command["tools"]]
        selected_tools.extend(host_tool_names)
        send({"id": command["id"], "type": "response", "command": command_type, "success": True, "data": {"toolNames": host_tool_names}})
    elif command_type == "get_available_commands":
        send({"id": command["id"], "type": "response", "command": command_type, "success": True, "data": []})
    elif command_type == "get_state":
        final_provider = "drift-provider" if prompted and ${routeDrift ? "True" : "False"} else provider
        state = {
            "model": {"provider": final_provider, "id": model},
            "thinkingLevel": thinking,
            "systemPrompt": ${ambientPrompt
				? JSON.stringify([OMP_CONTROLLER_SYSTEM_PROMPT, "<instructions>OX_DRIVER_AMBIENT_SENTINEL_NATIVE</instructions>"])
				: systemPromptDrift
					? `([${JSON.stringify(OMP_CONTROLLER_SYSTEM_PROMPT)}, ${JSON.stringify(OMP_FIXTURE_PROJECT_PROMPT + " changed")}] if prompted else [${JSON.stringify(OMP_CONTROLLER_SYSTEM_PROMPT)}, ${JSON.stringify(OMP_FIXTURE_PROJECT_PROMPT)}])`
					: JSON.stringify([OMP_CONTROLLER_SYSTEM_PROMPT, OMP_FIXTURE_PROJECT_PROMPT])},
            "dumpTools": [{"name": name, "description": name, "parameters": {}} for name in selected_tools + (["bash"] if ${unexpectedStateTool ? "True" : "False"} else [])],
        }
        if prompted and ${persistedSession ? "True" : "False"}:
            state["sessionFile"] = "/tmp/ambient-session.jsonl"
        send({"id": command["id"], "type": "response", "command": command_type, "success": True, "data": state})
    elif command_type == "prompt":
        if ${promptResponseFailure ? "True" : "False"}:
            send({"id": command["id"], "type": "response", "command": command_type, "success": False, "error": ${JSON.stringify(promptResponseError)}})
            sys.exit(0)
        prompted = True
        prompt_response = {"id": command["id"], "type": "response", "command": command_type, "success": True}
        if not ${promptAckOmitted ? "True" : "False"}:
            prompt_response["data"] = {"agentInvoked": ${promptNotInvoked ? "False" : "True"}}
        send(prompt_response)
        if ${promptResultFalse ? "True" : "False"}:
            send({"type": "prompt_result", "id": command["id"], "agentInvoked": False})
        if not ${missingAgentStart ? "True" : "False"}:
            send({"type": "agent_start"})
        if ${mutateOverlay ? "True" : "False"}:
            os.chmod(overlay_path, 0o600)
            open(overlay_path, "w", encoding="utf-8").write("{}\\n")
        if ${typeof routeMutationMarkerName === "string" ? "True" : "False"}:
            open(os.path.join(os.environ["TMPDIR"], ${JSON.stringify(routeMutationMarkerName ?? "")}), "w", encoding="utf-8").write("ready")
            time.sleep(1)
        if ${approval ? "True" : "False"}:
            send({"type": "extension_ui_request", "id": "approval-1", "method": "confirm", "title": "write?"})
        elif ${unexpectedTool ? "True" : "False"}:
            send({"type": "tool_execution_start", "toolName": "bash"})
        elif ${malformedChunk ? "True" : "False"}:
            send({"type": "rpc_chunk", "chunkId": "bad", "index": 1, "count": 2, "byteLength": 10, "data": "e30="})
        elif ${oversizedChunk ? "True" : "False"}:
            send({"type": "rpc_chunk", "chunkId": "oversized", "index": 0, "count": 2, "byteLength": 1, "data": "e30="})
        elif ${malformedJson ? "True" : "False"}:
            sys.stdout.write("{malformed-json\\n")
            sys.stdout.flush()
        elif ${invalidUtf8 ? "True" : "False"}:
            sys.stdout.buffer.write(bytes([0x7b, 0x22, 0xff, 0x22, 0x7d, 0x0a]))
            sys.stdout.buffer.flush()
        elif ${typeof hostToolCallPath === "string" ? "True" : "False"}:
            host_tool_pending = True
            send({"type": "tool_execution_start", "toolName": "ox_read_file"})
            send({"type": "host_tool_call", "id": "host-1", "toolCallId": "tool-1", "toolName": "ox_read_file", "arguments": {"path": ${JSON.stringify(hostToolCallPath ?? "")}}})
        elif not ${hang ? "True" : "False"}:
            completion_text = ${JSON.stringify(completionText)}
            containment_checks = json.loads(${JSON.stringify(JSON.stringify(containmentChecks ?? null))})
            if containment_checks:
                completion_text = json.dumps({
                    "allowedRead": read_probe(containment_checks["allowedRead"]),
                    "excludedRead": read_probe(containment_checks["excludedRead"]),
                    "outsideRead": read_probe(containment_checks["outsideRead"]),
                    "outsideMetadata": metadata_probe(containment_checks["outsideRead"]),
                    "workspaceWrite": write_probe(containment_checks["workspaceWrite"]),
                    "outsideWrite": write_probe(containment_checks["outsideWrite"]),
                    "isolationWrite": write_probe(os.path.join(os.environ["TMPDIR"], "seatbelt-write-probe")),
					"immutableModelConfigWrite": write_probe(os.path.join(os.environ["PI_CODING_AGENT_DIR"], "models.yml")) if ${immutableModelConfigWrite ? "True" : "False"} else None,
                }, separators=(",", ":"))
            send_maybe_chunked({"type": "message_end", "message": {"role": "assistant", "provider": provider, "model": model, "usage": ${JSON.stringify(FIXTURE_USAGE)}, "content": [{"type": "thinking", "thinking": "OMP_PRIVATE_REASONING_SENTINEL", "thinkingSignature": "OMP_PRIVATE_SIGNATURE_SENTINEL"}, {"type": "text", "text": completion_text}], "stopReason": ${JSON.stringify(terminalStopReason)}}})
            send({"type": "agent_end", "isTerminal": True})
            ${backgroundPidName ? `background = subprocess.Popen(["/bin/sleep", "20"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            open(os.path.join(os.environ["TMPDIR"], ${JSON.stringify(backgroundPidName)}), "w", encoding="utf-8").write(str(background.pid))` : ""}
    elif command_type == "host_tool_result" and host_tool_pending:
        host_tool_pending = False
        ${hostToolResultCapture ? `open(${JSON.stringify(hostToolResultCapture)}, "w", encoding="utf-8").write(json.dumps(command, separators=(",", ":")))` : ""}
        if not command.get("isError"):
            text = "\\n".join(item.get("text", "") for item in command["result"]["content"])
            send({"type": "message_end", "message": {"role": "assistant", "provider": provider, "model": model, "usage": ${JSON.stringify(FIXTURE_USAGE)}, "content": [{"type": "text", "text": "host result: " + text}], "stopReason": "stop"}})
            send({"type": "agent_end", "isTerminal": True})
    elif command_type == "abort":
        send({"id": command["id"], "type": "response", "command": command_type, "success": True})
        sys.exit(0)
`, { encoding: "utf8", mode: 0o700 });
	await chmod(executable, 0o700);
	return { root, executable, digest: await sha256(executable) };
}

async function routeFor(fixture) {
	const agentDirectory = join(fixture.root, "agent");
	const homeDirectory = join(fixture.root, "home");
	await mkdir(agentDirectory, { mode: 0o700 });
	await mkdir(homeDirectory, { mode: 0o700 });
	return {
		provider: "fixture-provider",
		model: "fixture-model",
		reasoning: "high",
		agentDirectory,
		homeDirectory,
		environment: { FIXTURE_ROUTE_AGENT_DIRECTORY: agentDirectory },
	};
}

async function repository() {
	const cwd = await trackedMkdtemp(join(tmpdir(), "ox-driver-omp-project-"));
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	await promisify(execFile)("git", ["init", "--quiet"], { cwd });
	return cwd;
}

function spec(cwd, timeoutSeconds = 10) {
	return {
		version: 1,
		tier: "attested",
		harness: "omp",
		routeProfile: "omp-explicit-isolated",
		task: {
			objective: "Inspect the fixture without modifying files",
			cwd,
			ownedPaths: [],
			excludedPaths: [".git"],
		},
		execution: {
			session: "ephemeral",
			topology: "solo",
			writerPolicy: "read-only",
			network: "configured",
			timeoutSeconds,
		},
		acceptance: { commands: [], requireCleanUnownedPaths: true },
	};
}

async function controllerFor(fixture, route, options = {}) {
	const stateRoot = await trackedMkdtemp(join(tmpdir(), "ox-driver-omp-state-"));
	const registry = new AdapterRegistry();
	registry.register(new OmpAdapter({
		launcher: fixture.executable,
		expectedVersion: "18.0.6",
		 expectedSha256: fixture.digest,
		route,
		enableReadOnlyHostTools: options.enableReadOnlyHostTools ?? false,
	}));
	return { controller: new OxController(registry, new RunStore(stateRoot, join(stateRoot, "leases"))), stateRoot };
}

const containedTest = process.platform === "darwin" ? test : test.skip;

test("qualifies an OMP RPC v2 binary without sending a model prompt", async () => {
	assert.equal(await ompPolicyBundleSha256(), OMP_POLICY_BUNDLE_SHA256);
	const fixture = await ompFixture();
	const route = await routeFor(fixture);
	const adapter = new OmpAdapter({
		launcher: fixture.executable,
		expectedVersion: "18.0.6",
		expectedSha256: fixture.digest,
		route,
		containmentProbe: validContainmentProof,
		containmentMechanismSha256: CONTAINMENT_MECHANISM_SHA256,
	});
	const doctor = await adapter.doctor();
	assert.equal(doctor.compatibility, process.platform === "darwin" ? "compatible" : "degraded", JSON.stringify(doctor, null, 2));
	assert.equal(doctor.harnessVersion, "18.0.6");
	assert.equal(doctor.capabilities["events.structured"], true);
	assert.equal(doctor.capabilities["route.configured"], true);
	assert.equal(doctor.capabilities["telemetry.usage"], process.platform === "darwin");
	assert.equal(doctor.capabilities["sandbox.filesystem"], process.platform === "darwin");
	assert.equal(doctor.probe.executionQualified, process.platform === "darwin");
	if (process.platform === "darwin") {
		assert.match(doctor.notices.join("\n"), /Version and RPC probes executed the immutable staged artifact through the production Seatbelt boundary with network denied/);
	}
	assert.match(doctor.notices.join("\n"), /callback-issued proof digests are not accepted|bubblewrap remains disabled/);
	assert.equal(doctor.capabilities["agents.children"], false);
});

test("blocks execution qualification when the reviewed OMP policy bundle drifts", async () => {
	const fixture = await ompFixture();
	const route = await routeFor(fixture);
	const adapter = new OmpAdapter({
		launcher: fixture.executable,
		expectedVersion: "18.0.6",
		expectedSha256: fixture.digest,
		expectedPolicyBundleSha256: "0".repeat(64),
		route,
	});
	const doctor = await adapter.doctor();
	assert.equal(doctor.probe.executionQualified, false);
	assert.equal(doctor.capabilities["sandbox.filesystem"], false);
	assert.match(doctor.notices.join("\n"), /policy bundle drifted/);
});

test("does not invoke or trust a caller-supplied containment proof callback", async () => {
	const fixture = await ompFixture();
	const route = await routeFor(fixture);
	const allowed = await repository();
	const denied = await repository();
	const requests = [];
	const adapter = new OmpAdapter({
		launcher: fixture.executable,
		expectedVersion: "18.0.6",
		expectedSha256: fixture.digest,
		route,
		containmentProbe: async (request) => {
			requests.push(request);
			if (request.cwd !== allowed) throw new Error("fixture containment denial");
			return validContainmentProof(request);
		},
		containmentMechanismSha256: CONTAINMENT_MECHANISM_SHA256,
		enableProcessContainment: false,
	});
	const doctor = await adapter.doctor();
	assert.equal(requests.length, 0);
	assert.ok((await adapter.preflight(spec(allowed), doctor)).some((issue) => issue.code === "OMP_CONTAINMENT_UNVERIFIED"));
	assert.ok((await adapter.preflight(spec(denied), doctor)).some((issue) => issue.code === "OMP_CONTAINMENT_UNVERIFIED"));
	assert.equal(requests.length, 0);
});

test("blocks controller dispatch before a self-attested containment callback can run", async () => {
	const fixture = await ompFixture();
	const route = await routeFor(fixture);
	const requests = [];
	const stateRoot = await trackedMkdtemp(join(tmpdir(), "ox-driver-omp-proof-state-"));
	const registry = new AdapterRegistry();
	registry.register(new OmpAdapter({
		launcher: fixture.executable,
		expectedVersion: "18.0.6",
		expectedSha256: fixture.digest,
		route,
		containmentProbe: async (request) => {
			requests.push(request);
			return validContainmentProof(request);
		},
		containmentMechanismSha256: CONTAINMENT_MECHANISM_SHA256,
		enableProcessContainment: false,
	}));
	const controller = new OxController(registry, new RunStore(stateRoot, join(stateRoot, "leases")));
	await assert.rejects(
		controller.run(spec(await repository()), { runId: "omp-proof-binding" }),
		/PROBE_NOT_EXECUTION_QUALIFIED|CAPABILITY_UNAVAILABLE|OMP_CONTAINMENT_UNVERIFIED/,
	);
	assert.equal(requests.length, 0);
});

test("replayed self-attested containment proof cannot change blocked status", async () => {
	const fixture = await ompFixture();
	const route = await routeFor(fixture);
	let replay;
	const adapter = new OmpAdapter({
		launcher: fixture.executable,
		expectedVersion: "18.0.6",
		expectedSha256: fixture.digest,
		route,
		containmentProbe: async (request) => {
			replay ??= await validContainmentProof(request);
			return replay;
		},
		containmentMechanismSha256: CONTAINMENT_MECHANISM_SHA256,
		enableProcessContainment: false,
	});
	const doctor = await adapter.doctor();
	const candidate = spec(await repository());
	const issues = await adapter.preflight(candidate, doctor);
	assert.ok(issues.some((issue) => issue.code === "OMP_CONTAINMENT_UNVERIFIED"));
	assert.equal(replay, undefined);
	assert.equal(doctor.capabilities["sandbox.filesystem"], false);
});

test("stale self-attested proof provider cannot authorize dispatch", async () => {
	const fixture = await ompFixture();
	const route = await routeFor(fixture);
	const stateRoot = await trackedMkdtemp(join(tmpdir(), "ox-driver-omp-stale-proof-state-"));
	const registry = new AdapterRegistry();
	registry.register(new OmpAdapter({
		launcher: fixture.executable,
		expectedVersion: "18.0.6",
		expectedSha256: fixture.digest,
		route,
		containmentProbe: async (request) => {
			const proof = await validContainmentProof(request);
			return request.phase === "post-run"
				? { ...proof, expiresAtUnixMs: request.requestedAtUnixMs }
				: proof;
		},
		containmentMechanismSha256: CONTAINMENT_MECHANISM_SHA256,
		enableProcessContainment: false,
	}));
	const controller = new OxController(registry, new RunStore(stateRoot, join(stateRoot, "leases")));
	await assert.rejects(
		controller.run(spec(await repository())),
		/PROBE_NOT_EXECUTION_QUALIFIED|CAPABILITY_UNAVAILABLE|OMP_CONTAINMENT_UNVERIFIED/,
	);
});

containedTest("macOS Seatbelt launch boundary permits scoped reads and denies excluded, outside, and workspace writes", async () => {
	const cwd = await repository();
	const allowedRead = join(cwd, "allowed.txt");
	const excludedRead = join(cwd, ".git", "excluded.txt");
	const outside = await trackedMkdtemp(join(tmpdir(), "ox-driver-omp-outside-"));
	const outsideRead = join(outside, "secret.txt");
	await writeFile(allowedRead, "allowed\n", "utf8");
	await writeFile(excludedRead, "excluded\n", "utf8");
	await writeFile(outsideRead, "outside\n", "utf8");
	const fixture = await ompFixture({
		containmentChecks: {
			allowedRead,
			excludedRead,
			outsideRead,
			workspaceWrite: join(cwd, "forbidden-write.txt"),
			outsideWrite: join(outside, "forbidden-write.txt"),
		},
	});
	const route = await routeFor(fixture);
	const { controller, stateRoot } = await controllerFor(fixture, route);
	const receipt = await controller.run(spec(cwd), { runId: "omp-seatbelt-boundary" });
	assert.equal(receipt.status, "completed", JSON.stringify(receipt, null, 2));
	const checks = JSON.parse(receipt.finalOutput);
	assert.deepEqual(checks.allowedRead, { ok: true, value: "allowed\n" });
	for (const denied of [
		checks.excludedRead,
		checks.outsideRead,
		checks.outsideMetadata,
		checks.workspaceWrite,
		checks.outsideWrite,
	]) {
		assert.equal(denied.ok, false);
		assert.match(denied.code, /^(?:EACCES|EPERM)$/);
	}
	assert.deepEqual(checks.isolationWrite, { ok: true });
	await assert.rejects(access(join(cwd, "forbidden-write.txt")));
	await assert.rejects(access(join(outside, "forbidden-write.txt")));

	const runDirectory = join(stateRoot, "runs", receipt.runId);
	const canonicalIsolationRoot = await realpath(join(runDirectory, "omp-isolation"));
	const evidence = JSON.parse(await readFile(join(runDirectory, "omp-isolation", "containment.json"), "utf8"));
	assert.equal(evidence.kind, "darwin-seatbelt");
	assert.equal(evidence.workspace.realpath, await realpath(cwd));
	assert.deepEqual(evidence.excludedPaths, [".git"]);
	assert.equal(evidence.executable.sha256, fixture.digest);
	assert.equal(evidence.executable.path, join(canonicalIsolationRoot, "omp-executable"));
	assert.equal(evidence.executable.staged, true);
	assert.equal(evidence.sourceExecutable.path, await realpath(fixture.executable));
	assert.match(evidence.routeEnforcementSha256, /^[0-9a-f]{64}$/);
	const events = (await readFile(join(runDirectory, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
	const started = events.find(event => event.type === "adapter.process.started");
	assert.equal(started.data.executable, "/usr/bin/sandbox-exec");
	assert.equal(started.data.targetExecutable, join(canonicalIsolationRoot, "omp-executable"));
	assert.equal(started.data.sourceExecutable, await realpath(fixture.executable));
	assert.match(started.data.containmentProfileSha256, /^[0-9a-f]{64}$/);
	const admission = JSON.parse(await readFile(join(runDirectory, "admission.json"), "utf8"));
	assert.equal(admission.processes[0].label, "OMP RPC harness through macOS Seatbelt");
	assert.equal(admission.processes[0].status, "exited");
});

containedTest("Seatbelt network-none mode and immutable model catalog fail closed", async () => {
	const cwd = await repository();
	const outside = await trackedMkdtemp(join(tmpdir(), "ox-driver-omp-network-none-outside-"));
	const fixture = await ompFixture({
		immutableModelConfigWrite: true,
		containmentChecks: {
			allowedRead: join(cwd, "allowed.txt"),
			excludedRead: join(cwd, ".git", "excluded.txt"),
			outsideRead: join(outside, "secret.txt"),
			workspaceWrite: join(cwd, "forbidden-write.txt"),
			outsideWrite: join(outside, "forbidden-write.txt"),
		},
	});
	await Promise.all([
		writeFile(join(cwd, "allowed.txt"), "allowed\n", "utf8"),
		writeFile(join(cwd, ".git", "excluded.txt"), "excluded\n", "utf8"),
		writeFile(join(outside, "secret.txt"), "outside\n", "utf8"),
	]);
	const route = await routeFor(fixture);
	const modelCatalog = "providers: {}\n";
	await writeFile(join(route.agentDirectory, "models.yml"), modelCatalog, { encoding: "utf8", mode: 0o600 });
	const { controller, stateRoot } = await controllerFor(fixture, route);
	const receipt = await controller.run(spec(cwd), { runId: "omp-immutable-model-catalog" });
	assert.equal(receipt.status, "completed", JSON.stringify(receipt, null, 2));
	const result = JSON.parse(receipt.finalOutput);
	assert.equal(result.immutableModelConfigWrite.ok, false);
	assert.match(result.immutableModelConfigWrite.code, /^(?:EACCES|EPERM)$/);
	const isolationRoot = join(stateRoot, "runs", receipt.runId, "omp-isolation");
	assert.equal(await readFile(join(isolationRoot, "agent", "models.yml"), "utf8"), modelCatalog);

	const profile = await readFile(join(isolationRoot, "seatbelt.sb"), "utf8");
	assert.match(profile, /\(remote tcp "\*:443"\)/);
	assert.match(profile, /\(literal "\/private\/var\/run\/mDNSResponder"\)/);
	assert.doesNotMatch(profile, /allow network\*|remote udp|remote tcp "\*:\*"/);
	assert.doesNotMatch(profile, /^\(allow mach-lookup\)$/m);
	assert.doesNotMatch(profile, /\(allow ipc-posix/);
	assert.match(profile, /\(allow signal \(target self\)\)/);
	assert.match(profile, /\(deny file-write\*[\s\S]*models\.yml/);
	const evidence = JSON.parse(await readFile(join(isolationRoot, "containment.json"), "utf8"));
	assert.equal(evidence.networkPolicy, "configured-https-443-and-dns");
	assert.deepEqual(evidence.immutableReadPaths, [{
		path: join(await realpath(isolationRoot), "agent", "models.yml"),
		sha256: await sha256(join(isolationRoot, "agent", "models.yml")),
	}]);

	const inspection = await inspectOmpProcessContainment();
	const directRoot = await trackedMkdtemp(join(tmpdir(), "ox-driver-omp-network-none-root-"));
	const directWritable = join(directRoot, "tmp");
	await mkdir(directWritable, { mode: 0o700 });
	const launch = await createOmpProcessContainmentLaunch({
		inspection,
		workspaceRoot: cwd,
		excludedPaths: [".git"],
		controllerRoot: directRoot,
		writablePaths: [directWritable],
		executable: fixture.executable,
		executableSha256: fixture.digest,
		routeEnforcementSha256: "a".repeat(64),
		networkPolicy: "none",
	});
	const directProfile = await readFile(launch.profilePath, "utf8");
	assert.match(directProfile, /\(deny network\*\)/);
	assert.doesNotMatch(directProfile, /\(allow network\*\)/);
	assert.equal(launch.networkPolicy, "none");
	assert.equal(JSON.parse(await readFile(launch.evidencePath, "utf8")).networkPolicy, "none");
});

containedTest("Seatbelt kernel denies host control, unrelated IPC, signals, and unconfigured network effects", async (t) => {
	const cwd = await repository();
	const outside = await trackedMkdtemp(join(tmpdir(), "ox-driver-omp-host-effects-"));
	const fixture = await ompFixture();
	const controllerRoot = await trackedMkdtemp(join(tmpdir(), "ox-driver-omp-host-policy-"));
	const writable = join(controllerRoot, "tmp");
	await mkdir(writable, { mode: 0o700 });
	const inspection = await inspectOmpProcessContainment();
	const launch = await createOmpProcessContainmentLaunch({
		inspection,
		workspaceRoot: cwd,
		excludedPaths: [".git"],
		controllerRoot,
		writablePaths: [writable],
		executable: fixture.executable,
		executableSha256: fixture.digest,
		routeEnforcementSha256: "a".repeat(64),
	});
	const prefix = ["-f", launch.profilePath];
	const python = "/Library/Developer/CommandLineTools/usr/bin/python3";
	const sleeper = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
	let shmHolder;
	let unixServer;
	let tcpServer;
	let httpsServer;
	try {
		const signalProbe = await runCommand("/usr/bin/sandbox-exec", [
			...prefix, "/bin/kill", "-0", String(sleeper.pid),
		], cwd);
		assert.notEqual(signalProbe.exitCode, 0);

		for (const [command, args] of [
			["/bin/launchctl", ["print-disabled", `gui/${process.getuid()}`]],
			["/usr/bin/shortcuts", ["list"]],
			["/usr/bin/security", ["help"]],
		]) {
			const result = await runCommand("/usr/bin/sandbox-exec", [...prefix, command, ...args], cwd);
			assert.notEqual(result.exitCode, 0, `${command} unexpectedly executed through the OMP profile`);
		}

		const shmSource = join(cwd, "omp-shm-probe.c");
		const shmExecutable = join(cwd, "omp-shm-probe");
		await writeFile(shmSource, POSIX_SHM_PROBE_SOURCE, { mode: 0o600 });
		const compile = await runCommand("/usr/bin/clang", [shmSource, "-o", shmExecutable], cwd);
		assert.equal(compile.exitCode, 0, compile.stderr);
		await chmod(shmExecutable, 0o700);
		const shmName = `/ox${process.pid}${Date.now().toString(36)}`;
		shmHolder = await startShmHolder(shmExecutable, shmName, cwd);
		const shmRead = await runCommand("/usr/bin/sandbox-exec", [
			...prefix, shmExecutable, "read", shmName,
		], cwd);
		assert.equal(shmRead.exitCode, 94, shmRead.stderr);

		const socketPath = join(outside, "unrelated.sock");
		unixServer = createServer(socket => socket.destroy());
		unixServer.listen(socketPath);
		await once(unixServer, "listening");
		const unixProbe = await runCommand("/usr/bin/sandbox-exec", [
			...prefix, python, "-c",
			"import socket,sys;s=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1])",
			socketPath,
		], cwd);
		assert.notEqual(unixProbe.exitCode, 0);

		tcpServer = createServer(socket => socket.destroy());
		tcpServer.listen(0, "127.0.0.1");
		await once(tcpServer, "listening");
		const address = tcpServer.address();
		const highPortProbe = await runCommand("/usr/bin/sandbox-exec", [
			...prefix, "/usr/bin/nc", "-w", "1", "127.0.0.1", String(address.port),
		], cwd);
		assert.notEqual(highPortProbe.exitCode, 0);

		const inboundProbe = await runCommand("/usr/bin/sandbox-exec", [
			...prefix, python, "-c",
			"import socket;s=socket.socket();s.bind(('127.0.0.1',0));s.listen(1)",
		], cwd);
		assert.notEqual(inboundProbe.exitCode, 0);
		const udpProbe = await runCommand("/usr/bin/sandbox-exec", [
			...prefix, python, "-c",
			"import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.sendto(b'x',('127.0.0.1',9))",
		], cwd);
		assert.notEqual(udpProbe.exitCode, 0);

		httpsServer = createServer(socket => socket.destroy());
		try {
			httpsServer.listen(443, "127.0.0.1");
			await once(httpsServer, "listening");
			const httpsProbe = await runCommand("/usr/bin/sandbox-exec", [
				...prefix, "/usr/bin/nc", "-w", "1", "127.0.0.1", "443",
			], cwd);
			assert.equal(httpsProbe.exitCode, 0, httpsProbe.stderr);
		} catch (error) {
			if (!error || !["EACCES", "EADDRINUSE"].includes(error.code)) throw error;
			t.diagnostic(`local TCP 443 allow probe unavailable: ${error.code}`);
		}

		const profile = await readFile(launch.profilePath, "utf8");
		assert.match(profile, /\(deny process-exec[\s\S]*\/bin\/launchctl/);
		assert.match(profile, /\(deny sysctl-write\)/);
		assert.match(profile, /\(deny mach-register\)/);
		assert.match(profile, /\(deny network-outbound \(literal "\/private\/var\/run\/syslog"\)\)/);
	} finally {
		if (shmHolder?.pid) {
			shmHolder.kill("SIGTERM");
			await once(shmHolder, "close").catch(() => undefined);
		}
		if (sleeper.pid) {
			sleeper.kill("SIGTERM");
			await once(sleeper, "close").catch(() => undefined);
		}
		for (const server of [unixServer, tcpServer, httpsServer]) {
			if (server?.listening) await new Promise(resolve => server.close(resolve));
		}
	}
});

containedTest("rejects a controller run root nested inside the inspected workspace", async () => {
	const fixture = await ompFixture();
	const cwd = await repository();
	const stateRoot = join(cwd, "controller-state");
	const writable = join(stateRoot, "tmp");
	await mkdir(writable, { recursive: true, mode: 0o700 });
	const inspection = await inspectOmpProcessContainment();
	await assert.rejects(
		createOmpProcessContainmentLaunch({
			inspection,
			workspaceRoot: cwd,
			excludedPaths: [".git"],
			controllerRoot: stateRoot,
			writablePaths: [writable],
			executable: fixture.executable,
			executableSha256: fixture.digest,
			routeEnforcementSha256: "a".repeat(64),
		}),
		/workspace and controller root must be disjoint/,
	);
});

containedTest("normalizes contained OMP RPC completion and v2 chunks into a controller receipt", async () => {
	const fixture = await ompFixture({ chunkOutput: true });
	const route = await routeFor(fixture);
	const { controller, stateRoot } = await controllerFor(fixture, route);
	const receipt = await controller.run(spec(await repository()));
	assert.equal(receipt.status, "completed");
	assert.equal(receipt.finalOutput, "OMP fixture complete");
	assert.deepEqual(receipt.configuredRoute, { provider: route.provider, model: route.model, reasoning: route.reasoning });
	assert.equal(receipt.usage.providerRequests, 1);
	assert.equal(receipt.usage.reportedCostUsdMicros, 330);
	assert.deepEqual(receipt.usage.tokens, { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, reasoning: 5, total: 150 });
	const events = await readFile(join(stateRoot, "runs", receipt.runId, "events.jsonl"), "utf8");
	assert.match(events, /message_end/);
	assert.doesNotMatch(events, /OMP_PRIVATE_REASONING_SENTINEL|OMP_PRIVATE_SIGNATURE_SENTINEL|OMP fixture complete/);
	assert.match(events, /"redacted":true/);
	const stdoutEvidence = JSON.parse(await readFile(join(stateRoot, "runs", receipt.runId, "stdout.log"), "utf8"));
	assert.equal(stdoutEvidence.redacted, true);
	assert.match(stdoutEvidence.sha256, /^[0-9a-f]{64}$/);
});

containedTest("fails completion and reaps OMP descendants left after leader exit", async () => {
	if (process.platform === "win32") return;
	const backgroundPidName = "background.pid";
	const fixture = await ompFixture({ backgroundPidName });
	const route = await routeFor(fixture);
	const { controller, stateRoot } = await controllerFor(fixture, route);
	const receipt = await controller.run(spec(await repository()), { runId: "omp-background-reap" });
	const backgroundPidPath = join(stateRoot, "runs", receipt.runId, "omp-isolation", "tmp", backgroundPidName);
	const backgroundPid = Number((await readFile(backgroundPidPath, "utf8")).trim());

	assert.equal(receipt.status, "failed");
	assert.match(receipt.notices.join("\n"), /left background processes/);
	assert.throws(() => process.kill(backgroundPid, 0), (error) => error?.code === "ESRCH");
});

containedTest("launches OMP with controller-owned roots and an immutable explicit overlay", async () => {
	const invocationCaptureName = "invocations.jsonl";
	const fixture = await ompFixture({ invocationCaptureName });
	const route = await routeFor(fixture);
	await writeFile(join(route.agentDirectory, "models.yml"), "providers: {}\n", { encoding: "utf8", mode: 0o600 });
	const { controller, stateRoot } = await controllerFor(fixture, route);
	const receipt = await controller.run(spec(await repository()));
	assert.equal(receipt.status, "completed");
	const capture = join(stateRoot, "runs", receipt.runId, "omp-isolation", "tmp", invocationCaptureName);
	const invocations = (await readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line));
	const invocation = invocations.at(-1);
	const isolationRoot = join(stateRoot, "runs", receipt.runId, "omp-isolation");
	const canonicalIsolationRoot = await realpath(isolationRoot);
	assert.equal(invocation.environment.HOME, join(isolationRoot, "home"));
	assert.equal(invocation.environment.PI_CODING_AGENT_DIR, join(isolationRoot, "agent"));
	assert.equal(invocation.environment.TMPDIR, join(isolationRoot, "tmp"));
	assert.equal(invocation.environment.PATH, `${canonicalIsolationRoot}:/usr/bin:/bin:/usr/sbin:/sbin`);
	assert.equal(invocation.environment.PI_CONFIG_DIR, ".ox-driver-omp");
	assert.equal(invocation.environment.PI_PY, "0");
	assert.equal(invocation.environment.PI_JS, "0");
	assert.equal(invocation.environment.PI_NO_PTY, "1");
	assert.equal(invocation.environment.PI_NO_TITLE, "1");
	assert.equal(invocation.environment.PI_CONFIG_FILES, undefined);
	assert.equal(invocation.environment.OMP_PROFILE, undefined);
	assert.equal(invocation.environment.NODE_OPTIONS, undefined);
	assert.equal(invocation.environment.HTTPS_PROXY, undefined);
	assert.notEqual(invocation.environment.HOME, route.homeDirectory);
	assert.notEqual(invocation.environment.PI_CODING_AGENT_DIR, route.agentDirectory);
	assert.equal(invocation.overlayMode, 0o400);
	assert.deepEqual(JSON.parse(invocation.overlay).extensions, []);
	assert.equal(JSON.parse(invocation.overlay).mcp.enableProjectConfig, false);
	assert.equal(JSON.parse(invocation.overlay).eval.py, false);
	assert.equal(JSON.parse(invocation.overlay).async.enabled, false);
	assert.equal(JSON.parse(invocation.overlay).memory.backend, "off");
	assert.equal(JSON.parse(invocation.overlay).advisor.enabled, false);
	assert.equal(JSON.parse(invocation.overlay).prewalk.enabled, false);
	assert.equal(JSON.parse(invocation.overlay).bash.autoBackground.enabled, false);
	assert.ok(invocation.args.includes("--config"));
	assert.ok(invocation.args.includes("--no-prewalk"));
	assert.equal(await readFile(join(isolationRoot, "agent", "models.yml"), "utf8"), "providers: {}\n");
});

test("rejects the optional controller host-tool lane during preflight", async () => {
	const fixture = await ompFixture();
	const route = await routeFor(fixture);
	const adapter = new OmpAdapter({
		launcher: fixture.executable,
		expectedVersion: "18.0.6",
		expectedSha256: fixture.digest,
		route,
		containmentProbe: validContainmentProof,
		containmentMechanismSha256: CONTAINMENT_MECHANISM_SHA256,
		enableReadOnlyHostTools: true,
	});
	const doctor = await adapter.doctor();
	const issues = await adapter.preflight(spec(await repository()), doctor);
	assert.ok(issues.some((issue) => issue.code === "OMP_HOST_TOOLS_DISABLED"));
	assert.equal(doctor.compatibility, "degraded", JSON.stringify(doctor, null, 2));
	assert.equal(doctor.probe.executionQualified, false);
	assert.match(doctor.notices.join("\n"), /path-component TOCTOU races/);
});

containedTest("keeps controller host tools disabled by default under process containment", async () => {
	const fixture = await ompFixture({ hostToolCallPath: "note.txt" });
	const route = await routeFor(fixture);
	const { controller } = await controllerFor(fixture, route);
	const cwd = await repository();
	await writeFile(join(cwd, "note.txt"), "must not be served\n", { encoding: "utf8", mode: 0o600 });
	const receipt = await controller.run(spec(cwd));
	assert.equal(receipt.status, "blocked");
	assert.match(receipt.notices.join("\n"), /unexpected interactive OMP request: host_tool_call/);
});

containedTest("fails closed when contained OMP changes route identity after the prompt", async () => {
	const fixture = await ompFixture({ routeDrift: true });
	const { controller } = await controllerFor(fixture, await routeFor(fixture));
	const receipt = await controller.run(spec(await repository()));
	assert.equal(receipt.status, "failed");
	assert.match(receipt.notices.join("\n"), /route or reasoning drifted/);
});

containedTest("normalizes unexpected contained OMP approval requests as blocked", async () => {
	const fixture = await ompFixture({ approval: true });
	const { controller } = await controllerFor(fixture, await routeFor(fixture));
	const receipt = await controller.run(spec(await repository()));
	assert.equal(receipt.status, "blocked");
	assert.match(receipt.notices.join("\n"), /unexpected interactive OMP request/);
});

containedTest("blocks unexpected OMP tools under process containment", async () => {
	const fixture = await ompFixture({ unexpectedTool: true });
	const { controller } = await controllerFor(fixture, await routeFor(fixture));
	const receipt = await controller.run(spec(await repository()));
	assert.equal(receipt.status, "blocked");
	assert.match(receipt.notices.join("\n"), /unexpected OMP tool/);
});

containedTest("fails malformed contained OMP RPC chunk sequences", async () => {
	const fixture = await ompFixture({ malformedChunk: true });
	const { controller } = await controllerFor(fixture, await routeFor(fixture));
	const receipt = await controller.run(spec(await repository()));
	assert.equal(receipt.status, "failed");
	assert.match(receipt.notices.join("\n"), /chunk sequence did not start/);
});

containedTest("fails contained OMP RPC chunks whose cumulative payload exceeds the declared length", async () => {
	const fixture = await ompFixture({ oversizedChunk: true });
	const { controller } = await controllerFor(fixture, await routeFor(fixture));
	const receipt = await controller.run(spec(await repository()));
	assert.equal(receipt.status, "failed");
	assert.match(receipt.notices.join("\n"), /exceeded its declared length/);
});

containedTest("fails malformed JSON emitted during a contained OMP turn", async () => {
	const fixture = await ompFixture({ malformedJson: true });
	const { controller } = await controllerFor(fixture, await routeFor(fixture));
	const receipt = await controller.run(spec(await repository()));
	assert.equal(receipt.status, "failed");
	assert.match(receipt.notices.join("\n"), /malformed JSON/);
});

containedTest("fails invalid UTF-8 emitted during a contained OMP turn", async () => {
	const fixture = await ompFixture({ invalidUtf8: true });
	const { controller } = await controllerFor(fixture, await routeFor(fixture));
	const receipt = await controller.run(spec(await repository()));
	assert.equal(receipt.status, "failed");
	assert.match(receipt.notices.join("\n"), /invalid UTF-8/);
});

containedTest("rejects a contained prompt acknowledgement that did not invoke the agent", async () => {
	const fixture = await ompFixture({ promptNotInvoked: true });
	const { controller } = await controllerFor(fixture, await routeFor(fixture));
	const receipt = await controller.run(spec(await repository()));
	assert.equal(receipt.status, "failed");
	assert.match(receipt.notices.join("\n"), /did not acknowledge a model-backed agent turn/);
});

containedTest("accepts an omitted agentInvoked hint and relies on the observed agent lifecycle", async () => {
	const fixture = await ompFixture({ promptAckOmitted: true });
	const { controller } = await controllerFor(fixture, await routeFor(fixture));
	const receipt = await controller.run(spec(await repository()));
	assert.equal(receipt.status, "completed");
	assert.equal(receipt.finalOutput, "OMP fixture complete");
});

containedTest("classifies a terminal OMP provider error without retaining its text", async () => {
	const fixture = await ompFixture({
		terminalStopReason: "error",
		completionText: "HTTP 401 OMP_PROVIDER_SECRET_SENTINEL",
	});
	const { controller, stateRoot } = await controllerFor(fixture, await routeFor(fixture));
	const receipt = await controller.run(spec(await repository()));
	assert.equal(receipt.status, "failed");
	assert.equal(receipt.finalOutput, undefined);
	assert.match(receipt.notices.join("\n"), /terminal provider outcome: error; category=auth; httpStatus=401; rawUtf8Bytes=37; sha256=[a-f0-9]{64}/);
	const runDirectory = join(stateRoot, "runs", receipt.runId);
	const persisted = (await Promise.all([
		readFile(join(runDirectory, "receipt.json"), "utf8"),
		readFile(join(runDirectory, "events.jsonl"), "utf8"),
		readFile(join(runDirectory, "stdout.log"), "utf8"),
		readFile(join(runDirectory, "stderr.log"), "utf8"),
	])).join("\n");
	assert.doesNotMatch(persisted, /OMP_PROVIDER_SECRET_SENTINEL/);
});

containedTest("classifies an empty terminal OMP response", async () => {
	const fixture = await ompFixture({ completionText: "   " });
	const { controller } = await controllerFor(fixture, await routeFor(fixture));
	const receipt = await controller.run(spec(await repository()));
	assert.equal(receipt.status, "failed");
	assert.equal(receipt.finalOutput, undefined);
	assert.match(receipt.notices.join("\n"), /terminal provider outcome: empty-output/);
});

containedTest("classifies a provider request error without retaining its raw error", async () => {
	const fixture = await ompFixture({ promptResponseFailure: true, promptResponseError: "HTTP 429 OMP_PROVIDER_ERROR_SENTINEL" });
	const { controller, stateRoot } = await controllerFor(fixture, await routeFor(fixture));
	const receipt = await controller.run(spec(await repository()));
	assert.equal(receipt.status, "failed");
	assert.match(receipt.notices.join("\n"), /provider request failed before a terminal response; category=rate-limit; httpStatus=429; rawUtf8Bytes=36; sha256=[a-f0-9]{64}/);
	const persisted = await readFile(join(stateRoot, "runs", receipt.runId, "events.jsonl"), "utf8");
	assert.doesNotMatch(persisted, /OMP_PROVIDER_ERROR_SENTINEL/);
});

containedTest("classifies a structured provider server error without retaining its fields", async () => {
	const fixture = await ompFixture({
		promptResponseFailure: true,
		promptResponseError: { status: 503, message: "OMP_PROVIDER_STRUCTURED_SECRET" },
	});
	const { controller, stateRoot } = await controllerFor(fixture, await routeFor(fixture));
	const receipt = await controller.run(spec(await repository()));
	assert.equal(receipt.status, "failed");
	assert.match(receipt.notices.join("\n"), /category=server; httpStatus=503; rawUtf8Bytes=\d+; sha256=[a-f0-9]{64}/);
	const persisted = (await Promise.all([
		readFile(join(stateRoot, "runs", receipt.runId, "receipt.json"), "utf8"),
		readFile(join(stateRoot, "runs", receipt.runId, "events.jsonl"), "utf8"),
	])).join("\n");
	assert.doesNotMatch(persisted, /OMP_PROVIDER_STRUCTURED_SECRET/);
});

for (const { name, completionText, category, status } of [
	{ name: "server", completionText: "HTTP 503 OMP_PROVIDER_SERVER_SECRET", category: "server", status: 503 },
	{ name: "unknown", completionText: "provider-state-opaque OMP_PROVIDER_UNKNOWN_SECRET", category: "unknown", status: undefined },
]) {
	containedTest(`classifies a terminal OMP ${name} failure without retaining its text`, async () => {
		const fixture = await ompFixture({ terminalStopReason: "error", completionText });
		const { controller, stateRoot } = await controllerFor(fixture, await routeFor(fixture));
		const receipt = await controller.run(spec(await repository()));
		assert.equal(receipt.status, "failed");
		assert.equal(receipt.finalOutput, undefined);
		assert.match(receipt.notices.join("\n"), new RegExp(`terminal provider outcome: error; category=${category};`));
		if (status === undefined) assert.doesNotMatch(receipt.notices.join("\n"), /httpStatus=/);
		else assert.match(receipt.notices.join("\n"), new RegExp(`httpStatus=${status};`));
		const persisted = await readFile(join(stateRoot, "runs", receipt.runId, "events.jsonl"), "utf8");
		assert.doesNotMatch(persisted, /OMP_PROVIDER_(?:SERVER|UNKNOWN)_SECRET/);
	});
}

containedTest("rejects a later prompt_result that reports a local-only prompt", async () => {
	const fixture = await ompFixture({ promptAckOmitted: true, promptResultFalse: true });
	const { controller } = await controllerFor(fixture, await routeFor(fixture));
	const receipt = await controller.run(spec(await repository()));
	assert.equal(receipt.status, "failed");
	assert.match(receipt.notices.join("\n"), /completed without a model-backed agent turn/);
});

containedTest("rejects session persistence that appears after a contained ephemeral prompt", async () => {
	const fixture = await ompFixture({ persistedSession: true });
	const { controller } = await controllerFor(fixture, await routeFor(fixture));
	const receipt = await controller.run(spec(await repository()));
	assert.equal(receipt.status, "failed");
	assert.match(receipt.notices.join("\n"), /unexpected session state/);
});

test("blocks doctor qualification when the RPC state exposes an extra tool", async () => {
	const fixture = await ompFixture({ unexpectedStateTool: true });
	const route = await routeFor(fixture);
	const adapter = new OmpAdapter({
		launcher: fixture.executable,
		expectedVersion: "18.0.6",
		 expectedSha256: fixture.digest,
		route,
		containmentProbe: validContainmentProof,
		containmentMechanismSha256: CONTAINMENT_MECHANISM_SHA256,
	});
	const doctor = await adapter.doctor();
	assert.equal(doctor.compatibility, "blocked");
	assert.equal(doctor.probe.executionQualified, false);
});

test("blocks doctor qualification when ambient instructions enter the system prompt", async () => {
	const fixture = await ompFixture({ ambientPrompt: true });
	const route = await routeFor(fixture);
	const adapter = new OmpAdapter({
		launcher: fixture.executable,
		expectedVersion: "18.0.6",
		expectedSha256: fixture.digest,
		route,
		containmentProbe: validContainmentProof,
		containmentMechanismSha256: CONTAINMENT_MECHANISM_SHA256,
	});
	const doctor = await adapter.doctor();
	assert.equal(doctor.compatibility, "blocked");
	assert.equal(doctor.probe.executionQualified, false);
});

test("rejects ambient system-prompt state before and after an OMP turn", async () => {
	const fixture = await ompFixture();
	const route = await routeFor(fixture);
	const state = {
		model: { provider: route.provider, id: route.model },
		thinkingLevel: route.reasoning,
		systemPrompt: [OMP_CONTROLLER_SYSTEM_PROMPT, OMP_FIXTURE_PROJECT_PROMPT],
		dumpTools: [{ name: "glob" }, { name: "grep" }, { name: "read" }],
	};
	assert.equal(ompRuntimeStateIssue(state, route), undefined);
	assert.match(
		ompRuntimeStateIssue({ ...state, systemPrompt: [OMP_CONTROLLER_SYSTEM_PROMPT, "<instructions>unreviewed</instructions>"] }, route),
		/system prompt contains ambient instructions/,
	);
	assert.match(ompRuntimeStateIssue({ ...state, systemPrompt: undefined }, route), /system prompt/);
	assert.match(ompRuntimeSystemPromptIssue([`prefix ${OMP_CONTROLLER_SYSTEM_PROMPT}`, OMP_FIXTURE_PROJECT_PROMPT]), /does not exactly match/);
	assert.match(ompRuntimeSystemPromptIssue([`${OMP_CONTROLLER_SYSTEM_PROMPT} suffix`, OMP_FIXTURE_PROJECT_PROMPT]), /does not exactly match/);
	assert.match(ompRuntimeSystemPromptIssue([OMP_CONTROLLER_SYSTEM_PROMPT, OMP_FIXTURE_PROJECT_PROMPT, "third segment"]), /invalid controller-owned shape/);
	assert.match(ompRuntimeSystemPromptIssue([OMP_CONTROLLER_SYSTEM_PROMPT, OMP_FIXTURE_PROJECT_PROMPT + "x".repeat(33 * 1024)]), /exceeds/);
});

containedTest("fails a run when the controller-owned OMP system prompt changes during execution", async () => {
	const fixture = await ompFixture({ systemPromptDrift: true });
	const { controller } = await controllerFor(fixture, await routeFor(fixture));
	const receipt = await controller.run(spec(await repository()));
	assert.equal(receipt.status, "failed");
	assert.match(receipt.notices.join("\n"), /system-prompt digest differs|system prompt changed during/);
});

test("copies the reviewed OMP model catalog from stable no-follow bytes", async () => {
	const source = await trackedMkdtemp(join(tmpdir(), "ox-driver-omp-model-source-"));
	const runDirectory = await trackedMkdtemp(join(tmpdir(), "ox-driver-omp-model-run-"));
	const sourcePath = join(source, "models.yml");
	await writeFile(sourcePath, "providers: {}\n", { encoding: "utf8", mode: 0o600 });
	const isolation = await createOmpRuntimeIsolation(source, runDirectory);
	assert.deepEqual(isolation.modelConfig, { name: "models.yml", sha256: await sha256(sourcePath) });
	assert.equal(await sha256(join(isolation.agentDirectory, "models.yml")), isolation.modelConfig.sha256);

	const symlinkSource = await trackedMkdtemp(join(tmpdir(), "ox-driver-omp-model-symlink-"));
	await symlink(sourcePath, join(symlinkSource, "models.yml"));
	await assert.rejects(
		createOmpRuntimeIsolation(symlinkSource, await trackedMkdtemp(join(tmpdir(), "ox-driver-omp-model-symlink-run-"))),
		/not a regular file/,
	);
});

test("blocks doctor qualification on duplicate ready frames", async () => {
	const fixture = await ompFixture({ duplicateReady: true });
	const route = await routeFor(fixture);
	const adapter = new OmpAdapter({
		launcher: fixture.executable,
		expectedVersion: "18.0.6",
		expectedSha256: fixture.digest,
		route,
		containmentProbe: validContainmentProof,
		containmentMechanismSha256: CONTAINMENT_MECHANISM_SHA256,
	});
	const doctor = await adapter.doctor();
	assert.equal(doctor.compatibility, "blocked");
	assert.equal(doctor.probe.executionQualified, false);
});

containedTest("blocks a contained harness from mutating the controller overlay", async () => {
	const fixture = await ompFixture({ mutateOverlay: true });
	const { controller, stateRoot } = await controllerFor(fixture, await routeFor(fixture));
	const receipt = await controller.run(spec(await repository()));
	assert.equal(receipt.status, "failed");
	assert.match(receipt.notices.join("\n"), /emitted stderr/);
	const overlay = JSON.parse(await readFile(join(stateRoot, "runs", receipt.runId, "omp-isolation", "controller-overlay.json"), "utf8"));
	assert.deepEqual(overlay.extensions, []);
});

containedTest("rejects contained terminal OMP events not preceded by agent_start", async () => {
	const fixture = await ompFixture({ missingAgentStart: true });
	const { controller } = await controllerFor(fixture, await routeFor(fixture));
	const receipt = await controller.run(spec(await repository()));
	assert.equal(receipt.status, "failed");
	assert.match(receipt.notices.join("\n"), /out-of-order terminal agent_end/);
});

containedTest("fails a run when controller-observed OMP route configuration changes during execution", async () => {
	const markerName = "route-mutation-ready";
	const fixture = await ompFixture({ routeMutationMarkerName: markerName });
	const route = await routeFor(fixture);
	const routeConfig = join(route.agentDirectory, "models.yml");
	await writeFile(routeConfig, "providers: {}\n", { encoding: "utf8", mode: 0o600 });
	const { controller, stateRoot } = await controllerFor(fixture, route);
	const cwd = await repository();
	const runId = "omp-controller-route-drift";
	const run = controller.run(spec(cwd), { runId });
	await waitForPath(join(stateRoot, "runs", runId, "omp-isolation", "tmp", markerName));
	await writeFile(routeConfig, "providers:\n  drift: {}\n", { encoding: "utf8", mode: 0o600 });
	const receipt = await run;
	assert.equal(receipt.status, "failed");
	assert.match(receipt.notices.join("\n"), /route or process-bound containment enforcement changed during the run/);
});

containedTest("cancels a contained OMP process that never reaches a terminal agent event", async () => {
	const fixture = await ompFixture({ hang: true });
	const { controller } = await controllerFor(fixture, await routeFor(fixture));
	const receipt = await controller.run(spec(await repository(), 1));
	assert.equal(receipt.status, "cancelled");
});

test("rejects OMP writers, teams, persistent sessions, and unqualified routes", async () => {
	const fixture = await ompFixture();
	const adapter = new OmpAdapter({ launcher: fixture.executable, expectedVersion: "18.0.6", expectedSha256: fixture.digest });
	const doctor = await adapter.doctor();
	const candidate = spec(await repository());
	candidate.tier = "trusted-host";
	candidate.execution.session = "new";
	candidate.execution.topology = "hierarchical";
	candidate.execution.writerPolicy = "one-writer";
	const issues = await adapter.preflight(candidate, doctor);
	assert.ok(issues.some((issue) => issue.code === "OMP_SESSION_UNVERIFIED"));
	assert.ok(issues.some((issue) => issue.code === "OMP_TIER_UNSUPPORTED"));
	assert.ok(issues.some((issue) => issue.code === "OMP_TOPOLOGY_UNVERIFIED"));
	assert.ok(issues.some((issue) => issue.code === "OMP_WRITER_UNVERIFIED"));
	assert.ok(issues.some((issue) => issue.code === "OMP_ROUTE_REQUIRED"));
	assert.ok(issues.some((issue) => issue.code === "OMP_CONTAINMENT_UNVERIFIED"));
});

test("qualifies RPC transport but blocks dispatch by default without mechanical containment", async () => {
	const fixture = await ompFixture();
	const route = await routeFor(fixture);
	const adapter = new OmpAdapter({
		launcher: fixture.executable,
		expectedVersion: "18.0.6",
		expectedSha256: fixture.digest,
		route,
		enableProcessContainment: false,
	});
	const doctor = await adapter.doctor();
	assert.equal(doctor.compatibility, "degraded");
	assert.equal(doctor.capabilities["events.structured"], true);
	assert.equal(doctor.capabilities["sandbox.filesystem"], false);
	assert.equal(doctor.probe.executionQualified, false);
	const candidate = spec(await repository());
	delete candidate.routeProfile;
	const issues = await adapter.preflight(candidate, doctor);
	assert.ok(issues.some((issue) => issue.code === "ROUTE_PROFILE_REQUIRED"));
	assert.ok(issues.some((issue) => issue.code === "OMP_CONTAINMENT_UNVERIFIED"));
});

test("rejects route environments that override controller-owned isolation variables", async () => {
	const fixture = await ompFixture();
	const route = await routeFor(fixture);
	route.environment.HOME = "/tmp/ambient-home";
	const adapter = new OmpAdapter({
		launcher: fixture.executable,
		expectedVersion: "18.0.6",
		expectedSha256: fixture.digest,
		route,
		containmentProbe: validContainmentProof,
		containmentMechanismSha256: CONTAINMENT_MECHANISM_SHA256,
	});
	const doctor = await adapter.doctor();
	assert.equal(doctor.compatibility, "degraded");
	assert.equal(doctor.capabilities["route.configured"], false);
	assert.match(doctor.notices.join("\n"), /may not override controller environment HOME/);
});

test("blocks unknown route-agent entries without treating credential state as configuration", async () => {
	const fixture = await ompFixture();
	const route = await routeFor(fixture);
	await writeFile(join(route.agentDirectory, "agent.db"), "credential-state-sentinel", { encoding: "utf8", mode: 0o000 });
	const adapter = new OmpAdapter({
		launcher: fixture.executable,
		expectedVersion: "18.0.6",
		expectedSha256: fixture.digest,
		route,
		containmentProbe: validContainmentProof,
		containmentMechanismSha256: CONTAINMENT_MECHANISM_SHA256,
	});
	const doctor = await adapter.doctor();
	assert.equal(doctor.compatibility, "degraded");
	assert.equal(doctor.capabilities["route.configured"], false);
	assert.match(doctor.notices.join("\n"), /unsupported entry: agent.db/);
});

test("does not execute an OMP artifact whose digest drifted", async () => {
	const directory = await trackedMkdtemp(join(tmpdir(), "ox-driver-omp-drift-"));
	const sentinel = join(directory, "executed");
	const fixture = await ompFixture({ executionSentinel: sentinel });
	const adapter = new OmpAdapter({
		launcher: fixture.executable,
		expectedVersion: "18.0.6",
		expectedSha256: "0".repeat(64),
	});
	const doctor = await adapter.doctor();
	assert.equal(doctor.compatibility, "blocked");
	assert.equal(doctor.probe.artifact, "drifted");
	await assert.rejects(access(sentinel));
});
