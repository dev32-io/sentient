from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from cli.board import load_manifest
from cli.errors import TransportUnavailable
from cli.transport.http import HttpClient, resolve_base_url


BOARDS = Path(__file__).resolve().parents[2] / "boards"


def test_resolve_base_url_static():
    m = load_manifest(BOARDS / "cube.yaml")
    m.http.discover_via = "static"
    m.http.static_host = "10.0.0.5"
    assert resolve_base_url(m, override=None) == "http://10.0.0.5:8081"


def test_resolve_base_url_override_wins():
    m = load_manifest(BOARDS / "cube.yaml")
    assert resolve_base_url(m, override="http://1.2.3.4:9999") == "http://1.2.3.4:9999"


def test_resolve_base_url_usb_info(monkeypatch):
    m = load_manifest(BOARDS / "cube.yaml")
    monkeypatch.setattr(
        "cli.transport.http._discover_ip_via_usb",
        lambda mf: "192.168.1.50",
    )
    assert resolve_base_url(m, override=None) == "http://192.168.1.50:8081"


def test_client_get_returns_json():
    with patch("cli.transport.http.requests.get") as mock_get:
        mock_get.return_value.status_code = 200
        mock_get.return_value.json.return_value = {"ok": True}
        c = HttpClient(base_url="http://1.2.3.4:8081", timeout_s=2.0)
        assert c.get_json("/info") == {"ok": True}


def test_client_get_timeout_raises():
    import requests as rq
    with patch("cli.transport.http.requests.get",
               side_effect=rq.Timeout("boom")):
        c = HttpClient(base_url="http://1.2.3.4:8081", timeout_s=0.5)
        with pytest.raises(TransportUnavailable):
            c.get_json("/info")


def test_reachable_true_on_200():
    with patch("cli.transport.http.requests.get") as mock_get:
        mock_get.return_value.status_code = 200
        c = HttpClient(base_url="http://1.2.3.4:8081", timeout_s=1.0)
        assert c.reachable("/info") is True


def test_reachable_false_on_connection_error():
    import requests as rq
    with patch("cli.transport.http.requests.get",
               side_effect=rq.ConnectionError("nope")):
        c = HttpClient(base_url="http://1.2.3.4:8081", timeout_s=1.0)
        assert c.reachable("/info") is False
