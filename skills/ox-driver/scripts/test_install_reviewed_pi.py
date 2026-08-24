#!/usr/bin/env python3
"""Unit checks for the reviewed Pi package-tree installer."""

from __future__ import annotations

import importlib.util
import io
import json
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("install_reviewed_pi.py")
SPEC = importlib.util.spec_from_file_location("install_reviewed_pi", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReviewedPiInstallerTests(unittest.TestCase):
    def test_integrity_accepts_exact_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "package.tgz"
            artifact.write_bytes(b"reviewed fixture")
            MODULE.verify(artifact, MODULE.integrity(artifact))

    def test_integrity_rejects_changed_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "package.tgz"
            artifact.write_bytes(b"changed fixture")
            with self.assertRaises(SystemExit):
                MODULE.verify(artifact, "sha512-invalid")

    def test_origin_and_reviewed_identity_are_fixed(self) -> None:
        self.assertEqual(MODULE.VERSION, "0.84.3")
        self.assertTrue(MODULE.TARBALL_URL.startswith("https://registry.npmjs.org/"))
        self.assertTrue(MODULE.EXPECTED_INTEGRITY.startswith("sha512-"))
        self.assertEqual(len(MODULE.PI_FAMILY_DEPENDENCIES), 6)
        self.assertEqual(set(MODULE.PI_FAMILY_DEPENDENCIES), set(MODULE.PI_FAMILY_INTEGRITY))
        self.assertIn("pi-telemetry", " ".join(MODULE.PI_FAMILY_DEPENDENCIES))

    def test_family_artifact_rejects_correct_version_with_wrong_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "pi-ai-0.84.3.tgz"
            artifact.write_bytes(b"correct name and version, wrong bytes")
            with self.assertRaises(SystemExit):
                MODULE.verify_family_artifact(artifact, "@earendil-works/pi-ai")

    def test_complete_lockfile_adds_all_pins_and_removes_dev_dependencies(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dependencies = {"chalk": "5.6.2"}
            optional = {"optional-fixture": "1.0.0"}
            manifest = {
                "name": MODULE.PACKAGE,
                "version": MODULE.VERSION,
                "dependencies": dependencies,
                "optionalDependencies": optional,
                "devDependencies": {"fixture-dev": "1.0.0"},
            }
            packages = {
                "": {
                    "name": MODULE.PACKAGE,
                    "version": MODULE.VERSION,
                    "dependencies": dependencies,
                    "optionalDependencies": optional,
                }
            }
            for package in MODULE.PI_FAMILY_DEPENDENCIES:
                packages[f"node_modules/{package}"] = {
                    "version": MODULE.VERSION,
                    "resolved": MODULE.family_tarball_url(package),
                }
            (root / "package.json").write_text(json.dumps(manifest), encoding="utf-8")
            (root / "npm-shrinkwrap.json").write_text(
                json.dumps({"lockfileVersion": 3, "packages": packages}), encoding="utf-8"
            )
            MODULE.complete_lockfile(root)
            completed_manifest = json.loads((root / "package.json").read_text(encoding="utf-8"))
            completed_lock = json.loads((root / "npm-shrinkwrap.json").read_text(encoding="utf-8"))
            self.assertNotIn("devDependencies", completed_manifest)
            for package, expected in MODULE.PI_FAMILY_INTEGRITY.items():
                self.assertEqual(
                    completed_lock["packages"][f"node_modules/{package}"]["integrity"],
                    expected,
                )

    def test_complete_lockfile_rejects_missing_nonfamily_integrity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = {"name": MODULE.PACKAGE, "version": MODULE.VERSION}
            packages = {"": {"name": MODULE.PACKAGE, "version": MODULE.VERSION}}
            for package in MODULE.PI_FAMILY_DEPENDENCIES:
                packages[f"node_modules/{package}"] = {
                    "version": MODULE.VERSION,
                    "resolved": MODULE.family_tarball_url(package),
                }
            packages["node_modules/unpinned"] = {"version": "1.0.0"}
            (root / "package.json").write_text(json.dumps(manifest), encoding="utf-8")
            (root / "npm-shrinkwrap.json").write_text(
                json.dumps({"lockfileVersion": 3, "packages": packages}), encoding="utf-8"
            )
            with self.assertRaises(SystemExit):
                MODULE.complete_lockfile(root)

    def test_safe_extract_rejects_path_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            archive_path = Path(temporary) / "bad.tgz"
            payload = b"bad"
            with tarfile.open(archive_path, "w:gz") as archive:
                info = tarfile.TarInfo("package/../../escape")
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))
            with self.assertRaises(SystemExit):
                MODULE.safe_extract_package(archive_path, Path(temporary) / "out")

    def test_install_refuses_existing_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.tgz"
            source.write_bytes(b"unused")
            target = root / "existing"
            target.mkdir()
            with self.assertRaises(SystemExit):
                MODULE.install_reviewed_tree(source, target, "npm")

    def test_install_uses_lock_enforcing_npm_ci(self) -> None:
        command = MODULE.npm_ci_command("/reviewed/npm", Path("/private/cache"))
        self.assertEqual(command[:2], ["/reviewed/npm", "ci"])
        self.assertIn("--omit=dev", command)
        self.assertIn("--ignore-scripts", command)
        self.assertIn("--no-audit", command)
        self.assertIn("--no-fund", command)
        self.assertIn("--registry=https://registry.npmjs.org", command)
        self.assertEqual(command[-2:], ["--cache", "/private/cache"])

    def test_npm_ci_rejects_bad_local_tarball_integrity(self) -> None:
        npm = shutil.which("npm")
        if not npm:
            self.skipTest("npm is not installed")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifact = root / "fixture-pkg-1.0.0.tgz"
            payload = json.dumps({"name": "fixture-pkg", "version": "1.0.0"}).encode()
            with tarfile.open(artifact, "w:gz") as archive:
                info = tarfile.TarInfo("package/package.json")
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))
            dependency = "file:./fixture-pkg-1.0.0.tgz"
            (root / "package.json").write_text(
                json.dumps(
                    {
                        "name": "integrity-probe",
                        "version": "1.0.0",
                        "dependencies": {"fixture-pkg": dependency},
                    }
                ),
                encoding="utf-8",
            )
            (root / "package-lock.json").write_text(
                json.dumps(
                    {
                        "name": "integrity-probe",
                        "version": "1.0.0",
                        "lockfileVersion": 3,
                        "packages": {
                            "": {
                                "name": "integrity-probe",
                                "version": "1.0.0",
                                "dependencies": {"fixture-pkg": dependency},
                            },
                            "node_modules/fixture-pkg": {
                                "version": "1.0.0",
                                "resolved": "file:fixture-pkg-1.0.0.tgz",
                                "integrity": "sha512-intentionally-wrong",
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )
            result = subprocess.run(
                MODULE.npm_ci_command(npm, root / "cache"),
                cwd=root,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("EINTEGRITY", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
