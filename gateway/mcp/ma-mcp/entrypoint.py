"""Streamable-HTTP entrypoint for the davidpadbury fork of music-assistant-mcp.

The fork's `server.main()` runs `mcp.run()` with no args (defaults to stdio).
We need streamable-http for hermes to dial it over the docker network, so
we re-import the already-built `mcp` (tools registered as a side-effect of
import) and call `mcp.run(transport="streamable-http", ...)` ourselves.

We also disable the MCP SDK's DNS-rebinding protection (Host-header check).
The protection is meant for MCP servers exposed to a browser via localhost;
ours runs inside the `sentient-internal` docker network with no host port
published, so the only valid client is Hermes, which legitimately connects
via `Host: ma-mcp:8668` (the docker-DNS service name). Without this
override, the SDK rejects every request with `421 Misdirected Request`,
which surfaces as `unhandled errors in a TaskGroup` on the Hermes side
and causes the entire MCP to be dropped from the agent's toolset.
"""

from __future__ import annotations

import os

# Importing this module also runs the registration side-effects in
# server.py (players, playback, queue, music tools) on the global `mcp`.
from mcp.server.transport_security import TransportSecuritySettings
from music_assistant_mcp.server import mcp


def main() -> None:
    host = os.environ.get("MA_MCP_HOST", "0.0.0.0")
    port = int(os.environ.get("MA_MCP_PORT", "8668"))
    mcp.settings.host = host
    mcp.settings.port = port
    mcp.settings.transport_security = TransportSecuritySettings(
        enable_dns_rebinding_protection=False,
    )
    mcp.run(transport="streamable-http")


if __name__ == "__main__":
    main()
