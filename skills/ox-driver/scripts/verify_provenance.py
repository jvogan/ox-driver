#!/usr/bin/env python3
"""Compare reviewed npm versions, integrity hashes, and Git commits with npm."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

MANIFEST = Path(__file__).resolve().parent.parent / "references" / "versions.json"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", default="https://registry.npmjs.org")
    args = parser.parse_args()
    packages = json.loads(MANIFEST.read_text(encoding="utf-8"))["packages"]
    for name, expected in packages.items():
        output = subprocess.check_output(
            [
                "npm",
                "view",
                f"{name}@{expected['version']}",
                "dist.integrity",
                "gitHead",
                "--registry",
                args.registry,
                "--json",
            ],
            text=True,
        )
        actual = json.loads(output)
        if isinstance(actual, str):
            actual = {"dist.integrity": actual}
        if actual.get("dist.integrity") != expected["integrity"]:
            raise SystemExit(f"provenance mismatch: {name} integrity")
        if "gitHead" in expected and actual.get("gitHead") != expected["gitHead"]:
            raise SystemExit(f"provenance mismatch: {name} gitHead")
        print(f"OK: {name}@{expected['version']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
