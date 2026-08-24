#!/usr/bin/env python3
"""Run the disposable guard-install test bundled with ox-driver."""

from pathlib import Path
import runpy

SCRIPT = (
    Path(__file__).resolve().parent.parent
    / "skills"
    / "ox-driver"
    / "scripts"
    / "test_guard_install.py"
)

runpy.run_path(str(SCRIPT), run_name="__main__")
