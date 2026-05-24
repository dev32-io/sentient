"""Daemon subcommand bodies — start / stop / status / ring.

main.py keeps only the click decorators that dispatch into this module.
Each function returns an exit code (or invokes sys.exit internally for the
serve loop, which never returns under normal operation).
"""
from __future__ import annotations

import json
import os
import signal
import socket as sock_mod

import click

from cli.daemon.lifecycle import (
    _ping,
    _runtime_dir,
    pidfile_path_for,
    socket_path_for,
)
from cli.daemon.server import _double_fork, serve


def start(port_path: str, idle_seconds: int, detach: bool) -> int:
    if detach:
        _double_fork()
    return serve(port_path, idle_seconds)


def stop(port_path: str) -> int:
    pid_path = pidfile_path_for(port_path)
    if not pid_path.exists():
        click.echo(f"no daemon running for {port_path}", err=True)
        return 0
    pid = int(pid_path.read_text().strip())
    try:
        os.kill(pid, signal.SIGTERM)
        click.echo(f"sent SIGTERM to {pid}")
        return 0
    except ProcessLookupError:
        pid_path.unlink(missing_ok=True)
        click.echo(f"daemon {pid} already gone")
        return 0
    except PermissionError:
        click.echo(
            f"cannot signal daemon {pid}: permission denied "
            f"(daemon owned by another user?)",
            err=True,
        )
        return 5


def status() -> int:
    runtime = _runtime_dir()
    if not runtime.exists():
        click.echo("no daemons running")
        return 0
    for sock in sorted(runtime.glob("*.sock")):
        alive = _ping(sock, timeout_s=0.5)
        click.echo(f"{sock.stem}  {'alive' if alive else 'dead'}  {sock}")
    return 0


def ring(port_path: str, lines: int, filter_pat: str | None) -> int:
    # Streams the daemon's raw ``{"events":[...]}`` envelope verbatim — e2e
    # tests parse the JSON blob (with escaped inner quotes) directly. The
    # ``fetch_events`` helper parses into a list and would change that wire
    # shape, so we keep the manual socket fetch here.
    sock_path = socket_path_for(port_path)
    s = sock_mod.socket(sock_mod.AF_UNIX, sock_mod.SOCK_STREAM)
    s.connect(str(sock_path))
    s.sendall((json.dumps({"kind": "events", "n": lines}) + "\n").encode())
    try:
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            text = chunk.decode("utf-8", errors="replace")
            for line in text.splitlines():
                if filter_pat is None or filter_pat in line:
                    click.echo(line)
    finally:
        s.close()
    return 0
