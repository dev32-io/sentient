# MCP Deployment Details — Gateway

Pairs with `.claude/rules/gateway/mcp-deployment.md`. Rationale, examples,
and exact compose snippets for the MCP-container standard.

## Why containerize every MCP

The pre-standard layout had two MCP shapes:

- **HTTP MCPs** (`ha-mcp`) — long-running container, gateway dials
  `http://ha-mcp:8086/mcp`. Clean isolation, restart by docker, network
  posture controlled at the compose layer.
- **stdio MCPs** (`music-assistant-mcp`, `mcp-server-fetch`, `searxng-mcp-server`) — Python
  packages installed inside `sentient-hermes`, spawned per session by
  supervisord-managed Hermes workers via `command:` config. They
  inherited hermes's netns (`internal: true` — no LAN/internet route),
  ran without resource limits, and conflated MCP lifecycle with worker
  lifecycle.

The stdio shape failed in production: `music-assistant-mcp` could not
reach `192.168.0.240:8095` because hermes is internal-only and the
package's aiohttp WebSocket client does not honor `HTTP_PROXY`. The fix
is structural: every MCP becomes a container, hermes only speaks HTTP
MCP, network posture is per-container.

## Threat model the rules enforce

Single concern: a random LAN device must not be able to call MCP tools
without auth. The defense:

- MCP containers join `sentient-internal` only (or `sentient-internal` +
  `sentient-external` when LAN egress is needed).
- No host port is published. The docker bridge isolates the MCP from
  the LAN; only containers on the same internal network (hermes,
  gateway) can dial it.
- We trust the MCP code itself. We chose to install it; we trust its
  tool surface. The boundary is reachability, not in-container behavior.

The foot-gun is `ports:` — anyone adding `ports: ["8086:8086"]` "for
debugging" punches a hole through the LAN isolation. Comment the
compose block to call this out.

## Compose template

```yaml
ma-mcp:
  build:
    context: ../mcp/ma-mcp
  image: sentient/ma-mcp:local
  container_name: sentient-ma-mcp
  # DO NOT add `ports:` — breaks LAN isolation. The container is reachable
  # only from inside `sentient-internal` (hermes / gateway).
  networks: [sentient-internal, sentient-external]
  environment:
    MUSIC_ASSISTANT_URL: http://mass.local:8095
    MUSIC_ASSISTANT_TOKEN: ${MA_TOKEN}
  env_file: .env
  # mass.local resolves via mDNS on the LAN, not inside docker. Static map
  # required so the in-container WS client can reach the LAN host.
  extra_hosts:
    - "mass.local:192.168.0.240"
  restart: unless-stopped
  mem_limit: 256m
  cpus: "0.5"
  logging:
    driver: json-file
    options:
      max-size: "10m"
      max-file: "7"
```

`sentient-external` membership is justified inline because the
upstream uses raw WebSocket; tinyproxy CONNECT works in theory but the
package's aiohttp `ws_connect()` does not pass `proxy=` when only
`HTTP_PROXY` env is set. Direct LAN egress, no inbound: acceptable.

We build from the davidpadbury/music-assistant-mcp fork (commit pinned
in the Dockerfile) because the official upstream
`music-assistant-mcp==0.3.0` opens the MA WS once in `lifespan()` and
never reconnects on listener exit — every tool call after a WS drop
raises `InvalidState: Not connected` until the container restarts.
The fork wraps tools in a `with_reconnect` retry decorator and
re-checks `connection.connected` on each `get_client()` call.

For a pure-HTTP MCP that talks to the internet (e.g. fetch-mcp), drop
`sentient-external` and route through `egress-proxy` instead:

```yaml
fetch-mcp:
  build:
    context: ../../gateway/mcp/fetch-mcp
  image: sentient/fetch-mcp:local
  networks: [sentient-internal]
  depends_on: [egress-proxy]
  environment:
    HTTP_PROXY: http://egress-proxy:3128
    HTTPS_PROXY: http://egress-proxy:3128
    NO_PROXY: localhost,127.0.0.1
```

## FastMCP HTTP transport

Most modern stdio-only MCP packages are FastMCP-based (`fastmcp>=2.x`
exposes `streamable-http`). The per-MCP Dockerfile pip-installs the
upstream package and runs:

```
fastmcp run <module>:mcp --transport streamable-http --host 0.0.0.0 --port 8086
```

If the upstream pins `fastmcp<2.x`, bump the constraint or wrap with a
small `mcp-proxy` shim. Pin the upstream package version in the
Dockerfile so the container is reproducible.

## User config references

Renderer output (post-standard):

```yaml
mcp_servers:
  music_assistant:
    url: http://ma-mcp:8668/mcp
    timeout: 30
    connect_timeout: 5
    tools:
      include: [...]
```

The renderer no longer emits `command/args/env` for MCP servers. Per-user
secrets (e.g. a user-scoped MA token) travel as bearer headers on the
HTTP MCP call when the upstream supports it; otherwise the container
holds a single shared token from compose env.

## Resolution semantics inside docker

Docker has no mDNS responder. `mass.local`, `home.local`, etc. all
NXDOMAIN from inside containers. Two options:

1. `extra_hosts:` static map per service. Simple, single edit point if
   the LAN host's IP changes.
2. avahi-daemon sidecar with host networking that publishes mDNS into a
   docker-internal DNS. Overkill for a handful of fixed targets.

Pick (1) by default.

## Migration checklist

When converting a `command:`-shaped MCP to the standard:

1. Add `gateway/mcp/<name>/Dockerfile` that installs the package,
   pins version, and runs FastMCP HTTP on a fixed port.
2. Add the service block to `deploy/docker/docker-compose.yml` (and
   `deploy/pi/docker-compose.yml`). Mirror the network/`extra_hosts`
   posture from the rules.
3. Update `gateway/src/profile-store/profile-renderer.ts` to emit
   `url:` for that MCP. Remove the legacy `command/args/env` branch
   for that server's slug.
4. Remove the per-user `MA_*` / similar env-var wiring from rendered
   config; the container owns those now.
5. Smoke-test from inside `sentient-hermes`:
   `nc -vz <service-name> 8086` then a real `tools/list` round-trip via
   the existing MCP client.
