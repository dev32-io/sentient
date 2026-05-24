"""Daemon lifecycle: spawn / ensure / idle-kill, per-port-hash scoping."""
from __future__ import annotations

import enum
import hashlib
import json
import os
import socket
import subprocess
import time
from pathlib import Path
from typing import Callable

from cli.errors import TransportUnavailable

# AF_UNIX path limit: 104 chars on macOS, 108 on Linux. Use 104 as the safe ceiling.
_AF_UNIX_PATH_MAX = 104


def _runtime_dir() -> Path:
    override = os.environ.get("ESP32_DEVTOOL_RUNTIME_DIR")
    if override:
        return Path(override)
    return Path("/tmp/esp32-devtool")


def port_hash(port: str) -> str:
    return hashlib.sha1(port.encode()).hexdigest()[:12]


def socket_path_for(port: str) -> Path:
    p = _runtime_dir() / f"{port_hash(port)}.sock"
    if len(str(p)) > _AF_UNIX_PATH_MAX:
        raise ValueError(
            f"daemon socket path '{p}' is {len(str(p))} chars; AF_UNIX limit is "
            f"{_AF_UNIX_PATH_MAX}. Set ESP32_DEVTOOL_RUNTIME_DIR to a shorter path "
            f"(default /tmp/esp32-devtool stays well under the limit)."
        )
    return p


def pidfile_path_for(port: str) -> Path:
    return _runtime_dir() / f"{port_hash(port)}.pid"


def logfile_path_for(port: str) -> Path:
    return _runtime_dir() / f"{port_hash(port)}.log"


class DaemonState(enum.Enum):
    ALREADY_RUNNING = "already_running"
    SPAWNED = "spawned"


def _ping(sock_path: Path, timeout_s: float = 1.0) -> bool:
    if not sock_path.exists():
        return False
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout_s)
        s.connect(str(sock_path))
        s.sendall(json.dumps({"kind": "ping"}).encode() + b"\n")
        data = s.recv(1024)
        s.close()
        return b"ok" in data
    except (OSError, socket.timeout):
        return False


def fetch_events(sock_path: Path, n: int = 200, timeout_s: float = 2.0) -> list[str]:
    """Fetch the last ``n`` lines from a running daemon's ring buffer.

    Returns [] if the daemon isn't reachable; raises only on protocol corruption.
    """
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout_s)
    try:
        s.connect(str(sock_path))
        s.sendall((json.dumps({"kind": "events", "n": n}) + "\n").encode())
        buf = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
    except (OSError, socket.timeout):
        return []
    finally:
        s.close()
    try:
        obj = json.loads(buf.decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        return []
    events = obj.get("events", [])
    return events if isinstance(events, list) else []


def _default_spawn(port: str) -> None:
    cli_main = Path(__file__).resolve().parents[1] / "main.py"
    log = logfile_path_for(port)
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, "ab", buffering=0) as lf:
        subprocess.Popen(
            ["uv", "run", "--script", str(cli_main),
             "daemon", "start", "--port", port, "--detach"],
            stdout=lf, stderr=lf, stdin=subprocess.DEVNULL,
            start_new_session=True,
        )


def ensure_daemon(
    port: str,
    *,
    spawn: Callable[[str], None] = _default_spawn,
    spawn_timeout_s: float = 12.0,
) -> DaemonState:
    sock_path = socket_path_for(port)
    sock_path.parent.mkdir(parents=True, exist_ok=True)

    if _ping(sock_path):
        return DaemonState.ALREADY_RUNNING

    spawn(port)
    deadline = time.time() + spawn_timeout_s
    while time.time() < deadline:
        if _ping(sock_path):
            return DaemonState.SPAWNED
        time.sleep(0.1)

    raise TransportUnavailable(
        f"daemon failed to start within {spawn_timeout_s}s",
        next_step=f"inspect {logfile_path_for(port)}",
    )
