#!/usr/bin/env python3
"""Install Ox Driver model settings, guard assets, and optional fleet profiles.

The helper uses only the Python standard library and never installs npm packages,
credentials, or shell startup entries. Run `--guard` first, install the pinned
sandbox dependency, test the guard, then run `--fleet`.
"""

from __future__ import annotations

import argparse
import json
import os
import pwd
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

SKILL_ROOT = Path(__file__).resolve().parent.parent
ASSETS = SKILL_ROOT / "assets"

THINKING_MAP = {
    "off": None,
    "minimal": None,
    "low": "low",
    "medium": None,
    "high": "high",
    "xhigh": None,
    "max": "max",
}

SUBAGENTS = {
    "defaultThinking": "max",
    "maxThinking": "max",
    "modelScope": {"enforce": True, "strict": True, "allow": ["inherit"]},
}

COMPACTION = {
    "enabled": True,
    "reserveTokens": 196608,
    "keepRecentTokens": 65536,
}

RETRY = {
    "enabled": True,
    "maxRetries": 3,
    "baseDelayMs": 2000,
}

PROVIDER_RETRY = {
    "maxRetries": 0,
    "maxRetryDelayMs": 60000,
}

PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent"
PI_PACKAGE_VERSION = "0.84.3"

FLEET_COMMON_ASSETS = (
    (ASSETS / "prompts" / "team.md", "prompts/team.md", 0o644),
    (ASSETS / "prompts" / "solo.md", "prompts/solo.md", 0o644),
    (ASSETS / "prompts" / "team-smoke.md", "prompts/team-smoke.md", 0o644),
    (ASSETS / "prompts" / "team-acceptance.md", "prompts/team-acceptance.md", 0o644),
)

PERMISSION_PROFILE_DIRS = {
    "power": ASSETS / "agents",
    "edit-only": ASSETS / "permissions" / "edit-only",
    "review-only": ASSETS / "permissions" / "review-only",
}

FILE_SCOPE_BY_PROFILE = {
    "power": "home",
    "edit-only": "project",
    "review-only": "project",
}


def permission_policy_payload(permission_profile: str) -> bytes:
    return (
        json.dumps(
            {
                "fileScope": FILE_SCOPE_BY_PROFILE[permission_profile],
                "permissionProfile": permission_profile,
                "stealthTermsAcknowledged": True,
            },
            indent=2,
        )
        + "\n"
    ).encode()

DEVELOPMENT_DOMAINS = [
    "npmjs.org",
    "*.npmjs.org",
    "registry.npmjs.org",
    "pypi.org",
    "*.pypi.org",
    "files.pythonhosted.org",
    "github.com",
    "*.github.com",
    "api.github.com",
    "raw.githubusercontent.com",
]

GUARD_ASSETS = (
    (ASSETS / "extensions" / "pi-safety.ts", "extensions/pi-safety.ts", 0o644),
    (ASSETS / "extensions" / "pi-resilience.ts", "extensions/pi-resilience.ts", 0o644),
    (ASSETS / "extensions" / "pi-image-budget.ts", "extensions/pi-image-budget.ts", 0o644),
    (ASSETS / "extensions" / "sandbox" / "index.ts", "extensions/sandbox/index.ts", 0o644),
    (ASSETS / "extensions" / "sandbox" / "sensitive-paths.ts", "extensions/sandbox/sensitive-paths.ts", 0o644),
    (ASSETS / "extensions" / "sandbox" / "package.json", "extensions/sandbox/package.json", 0o644),
    (ASSETS / "extensions" / "sandbox" / "package-lock.json", "extensions/sandbox/package-lock.json", 0o644),
)


class SetupError(RuntimeError):
    pass


def reject_symlink(path: Path, label: str) -> None:
    if path.is_symlink():
        raise SetupError(f"refusing symlink {label}: {path}")


