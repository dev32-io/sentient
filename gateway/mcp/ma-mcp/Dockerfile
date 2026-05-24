# Music Assistant MCP — dockerized HTTP MCP server.
#
# We build from the davidpadbury/music-assistant-mcp fork because the
# official upstream (devjourney/music-assistant-mcp 0.3.0) wraps the
# Music Assistant WebSocket in a one-shot FastMCP `lifespan()` block —
# `start_listening()` runs once at app startup and never restarts on
# listener exit. After any MA WS drop (idle, reverse-proxy heartbeat,
# etc.), every subsequent tool call raises `InvalidState: Not connected`
# until the container is restarted. The fork adds:
#   - a `with_reconnect` decorator that catches connection errors,
#     calls `force_reconnect()`, and retries the tool once;
#   - a `get_client()` lazy reconnect that checks `connection.connected`
#     on each call.
# This is exactly the missing reconnect path. Pinning to a commit SHA
# keeps the build reproducible.
#
# The fork's bundled entrypoint (`mcp.run()`) defaults to stdio. Hermes
# dials this MCP over streamable-http, so we override the entrypoint to
# call `mcp.run(transport="streamable-http", host=..., port=...)` after
# importing the fork's already-registered `mcp` object.
#
# See .claude/rules/gateway/mcp-deployment.md for the deployment standard
# and agents/docs/gateway/mcp-deployment-details.md for rationale.

FROM python:3.13-slim

ARG MA_MCP_FORK_REF=0339b968a8ca

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir \
        "git+https://github.com/davidpadbury/music-assistant-mcp.git@${MA_MCP_FORK_REF}"

# Thin entrypoint — imports the fork's `mcp` (tools already registered)
# and runs it over streamable-http with host/port from env.
COPY entrypoint.py /app/entrypoint.py

ENV MA_MCP_HOST=0.0.0.0 \
    MA_MCP_PORT=8668 \
    PYTHONUNBUFFERED=1

EXPOSE 8668

CMD ["python", "/app/entrypoint.py"]
