from __future__ import annotations

from pathlib import Path

import pytest

from cli.board import load_manifest
from cli.errors import TransportUnavailable
from cli.transport.router import resolve_transport, Transport


BOARDS = Path(__file__).resolve().parents[2] / "boards"


def _cube():
    return load_manifest(BOARDS / "cube.yaml")


def test_resolve_screenshot_picks_http_when_reachable():
    t = resolve_transport(_cube(), "screenshot",
                          http_reachable=lambda m: True,
                          daemon_reachable=lambda m: True)
    assert t == Transport.HTTP


def test_resolve_screenshot_unreachable_raises():
    with pytest.raises(TransportUnavailable, match="HTTP"):
        resolve_transport(_cube(), "screenshot",
                          http_reachable=lambda m: False,
                          daemon_reachable=lambda m: True)


def test_resolve_cmd_picks_usb_cdc():
    t = resolve_transport(_cube(), "cmd",
                          http_reachable=lambda m: False,
                          daemon_reachable=lambda m: True)
    assert t == Transport.USB_CDC


def test_resolve_cmd_no_daemon_raises():
    with pytest.raises(TransportUnavailable, match="daemon"):
        resolve_transport(_cube(), "cmd",
                          http_reachable=lambda m: False,
                          daemon_reachable=lambda m: False)


def test_resolve_logs_auto_returns_both():
    t = resolve_transport(_cube(), "logs",
                          http_reachable=lambda m: True,
                          daemon_reachable=lambda m: True)
    assert t == Transport.AUTO


def test_resolve_unknown_verb_raises():
    with pytest.raises(KeyError):
        resolve_transport(_cube(), "no-such-verb",
                          http_reachable=lambda m: True,
                          daemon_reachable=lambda m: True)
