#!/usr/bin/env python3
"""Download, verify, and optionally install the reviewed Pi package tree."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shutil
import stat
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

PACKAGE = "@earendil-works/pi-coding-agent"
REGISTRY = "https://registry.npmjs.org"
VERSIONS_PATH = Path(__file__).resolve().parents[1] / "references" / "versions.json"
PI_FAMILY_DEPENDENCIES = (
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-client",
    "@earendil-works/pi-protocol",
    "@earendil-works/pi-telemetry",
    "@earendil-works/pi-tui",
)


def reviewed_packages() -> dict[str, dict[str, str]]:
    value = json.loads(VERSIONS_PATH.read_text(encoding="utf-8"))
    packages = value.get("packages")
    if not isinstance(packages, dict):
        raise SystemExit("versions.json has no packages object")
    return packages


PINS = reviewed_packages()
VERSION = PINS[PACKAGE]["version"]
EXPECTED_INTEGRITY = PINS[PACKAGE]["integrity"]
PI_FAMILY_INTEGRITY = {
    package: PINS[package]["integrity"] for package in PI_FAMILY_DEPENDENCIES
}
TARBALL_URL = (
    f"{REGISTRY}/@earendil-works/pi-coding-agent/-/pi-coding-agent-{VERSION}.tgz"
)


def default_install_dir() -> Path:
    data_home = os.environ.get("XDG_DATA_HOME")
    base = Path(data_home).expanduser() if data_home else Path.home() / ".local" / "share"
    return base / "ox-driver" / "pi" / VERSION


def integrity(path: Path) -> str:
    digest = hashlib.sha512(path.read_bytes()).digest()
    return "sha512-" + base64.b64encode(digest).decode("ascii")


def verify(path: Path, expected: str = EXPECTED_INTEGRITY) -> None:
    actual = integrity(path)
    if actual != expected:
        raise SystemExit(f"Pi tarball integrity mismatch: expected {expected}, got {actual}")


def download_url(url: str, path: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "ox-driver/1"})
    with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310 - fixed origin
        final = urlparse(response.geturl())
        if (
            final.scheme != "https"
            or final.hostname != "registry.npmjs.org"
            or final.port not in (None, 443)
        ):
            raise SystemExit(
                "refusing Pi tarball redirect outside the official npm registry: "
                f"{response.geturl()}"
            )
        with path.open("xb") as destination:
            shutil.copyfileobj(response, destination)


def download(path: Path) -> None:
    download_url(TARBALL_URL, path)


def family_tarball_url(package: str) -> str:
    name = package.split("/", 1)[1]
    return f"{REGISTRY}/{package}/-/{name}-{VERSION}.tgz"


def read_tar_manifest(path: Path) -> dict[str, object]:
    with tarfile.open(path, "r:gz") as archive:
        try:
            member = archive.getmember("package/package.json")
        except KeyError as exc:
            raise SystemExit(f"npm tarball has no package.json: {path.name}") from exc
        if not member.isfile():
            raise SystemExit(f"npm tarball package.json is not a regular file: {path.name}")
        source = archive.extractfile(member)
        if source is None:
            raise SystemExit(f"could not read npm tarball package.json: {path.name}")
        return json.loads(source.read().decode("utf-8"))


def verify_artifact_identity(path: Path, package: str, version: str) -> None:
    value = read_tar_manifest(path)
    if value.get("name") != package or value.get("version") != version:
        raise SystemExit(
            f"npm tarball identity mismatch: expected {package}@{version}, "
            f"got {value.get('name')}@{value.get('version')}"
        )


def verify_family_artifact(path: Path, package: str) -> None:
    expected = PI_FAMILY_INTEGRITY.get(package)
    if expected is None:
        raise SystemExit(f"unreviewed Pi-family package: {package}")
    verify(path, expected)
    verify_artifact_identity(path, package, VERSION)


def verify_family_tarballs(directory: Path) -> None:
    for package in PI_FAMILY_DEPENDENCIES:
        artifact = directory / f"{package.split('/', 1)[1]}-{VERSION}.tgz"
        download_url(family_tarball_url(package), artifact)
        verify_family_artifact(artifact, package)


def safe_extract_package(source: Path, destination: Path) -> Path:
    package_root = destination / "package"
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    with tarfile.open(source, "r:gz") as archive:
        for member in archive:
            relative = PurePosixPath(member.name)
            if (
                relative.is_absolute()
                or not relative.parts
                or relative.parts[0] != "package"
                or ".." in relative.parts
            ):
                raise SystemExit(f"unsafe path in reviewed Pi tarball: {member.name}")
            target = destination.joinpath(*relative.parts)
            if member.isdir():
                target.mkdir(mode=0o755, parents=True, exist_ok=True)
                continue
            if not member.isfile():
                raise SystemExit(f"unsupported member in reviewed Pi tarball: {member.name}")
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            source_file = archive.extractfile(member)
            if source_file is None:
                raise SystemExit(f"could not read reviewed Pi member: {member.name}")
            with target.open("xb") as destination_file:
                shutil.copyfileobj(source_file, destination_file)
            target.chmod(stat.S_IMODE(member.mode) & 0o755 or 0o644)
    if not package_root.is_dir():
        raise SystemExit("reviewed Pi tarball has no package directory")
    return package_root


def complete_lockfile(package_root: Path) -> None:
    manifest_path = package_root / "package.json"
    lock_path = package_root / "npm-shrinkwrap.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    packages = lock.get("packages")
    root = packages.get("") if isinstance(packages, dict) else None
    if (
        manifest.get("name") != PACKAGE
        or manifest.get("version") != VERSION
        or lock.get("lockfileVersion") != 3
        or not isinstance(root, dict)
        or root.get("name") != PACKAGE
        or root.get("version") != VERSION
    ):
        raise SystemExit("reviewed Pi package or shrinkwrap has an unexpected identity")

    for package in PI_FAMILY_DEPENDENCIES:
        entry = packages.get(f"node_modules/{package}")
        if not isinstance(entry, dict) or entry.get("version") != VERSION:
            raise SystemExit(f"reviewed Pi shrinkwrap has an unexpected {package} version")
        if entry.get("resolved") != family_tarball_url(package):
            raise SystemExit(f"reviewed Pi shrinkwrap has an unexpected {package} origin")
        expected = PI_FAMILY_INTEGRITY[package]
        if entry.get("integrity") not in (None, expected):
            raise SystemExit(f"reviewed Pi shrinkwrap conflicts with the {package} pin")
        entry["integrity"] = expected

    incomplete = [
        path
        for path, entry in packages.items()
        if path and (not isinstance(entry, dict) or not entry.get("integrity"))
    ]
    if incomplete:
        raise SystemExit(f"reviewed Pi shrinkwrap still lacks integrity: {incomplete[0]}")

    manifest.pop("devDependencies", None)
    if manifest.get("dependencies", {}) != root.get("dependencies", {}):
        raise SystemExit("reviewed Pi manifest and shrinkwrap dependencies differ")
    if manifest.get("optionalDependencies", {}) != root.get("optionalDependencies", {}):
        raise SystemExit("reviewed Pi manifest and shrinkwrap optional dependencies differ")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    lock_path.write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")


def verify_installed_family(package_root: Path) -> None:
    manifest = json.loads((package_root / "package.json").read_text(encoding="utf-8"))
    if manifest.get("name") != PACKAGE or manifest.get("version") != VERSION:
        raise SystemExit("installed Pi package identity does not match the reviewed version")
    lock = json.loads((package_root / "npm-shrinkwrap.json").read_text(encoding="utf-8"))
    for package in PI_FAMILY_DEPENDENCIES:
        scope, name = package.split("/", 1)
        path = package_root / "node_modules" / scope / name / "package.json"
        if not path.is_file() or path.is_symlink():
            raise SystemExit(f"installed Pi dependency is missing: {package}")
        value = json.loads(path.read_text(encoding="utf-8"))
        if value.get("name") != package or value.get("version") != VERSION:
            raise SystemExit(f"installed Pi dependency is outside the reviewed pin: {package}")
        entry = lock.get("packages", {}).get(f"node_modules/{package}")
        if not isinstance(entry, dict) or entry.get("integrity") != PI_FAMILY_INTEGRITY[package]:
            raise SystemExit(f"installed Pi shrinkwrap lacks reviewed integrity: {package}")


def npm_ci_command(npm: str, cache: Path) -> list[str]:
    return [
        npm,
        "ci",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        f"--registry={REGISTRY}",
        "--cache",
        str(cache),
    ]


def install_reviewed_tree(source: Path, target: Path, npm: str) -> Path:
    target = target.expanduser().absolute()
    if target.exists() or target.is_symlink():
        raise SystemExit(
            f"refusing to replace existing reviewed Pi directory: {target}; "
            "verify and move it aside before reinstalling"
        )
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".pi-install-", dir=target.parent))
    try:
        package_root = safe_extract_package(source, temporary / "source")
        complete_lockfile(package_root)
        cache = temporary / "npm-cache"
        subprocess.run(npm_ci_command(npm, cache), cwd=package_root, check=True)
        verify_installed_family(package_root)
        executable = package_root / "dist" / "cli.js"
        if not executable.is_file() or executable.is_symlink() or not os.access(executable, os.X_OK):
            raise SystemExit("reviewed Pi executable is missing or not executable")
        os.replace(package_root, target)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
    return target / "dist" / "cli.js"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--install",
        action="store_true",
        help="install into an isolated, versioned user directory with lifecycle scripts disabled",
    )
    parser.add_argument(
        "--install-dir",
        type=Path,
        default=default_install_dir(),
        help="versioned destination used with --install",
    )
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="ox-driver-pi-") as temporary:
        temporary_path = Path(temporary)
        tarball = temporary_path / f"pi-coding-agent-{VERSION}.tgz"
        download(tarball)
        verify(tarball)
        verify_artifact_identity(tarball, PACKAGE, VERSION)
        verify_family_tarballs(temporary_path)
        inspection_root = safe_extract_package(tarball, temporary_path / "inspection")
        complete_lockfile(inspection_root)
        print(f"Verified {PACKAGE}@{VERSION}: {EXPECTED_INTEGRITY}")
        print("Verified six Pi-family tarballs and every shrinkwrap integrity entry.")
        if not args.install:
            print("Verification only; rerun with --install to create the isolated reviewed tree.")
            return 0
        npm = shutil.which("npm")
        if not npm:
            raise SystemExit("npm is required to install the reviewed Pi package tree")
        executable = install_reviewed_tree(tarball, args.install_dir, npm)
        print(f"Installed reviewed Pi without replacing raw Pi: {executable}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
