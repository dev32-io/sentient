"""esp32-devtool restart — `cmd restart`."""
from __future__ import annotations

from cli.commands.cmd import run as cmd_run


def run(ctx_obj) -> int:
    return cmd_run(ctx_obj, "restart", ())
