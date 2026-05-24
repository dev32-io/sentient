"""Capability → transport resolution. Reads board manifest, gates on reachability."""
from __future__ import annotations

from enum import Enum
from typing import Callable

from cli.board import BoardManifest
from cli.errors import TransportUnavailable


class Transport(str, Enum):
    USB_CDC = "usb-cdc"
    HTTP = "http"
    AUTO = "auto"


ReachableProbe = Callable[[BoardManifest], bool]


def resolve_transport(
    manifest: BoardManifest,
    capability: str,
    *,
    http_reachable: ReachableProbe,
    daemon_reachable: ReachableProbe,
) -> Transport:
    if capability not in manifest.capabilities:
        raise KeyError(
            f"board '{manifest.name}' has no capability '{capability}'; "
            f"declared: {sorted(manifest.capabilities)}"
        )

    cap = manifest.capabilities[capability]
    if cap.transport == "auto":
        return Transport.AUTO

    if cap.transport == "http":
        if not http_reachable(manifest):
            raise TransportUnavailable(
                f"HTTP unavailable for '{capability}' on {manifest.name}",
                next_step=(
                    f"confirm cube WiFi with `esp32-devtool logs --follow`, "
                    f"then retry"
                ),
            )
        return Transport.HTTP

    if cap.transport == "usb-cdc":
        if not daemon_reachable(manifest):
            raise TransportUnavailable(
                f"daemon unreachable for '{capability}' on {manifest.name}",
                next_step="run `esp32-devtool daemon start` or check the cable",
            )
        return Transport.USB_CDC

    raise ValueError(f"unknown transport '{cap.transport}' for '{capability}'")
