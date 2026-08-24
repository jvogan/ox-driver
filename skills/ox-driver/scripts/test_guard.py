#!/usr/bin/env python3
"""Offline structural and negative tests for an installed Ox Driver guard."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path


def check(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"GUARD_TEST_FAIL: {message}")


def run(
    command: list[str], cwd: Path, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command, cwd=cwd, env=env, text=True, capture_output=True, check=False
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config-dir", type=Path, required=True)
    args = parser.parse_args()
    config = args.config_dir.expanduser().resolve()
    root = config / "bin" / "pi-ox"
    child = config / "bin" / "pi-child"
    safety = config / "extensions" / "pi-safety.ts"
    resilience = config / "extensions" / "pi-resilience.ts"
    sandbox = config / "extensions" / "sandbox" / "index.ts"
    sensitive_paths = config / "extensions" / "sandbox" / "sensitive-paths.ts"
    sandbox_config = config / "extensions" / "sandbox.json"
    dependency = (
        config
        / "extensions"
        / "sandbox"
        / "node_modules"
        / "@anthropic-ai"
        / "sandbox-runtime"
    )

    for path in (root, child, safety, resilience, sandbox, sensitive_paths, sandbox_config):
        check(path.is_file() and not path.is_symlink(), f"missing or symlinked {path}")
    check(os.access(root, os.X_OK) and os.access(child, os.X_OK), "launchers are not executable")
    check(dependency.is_dir(), "sandbox dependency is missing")
    check(run(["bash", "-n", str(root)], config).returncode == 0, "pi-ox shell syntax")
    check(run(["bash", "-n", str(child)], config).returncode == 0, "pi-child shell syntax")

    safety_text = safety.read_text(encoding="utf-8")
    sandbox_text = sandbox.read_text(encoding="utf-8")
    launcher_text = root.read_text(encoding="utf-8")
    resilience_text = resilience.read_text(encoding="utf-8")
    for required in (
        'if (process.env.OX_DRIVER_GUARD_READY !== "1") return;',
        "nested agent runtimes are disabled",
        "PI_SUBAGENT_",
        "Paths outside the current project are blocked",
        "realpathSync",
		'normalized.includes("/.aws/")',
		'normalized.includes("/.codex/")',
		'normalized.includes("/.kube/")',
        'pi.on("before_agent_start"',
        'pi.on("model_select"',
    ):
        check(required in safety_text, f"pi-safety invariant missing: {required}")
    check("env: bashEnv" in sandbox_text, "sandbox does not forward the filtered Pi environment")
    check("TMPDIR: runtimeTmp" in sandbox_text, "sandbox does not force an allowed temporary directory")
    check("CLAUDE_CODE_TMPDIR" in sandbox_text, "sandbox runtime temporary directory is not isolated")
    check("mkdtempSync" in sandbox_text and "chmodSync(created, 0o700)" in sandbox_text, "sandbox runtime temporary directory is not created privately")
    check("realpathSync(getAgentDir())" in sandbox_text, "sandbox does not canonicalize the protected agent directory")
    check('name.startsWith("PI_SUBAGENT_")' in sandbox_text, "bash can read supervisor state")
    check("PRIVATE_PROXY_ENV.has(name)" in sandbox_text, "bash can read credential-bearing proxy variables")
    check("Required bash sandbox unavailable" in sandbox_text, "sandbox is not fail-closed")
    check("if (required) ctx.shutdown();" in sandbox_text, "required sandbox failure does not terminate the guarded session")
    check('const systemTmp = realpathSync("/tmp");' in sandbox_text, "canonical system temp is writable")
    check("systemTmp, runtimePath" in sandbox_text, "system and private temp paths are permitted")
    check('const openNetwork = config.networkMode === "open";' in sandbox_text, "open network mode is missing")
    check("openNetwork ? async () => true : undefined" in sandbox_text, "open network mode is not explicit")
    check("CACHE_TTL_SECONDS=60" in launcher_text, "catalog cache TTL is not fixed")
    check('printf \'%s\\n\' "$$" >"$lock/owner"' in launcher_text, "cache lock has no owner record")
    check('! kill -0 "$owner"' in launcher_text, "stale cache locks are not recovered")
    check("inspect the self-healing cache lock" in launcher_text, "catalog failure does not identify its lock")
    check("HTTPS_PROXY" in launcher_text and "SSL_CERT_FILE" in launcher_text, "proxy or CA environment is stripped")
    check("recursive filesystem deletion is disabled" in safety_text, "recursive deletion is not hard-blocked")
    check("irreversible Git remote operations are disabled" in safety_text, "forced Git remote changes are not hard-blocked")
    check("--connect-timeout 5" in launcher_text and "--max-time 20" in launcher_text, "catalog checks have no deadline")
    check("now - lock_mtime > 2" in launcher_text, "ownerless catalog locks are not recovered")
    for system_root in ("/dev", "/proc", "/sys", "/run", "/boot", "/mnt", "/srv"):
        check(system_root in launcher_text, f"launcher does not reject system root {system_root}")
    check("sha512-XBmKqvrj4mCVQ6/" in launcher_text, "pi-subagents registry integrity is not enforced")
    check("Object.values(model?.pricing" in launcher_text, "not every advertised price is checked")
    check("exec env -i" in launcher_text, "Pi does not receive a minimal environment")
    check("export HOME=" in launcher_text and "@TRUSTED_HOME@" not in launcher_text, "launcher does not pin the trusted account home")
    check('mktemp -d /tmp/ox-driver-runtime.XXXXXX' in launcher_text, "launcher does not create a private per-root temporary directory")
    check("cleanup_runtime_temp" in launcher_text, "launcher does not clean its private runtime temporary directory")
    check("pi-resilience.ts" in launcher_text, "bounded resilience extension is not loaded")
    check("existing child session target must be a regular owned file" in launcher_text, "existing child session type and owner validation is missing")
    check(
        'message.stopReason === "stop" && message.content.length === 0'
        in resilience_text,
        "empty-success resilience guard is missing or too broad",
    )
    check(
        'message.errorMessage?.trim().toUpperCase() === "ERROR"' in resilience_text,
        "bare-error resilience guard is missing or too broad",
    )
    check("usage.input > 0" in resilience_text, "resilience guard does not require zero usage")

    resilience_probe = f"""
