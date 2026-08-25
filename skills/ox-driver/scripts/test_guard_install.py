#!/usr/bin/env python3
"""Install and test the complete Ox Driver guard in a disposable Pi directory."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import json
import os
import shlex
import shutil
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent


def checked(command: list[str], cwd: Path | None = None) -> None:
    subprocess.run(command, cwd=cwd, check=True)


def effective_runtime_policy(policy: dict, linux_helper: Path | None = None) -> dict:
    effective = json.loads(json.dumps(policy))
    if sys.platform.startswith("linux"):
        deny_read = set(effective["filesystem"]["denyRead"])
        effective["filesystem"]["denyWrite"] = [
            entry for entry in effective["filesystem"]["denyWrite"] if entry not in deny_read
        ]
        if linux_helper is not None:
            effective["filesystem"].setdefault("allowRead", []).append(str(linux_helper))
    return effective


def fake_pi(root: Path) -> Path:
    package = root / "node_modules" / "@earendil-works" / "pi-coding-agent"
    executable = package / "dist" / "cli.py"
    executable.parent.mkdir(parents=True)
    (package / "package.json").write_text(
        json.dumps(
            {
                "name": "@earendil-works/pi-coding-agent",
                "version": "0.84.3",
                "bin": {"pi": "dist/cli.py"},
            }
        )
        + "\n",
        encoding="utf-8",
    )
    executable.write_text(
        "#!/usr/bin/env python3\n"
        "import os, sys\n"
        "if 'DATABASE_URL' in os.environ: sys.exit(20)\n"
        "if os.environ.get('OX_DRIVER_GUARD_READY') != '1': sys.exit(21)\n"
        "if os.environ.get('HOME') == '/': sys.exit(25)\n"
        "if '/ox-driver-runtime.' not in os.environ.get('TMPDIR', ''): sys.exit(26)\n"
        "if not any(arg.endswith('/extensions/pi-image-budget.ts') for arg in sys.argv): sys.exit(27)\n"
        "if os.environ.get('PI_SUBAGENT_CHILD') == '1':\n"
        "    if os.environ.get('PI_SUBAGENT_DEPTH') != '1': sys.exit(22)\n"
        "else:\n"
        "    if os.environ.get('PI_SUBAGENT_WAIT_TOOL_ENABLED') is not None: sys.exit(23)\n"
        "    if os.environ.get('PI_SUBAGENT_MAX_DEPTH') != '2': sys.exit(24)\n",
        encoding="utf-8",
    )
    executable.chmod(0o755)
    return executable


def main() -> int:
    with tempfile.TemporaryDirectory() as temporary:
        temporary_path = Path(temporary)
        config = temporary_path / "agent"
        pi_binary = fake_pi(temporary_path / "fake-pi")
        fake_bin = temporary_path / "trusted-bin"
        fake_bin.mkdir()
        node_binary = shutil.which("node")
        if not node_binary:
            raise SystemExit("node is required for the guard install test")
        (fake_bin / "node").symlink_to(node_binary)
        fake_curl = fake_bin / "curl"
        fake_curl.write_text(
            "#!/bin/bash\n"
            "set -euo pipefail\n"
            "out=\n"
            "while (($#)); do if [[ $1 == -o ]]; then shift; out=$1; fi; shift; done\n"
            "body='{\"data\":[{\"id\":\"stealth/ox-alpha\",\"pricing\":{\"prompt\":\"0\",\"completion\":\"0\"},\"supported_parameters\":[\"tools\",\"reasoning_effort\"],\"reasoning\":{\"supported_efforts\":[\"max\"]}}]}'\n"
            "if [[ -n $out ]]; then printf '%s' \"$body\" >\"$out\"; else printf '%s' \"$body\"; fi\n",
            encoding="utf-8",
        )
        fake_curl.chmod(0o755)
        setup_env = os.environ.copy()
        setup_env["PATH"] = str(fake_bin) + os.pathsep + setup_env["PATH"]
        subprocess.run(
            [
                sys.executable,
                str(SCRIPTS / "setup.py"),
                "--config-dir",
                str(config),
                "--guard",
                "--acknowledge-stealth-terms",
                "--pi-binary",
                str(pi_binary),
                "--network-profile",
                "none",
            ],
            env=setup_env,
            check=True,
        )
        config = config.resolve()
        sandbox = config / "extensions" / "sandbox"
        checked(["npm", "ci", "--ignore-scripts"], cwd=sandbox)
        checked(
            [
                sys.executable,
                str(SCRIPTS / "test_guard.py"),
                "--config-dir",
                str(config),
            ]
        )
        npm_home = config / "npm"
        npm_home.mkdir()
        checked(
            [
                "npm",
                "install",
                "--ignore-scripts",
                "--save-exact",
                "pi-subagents@0.56.0",
            ],
            cwd=npm_home,
        )
        subagent_config = config / "extensions" / "subagent" / "config.json"
        subagent_config.parent.mkdir(parents=True)
        subagent_config.write_text(
            json.dumps(
                {
                    "defaultSessionDir": str(config / "subagent-sessions"),
                    "maxSubagentDepth": 2,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        cache = config / "cache" / "ox-driver-guard"
        cache.mkdir(parents=True, mode=0o700, exist_ok=True)
        (cache / "models.json").write_text(
            json.dumps(
                {
                    "data": [
                        {
                            "id": "stealth/ox-alpha",
                            "pricing": {"prompt": "0", "completion": "0"},
                            "supported_parameters": ["tools", "reasoning_effort"],
                            "reasoning": {"supported_efforts": ["max"]},
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        package = npm_home / "node_modules" / "pi-subagents"
        package_lock = npm_home / "package-lock.json"
        project = temporary_path / "project"
        project.mkdir()
        (project / "seed.txt").write_text("seed\n", encoding="utf-8")
        checked(["git", "init", "--quiet"], cwd=project)
        checked(["git", "config", "user.name", "Ox Driver Test"], cwd=project)
        checked(["git", "config", "user.email", "test@example.invalid"], cwd=project)
        checked(["git", "add", "seed.txt"], cwd=project)
        checked(["git", "commit", "--quiet", "-m", "seed"], cwd=project)
        linked_worktree = temporary_path / "linked-worktree"
        checked(["git", "worktree", "add", "--quiet", "-b", "ox-driver-test", str(linked_worktree)], cwd=project)
        git_common = subprocess.check_output(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=project,
            text=True,
        ).strip()
        child_env = os.environ.copy()
        child_runtime_context = tempfile.TemporaryDirectory(prefix="ox-driver-runtime.", dir="/tmp")
        child_runtime = Path(child_runtime_context.name).resolve()
        child_runtime.chmod(0o700)
        child_env.update(
            {
                "OX_DRIVER_ROOT_CWD": str(project),
                "OX_DRIVER_ROOT_GIT_COMMON_DIR": git_common,
                "PI_SUBAGENT_DEPTH": "1",
                "PI_SUBAGENT_CHILD": "1",
                "PI_SUBAGENT_MAX_DEPTH": "2",
                "PI_SUBAGENT_FANOUT_CHILD": "1",
                "PI_SUBAGENT_CHILD_AGENT": "pi-lead",
                "OX_DRIVER_RUNTIME_TMP": str(child_runtime),
                "TMPDIR": str(child_runtime),
                "DATABASE_URL": "synthetic-must-be-removed",
                "HTTPS_PROXY": "http://proxy.example.invalid:8443",
            }
        )
        allowed_child = subprocess.run(
            [
                str(config / "bin" / "pi-child"),
                "--model",
                "openrouter/stealth/ox-alpha:max",
                "--extension",
                str(package / "src" / "runs" / "shared" / "subagent-prompt-runtime.ts"),
                "--extension",
                str(package / "src" / "extension" / "fanout-child.ts"),
                "--tools",
                "read,write,edit,bash,grep,find,ls,subagent,subagent_wait,contact_supervisor",
                "-p",
                "test",
            ],
            cwd=project,
            env=child_env,
            check=False,
        )
        if allowed_child.returncode != 0:
            raise SystemExit(f"allowed child argv/env test failed: {allowed_child.returncode}")
        leaf_env = child_env.copy()
        leaf_env["PI_SUBAGENT_FANOUT_CHILD"] = "0"
        leaf_env["PI_SUBAGENT_CHILD_AGENT"] = "pi-agent"
        linked_child = subprocess.run(
            [
                str(config / "bin" / "pi-child"),
                "--model",
                "openrouter/stealth/ox-alpha:max",
                "--extension",
                str(package / "src" / "runs" / "shared" / "subagent-prompt-runtime.ts"),
                "--tools",
                "read,write,edit,bash,grep,find,ls,contact_supervisor",
                "-p",
                "test",
            ],
            cwd=linked_worktree,
            env=leaf_env,
            check=False,
        )
        if linked_child.returncode != 0:
            raise SystemExit(f"linked worktree child was blocked: {linked_child.returncode}")
        managed_sessions = config / "subagent-sessions" / "fixture"
        managed_sessions.mkdir(parents=True)
        session_target = managed_sessions / "run-symlink"
        session_target.symlink_to(temporary_path, target_is_directory=True)
        session_symlink = subprocess.run(
            [
                str(config / "bin" / "pi-child"),
                "--model",
                "openrouter/stealth/ox-alpha:max",
                "--extension",
                str(package / "src" / "runs" / "shared" / "subagent-prompt-runtime.ts"),
                "--tools",
                "read,contact_supervisor",
                "--session",
                str(session_target),
                "-p",
                "test",
            ],
            cwd=project,
            env=leaf_env,
            text=True,
            capture_output=True,
            check=False,
        )
        if session_symlink.returncode == 0 or "session target must not be a symlink" not in session_symlink.stderr:
            raise SystemExit("child session target symlink was not rejected")
        leaf_wait = subprocess.run(
            [
                str(config / "bin" / "pi-child"),
                "--model",
                "openrouter/stealth/ox-alpha:max",
                "--extension",
                str(package / "src" / "runs" / "shared" / "subagent-prompt-runtime.ts"),
                "--tools",
                "read,subagent_wait,contact_supervisor",
                "-p",
                "test",
            ],
            cwd=project,
            env=leaf_env,
            text=True,
            capture_output=True,
            check=False,
        )
        if leaf_wait.returncode == 0 or "cannot receive delegation tools" not in leaf_wait.stderr:
            raise SystemExit("pi-agent leaf received subagent_wait")
        missing_prompt = subprocess.run(
            [
                str(config / "bin" / "pi-child"),
                "--model",
                "openrouter/stealth/ox-alpha:max",
                "--tools",
                "read,write,edit,bash,grep,find,ls,contact_supervisor",
                "-p",
                "test",
            ],
            cwd=project,
            env=leaf_env,
            text=True,
            capture_output=True,
            check=False,
        )
        if missing_prompt.returncode == 0 or "exactly one pinned prompt" not in missing_prompt.stderr:
            raise SystemExit("missing child prompt runtime was not rejected")
        outside_extension = temporary_path / "outside.ts"
        outside_extension.write_text("export default () => {};\n", encoding="utf-8")
        rejected_child = subprocess.run(
            [
                str(config / "bin" / "pi-child"),
                "--model",
                "openrouter/stealth/ox-alpha:max",
                "--extension",
                str(outside_extension),
                "-p",
                "test",
            ],
            cwd=project,
            env=leaf_env,
            text=True,
            capture_output=True,
            check=False,
        )
        if rejected_child.returncode == 0 or "outside the pinned" not in rejected_child.stderr:
            raise SystemExit("external child extension was not rejected")
        outside_cwd = temporary_path / "outside-cwd"
        outside_cwd.mkdir()
        rejected_cwd = subprocess.run(
            [
                str(config / "bin" / "pi-child"),
                "--model",
                "openrouter/stealth/ox-alpha:max",
                "-p",
                "test",
            ],
            cwd=outside_cwd,
            env=leaf_env,
            text=True,
            capture_output=True,
            check=False,
        )
        if rejected_cwd.returncode == 0 or "outside the root project" not in rejected_cwd.stderr:
            raise SystemExit("out-of-root child cwd was not rejected")
        lock_data = json.loads(package_lock.read_text(encoding="utf-8"))
        saved_integrity = lock_data["packages"]["node_modules/pi-subagents"]["integrity"]
        lock_data["packages"]["node_modules/pi-subagents"]["integrity"] = "sha512-tampered"
        package_lock.write_text(json.dumps(lock_data) + "\n", encoding="utf-8")
        tampered_fleet = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS / "setup.py"),
                "--config-dir",
                str(config),
                "--fleet",
                "--permission-profile",
                "power",
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        if tampered_fleet.returncode == 0 or "registry integrity" not in tampered_fleet.stderr:
            raise SystemExit("tampered pi-subagents lock integrity was not rejected")
        lock_data["packages"]["node_modules/pi-subagents"]["integrity"] = saved_integrity
        package_lock.write_text(json.dumps(lock_data) + "\n", encoding="utf-8")

        checked(
            [
                sys.executable,
                str(SCRIPTS / "setup.py"),
                "--config-dir",
                str(config),
                "--fleet",
                "--permission-profile",
                "power",
            ]
        )

        # The power profile must support useful cross-folder reads without
        # reopening sensitive paths or broad Bash writes.
        shared = temporary_path / "shared-read.txt"
        shared.write_text("CROSS_FOLDER_OK\n", encoding="utf-8")
        synthetic_secret = temporary_path / ".env"
        synthetic_secret.write_text("SYNTHETIC_ONLY=1\n", encoding="utf-8")
        credential_paths = [
            temporary_path / ".aws" / "credentials",
            temporary_path / ".kube" / "config",
            temporary_path / ".codex" / "session.jsonl",
            temporary_path / ".agents" / "skills" / "ox-driver" / "SKILL.md",
            temporary_path / ".claude" / "settings.json",
            temporary_path / ".docker" / "config.json",
            temporary_path / ".config" / "gh" / "hosts.yml",
        ]
        for credential_path in credential_paths:
            credential_path.parent.mkdir(parents=True, exist_ok=True)
            credential_path.write_text("SYNTHETIC_ONLY=1\n", encoding="utf-8")
        keychain_directory = temporary_path / "Library" / "Keychains"
        keychain_directory.mkdir(parents=True)
        credential_paths.append(keychain_directory)
        project_credential_dirs = [
            project / ".ssh",
            project / ".aws",
            project / ".gnupg",
            project / ".kube",
            project / ".docker",
            project / ".codex",
            project / ".agents",
            project / ".claude",
            project / ".azure",
            project / ".config" / "gh",
            project / ".config" / "gcloud",
            project / ".config" / "opencode",
        ]
        for directory in project_credential_dirs:
            directory.mkdir(parents=True, exist_ok=True)
        sandbox_module = (config / "extensions" / "sandbox" / "sensitive-paths.ts").resolve().as_uri()
        sandbox_probe = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                "--input-type=module",
                "--eval",
                (
                    f'import {{ discoverProjectSecrets }} from {json.dumps(sandbox_module)}; '
                    'const found = discoverProjectSecrets(process.argv[1]); '
                    'for (const expected of process.argv.slice(2)) if (!found.includes(expected)) process.exit(40);'
                ),
                str(project),
                *(str(path) for path in project_credential_dirs),
            ],
            cwd=project,
            text=True,
            capture_output=True,
            check=False,
        )
        if sandbox_probe.returncode != 0:
            raise SystemExit(f"project credential directories were not added to sandbox denies: {sandbox_probe.stderr}")
        safety = config / "extensions" / "pi-safety.ts"
        power_env = os.environ.copy()
        power_env["HOME"] = str(temporary_path)
        scope_probe = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                "--input-type=module",
                "--eval",
                (
                    f'import {{ validateProjectPath }} from {json.dumps(safety.resolve().as_uri())}; '
                    'const [cwd, shared, secret, ...credentials] = process.argv.slice(1); '
                    'if (validateProjectPath(shared, cwd, false)) process.exit(30); '
                    'if (!validateProjectPath(secret, cwd, false)) process.exit(31); '
                    'if (!validateProjectPath("/etc/hosts", cwd, false)) process.exit(32); '
                    'if (credentials.some(path => !validateProjectPath(path, cwd, false))) process.exit(33);'
                ),
                str(project),
                str(shared),
                str(synthetic_secret),
                *(str(path) for path in credential_paths),
            ],
            cwd=project,
            env=power_env,
            text=True,
            capture_output=True,
            check=False,
        )
        if scope_probe.returncode != 0:
            raise SystemExit(f"power file scope test failed: {scope_probe.stderr}")

        srt = sandbox / "node_modules" / ".bin" / "srt"
        linux_helper = next(
            (sandbox / "node_modules" / "@anthropic-ai" / "sandbox-runtime" / "vendor" / "seccomp").glob("*/apply-seccomp"),
            None,
        )
        sandbox_config = config / "extensions" / "sandbox.json"
        runtime_temp_path = temporary_path.parent / f"{temporary_path.name}-runtime-tmp"
        runtime_temp_path.mkdir(mode=0o700)
        runtime_policy = json.loads(sandbox_config.read_text(encoding="utf-8"))
        runtime_policy["filesystem"]["allowWrite"].append(str(runtime_temp_path))
        sandbox_config.write_text(json.dumps(runtime_policy) + "\n", encoding="utf-8")
        sandbox_runtime_config = temporary_path / "sandbox-runtime-test.json"
        sandbox_runtime_config.write_text(
            json.dumps(effective_runtime_policy(runtime_policy, linux_helper)) + "\n", encoding="utf-8"
        )
        sandbox_env = power_env
        blocked_cross_read = subprocess.run(
            [str(srt), "--settings", str(sandbox_runtime_config), "-c", f"cat {shlex.quote(str(shared))}"],
            cwd=project,
            env=sandbox_env,
            text=True,
            capture_output=True,
            check=False,
        )
        if blocked_cross_read.returncode == 0:
            raise SystemExit("sandbox Bash read outside the project")
        blocked_secret = subprocess.run(
            [str(srt), "--settings", str(sandbox_runtime_config), "-c", f"cat {shlex.quote(str(synthetic_secret))}"],
            cwd=project,
            env=sandbox_env,
            text=True,
            capture_output=True,
            check=False,
        )
        if blocked_secret.returncode == 0:
            raise SystemExit("sandbox read a synthetic credential file")
        outside_write = outside_cwd / "bash-write.txt"
        blocked_write = subprocess.run(
            [str(srt), "--settings", str(sandbox_runtime_config), "-c", f"printf blocked > {shlex.quote(str(outside_write))}"],
            cwd=project,
            env=sandbox_env,
            text=True,
            capture_output=True,
            check=False,
        )
        if blocked_write.returncode == 0 or outside_write.exists():
            raise SystemExit("sandbox wrote outside the project and approved temporary path")
        temporary_env = sandbox_env.copy()
        runtime_temp = str(runtime_temp_path)
        temporary_env["TMPDIR"] = runtime_temp
        temporary_env["CLAUDE_CODE_TMPDIR"] = runtime_temp
        temporary_env["CLAUDE_TMPDIR"] = runtime_temp
        temporary_write = subprocess.run(
            [str(srt), "--settings", str(sandbox_runtime_config), "-c", 'file="$(mktemp "$TMPDIR/file.XXXXXX")"; printf ok >"$file"; test -s "$file"'],
            cwd=project,
            env=temporary_env,
            text=True,
            capture_output=True,
            check=False,
        )
        if temporary_write.returncode != 0:
            raise SystemExit(f"sandbox could not use its forced temporary directory: {temporary_write.stderr}")

        nested_project = temporary_path / "nested-agent-project"
        nested_project.mkdir()
        nested_agent = (nested_project / ".ox-agent").resolve()
        subprocess.run(
            [
                sys.executable,
                str(SCRIPTS / "setup.py"),
                "--config-dir",
                str(nested_agent),
                "--guard",
                "--acknowledge-stealth-terms",
                "--pi-binary",
                str(pi_binary),
                "--network-profile",
                "none",
            ],
            env=setup_env,
            check=True,
        )
        nested_policy = json.loads(
            (nested_agent / "extensions" / "sandbox.json").read_text(encoding="utf-8")
        )
        for key in ("denyRead", "denyWrite"):
            if str(nested_agent) not in nested_policy["filesystem"][key]:
                raise SystemExit(f"custom agent directory is absent from {key}")
        nested_runtime_policy = temporary_path / "nested-sandbox-runtime-test.json"
        nested_runtime_policy.write_text(
            json.dumps(effective_runtime_policy(nested_policy, linux_helper)) + "\n", encoding="utf-8"
        )
        normal_project_file = nested_project / "normal.txt"
        allowed_project_write = subprocess.run(
            [
                str(srt),
                "--settings",
                str(nested_runtime_policy),
                "-c",
                f"printf normal > {shlex.quote(str(normal_project_file))}",
            ],
            cwd=nested_project,
            env=sandbox_env,
            text=True,
            capture_output=True,
            check=False,
        )
        if allowed_project_write.returncode != 0 or normal_project_file.read_text() != "normal":
            raise SystemExit("nested-agent policy blocked an ordinary project write")
        protected_launcher = nested_agent / "bin" / "pi-child"
        original_launcher = protected_launcher.read_bytes()
        blocked_agent_write = subprocess.run(
            [
                str(srt),
                "--settings",
                str(nested_runtime_policy),
                "-c",
                f"printf compromised > {shlex.quote(str(protected_launcher))}",
            ],
            cwd=nested_project,
            env=sandbox_env,
            text=True,
            capture_output=True,
            check=False,
        )
        if blocked_agent_write.returncode == 0 or protected_launcher.read_bytes() != original_launcher:
            raise SystemExit("sandbox modified a custom agent directory inside the project")

        alias_project = temporary_path / "alias-agent-project"
        physical_parent = alias_project / "physical"
        physical_parent.mkdir(parents=True)
        alias_parent = alias_project / "alias"
        alias_parent.symlink_to(physical_parent, target_is_directory=True)
        subprocess.run(
            [
                sys.executable,
                str(SCRIPTS / "setup.py"),
                "--config-dir",
                str(alias_parent / "agent"),
                "--guard",
                "--acknowledge-stealth-terms",
                "--pi-binary",
                str(pi_binary),
                "--network-profile",
                "none",
            ],
            env=setup_env,
            check=True,
        )
        canonical_agent = (physical_parent / "agent").resolve()
        alias_policy_path = canonical_agent / "extensions" / "sandbox.json"
        alias_policy = json.loads(alias_policy_path.read_text(encoding="utf-8"))
        if str(canonical_agent) not in alias_policy["filesystem"]["denyWrite"]:
            raise SystemExit("symlinked agent parent was not canonicalized")
        alias_launcher = canonical_agent / "bin" / "pi-child"
        alias_launcher_original = alias_launcher.read_bytes()
        alias_runtime_policy = temporary_path / "alias-sandbox-runtime-test.json"
        alias_runtime_policy.write_text(
            json.dumps(effective_runtime_policy(alias_policy, linux_helper)) + "\n", encoding="utf-8"
        )
        blocked_alias_write = subprocess.run(
            [
                str(srt),
                "--settings",
                str(alias_runtime_policy),
                "-c",
                f"printf compromised > {shlex.quote(str(alias_launcher))}",
            ],
            cwd=alias_project,
            env=sandbox_env,
            text=True,
            capture_output=True,
            check=False,
        )
        if blocked_alias_write.returncode == 0 or alias_launcher.read_bytes() != alias_launcher_original:
            raise SystemExit("sandbox modified an agent directory through a symlinked parent")

        hostile_root_env = child_env.copy()
        hostile_root_env["HOME"] = "/"
        hostile_root_env["TMPDIR"] = "/"
        hostile_root_env["PI_SUBAGENT_WAIT_TOOL_ENABLED"] = "false"
        hostile_root_env["PI_SUBAGENTS_CONFIG"] = "untrusted"
        clean_root = subprocess.run(
            [str(config / "bin" / "pi-ox"), "-p", "test"],
            cwd=project,
            env=hostile_root_env,
            text=True,
            capture_output=True,
            check=False,
        )
        if clean_root.returncode != 0:
            raise SystemExit(f"root protocol environment was not reset: {clean_root.returncode} {clean_root.stderr}")

        models_cache = cache / "models.json"
        models_cache.unlink()
        ownerless_lock = cache / "models.lock"
        ownerless_lock.mkdir()
        old = 1_700_000_000
        os.utime(ownerless_lock, (old, old))
        ownerless_env = hostile_root_env.copy()
        ownerless_env["PATH"] = str(temporary_path / "untrusted-path")
        recovered_lock = subprocess.run(
            [str(config / "bin" / "pi-ox"), "-p", "test"],
            cwd=project,
            env=ownerless_env,
            text=True,
            capture_output=True,
            check=False,
        )
        if recovered_lock.returncode != 0 or ownerless_lock.exists():
            raise SystemExit(f"ownerless catalog lock did not recover: {recovered_lock.stderr}")

        missing_policy = sandbox_config.with_suffix(".json.disabled")
        sandbox_config.rename(missing_policy)
        try:
            policy_failure = subprocess.run(
                [str(config / "bin" / "pi-ox"), "-p", "test"],
                cwd=project,
                env=child_env,
                text=True,
                capture_output=True,
                check=False,
            )
            if policy_failure.returncode == 0 or "sandbox policy is missing" not in policy_failure.stderr:
                raise SystemExit("missing sandbox policy did not fail closed")
        finally:
            missing_policy.rename(sandbox_config)
        shutil.rmtree(runtime_temp_path)
        child_runtime_context.cleanup()
    print("GUARD_INSTALL_TEST_PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