def ensure_directory(path: Path, dry_run: bool) -> None:
    reject_symlink(path, "directory")
    if path.exists() and not path.is_dir():
        raise SetupError(f"expected a directory: {path}")
    if not path.exists() and not dry_run:
        path.mkdir(parents=True, mode=0o700)


def load_json(path: Path) -> dict[str, Any]:
    reject_symlink(path, "JSON target")
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SetupError(f"invalid JSON in {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise SetupError(f"top-level JSON value must be an object: {path}")
    return value


def set_value(
    target: dict[str, Any], key: str, value: Any, label: str, changes: list[str]
) -> None:
    if target.get(key) == value:
        return
    previous = f" (was {json.dumps(target[key])})" if key in target else ""
    changes.append(f"set {label} = {json.dumps(value)}{previous}")
    target[key] = value


def backup_path(path: Path) -> Path:
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    candidate = path.with_name(f"{path.name}.bak-{stamp}-{os.getpid()}")
    sequence = 0
    while candidate.exists():
        sequence += 1
        candidate = path.with_name(f"{path.name}.bak-{stamp}-{os.getpid()}-{sequence}")
    return candidate


def atomic_write(path: Path, payload: bytes, mode: int) -> None:
    ensure_directory(path.parent, dry_run=False)
    reject_symlink(path, "write target")
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise


def save_json(
    path: Path, value: dict[str, Any], changes: list[str], dry_run: bool
) -> None:
    if not changes:
        print(f"  {path}: unchanged")
        return
    for change in changes:
        print(f"  {path}: {change}")
    if dry_run:
        return
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    if path.exists():
        backup = backup_path(path)
        shutil.copy2(path, backup, follow_symlinks=False)
        print(f"  {path}: backup {backup.name}")
    atomic_write(path, (json.dumps(value, indent=2) + "\n").encode(), mode)


def resolve_pi_binary(requested: Path | None) -> Path:
    candidate = requested
    if candidate is None:
        data_home = os.environ.get("XDG_DATA_HOME")
        base = Path(data_home).expanduser() if data_home else Path.home() / ".local" / "share"
        reviewed = base / "ox-driver" / "pi" / PI_PACKAGE_VERSION / "dist" / "cli.js"
        if reviewed.is_file():
            candidate = reviewed
    if candidate is None:
        npm = shutil.which("npm")
        if npm:
            result = subprocess.run(
                [npm, "root", "--global"], text=True, capture_output=True, check=False
            )
            if result.returncode == 0 and result.stdout.strip():
                candidate = (
                    Path(result.stdout.strip())
                    / PI_PACKAGE_NAME
                    / "dist"
                    / "cli.js"
                )
    if candidate is None:
        raise SetupError(
            "could not locate the reviewed Pi package; pass --pi-binary with its package executable"
        )
    candidate = candidate.expanduser().absolute()
    try:
        candidate = candidate.resolve(strict=True)
    except OSError as exc:
        raise SetupError(f"could not resolve Pi executable: {candidate}") from exc
    if not candidate.is_file() or not os.access(candidate, os.X_OK):
        raise SetupError(f"Pi binary is not an executable file: {candidate}")
    package_root: Path | None = None
    package: dict[str, Any] | None = None
    for parent in (candidate.parent, *candidate.parents):
        manifest = parent / "package.json"
        if not manifest.is_file():
            continue
        try:
            parsed = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SetupError(f"could not read Pi package identity: {manifest}") from exc
        if parsed.get("name") == PI_PACKAGE_NAME:
            package_root = parent
            package = parsed
            break
    if package_root is None or package is None:
        raise SetupError(
            f"Pi executable is not inside a {PI_PACKAGE_NAME}@{PI_PACKAGE_VERSION} package: {candidate}"
        )
    if package.get("version") != PI_PACKAGE_VERSION:
        raise SetupError(
            f"Pi package version is {package.get('version')!r}; expected {PI_PACKAGE_VERSION}"
        )
    bin_field = package.get("bin")
    relative_bin = bin_field.get("pi") if isinstance(bin_field, dict) else None
    if not isinstance(relative_bin, str):
        raise SetupError("Pi package manifest does not declare bin.pi")
    expected = (package_root / relative_bin).resolve(strict=True)
    if candidate != expected:
        raise SetupError(f"Pi executable does not match the package's bin.pi: {candidate}")
    return candidate


def static_payloads(agent_dir: Path, specs: tuple[tuple[Path, str, int], ...]):
    items: list[tuple[bytes, Path, int]] = []
    for source, relative, mode in specs:
        if not source.is_file():
            raise SetupError(f"missing bundled asset: {source}")
        items.append((source.read_bytes(), agent_dir / relative, mode))
    return items


def guard_payloads(
    agent_dir: Path,
    pi_binary: Path,
    network_profile: str,
    custom_domains: list[str],
    permission_profile: str,
):
    node_binary = shutil.which("node")
    if not node_binary:
        raise SetupError("node is required to render the protected runtime path")
    trusted_path = ":".join(
        dict.fromkeys(
            [str(Path(node_binary).absolute().parent), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        )
    )
    trusted_home = Path(pwd.getpwuid(os.getuid()).pw_dir).resolve(strict=True)
    items = static_payloads(agent_dir, GUARD_ASSETS)
    sandbox_config = sandbox_policy(agent_dir)
    if network_profile == "open":
        sandbox_config["networkMode"] = "open"
        allowed_domains = []
    elif network_profile == "development":
        sandbox_config["networkMode"] = "restricted"
        allowed_domains = DEVELOPMENT_DOMAINS
    elif network_profile == "custom":
        sandbox_config["networkMode"] = "restricted"
        if not custom_domains:
            raise SetupError("custom network profile requires at least one --allow-domain")
        allowed_domains = custom_domains
    else:
        sandbox_config["networkMode"] = "restricted"
        allowed_domains = []
    sandbox_config["network"]["allowedDomains"] = allowed_domains
    items.append(
        (
            (json.dumps(sandbox_config, indent=2) + "\n").encode(),
            agent_dir / "extensions" / "sandbox.json",
            0o600,
        )
    )
    items.append(
        (
            permission_policy_payload(permission_profile),
            agent_dir / "extensions" / "pi-safety.json",
            0o600,
        )
    )
    template = (ASSETS / "bin" / "pi-guard").read_text(encoding="utf-8")
    rendered = (
        template.replace("@REAL_PI@", shlex.quote(str(pi_binary)))
        .replace("@AGENT_DIR@", shlex.quote(str(agent_dir)))
        .replace("@TRUSTED_PATH@", shlex.quote(trusted_path))
        .replace("@TRUSTED_HOME@", shlex.quote(str(trusted_home)))
        .encode()
    )
    items.extend(
        [
            (rendered, agent_dir / "bin" / "pi-ox", 0o755),
            (rendered, agent_dir / "bin" / "pi-child", 0o755),
        ]
    )
    return items


def sandbox_policy(agent_dir: Path) -> dict[str, Any]:
    policy = json.loads(
        (ASSETS / "extensions" / "sandbox.json").read_text(encoding="utf-8")
    )
    actual_auth = str(agent_dir / "auth.json")
    protected_agent_paths = [str(agent_dir), str(agent_dir / "**")]
    deny_read = policy["filesystem"]["denyRead"]
    if actual_auth not in deny_read:
        deny_read.append(actual_auth)
    deny_write = policy["filesystem"]["denyWrite"]
    for protected_path in protected_agent_paths:
        if protected_path not in deny_read:
            deny_read.append(protected_path)
        if protected_path not in deny_write:
            deny_write.append(protected_path)
    return policy


def fleet_payloads(agent_dir: Path, permission_profile: str):
    profile_dir = PERMISSION_PROFILE_DIRS[permission_profile]
    specs = (
        (profile_dir / "pi-agent.md", "agents/pi-agent.md", 0o644),
        (profile_dir / "pi-lead.md", "agents/pi-lead.md", 0o644),
        *FLEET_COMMON_ASSETS,
    )
    items = static_payloads(agent_dir, specs)
    items.extend(
        [
            (
                permission_policy_payload(permission_profile),
                agent_dir / "extensions" / "pi-safety.json",
                0o600,
            ),
            (
                (
                    json.dumps(
                        {
                            "defaultSessionDir": str(agent_dir / "subagent-sessions"),
                            "maxSubagentDepth": 2,
                        },
                        indent=2,
                    )
                    + "\n"
                ).encode(),
                agent_dir / "extensions" / "subagent" / "config.json",
                0o600,
            ),
        ]
    )
    return items


def preflight_payloads(
    items: list[tuple[bytes, Path, int]], label: str
) -> list[tuple[bytes, Path, int]]:
    installs: list[tuple[bytes, Path, int]] = []
    conflicts: list[Path] = []
    for payload, destination, mode in items:
        reject_symlink(destination.parent, "asset directory")
        reject_symlink(destination, "asset target")
        if destination.exists():
            if destination.is_file() and destination.read_bytes() == payload:
                print(f"  {destination}: already installed")
            else:
                conflicts.append(destination)
        else:
            installs.append((payload, destination, mode))
    if conflicts:
        joined = "\n  ".join(str(path) for path in conflicts)
        raise SetupError(f"{label} conflict; no files were changed. Review or rename:\n  {joined}")
    return installs


def install_payloads(items: list[tuple[bytes, Path, int]], dry_run: bool) -> None:
    for payload, destination, mode in items:
        print(f"  {destination}: install")
        if not dry_run:
            atomic_write(destination, payload, mode)


def replace_owned_file(path: Path, payload: bytes, mode: int, dry_run: bool) -> None:
    reject_symlink(path, "owned asset")
    if not path.is_file():
        raise SetupError(f"owned asset is missing: {path}")
    if path.read_bytes() == payload:
        print(f"  {path}: unchanged")
        return
    print(f"  {path}: update")
    if dry_run:
        return
    backup = backup_path(path)
    shutil.copy2(path, backup, follow_symlinks=False)
    print(f"  {path}: backup {backup.name}")
    atomic_write(path, payload, mode)


def recognized_permission_profile(agent_dir: Path) -> str:
    current: dict[str, bytes] = {}
    for name in ("pi-agent.md", "pi-lead.md"):
        target = agent_dir / "agents" / name
        reject_symlink(target, "agent profile")
        if not target.is_file():
            raise SetupError(f"agent profile is missing: {target}")
        current[name] = target.read_bytes()
    for profile, directory in PERMISSION_PROFILE_DIRS.items():
        if all(current[name] == (directory / name).read_bytes() for name in current):
            policy = agent_dir / "extensions" / "pi-safety.json"
            reject_symlink(policy, "capability policy")
            if not policy.is_file() or policy.read_bytes() != permission_policy_payload(profile):
                raise SetupError(
                    "installed capability policy does not match the recognized agent profiles"
                )
            return profile
    raise SetupError("installed agent profiles are hand-edited or from an unknown Ox Driver version")


def update_permission_profile(
    agent_dir: Path, permission_profile: str, dry_run: bool
) -> None:
    current = recognized_permission_profile(agent_dir)
    print(f"Child capability profile: {current} -> {permission_profile}")
    directory = PERMISSION_PROFILE_DIRS[permission_profile]
    for name in ("pi-agent.md", "pi-lead.md"):
        replace_owned_file(
            agent_dir / "agents" / name,
            (directory / name).read_bytes(),
            0o644,
            dry_run,
        )
    replace_owned_file(
        agent_dir / "extensions" / "pi-safety.json",
        permission_policy_payload(permission_profile),
        0o600,
        dry_run,
    )


def update_network_profile(
    agent_dir: Path,
    network_profile: str,
    custom_domains: list[str],
    dry_run: bool,
) -> None:
    target = agent_dir / "extensions" / "sandbox.json"
    reject_symlink(target, "sandbox policy")
    if not target.is_file():
        raise SetupError(f"sandbox policy is missing: {target}")
    try:
        current = json.loads(target.read_text(encoding="utf-8"))
        baseline = sandbox_policy(agent_dir)
    except (OSError, json.JSONDecodeError) as exc:
        raise SetupError("could not read the installed sandbox policy") from exc
    if not isinstance(current, dict) or not isinstance(current.get("network"), dict):
        raise SetupError("installed sandbox policy has an unknown shape")
    current_shape = json.loads(json.dumps(current))
    current_shape["networkMode"] = "open"
    current_shape["network"]["allowedDomains"] = []
    if current_shape != baseline:
        raise SetupError("installed sandbox policy is hand-edited or from an unknown Ox Driver version")
    if network_profile == "open":
        mode = "open"
        domains = []
    elif network_profile == "development":
        mode = "restricted"
        domains = DEVELOPMENT_DOMAINS
    elif network_profile == "custom":
        mode = "restricted"
        if not custom_domains:
            raise SetupError("custom network profile requires at least one --allow-domain")
        domains = custom_domains
    else:
        mode = "restricted"
        domains = []
    desired = json.loads(json.dumps(baseline))
    desired["networkMode"] = mode
    desired["network"]["allowedDomains"] = domains
    replace_owned_file(
        target,
        (json.dumps(desired, indent=2) + "\n").encode(),
        0o600,
        dry_run,
    )


def require_guard(agent_dir: Path) -> None:
    required_files = (
        agent_dir / "bin" / "pi-ox",
        agent_dir / "bin" / "pi-child",
        agent_dir / "extensions" / "pi-safety.ts",
        agent_dir / "extensions" / "pi-resilience.ts",
        agent_dir / "extensions" / "pi-image-budget.ts",
        agent_dir / "extensions" / "pi-safety.json",
        agent_dir / "extensions" / "sandbox.json",
        agent_dir / "extensions" / "sandbox" / "index.ts",
        agent_dir / "extensions" / "sandbox" / "sensitive-paths.ts",
    )
    for path in required_files:
        reject_symlink(path, "Ox Driver guard asset")
    missing = [path for path in required_files if not path.is_file()]
    dependency = agent_dir / "extensions" / "sandbox" / "node_modules" / "@anthropic-ai" / "sandbox-runtime"
    if not dependency.is_dir():
        missing.append(dependency)
    for path in required_files[:2]:
        if path.exists() and not os.access(path, os.X_OK):
            missing.append(path)
    if missing:
        joined = "\n  ".join(str(path) for path in missing)
        raise SetupError(
            "fleet install requires the prepared guard and sandbox dependency. Missing:\n  "
            + joined
        )


def require_pi_subagents(agent_dir: Path) -> None:
    package_root = agent_dir / "npm" / "node_modules" / "pi-subagents"
    manifest = package_root / "package.json"
    entry = package_root / "index.ts"
    prompt_runtime = package_root / "src" / "runs" / "shared" / "subagent-prompt-runtime.ts"
    fanout_runtime = package_root / "src" / "extension" / "fanout-child.ts"
    lock = agent_dir / "npm" / "package-lock.json"
    for path in (package_root, manifest, entry, prompt_runtime, fanout_runtime, lock):
        reject_symlink(path, "pi-subagents package path")
    if not all(path.is_file() for path in (manifest, entry, prompt_runtime, fanout_runtime, lock)):
        raise SetupError("fleet install requires the complete pinned pi-subagents package")
    try:
        package = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SetupError("could not read the pi-subagents package identity") from exc
    if package.get("name") != "pi-subagents" or package.get("version") != "0.56.0":
        raise SetupError("installed pi-subagents package is not the reviewed 0.56.0 release")
    try:
        lock_data = json.loads(lock.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SetupError("could not read the pi-subagents package lock") from exc
    pinned = lock_data.get("packages", {}).get("node_modules/pi-subagents", {})
    if pinned.get("version") != "0.56.0" or pinned.get("integrity") != "sha512-XBmKqvrj4mCVQ6/uXiPqCmzHxGfBB+jjwmfNR3El+IfhnaJwZ+W6evXYRI3lQEXe6Nf56xfzUXQExIzE8cT5BQ==":
        raise SetupError("installed pi-subagents lock does not match reviewed registry integrity")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--guard", action="store_true", help="install guarded launchers and safety extensions")
    parser.add_argument(
        "--acknowledge-stealth-terms",
        action="store_true",
        help="confirm that the user reviewed and accepted the governing Stealth data terms",
    )
    parser.add_argument("--fleet", action="store_true", help="add team settings and profiles after the guard is ready")
    parser.add_argument(
        "--update-permission-profile",
        action="store_true",
        help="replace recognized installed agent profiles with --permission-profile",
    )
    parser.add_argument(
        "--update-network-profile",
        action="store_true",
        help="replace a recognized installed sandbox policy with --network-profile",
    )
    parser.add_argument(
        "--permission-profile",
        choices=tuple(PERMISSION_PROFILE_DIRS),
        default="power",
        help="child tool ceiling (default: power)",
    )
    parser.add_argument(
        "--network-profile",
        choices=("open", "none", "development", "custom"),
        default="open",
        help="guarded root and child bash network policy (default: open)",
    )
    parser.add_argument(
        "--allow-domain",
        action="append",
        default=[],
        help="domain allowed by --network-profile custom; repeat as needed",
    )
    parser.add_argument("--dry-run", action="store_true", help="print changes without writing")
    parser.add_argument(
        "--pi-binary",
        type=Path,
        help="exact executable from the reviewed Pi npm package (auto-detected when omitted)",
    )
    parser.add_argument(
        "--config-dir",
        type=Path,
        help="Pi agent directory (default: PI_CODING_AGENT_DIR or ~/.pi/agent)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    configured = args.config_dir or os.environ.get("PI_CODING_AGENT_DIR")
    requested_agent_dir = (Path(configured).expanduser() if configured else Path.home() / ".pi" / "agent").absolute()

    try:
        if requested_agent_dir.is_symlink():
            raise SetupError(f"refusing symlink agent directory: {requested_agent_dir}")
        agent_dir = requested_agent_dir.resolve(strict=False)
        action_count = sum(
            bool(value)
            for value in (
                args.guard,
                args.fleet,
                args.update_permission_profile,
                args.update_network_profile,
            )
        )
        if action_count > 1 and not (args.dry_run and args.guard and args.fleet and action_count == 2):
            raise SetupError("choose one install or update action per run")
        if args.guard and args.fleet and not args.dry_run:
            raise SetupError("run --guard, install/test the sandbox dependency, then run --fleet")
        if args.guard and not args.acknowledge_stealth_terms:
            raise SetupError(
                "--guard requires --acknowledge-stealth-terms after the user reviews the governing Stealth EULA"
            )
        ensure_directory(agent_dir, args.dry_run)

        if args.update_permission_profile:
            require_guard(agent_dir)
            require_pi_subagents(agent_dir)
            print(f"Pi config: {agent_dir}{' (dry run)' if args.dry_run else ''}")
            update_permission_profile(agent_dir, args.permission_profile, args.dry_run)
            print("Next: rerun the matching capability and sandbox acceptance tests.")
            return 0

        if args.update_network_profile:
            require_guard(agent_dir)
            print(f"Pi config: {agent_dir}{' (dry run)' if args.dry_run else ''}")
            update_network_profile(
                agent_dir,
                args.network_profile,
                args.allow_domain,
                args.dry_run,
            )
            print("Next: rerun the matching capability and sandbox acceptance tests.")
            return 0

        models_path = agent_dir / "models.json"
        settings_path = agent_dir / "settings.json"
        models = load_json(models_path)
        settings = load_json(settings_path)

        model_changes: list[str] = []
        providers = models.setdefault("providers", {})
        if not isinstance(providers, dict):
            raise SetupError("models.json providers must be an object")
        openrouter = providers.setdefault("openrouter", {})
        if not isinstance(openrouter, dict):
            raise SetupError("models.json providers.openrouter must be an object")
        overrides = openrouter.setdefault("modelOverrides", {})
        if not isinstance(overrides, dict):
            raise SetupError("models.json openrouter.modelOverrides must be an object")
        model = overrides.setdefault("stealth/ox-alpha", {})
        if not isinstance(model, dict):
            raise SetupError("ox-alpha model override must be an object")
        set_value(
            model,
            "thinkingLevelMap",
            THINKING_MAP,
            "providers.openrouter.modelOverrides.stealth/ox-alpha.thinkingLevelMap",
            model_changes,
        )

        setting_changes: list[str] = []
        compaction = settings.setdefault("compaction", {})
        if not isinstance(compaction, dict):
            raise SetupError("settings.json compaction must be an object")
        for key, value in COMPACTION.items():
            set_value(compaction, key, value, f"compaction.{key}", setting_changes)
        retry = settings.setdefault("retry", {})
        if not isinstance(retry, dict):
            raise SetupError("settings.json retry must be an object")
        for key, value in RETRY.items():
            set_value(retry, key, value, f"retry.{key}", setting_changes)
        provider_retry = retry.setdefault("provider", {})
        if not isinstance(provider_retry, dict):
            raise SetupError("settings.json retry.provider must be an object")
        for key, value in PROVIDER_RETRY.items():
            set_value(provider_retry, key, value, f"retry.provider.{key}", setting_changes)
        terminal = settings.setdefault("terminal", {})
        if not isinstance(terminal, dict):
            raise SetupError("settings.json terminal must be an object")
        set_value(terminal, "showImages", False, "terminal.showImages", setting_changes)

        installs: list[tuple[bytes, Path, int]] = []
        if args.guard:
            installs.extend(
                preflight_payloads(
                    guard_payloads(
                        agent_dir,
                        resolve_pi_binary(args.pi_binary),
                        args.network_profile,
                        args.allow_domain,
                        args.permission_profile,
                    ),
                    "guard asset",
                )
            )

        if args.fleet:
            if not args.dry_run:
                require_guard(agent_dir)
                require_pi_subagents(agent_dir)
            subagents = settings.setdefault("subagents", {})
            if not isinstance(subagents, dict):
                raise SetupError("settings.json subagents must be an object")
            for key, value in SUBAGENTS.items():
                set_value(subagents, key, value, f"subagents.{key}", setting_changes)
            installs.extend(
                preflight_payloads(
                    fleet_payloads(agent_dir, args.permission_profile),
                    "fleet profile",
                )
            )

        print(f"Pi config: {agent_dir}{' (dry run)' if args.dry_run else ''}")
        save_json(models_path, models, model_changes, args.dry_run)
        save_json(settings_path, settings, setting_changes, args.dry_run)
        install_payloads(installs, args.dry_run)

        if args.guard:
            print(f"Next: cd {agent_dir / 'extensions' / 'sandbox'} && npm ci --ignore-scripts")
            print("Then run scripts/test_guard.py against this config before --fleet.")
        elif args.fleet:
            print(f"Installed child capability profile: {args.permission_profile}")
            print("Next: verify pi-subagents is pinned, then start the harness through bin/pi-ox and run /subagents-doctor.")
        else:
            print("Next: restart Pi and run the direct route probe from references/pi-setup.md.")
        return 0
    except SetupError as exc:
        print(f"setup failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
