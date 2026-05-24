"""esp32-devtool touch <x> <y> [--hold MS] — POST a synthetic tap to /touch."""
from __future__ import annotations

import json

import click

from cli.board import BOARDS_DIR, detect_board
from cli.errors import DevtoolError, report_devtool_error
from cli.transport.http import HttpClient, resolve_base_url


def run(ctx_obj: dict, x: int, y: int, hold_ms: int) -> int:
    try:
        manifest = detect_board(boards_dir=BOARDS_DIR,
                                override_name=ctx_obj.get("board"))
        base = resolve_base_url(manifest, override=ctx_obj.get("http_url"))
        client = HttpClient(base_url=base, timeout_s=5.0)
        result = client.post_json("/touch", {"x": x, "y": y, "hold_ms": hold_ms})
    except DevtoolError as e:
        report_devtool_error(e, json_out=ctx_obj.get("json_out", False))
        return e.exit_code
    click.echo(json.dumps(result))
    return 0
