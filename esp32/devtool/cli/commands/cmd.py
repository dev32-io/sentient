"""esp32-devtool cmd <verb> — JSON-RPC over USB-CDC."""
from __future__ import annotations

import json

import click

from cli.board import BOARDS_DIR, detect_board
from cli.errors import DevtoolError
from cli.transport.usb_cdc import UsbCdcClient


def _parse_params(params: tuple[str, ...]) -> dict:
    out: dict = {}
    for p in params:
        if "=" not in p:
            raise click.BadParameter(f"param '{p}' missing =")
        k, v = p.split("=", 1)
        try:
            out[k] = json.loads(v)
        except json.JSONDecodeError:
            out[k] = v
    return out


def run(ctx_obj: dict, verb: str, params: tuple[str, ...]) -> int:
    try:
        manifest = detect_board(
            boards_dir=BOARDS_DIR,
            override_name=ctx_obj.get("board"),
        )
        client = UsbCdcClient.for_manifest(
            manifest, port_override=ctx_obj.get("port")
        )
        result = client.invoke(verb, _parse_params(params))
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
    click.echo(json.dumps(result))
    return 0
