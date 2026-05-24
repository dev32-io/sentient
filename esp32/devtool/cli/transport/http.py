"""HTTP transport client for esp32-devtool."""
from __future__ import annotations

import json as json_mod
from dataclasses import dataclass
from typing import Any

import requests

from cli.board import BoardManifest
from cli.errors import TransportUnavailable


def _discover_ip_via_usb(manifest: BoardManifest) -> str:
    """Issue a USB-CDC `state` verb to discover the cube's IP.

    Imported lazily to avoid circular import; full impl in transport/usb_cdc.py.
    """
    from cli.transport.usb_cdc import UsbCdcClient
    client = UsbCdcClient.for_manifest(manifest)
    result = client.invoke("state", {})
    ip = result.get("ip") or result.get("wifi", {}).get("ip")
    if not ip:
        raise TransportUnavailable(
            "cube has no IP yet (state.ip empty)",
            next_step="wait for WiFi (`esp32-devtool logs --follow`), then retry",
        )
    return ip


def resolve_base_url(manifest: BoardManifest, *, override: str | None) -> str:
    if override:
        return override
    if not manifest.http.enabled:
        raise TransportUnavailable(
            f"board {manifest.name} has http.enabled=false",
            next_step="enable http in the manifest, or pass --http <url>",
        )
    if manifest.http.discover_via == "static":
        host = manifest.http.static_host
        if not host:
            raise TransportUnavailable(
                "http.discover_via=static but http.static_host is empty",
                next_step="set http.static_host in the manifest, or pass --http",
            )
        return f"http://{host}:{manifest.http.port}"
    if manifest.http.discover_via == "usb-info":
        ip = _discover_ip_via_usb(manifest)
        return f"http://{ip}:{manifest.http.port}"
    if manifest.http.discover_via == "mdns":
        raise TransportUnavailable("mdns discovery not implemented in v1")
    raise TransportUnavailable(f"unknown discover_via: {manifest.http.discover_via}")


@dataclass
class HttpClient:
    base_url: str
    timeout_s: float = 5.0

    def get_json(self, path: str) -> dict[str, Any]:
        try:
            r = requests.get(self.base_url + path, timeout=self.timeout_s)
        except (requests.Timeout, requests.ConnectionError) as e:
            raise TransportUnavailable(f"HTTP {path} → {type(e).__name__}: {e}")
        if r.status_code != 200:
            raise TransportUnavailable(f"HTTP {path} → {r.status_code}")
        return r.json()

    def get_bytes(self, path: str, *, accept: str | None = None) -> tuple[bytes, dict]:
        headers = {"Accept": accept} if accept else {}
        try:
            r = requests.get(self.base_url + path, headers=headers,
                             timeout=self.timeout_s, stream=False)
        except (requests.Timeout, requests.ConnectionError) as e:
            raise TransportUnavailable(f"HTTP {path} → {type(e).__name__}: {e}")
        if r.status_code != 200:
            raise TransportUnavailable(f"HTTP {path} → {r.status_code}")
        return r.content, dict(r.headers)

    def post_bytes(self, path: str, body: bytes, *, content_type: str) -> dict[str, Any]:
        try:
            r = requests.post(self.base_url + path, data=body,
                              headers={"Content-Type": content_type},
                              timeout=self.timeout_s)
        except (requests.Timeout, requests.ConnectionError) as e:
            raise TransportUnavailable(f"HTTP POST {path} → {type(e).__name__}: {e}")
        if r.status_code != 200:
            raise TransportUnavailable(f"HTTP POST {path} → {r.status_code}")
        return r.json()

    def post_json(self, path: str, payload: dict) -> dict[str, Any]:
        body = json_mod.dumps(payload).encode()
        return self.post_bytes(path, body, content_type="application/json")

    def reachable(self, path: str = "/info") -> bool:
        try:
            r = requests.get(self.base_url + path, timeout=2.0)
            return 200 <= r.status_code < 300
        except (requests.Timeout, requests.ConnectionError):
            return False
