#!/usr/bin/env python3
"""Isolated regression tests for the Ox Driver setup helper."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().with_name("setup.py")


def run_setup(config: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--config-dir", str(config), *arguments],
        text=True,
        capture_output=True,
        check=False,
    )


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
    executable.write_text("#!/usr/bin/env python3\n", encoding="utf-8")
    executable.chmod(0o755)
    return executable


def fake_subagents(config: Path) -> None:
    package = config / "npm" / "node_modules" / "pi-subagents"
    for relative in (
        "index.ts",
        "src/runs/shared/subagent-prompt-runtime.ts",
        "src/extension/fanout-child.ts",
    ):
        target = package / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("export default () => {};\n", encoding="utf-8")
    (package / "package.json").write_text(
        json.dumps({"name": "pi-subagents", "version": "0.56.0"}) + "\n",
        encoding="utf-8",
    )
    lock = config / "npm" / "package-lock.json"
    lock.write_text(
        json.dumps(
            {
                "packages": {
                    "node_modules/pi-subagents": {
                        "version": "0.56.0",
                        "integrity": "sha512-XBmKqvrj4mCVQ6/uXiPqCmzHxGfBB+jjwmfNR3El+IfhnaJwZ+W6evXYRI3lQEXe6Nf56xfzUXQExIzE8cT5BQ==",
                    }
                }
            }
        )
        + "\n",
        encoding="utf-8",
    )


def prepare_guard(config: Path, permission_profile: str = "power") -> None:
    pi_binary = fake_pi(config.parent / "fake-pi")
    result = run_setup(
        config,
        "--guard",
        "--acknowledge-stealth-terms",
        "--pi-binary",
        str(pi_binary),
        "--permission-profile",
        permission_profile,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    dependency = (
        config
        / "extensions"
        / "sandbox"
        / "node_modules"
        / "@anthropic-ai"
        / "sandbox-runtime"
    )
    dependency.mkdir(parents=True)
    fake_subagents(config)


class SetupTests(unittest.TestCase):
    def test_guard_requires_stealth_terms_acknowledgement(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "agent"
            result = run_setup(
                config,
                "--guard",
                "--pi-binary",
                str(fake_pi(Path(temporary) / "fake-pi")),
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("--acknowledge-stealth-terms", result.stderr)

    def test_default_guard_keeps_full_web_access(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "agent"
            prepare_guard(config)
            policy = json.loads(
                (config / "extensions" / "sandbox.json").read_text(encoding="utf-8")
            )
            self.assertEqual(policy["networkMode"], "open")
            self.assertEqual(policy["network"]["allowedDomains"], [])
            canonical = config.resolve()
            self.assertIn(str(canonical / "auth.json"), policy["filesystem"]["denyRead"])

    def test_dry_run_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "agent"
            result = run_setup(
                config,
                "--guard",
                "--acknowledge-stealth-terms",
                "--fleet",
                "--pi-binary",
                str(fake_pi(Path(temporary) / "fake-pi")),
                "--dry-run",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(config.exists())

    def test_fleet_merge_backup_and_idempotence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "agent"
            config.mkdir()
            (config / "models.json").write_text(
                json.dumps({"unrelatedModelKey": True}) + "\n", encoding="utf-8"
            )
            (config / "settings.json").write_text(
                json.dumps({"unrelatedSettingKey": 7}) + "\n", encoding="utf-8"
            )

            prepare_guard(config)
            result = run_setup(config, "--fleet")
            self.assertEqual(result.returncode, 0, result.stderr)
            models = json.loads((config / "models.json").read_text(encoding="utf-8"))
            settings = json.loads((config / "settings.json").read_text(encoding="utf-8"))
            self.assertTrue(models["unrelatedModelKey"])
            self.assertEqual(settings["unrelatedSettingKey"], 7)
            self.assertNotIn("defaultProvider", settings)
            self.assertNotIn("defaultModel", settings)
            self.assertNotIn("defaultThinkingLevel", settings)
            self.assertIs(settings["terminal"]["showImages"], False)
            self.assertEqual(
                settings["compaction"],
                {"enabled": True, "reserveTokens": 196608, "keepRecentTokens": 65536},
            )
            self.assertEqual(settings["retry"]["enabled"], True)
            self.assertEqual(settings["retry"]["maxRetries"], 3)
            self.assertEqual(settings["retry"]["provider"]["maxRetries"], 0)
            self.assertEqual(settings["subagents"]["maxThinking"], "max")
            self.assertNotIn("maxSubagentDepth", settings["subagents"])
            self.assertEqual(
                settings["subagents"]["modelScope"],
                {"enforce": True, "strict": True, "allow": ["inherit"]},
            )
            self.assertEqual(len(list(config.glob("models.json.bak-*"))), 1)
            self.assertEqual(len(list(config.glob("settings.json.bak-*"))), 2)
            for relative in (
                "agents/pi-agent.md",
                "agents/pi-lead.md",
                "prompts/team.md",
                "prompts/solo.md",
                "prompts/team-smoke.md",
                "prompts/team-acceptance.md",
                "extensions/pi-safety.json",
                "extensions/pi-image-budget.ts",
                "extensions/subagent/config.json",
            ):
                self.assertTrue((config / relative).is_file())
            self.assertEqual(
                json.loads((config / "extensions" / "pi-safety.json").read_text())["fileScope"],
                "home",
            )
            session_config = json.loads(
                (config / "extensions" / "subagent" / "config.json").read_text()
            )
            self.assertEqual(
                session_config["defaultSessionDir"], str(config.resolve() / "subagent-sessions")
            )
            self.assertEqual(session_config["maxSubagentDepth"], 2)
            self.assertIn(
                "completionGuard: false",
                (config / "agents" / "pi-lead.md").read_text(encoding="utf-8"),
            )

            before = {path.name for path in config.glob("*.bak-*")}
            second = run_setup(config, "--fleet")
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(before, {path.name for path in config.glob("*.bak-*")})

    def test_profile_conflict_is_all_or_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "agent"
            prepare_guard(config)
            agents = config / "agents"
            agents.mkdir(parents=True, exist_ok=True)
            settings = config / "settings.json"
            before = settings.read_text(encoding="utf-8")
            (agents / "pi-agent.md").write_text("different\n", encoding="utf-8")

            result = run_setup(config, "--fleet")
            self.assertEqual(result.returncode, 2)
            self.assertEqual(settings.read_text(encoding="utf-8"), before)

    def test_unverified_pi_binary_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "agent"
            result = run_setup(
                config,
                "--guard",
                "--acknowledge-stealth-terms",
                "--pi-binary",
                sys.executable,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("is not inside", result.stderr)

    def test_special_character_paths_render_valid_launcher(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            config = base / "agent $value 'quoted'"
            pi_binary = fake_pi(base / "package $value 'quoted'")
            result = run_setup(
                config,
                "--guard",
                "--acknowledge-stealth-terms",
                "--pi-binary",
                str(pi_binary),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            launcher = config / "bin" / "pi-ox"
            syntax = subprocess.run(
                ["bash", "-n", str(launcher)], text=True, capture_output=True
            )
            self.assertEqual(syntax.returncode, 0, syntax.stderr)
            dependency = (
                config
                / "extensions"
                / "sandbox"
                / "node_modules"
                / "@anthropic-ai"
                / "sandbox-runtime"
            )
            dependency.mkdir(parents=True)
            rejected = subprocess.run(
                [str(launcher), "--model", "other/model", "-p", "test"],
                cwd=base,
                text=True,
                capture_output=True,
            )
            self.assertEqual(rejected.returncode, 4)
            self.assertIn("policy overrides", rejected.stderr)

    def test_conservative_permission_profiles(self) -> None:
        for profile in ("edit-only", "review-only"):
            with self.subTest(profile=profile), tempfile.TemporaryDirectory() as temporary:
                config = Path(temporary) / "agent"
                prepare_guard(config, profile)
                result = run_setup(config, "--fleet", "--permission-profile", profile)
                self.assertEqual(result.returncode, 0, result.stderr)
                agent = (config / "agents" / "pi-agent.md").read_text(encoding="utf-8")
                self.assertNotIn("bash", agent.split("---", 2)[1])
                self.assertEqual(
                    json.loads((config / "extensions" / "pi-safety.json").read_text())["fileScope"],
                    "project",
                )

    def test_recognized_permission_profile_can_be_updated(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "agent"
            prepare_guard(config, "review-only")
            installed = run_setup(
                config, "--fleet", "--permission-profile", "review-only"
            )
            self.assertEqual(installed.returncode, 0, installed.stderr)
            models = config / "models.json"
            settings = config / "settings.json"
            models.write_text('{"migrated": true}\n', encoding="utf-8")
            settings.write_text('{"defaultModel": "replacement/model"}\n', encoding="utf-8")
            models_before = models.read_bytes()
            settings_before = settings.read_bytes()
            target = config / "agents" / "pi-agent.md"
            before = target.read_text(encoding="utf-8")
            preview = run_setup(
                config,
                "--update-permission-profile",
                "--permission-profile",
                "power",
                "--dry-run",
            )
            self.assertEqual(preview.returncode, 0, preview.stderr)
            self.assertEqual(target.read_text(encoding="utf-8"), before)
            updated = run_setup(
                config, "--update-permission-profile", "--permission-profile", "power"
            )
            self.assertEqual(updated.returncode, 0, updated.stderr)
            self.assertIn("bash", target.read_text(encoding="utf-8").split("---", 2)[1])
            self.assertEqual(
                json.loads((config / "extensions" / "pi-safety.json").read_text())["fileScope"],
                "home",
            )
            self.assertEqual(len(list(target.parent.glob("pi-agent.md.bak-*"))), 1)
            self.assertEqual(models.read_bytes(), models_before)
            self.assertEqual(settings.read_bytes(), settings_before)

    def test_recognized_network_profile_can_be_updated(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "agent"
            prepare_guard(config)
            target = config / "extensions" / "sandbox.json"
            updated = run_setup(
                config,
                "--update-network-profile",
                "--network-profile",
                "development",
            )
            self.assertEqual(updated.returncode, 0, updated.stderr)
            policy = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(policy["networkMode"], "restricted")
            self.assertIn("registry.npmjs.org", policy["network"]["allowedDomains"])
            self.assertEqual(len(list(target.parent.glob("sandbox.json.bak-*"))), 1)

            restored = run_setup(
                config,
                "--update-network-profile",
                "--network-profile",
                "open",
            )
            self.assertEqual(restored.returncode, 0, restored.stderr)
            policy = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(policy["networkMode"], "open")
            self.assertEqual(policy["network"]["allowedDomains"], [])

    def test_hand_edited_profile_update_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "agent"
            prepare_guard(config)
            installed = run_setup(config, "--fleet")
            self.assertEqual(installed.returncode, 0, installed.stderr)
            models = config / "models.json"
            settings = config / "settings.json"
            models_before = models.read_bytes()
            settings_before = settings.read_bytes()
            target = config / "agents" / "pi-agent.md"
            target.write_text("hand edited\n", encoding="utf-8")
            result = run_setup(
                config,
                "--update-permission-profile",
                "--permission-profile",
                "review-only",
            )
            self.assertEqual(result.returncode, 2)
            self.assertEqual(target.read_text(encoding="utf-8"), "hand edited\n")
            self.assertEqual(models.read_bytes(), models_before)
            self.assertEqual(settings.read_bytes(), settings_before)

    @unittest.skipIf(os.name == "nt", "symlink behavior differs on Windows")
    def test_symlink_target_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "agent"
            config.mkdir()
            (config / "settings.json").symlink_to(os.devnull)
            result = run_setup(config)
            self.assertEqual(result.returncode, 2)
            self.assertIn("refusing symlink", result.stderr)


if __name__ == "__main__":
    unittest.main()
