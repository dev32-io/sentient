from __future__ import annotations

import json
import socket
import threading
from pathlib import Path

import pytest
import tempfile

from cli.board import load_manifest
from cli.transport.usb_cdc import UsbCdcClient
from cli.errors import VerbError


BOARDS = Path(__file__).resolve().parents[2] / "boards"


@pytest.fixture
def short_tmp(monkeypatch):
    """macOS AF_UNIX path limit is 104 chars; pytest tmp_path exceeds it."""
    d = tempfile.mkdtemp(dir="/tmp", prefix="devtool-usbcdc-")
    monkeypatch.setenv("ESP32_DEVTOOL_RUNTIME_DIR", d)
    yield Path(d)


def _fake_daemon(sock_path: Path, response: dict) -> threading.Thread:
    sock_path.parent.mkdir(parents=True, exist_ok=True)
    if sock_path.exists():
        sock_path.unlink()
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(str(sock_path))
    srv.listen(1)

    def run():
        c, _ = srv.accept()
        # ignore content; reply with response
        c.recv(65536)
        c.sendall((json.dumps(response) + "\n").encode())
        c.close()
        srv.close()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t


def test_invoke_returns_result(short_tmp):
    port = "/dev/cu.usbmodem101"
    from cli.daemon.lifecycle import socket_path_for
    sock = socket_path_for(port)
    _fake_daemon(sock, {"kind": "rsp", "json": json.dumps({
        "jsonrpc": "2.0", "id": 1, "result": {"ok": True, "state": "IDLE"}
    })})
    c = UsbCdcClient(port=port, _auto_ensure=False)
    out = c.invoke("state", {})
    assert out == {"ok": True, "state": "IDLE"}


def test_invoke_error_raises(short_tmp):
    port = "/dev/cu.usbmodem101"
    from cli.daemon.lifecycle import socket_path_for
    sock = socket_path_for(port)
    _fake_daemon(sock, {"kind": "rsp", "json": json.dumps({
        "jsonrpc": "2.0", "id": 1,
        "error": {"code": -32601, "message": "method not found"}
    })})
    c = UsbCdcClient(port=port, _auto_ensure=False)
    with pytest.raises(VerbError, match="method not found"):
        c.invoke("no.such.verb", {})


def test_for_manifest_picks_port(short_tmp):
    m = load_manifest(BOARDS / "cube.yaml")
    c = UsbCdcClient.for_manifest(m, scan_ports=lambda g: ["/dev/cu.usbmodem201"])
    assert c.port == "/dev/cu.usbmodem201"
