from __future__ import annotations

import os
import socket
import tempfile
import threading
import time
from pathlib import Path

import pytest

from cli.daemon.lifecycle import (
    port_hash,
    socket_path_for,
    pidfile_path_for,
    logfile_path_for,
    ensure_daemon,
    DaemonState,
)
from cli.errors import TransportUnavailable


@pytest.fixture()
def short_tmp(monkeypatch):
    """Provide a short temp dir that fits inside the Unix socket path limit (104 chars on macOS).

    pytest's tmp_path resolves to /private/var/folders/.../pytest-N/test_name0/ which
    exceeds the 104-char AF_UNIX limit when combined with the hash+.sock suffix.
    Using /tmp/ directly keeps paths short enough.
    """
    d = tempfile.mkdtemp(dir="/tmp", prefix="devtool-test-")
    monkeypatch.setenv("ESP32_DEVTOOL_RUNTIME_DIR", d)
    yield Path(d)
    import shutil
    shutil.rmtree(d, ignore_errors=True)


def test_port_hash_deterministic():
    h1 = port_hash("/dev/cu.usbmodem101")
    h2 = port_hash("/dev/cu.usbmodem101")
    assert h1 == h2
    assert len(h1) == 12


def test_port_hash_distinct_per_port():
    assert port_hash("/dev/cu.usbmodem101") != port_hash("/dev/cu.usbmodem201")


def test_socket_path_contains_hash(short_tmp):
    p = socket_path_for("/dev/cu.usbmodem101")
    assert port_hash("/dev/cu.usbmodem101") in str(p)


def test_ensure_daemon_returns_existing(short_tmp):
    port = "/dev/cu.usbmodem101"
    sock_path = socket_path_for(port)
    sock_path.parent.mkdir(parents=True, exist_ok=True)

    # Fake daemon: bind socket, respond to ping
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(str(sock_path))
    srv.listen(1)

    def fake_daemon():
        c, _ = srv.accept()
        c.recv(4096)
        c.sendall(b'{"ok":true}\n')
        c.close()

    threading.Thread(target=fake_daemon, daemon=True).start()
    state = ensure_daemon(port, spawn=lambda p: pytest.fail("should not spawn"))
    assert state is DaemonState.ALREADY_RUNNING
    srv.close()


def test_ensure_daemon_spawns_when_socket_dead(short_tmp):
    port = "/dev/cu.usbmodem101"
    spawned: list[str] = []

    def fake_spawn(p: str):
        spawned.append(p)
        # Simulate the spawned daemon binding the socket after 200 ms
        def delayed_bind():
            time.sleep(0.2)
            sock_path = socket_path_for(p)
            sock_path.parent.mkdir(parents=True, exist_ok=True)
            srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            srv.bind(str(sock_path))
            srv.listen(1)
            try:
                c, _ = srv.accept()
                c.recv(4096)
                c.sendall(b'{"ok":true}\n')
                c.close()
            finally:
                srv.close()
        threading.Thread(target=delayed_bind, daemon=True).start()

    state = ensure_daemon(port, spawn=fake_spawn, spawn_timeout_s=2.0)
    assert state is DaemonState.SPAWNED
    assert spawned == [port]


def test_ensure_daemon_spawn_timeout(short_tmp):
    port = "/dev/cu.usbmodem101"
    with pytest.raises(TransportUnavailable, match="daemon failed"):
        ensure_daemon(port, spawn=lambda p: None, spawn_timeout_s=0.4)
