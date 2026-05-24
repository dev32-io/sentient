"""esp32-devtool ui dump-tree — `cmd ui.dump_tree`."""
from __future__ import annotations

from cli.commands.cmd import run as cmd_run


def dump_tree(ctx_obj) -> int:
    return cmd_run(ctx_obj, "ui.dump_tree", ())
