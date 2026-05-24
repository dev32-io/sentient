"""esp32-devtool setup — dev environment bootstrap.

Ports `esp32/cube/scripts/setup-hil.sh` and adds the lvgl-sim cmake bootstrap.
Board-agnostic: pure host-side toolchain setup, no daemon, no serial.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import click

from cli.repo_root import resolve_repo_root


HIL_VENV_REL = "esp32/cube/tests/hil/.venv"
HIL_REQS_REL = "esp32/cube/tests/hil/requirements.txt"
LVGL_SIM_REL = "esp32/cube/lvgl-sim"


def run(hil: bool, lvgl_sim: bool) -> int:
    repo = resolve_repo_root()
    if hil:
        venv = repo / HIL_VENV_REL
        if not venv.exists():
            subprocess.check_call([sys.executable, "-m", "venv", str(venv)])
        pip = venv / "bin" / "pip"
        req = repo / HIL_REQS_REL
        if not req.exists():
            click.echo(
                f"[esp32-devtool] requirements file missing: {req}", err=True,
            )
            return 5
        subprocess.check_call(
            [str(pip), "install", "--upgrade", "pip", "--quiet"],
        )
        subprocess.check_call(
            [str(pip), "install", "-r", str(req), "--quiet"],
        )
        click.echo(f"HIL venv ready at {venv}")
    if lvgl_sim:
        sim = repo / LVGL_SIM_REL
        if not sim.exists():
            click.echo(
                f"[esp32-devtool] lvgl-sim dir missing: {sim}", err=True,
            )
            return 5
        subprocess.check_call(
            ["cmake", "-S", str(sim), "-B", str(sim / "build")],
            cwd=str(sim),
        )
        subprocess.check_call(
            ["cmake", "--build", str(sim / "build"), "-j"], cwd=str(sim),
        )
        click.echo(f"lvgl-sim built at {sim}/build")
    if not (hil or lvgl_sim):
        click.echo("nothing to do — pass --hil or --lvgl-sim", err=True)
        return 2
    return 0
