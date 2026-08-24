#!/usr/bin/env python3
"""Run the reviewed Pi installer bundled with the ox-driver skill."""

from pathlib import Path
import runpy

SCRIPT = (
    Path(__file__).resolve().parent.parent
    / "skills"
    / "ox-driver"
    / "scripts"
    / "install_reviewed_pi.py"
)

runpy.run_path(str(SCRIPT), run_name="__main__")
