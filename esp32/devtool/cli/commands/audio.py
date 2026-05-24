"""esp32-devtool audio record|play|inject — HTTP capture/playback/injection.

record / inject ride the devtool HTTP companion (binary PCM bodies); play
still routes through USB-CDC because the audio.play_pcm verb has not yet
migrated to HTTP (devtool plan Task 24).
"""
from __future__ import annotations

import json
from pathlib import Path

import click

from cli.board import BOARDS_DIR, detect_board
from cli.errors import DevtoolError, report_devtool_error
from cli.transport.http import HttpClient, resolve_base_url
from cli.transport.usb_cdc import UsbCdcClient


# /audio/record returns raw PCM, which is slow over WiFi vs JSON verbs. A 10 s
# capture at 16 kHz mono is 320 KB; allow generous timeout so the underlying
# AudioService::RecordPcm has time to drain its 1 s codec buffer and stream
# back.
_HTTP_TIMEOUT_S = 30.0


def _http(ctx_obj: dict) -> tuple:
    manifest = detect_board(boards_dir=BOARDS_DIR,
                            override_name=ctx_obj.get("board"))
    base = resolve_base_url(manifest, override=ctx_obj.get("http_url"))
    return manifest, HttpClient(base_url=base, timeout_s=_HTTP_TIMEOUT_S)


def record(ctx_obj: dict, duration_ms: int, out_path: str) -> int:
    try:
        _, client = _http(ctx_obj)
        body, headers = client.get_bytes(
            f"/audio/record?duration_ms={duration_ms}"
        )
    except DevtoolError as e:
        report_devtool_error(e, json_out=ctx_obj.get("json_out", False))
        return e.exit_code

    Path(out_path).write_bytes(body)
    samples = int(headers.get("X-Audio-Samples", str(len(body) // 2)))
    if ctx_obj.get("json_out"):
        click.echo(json.dumps({
            "out": out_path, "samples": samples, "bytes": len(body),
        }))
    else:
        click.echo(f"recorded {samples} samples -> {out_path}")
    return 0


def inject(ctx_obj: dict, in_path: str) -> int:
    try:
        _, client = _http(ctx_obj)
        body = Path(in_path).read_bytes()
        result = client.post_bytes(
            "/audio/inject", body,
            content_type="audio/L16; rate=16000; channels=1",
        )
    except DevtoolError as e:
        report_devtool_error(e, json_out=ctx_obj.get("json_out", False))
        return e.exit_code
    click.echo(json.dumps(result))
    return 0


def play(ctx_obj: dict, in_path: str) -> int:
    """Small pre-baked clips via USB-CDC `audio.play_pcm` verb.

    Large streams should use `inject` instead. The play_pcm verb still lives
    in agent_console; if its USB-CDC dispatch is unavailable the call surfaces
    a TransportUnavailable / VerbError that the caller reports verbatim.
    """
    try:
        manifest = detect_board(boards_dir=BOARDS_DIR,
                                override_name=ctx_obj.get("board"))
        client = UsbCdcClient.for_manifest(
            manifest, port_override=ctx_obj.get("port"),
        )
        import base64
        b64 = base64.b64encode(Path(in_path).read_bytes()).decode()
        result = client.invoke("audio.play_pcm", {"pcm_b64": b64, "rate": 16000})
    except DevtoolError as e:
        report_devtool_error(e, json_out=ctx_obj.get("json_out", False))
        return e.exit_code
    click.echo(json.dumps(result))
    return 0