import resilience from {json.dumps(resilience.resolve().as_uri())};
let handler;
delete process.env.OX_DRIVER_GUARD_READY;
resilience({{ on: (_name, value) => {{ handler = value; }} }});
if (handler) process.exit(20);
process.env.OX_DRIVER_GUARD_READY = "1";
resilience({{ on: (_name, value) => {{ handler = value; }} }});
if (!handler) process.exit(21);
const usage = {{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }};
const event = (changes) => ({{ message: {{ role: "assistant", content: [], stopReason: "stop", usage, ...changes }} }});
const empty = await handler(event({{}}));
if (empty?.message?.stopReason !== "error" || !empty.message.errorMessage.includes("empty successful")) process.exit(22);
const bare = await handler(event({{ stopReason: "error", errorMessage: "ERROR" }}));
if (bare?.message?.stopReason !== "error" || !bare.message.errorMessage.startsWith("Provider returned error:")) process.exit(23);
if (await handler(event({{ stopReason: "error", errorMessage: "permission denied" }}))) process.exit(24);
if (await handler(event({{ content: [{{ type: "text", text: "ok" }}] }}))) process.exit(25);
if (await handler(event({{ usage: {{ ...usage, input: 1 }} }}))) process.exit(26);
"""
    resilience_result = run(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", resilience_probe],
        config,
    )
    check(
        resilience_result.returncode == 0,
        f"resilience behavior probe failed: {resilience_result.stderr.strip()}",
    )

    policy = json.loads(sandbox_config.read_text(encoding="utf-8"))
    check(policy.get("enabled") is False, "normal raw Pi sandbox default changed")
    check(policy.get("networkMode") in ("open", "restricted"), "unknown network mode")
    check("." in policy["filesystem"]["allowWrite"], "project writes are not allowed")
    check("~" in policy["filesystem"]["denyRead"], "sandbox Bash can broadly read the home directory")
    check("~" not in policy["filesystem"]["denyWrite"], "home-wide deny would shadow the selected project")
    check("." in policy["filesystem"]["allowRead"], "sandbox Bash cannot read the project")
    check('allowRead: ["."]' in sandbox_text, "sandbox default does not preserve workspace-scoped Bash reads")
    check("~/.pi/agent/auth.json" in policy["filesystem"]["denyRead"], "Pi auth is readable")
    check(str(config / "auth.json") in policy["filesystem"]["denyRead"], "custom Pi auth path is readable")
    for secret_pattern in (".env", ".env.*", "*.pem", "*.key", ".npmrc"):
        check(secret_pattern in policy["filesystem"]["denyRead"], f"bash can read {secret_pattern}")
    for secret_dir in (".ssh", ".aws", ".kube", ".docker", ".codex", ".agents", ".claude", ".azure", ".config/gh", ".config/gcloud", ".config/opencode"):
        check(secret_dir in policy["filesystem"]["denyRead"], f"bash can read future {secret_dir} files")
        check(secret_dir in policy["filesystem"]["denyWrite"], f"bash can write future {secret_dir} files")

    with tempfile.TemporaryDirectory() as temporary:
        allowed = Path(temporary)
        child_env = os.environ.copy()
        child_env["OX_DRIVER_ROOT_CWD"] = str(allowed)
        child_env["PI_SUBAGENT_CHILD_AGENT"] = "pi-agent"
        child_env["PI_SUBAGENT_CHILD"] = "1"
        child_env["PI_SUBAGENT_FANOUT_CHILD"] = "0"
        child_env["PI_SUBAGENT_DEPTH"] = "1"
        child_env["PI_SUBAGENT_MAX_DEPTH"] = "2"
        child_runtime_context = tempfile.TemporaryDirectory(prefix="ox-driver-runtime.", dir="/tmp")
        child_runtime = Path(child_runtime_context.name).resolve()
        child_runtime.chmod(0o700)
        child_env["OX_DRIVER_RUNTIME_TMP"] = str(child_runtime)
        child_env["TMPDIR"] = str(child_runtime)
        wrong_model = run(
            [str(child), "--model", "openrouter/paid/model:max", "--tools", "read", "-p", "test"],
            allowed,
            child_env,
        )
        check(wrong_model.returncode != 0 and "outside policy" in wrong_model.stderr, "paid child model was not rejected")
        low_thinking = run(
            [str(child), "--model", "openrouter/stealth/ox-alpha:low", "--tools", "read", "-p", "test"],
            allowed,
            child_env,
        )
        check(low_thinking.returncode != 0 and "must use :max" in low_thinking.stderr, "low child thinking was not rejected")
        root_override = run([str(root), "--model", "other/model", "-p", "test"], allowed)
        check(root_override.returncode != 0 and "policy overrides" in root_override.stderr, "root model override was not rejected")
        api_key = run([str(root), "--api-key", "not-a-secret", "-p", "test"], allowed)
        check(api_key.returncode != 0 and "API keys" in api_key.stderr, "root API-key injection was not rejected")
        alternate_cwd = run([str(root), "--cwd", str(Path.home()), "-p", "test"], allowed)
        check(alternate_cwd.returncode != 0 and "alternate cwd" in alternate_cwd.stderr, "alternate cwd was not rejected")
        no_sandbox = run([str(root), "--no-sandbox", "-p", "test"], allowed)
        check(no_sandbox.returncode != 0 and "policy overrides" in no_sandbox.stderr, "sandbox negation was not rejected")
        sandbox_false = run([str(root), "--sandbox=false", "-p", "test"], allowed)
        check(sandbox_false.returncode != 0 and "policy overrides" in sandbox_false.stderr, "sandbox false override was not rejected")
        child_sandbox_false = run(
            [str(child), "--sandbox=false", "--model", "openrouter/stealth/ox-alpha:max", "--tools", "read", "-p", "test"],
            allowed,
            child_env,
        )
        check(child_sandbox_false.returncode != 0 and "protected runtime surface" in child_sandbox_false.stderr, "child sandbox false override was not rejected")
        extra_extension = run([str(root), "--extension", str(safety), "-p", "test"], allowed)
        check(extra_extension.returncode != 0 and "policy overrides" in extra_extension.stderr, "root extension injection was not rejected")
        model_scope = run([str(root), "--models", "*", "-p", "test"], allowed)
        check(model_scope.returncode != 0 and "policy overrides" in model_scope.stderr, "model picker widening was not rejected")
        approve = run([str(root), "--approve", "-p", "test"], allowed)
        check(approve.returncode != 0 and "policy overrides" in approve.stderr, "project trust override was not rejected")
        attachment = run([str(root), "-p", "@.env", "test"], allowed)
        check(attachment.returncode != 0 and "unreviewed file inputs" in attachment.stderr, "pre-hook file attachment was not rejected")
        system_prompt = run([str(root), "--append-system-prompt", ".env", "-p", "test"], allowed)
        check(system_prompt.returncode != 0 and "unreviewed file inputs" in system_prompt.stderr, "system-prompt file input was not rejected")

        project = allowed / "project"
        project.mkdir()
        (project / "escape-file").symlink_to("/etc/hosts")
        (project / "escape-dir").symlink_to("/etc", target_is_directory=True)
        (project / ".env").write_text("SYNTHETIC_ONLY=1\n", encoding="utf-8")
        docker_context = project / ".docker" / "contexts" / "meta.json"
        docker_context.parent.mkdir(parents=True)
        docker_context.write_text("SYNTHETIC_DOCKER_ONLY\n", encoding="utf-8")
        safe_source = project / "source"
        safe_source.mkdir()
        (safe_source / "main.ts").write_text("export const safe = true;\n", encoding="utf-8")
        (safe_source / ".env.example").write_text("TOKEN=replace-me\n", encoding="utf-8")
        project_pi = project / ".pi" / "agent" / "sessions"
        project_pi.mkdir(parents=True)
        (project_pi / "prior.jsonl").write_text("private transcript\n", encoding="utf-8")
        module_url = safety.resolve().as_uri()
        policy_env = os.environ.copy()
        policy_env["PI_CODING_AGENT_DIR"] = str(config)
        probe = run(
            [
                "node",
                "--experimental-strip-types",
                "--input-type=module",
                "--eval",
                (
                    f'import {{ validateProjectPath }} from {json.dumps(module_url)}; '
                    'const [cwd, agentDir] = process.argv.slice(1); '
                    'if (!validateProjectPath("escape-file", cwd, false)) process.exit(10); '
                    'if (!validateProjectPath("escape-dir/new.txt", cwd, true)) process.exit(11); '
                    'if (!validateProjectPath(agentDir + "/bin/pi-child", cwd, false)) process.exit(12); '
                    'if (!validateProjectPath(agentDir + "/bin/pi-child", cwd, true)) process.exit(13); '
                    'if (!validateProjectPath(".pi/agent/sessions/prior.jsonl", cwd, false)) process.exit(14); '
                    'if (validateProjectPath("source/main.ts", cwd, false)) process.exit(15);'
                    'if (!validateProjectPath(".docker", cwd, false)) process.exit(16); '
                    'if (!validateProjectPath(".docker/contexts/meta.json", cwd, false)) process.exit(17);'
                ),
                str(project),
                str(config),
            ],
            project,
            policy_env,
        )
        check(probe.returncode == 0, f"symlink escape was not blocked: {probe.stderr}")

        activation_probe = run(
            [
                "node",
                "--experimental-strip-types",
                "--input-type=module",
                "--eval",
                (
                    f'import piSafety from {json.dumps(module_url)}; '
                    'let registrations = 0; '
                    'const pi = { on() { registrations += 1; } }; '
                    'delete process.env.OX_DRIVER_GUARD_READY; '
                    'piSafety(pi); '
                    'if (registrations !== 0) process.exit(20); '
                    'process.env.OX_DRIVER_GUARD_READY = "1"; '
                    'piSafety(pi); '
                    'if (registrations !== 4) process.exit(21);'
                ),
            ],
            project,
            policy_env,
        )
        check(
            activation_probe.returncode == 0,
            f"pi-safety raw/guarded activation boundary failed: {activation_probe.stderr}",
        )

        recursive_probe = run(
            [
                "node",
                "--experimental-strip-types",
                "--input-type=module",
                "--eval",
                (
                    f'import piSafety from {json.dumps(module_url)}; '
                    'let handler; process.env.OX_DRIVER_GUARD_READY = "1"; '
                    'const pi = { on(name, fn) { if (name === "tool_call") handler = fn; }, getThinkingLevel() { return "max"; } }; '
                    'piSafety(pi); if (!handler) process.exit(40); '
                    'const result = await handler({ toolName: "grep", input: { pattern: "SYNTHETIC_ONLY", path: "." } }, { cwd: process.argv[1] }); '
                    'if (!result?.block || !result.reason.includes("sensitive file")) process.exit(41); '
                    'const safeSearch = await handler({ toolName: "grep", input: { pattern: "safe", path: "source" } }, { cwd: process.argv[1] }); '
                    'if (safeSearch !== undefined) process.exit(42); '
                    'const nestedCommands = ["env X=1 pi -p x", "env -i pi -p x", "bash -c \'pi -p x\'"]; '
                    'for (const command of nestedCommands) { const denied = await handler({ toolName: "bash", input: { command } }, { cwd: process.argv[1] }); if (!denied?.block) process.exit(50); } '
                    'const destructive = ["rm -rf /tmp/project", "rm -rf .", "find . -delete", "git clean -fd", "git reset --quiet --hard", "git push -f origin main", "git push origin +main", "git push origin :main", "git push --mirror origin", "git push --all --prune origin"]; '
                    'for (const command of destructive) { const denied = await handler({ toolName: "bash", input: { command } }, { cwd: process.argv[1] }); if (!denied?.block) process.exit(51); } '
                    'const shadow = await handler({ toolName: "subagent", input: { agent: "pi-agent", task: "x" } }, { cwd: process.argv[1] }); '
                    'if (!shadow?.block || !shadow.reason.includes("agentScope")) process.exit(43); '
                    'const pinned = await handler({ toolName: "subagent", input: { agent: "pi-agent", agentScope: "user", task: "x", async: true } }, { cwd: process.argv[1] }); '
                    'if (pinned !== undefined) process.exit(44); '
                    'const rootLead = await handler({ toolName: "subagent", input: { agent: "pi-lead", agentScope: "user", task: "x" } }, { cwd: process.argv[1] }); '
                    'if (rootLead !== undefined) process.exit(49); '
                    'const bad = ['
                    '{ agent: "pi-agent", agentScope: "project", task: "x" },'
                    '{ agent: "pi-agent", agentScope: "both", task: "x" },'
                    '{ agent: "pi-agent", agentScope: "user", task: "" },'
                    '{ agent: "unknown", agentScope: "user", task: "x" },'
                    '{ agent: "pi-agent ", agentScope: "user", task: "x" },'
                    '{ agent: "pi-agent", agentScope: "user", task: "x", action: "status" },'
                    '{ agent: "pi-agent", agentScope: "user", task: "x", workflowScript: null },'
                    '{ agent: "pi-agent", agentScope: "user", task: "x", gate: "true" },'
                    '{ agent: "pi-agent", agentScope: "user", task: "x", acceptance: {} },'
                    '{ agent: "pi-agent", agentScope: "user", task: "x", share: true },'
                    '{ agent: "pi-agent", agentScope: "user", task: "x", output: "/tmp/x" },'
                    '{ agent: "pi-agent", agentScope: "user", task: "x", cwd: "/tmp", worktree: true },'
                    '{ agent: "pi-agent", agentScope: "user", task: "x", extensions: [] }]; '
                    'for (const input of bad) { const denied = await handler({ toolName: "subagent", input }, { cwd: process.argv[1] }); if (!denied?.block) process.exit(45); } '
                    'process.env.PI_SUBAGENT_CHILD_AGENT = "pi-lead"; '
                    'if (await handler({ toolName: "subagent", input: { agent: "pi-agent", agentScope: "user", task: "x" } }, { cwd: process.argv[1] }) !== undefined) process.exit(46); '
                    'const nestedLead = await handler({ toolName: "subagent", input: { agent: "pi-lead", agentScope: "user", task: "x" } }, { cwd: process.argv[1] }); '
                    'if (!nestedLead?.block) process.exit(47); '
                    'process.env.PI_SUBAGENT_CHILD_AGENT = "pi-agent"; '
                    'const depth3 = await handler({ toolName: "subagent", input: { agent: "pi-agent", agentScope: "user", task: "x" } }, { cwd: process.argv[1] }); '
                    'if (!depth3?.block) process.exit(48);'
                ),
                str(project),
            ],
            project,
            policy_env,
        )
        check(recursive_probe.returncode == 0, f"recursive secret search was not blocked: {recursive_probe.stderr}")

        with tempfile.TemporaryDirectory() as review_directory:
            review_extension = Path(review_directory) / "pi-safety.ts"
            shutil.copy2(safety, review_extension)
            (Path(review_directory) / "pi-safety.json").write_text(
                json.dumps(
                    {"fileScope": "project", "permissionProfile": "review-only"}
                )
                + "\n",
                encoding="utf-8",
            )
            review_probe = run(
                [
                    "node",
                    "--experimental-strip-types",
                    "--input-type=module",
                    "--eval",
                    (
                        f'import piSafety from {json.dumps(review_extension.resolve().as_uri())}; '
                        'let handler; process.env.OX_DRIVER_GUARD_READY = "1"; '
                        'const pi = { on(name, fn) { if (name === "tool_call") handler = fn; }, getThinkingLevel() { return "max"; } }; '
                        'piSafety(pi); if (!handler) process.exit(50); '
                        'const blocked = await handler({ toolName: "subagent", input: { agent: "pi-agent", agentScope: "user", task: "x", worktree: true } }, { cwd: process.argv[1] }); '
                        'if (!blocked?.block || !blocked.reason.includes("review-only")) process.exit(51); '
                        'const ordinary = await handler({ toolName: "subagent", input: { agent: "pi-agent", agentScope: "user", task: "x", worktree: false } }, { cwd: process.argv[1] }); '
                        'if (ordinary !== undefined) process.exit(52);'
                    ),
                    str(project),
                ],
                project,
            )
            check(
                review_probe.returncode == 0,
                f"review-only worktree boundary failed: {review_probe.stderr}",
            )

        resilience_url = resilience.resolve().as_uri()
        resilience_probe = run(
            [
                "node",
                "--experimental-strip-types",
                "--input-type=module",
                "--eval",
                (
                    f'import piResilience from {json.dumps(resilience_url)}; '
                    'let handler; const pi = { on(name, fn) { if (name === "message_end") handler = fn; } }; '
                    'delete process.env.OX_DRIVER_GUARD_READY; piResilience(pi); '
                    'if (handler) process.exit(30); '
                    'process.env.OX_DRIVER_GUARD_READY = "1"; piResilience(pi); '
                    'if (!handler) process.exit(31); '
                    'const base = { role: "assistant", stopReason: "stop", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }; '
                    'const retry = await handler({ message: base }); '
                    'if (retry?.message?.stopReason !== "error") process.exit(32); '
                    'const used = await handler({ message: { ...base, usage: { ...base.usage, input: 1 } } }); '
                    'if (used !== undefined) process.exit(33); '
                    'const content = await handler({ message: { ...base, content: [{ type: "text", text: "ok" }] } }); '
                    'if (content !== undefined) process.exit(34);'
                ),
            ],
            project,
        )
        check(
            resilience_probe.returncode == 0,
            f"bounded resilience behavior failed: {resilience_probe.stderr}",
        )

        home_rejection = run([str(root), "-p", "test"], Path.home())
        child_runtime_context.cleanup()
    check(home_rejection.returncode != 0 and "sensitive working directory" in home_rejection.stderr, "home cwd was not rejected")
    print("GUARD_TEST_PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
