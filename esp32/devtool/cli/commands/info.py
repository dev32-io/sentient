"""esp32-devtool info — GET /info → JSON to stdout."""
from __future__ import annotations

import json

import click

from cli.board import BOARDS_DIR, detect_board
from cli.errors import DevtoolError
from cli.transport.http import HttpClient, resolve_base_url


def run(ctx_obj: dict) -> int:
    try:
        manifest = detect_board(
            boards_dir=BOARDS_DIR,
            override_name=ctx_obj.get("board"),
        )
        base = resolve_base_url(manifest, override=ctx_obj.get("http_url"))
        client = HttpClient(base_url=base, timeout_s=3.0)
        payload = client.get_json("/info")
    except DevtoolError as e:
        if ctx_obj.get("json_out"):
            click.echo(json.dumps({
                "error": type(e).__name__,
                "message": str(e),
                "next_step": e.next_step,
            }), err=True)
        else:
            click.echo(f"[esp32-devtool] {e}", err=True)
            if e.next_step:
                click.echo(f"   next step: {e.next_step}", err=True)
        return e.exit_code

    if ctx_obj.get("json_out"):
        click.echo(json.dumps(payload))
    else:
        for k, v in payload.items():
            click.echo(f"{k}: {v}")
    return 0
