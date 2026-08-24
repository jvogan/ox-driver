#!/usr/bin/env python3
"""Validate the public skill package and repository hygiene."""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "skills" / "ox-driver"
ERRORS: list[str] = []

REVIEWED = {
    "@earendil-works/pi-coding-agent": "0.84.3",
    "pi-subagents": "0.56.0",
    "skills": "1.5.23",
    "@anthropic-ai/sandbox-runtime": "0.0.73",
}

PRIVATE_PATTERNS = {
    r"/" + r"Users/[^/\s]+": "personal macOS path",
    r"/" + r"home/[^/\s]+": "personal Linux path",
}


def error(path: Path | str, message: str) -> None:
    ERRORS.append(f"{path}: {message}")


def frontmatter(path: Path) -> tuple[dict[str, str], str] | None:
    text = path.read_text(encoding="utf-8")
    match = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if not match:
        error(path, "missing YAML frontmatter")
        return None
    raw, body = match.groups()
    fields: dict[str, str] = {}
    lines = raw.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        item = re.fullmatch(r"([a-zA-Z][a-zA-Z0-9_-]*):(?: (.*))?", line)
        if not item:
            error(path, f"unsupported frontmatter line {index + 1}: {line!r}")
            return None
        key, value = item.group(1), item.group(2) or ""
        if key in fields:
            error(path, f"duplicate frontmatter key: {key}")
            return None
        if value in {">", ">-", "|", "|-"}:
            block: list[str] = []
            index += 1
            while index < len(lines) and (
                lines[index].startswith("  ") or not lines[index].strip()
            ):
                block.append(lines[index][2:] if lines[index].startswith("  ") else "")
                index += 1
            fields[key] = " ".join(part.strip() for part in block if part.strip())
            continue
        if value == "" and index + 1 < len(lines) and lines[index + 1].startswith("  "):
            nested: dict[str, str] = {}
            index += 1
            while index < len(lines) and lines[index].startswith("  "):
                nested_item = re.fullmatch(
                    r"  ([a-zA-Z][a-zA-Z0-9_-]*):(?: (.*))?", lines[index]
                )
                if not nested_item:
                    error(path, f"unsupported frontmatter line {index + 1}: {lines[index]!r}")
                    return None
                nested_key, nested_value = nested_item.group(1), nested_item.group(2) or ""
                if nested_key in nested:
                    error(path, f"duplicate nested frontmatter key: {key}.{nested_key}")
                    return None
                nested[nested_key] = nested_value.strip('"\'')
                index += 1
            fields[key] = json.dumps(nested, sort_keys=True)
            continue
        fields[key] = value.strip('"\'')
        index += 1
    return fields, body


def validate_skill() -> None:
    skill_md = SKILL / "SKILL.md"
    parsed = frontmatter(skill_md)
    if not parsed:
        return
    fields, body = parsed
    allowed = {"name", "description", "license", "compatibility", "metadata"}
    unknown = set(fields) - allowed
    if unknown:
        error(skill_md, f"non-portable frontmatter fields: {sorted(unknown)}")
    if fields.get("name") != "ox-driver":
        error(skill_md, "name must match the skill directory")
    description = fields.get("description", "")
    if not description or len(description) > 1024:
        error(skill_md, "description must contain 1-1024 characters")
    if body.count("\n") + 1 > 500:
        error(skill_md, "body exceeds 500 lines")


def validate_profiles() -> None:
    profiles = [
        (SKILL / "assets" / "agents" / "pi-agent.md", False),
        (SKILL / "assets" / "agents" / "pi-lead.md", True),
    ]
    for permission in ("edit-only", "review-only"):
        profiles.extend(
            [
                (SKILL / "assets" / "permissions" / permission / "pi-agent.md", False),
                (SKILL / "assets" / "permissions" / permission / "pi-lead.md", True),
            ]
        )
    for path, can_delegate in profiles:
        parsed = frontmatter(path)
        if not parsed:
            continue
        fields, _ = parsed
        if fields.get("name") != path.stem:
            error(path, "profile name does not match filename")
        if fields.get("model") != "inherit" or fields.get("thinking") != "max":
            error(path, "profile must inherit the model and request max thinking")
        if can_delegate and fields.get("completionGuard") != "false":
            error(path, "lead must disable the edit-centric completion guard")
        tools = {item.strip() for item in fields.get("tools", "").split(",") if item.strip()}
        expected = {
            "subagent": can_delegate,
            "subagent_wait": can_delegate,
            "contact_supervisor": True,
        }
        for tool, present in expected.items():
            if (tool in tools) != present:
                error(path, f"tool contract mismatch for {tool}")


def validate_links() -> None:
    markdown_link = re.compile(r"\]\((?!https?://|mailto:|#)([^)\s]+?)(?:#[^)]*)?\)")
    for path in ROOT.rglob("*.md"):
        text = path.read_text(encoding="utf-8")
        for target in markdown_link.findall(text):
            if target.startswith("<") and target.endswith(">"):
                target = target[1:-1]
            if not (path.parent / target).exists():
                error(path, f"broken relative link: {target}")


def validate_privacy() -> None:
    for path in ROOT.rglob("*"):
        if not path.is_file() or "node_modules" in path.parts:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for pattern, label in PRIVATE_PATTERNS.items():
            if re.search(pattern, text, re.I):
                error(path, f"contains {label}")


