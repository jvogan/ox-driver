#!/usr/bin/env python3
"""Run the setup tests bundled with the ox-driver skill."""

from pathlib import Path
import runpy

SCRIPT = (
    Path(__file__).resolve().parent.parent
    / "skills"
    / "ox-driver"
    / "scripts"
    / "test_setup.py"
)

runpy.run_path(str(SCRIPT), run_name="__main__")