def validate_versions() -> None:
    path = SKILL / "references" / "versions.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        error(path, f"invalid version manifest: {exc}")
        return
    packages = data.get("packages", {})
    for package, version in REVIEWED.items():
        entry = packages.get(package, {})
        if entry.get("version") != version:
            error(path, f"unexpected reviewed version for {package}")
        if "gitHead" in entry and not re.fullmatch(r"[0-9a-f]{40}", str(entry["gitHead"])):
            error(path, f"invalid Git commit for {package}")
        if not str(entry.get("integrity", "")).startswith("sha512-"):
            error(path, f"missing sha512 integrity for {package}")

    corpus = "\n".join(
        path.read_text(encoding="utf-8")
        for path in ROOT.rglob("*")
        if path.is_file() and path.suffix in {".md", ".py", ".yml", ".yaml"}
    )
    for package, version in REVIEWED.items():
        if f"{package}@{version}" not in corpus:
            error(ROOT, f"reviewed pin is not documented: {package}@{version}")


def validate_scripts() -> None:
    required = [
        ROOT / "scripts" / "setup.py",
        ROOT / "scripts" / "install_reviewed_pi.py",
        ROOT / "scripts" / "test_install_reviewed_pi.py",
        ROOT / "scripts" / "test_guard.py",
        ROOT / "scripts" / "test_guard_install.py",
        ROOT / "scripts" / "verify_provenance.py",
        SKILL / "scripts" / "setup.py",
        SKILL / "scripts" / "install_reviewed_pi.py",
        SKILL / "scripts" / "test_install_reviewed_pi.py",
        SKILL / "scripts" / "test_guard.py",
        SKILL / "scripts" / "test_guard_install.py",
        SKILL / "scripts" / "verify_provenance.py",
    ]
    for path in required:
        if not path.is_file():
            error(path, "missing setup helper")
            continue
        try:
            ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except SyntaxError as exc:
            error(path, f"does not compile: {exc}")


def validate_guard_assets() -> None:
    wrapper = SKILL / "assets" / "bin" / "pi-guard"
    safety = SKILL / "assets" / "extensions" / "pi-safety.ts"
    resilience = SKILL / "assets" / "extensions" / "pi-resilience.ts"
    sandbox = SKILL / "assets" / "extensions" / "sandbox" / "index.ts"
    lock = SKILL / "assets" / "extensions" / "sandbox" / "package-lock.json"
    team = SKILL / "assets" / "prompts" / "team.md"
    for path in (wrapper, safety, resilience, sandbox, lock, team):
        if not path.is_file():
            error(path, "missing guard asset")
            return
    wrapper_text = wrapper.read_text(encoding="utf-8")
    safety_text = safety.read_text(encoding="utf-8")
    resilience_text = resilience.read_text(encoding="utf-8")
    sandbox_text = sandbox.read_text(encoding="utf-8")
    team_text = team.read_text(encoding="utf-8")
    for token in (
        "PI_SUBAGENT_PI_BINARY",
        "OX_DRIVER_GUARD_READY",
        "check_free_route",
        "validate_child_args",
        "--sandbox",
        "--approve|-a",
        '! kill -0 "$owner"',
    ):
        if token not in wrapper_text:
            error(wrapper, f"missing guard invariant: {token}")
    for token in (
        'if (process.env.OX_DRIVER_GUARD_READY !== "1") return;',
        "nested agent runtimes are disabled",
        'normalized.includes("/.aws/")',
        'normalized.includes("/.codex/")',
        "Recursive native search would cross a sensitive file",
    ):
        if token not in safety_text:
            error(safety, f"missing safety invariant: {token}")
    for token in (
        'if (process.env.OX_DRIVER_GUARD_READY !== "1") return;',
        'message.stopReason === "stop" && message.content.length === 0',
        'message.errorMessage?.trim().toUpperCase() === "ERROR"',
        "usage.input > 0",
        'stopReason: "error"',
    ):
        if token not in resilience_text:
            error(resilience, f"missing bounded-retry invariant: {token}")
    for token in ("env: bashEnv", "Required bash sandbox unavailable", "strictAllowlist"):
        if token not in sandbox_text:
            error(sandbox, f"missing sandbox invariant: {token}")
    if "OX_DRIVER_GUARD_READY=1" not in team_text:
        error(team, "team prompt lacks guarded-launch preflight")
    for token in ('agent: "pi-lead"', 'agentScope: "user"', "Do not use\n`workflowScript`", "subagent_wait"):
        if token not in team_text:
            error(team, f"team prompt lacks protected direct-call invariant: {token}")
    lock_data = json.loads(lock.read_text(encoding="utf-8"))
    package = lock_data.get("packages", {}).get("node_modules/@anthropic-ai/sandbox-runtime", {})
    reviewed = json.loads((SKILL / "references" / "versions.json").read_text(encoding="utf-8"))["packages"]["@anthropic-ai/sandbox-runtime"]
    if package.get("version") != reviewed["version"] or package.get("integrity") != reviewed["integrity"]:
        error(lock, "sandbox dependency does not match reviewed provenance")


def main() -> int:
    validate_skill()
    validate_profiles()
    validate_links()
    validate_privacy()
    validate_versions()
    validate_scripts()
    validate_guard_assets()
    if ERRORS:
        print("\n".join(ERRORS))
        return 1
    print("OK: ox-driver skill, profiles, links, pins, scripts, and public hygiene")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
