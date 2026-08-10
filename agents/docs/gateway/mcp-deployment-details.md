# MCP Deployment Details — Gateway

Pairs with `.claude/rules/gateway/mcp-deployment.md`. Rationale, examples,
and exact compose snippets for the MCP-container standard.

## Why containerize every MCP

The pre-standard layout had two MCP shapes:

- **HTTP MCPs** (`ha-mcp`) — long-running container, gateway dials it over
  HTTP. Clean isolation, restart by docker, network posture controlled at
  the compose layer. (At the time: docker DNS, `http://ha-mcp:8086/mcp`. The
  gateway is a native host process now, so this is loopback,
  `http://127.0.0.1:8086/mcp` — see "The loopback-only publish topology"
  below for the current dial pattern.)
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
- Any published port binds `127.0.0.1` explicitly — the LAN never reaches an
  MCP directly, only the gateway's `8888` is LAN-facing. Whether a container
  publishes its own loopback port or stays internal-only behind
  `ingress-proxy` follows the decision procedure below, not a flat rule.
- We trust the MCP code itself. We chose to install it; we trust its
  tool surface. The boundary is reachability, not in-container behavior.

The foot-gun is now a **missing** `127.0.0.1:` prefix — `ports: ["8086:8086"]`
binds `0.0.0.0` by docker default and puts the MCP on the LAN. Comment the
compose block / template to call this out, and see `enforcePublishReachable`
in `docker-driver.ts` for the automated guard.

## Compose template

```yaml
ma-mcp:
  build:
    context: ../mcp/ma-mcp
  image: sentient/ma-mcp:local
  container_name: sentient-ma-mcp
  # LOOPBACK ONLY. sentient-external gives this container LAN reach by
  # design (it dials Music Assistant), so a direct loopback publish adds no
  # new exposure — the native gateway dials it at 127.0.0.1:8668/mcp.
  ports:
    - "127.0.0.1:8668:8668"
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
`sentient-external` and route through `egress-proxy` instead. This is the
**internal-only** shape: no `ports:` at all, reached inbound via
`ingress-proxy` (see "The loopback-only publish topology" above) —
`egress-proxy` below is the OUTBOUND path, unrelated to how the gateway
reaches the container:

```yaml
fetch-mcp:
  build:
    context: ../../gateway/mcp/fetch-mcp
  image: sentient/fetch-mcp:local
  # NO `ports:` — deliberately, and docker would drop them anyway on an
  # internal-only container. ingress-proxy owns the loopback publish and
  # forwards inward; the native gateway still dials http://127.0.0.1:8088/mcp.
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

Renderer output (post-standard, post-native-migration — loopback, not
docker DNS; see `gateway/config.yaml#mcp_catalog`):

```yaml
mcp_servers:
  music_assistant:
    url: http://127.0.0.1:8668/mcp
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

## The loopback-only publish topology (post native-stack migration)

The gateway is a native host process now — it dials every MCP over
`http://127.0.0.1:<port>/mcp`, never docker DNS. `deploy/docker/` (the
old Linux compose that also ran the gateway itself) is **removed**; the
service blocks below live only in `deploy/mac-prod/docker-compose.yml`
(the dev-only `deploy/macos/` bakery is removed too), and even there they're
`build-only` —
the gateway's own orchestrator (`gateway/src/system-orchestrator/`) creates,
starts and health-checks the containers from a `managed_services` entry in
`gateway/config.yaml` plus a template at `gateway/templates/services/<name>.yaml`,
not `docker compose up`.

Getting a container's loopback port published is **asymmetric by design** —
which side an addon lands on turns on the egress question the rules ask, not
on a flat "publish/don't publish" list. Two concrete examples, both real:

- **`ha-mcp` / `ma-mcp`** — attach `sentient-external` (they dial Home
  Assistant / Music Assistant on the LAN, so they need routable egress *by
  design*) and publish their own loopback port directly
  (`gateway/templates/services/ha-mcp.yaml`): a direct publish adds no new
  exposure on a container that already has LAN reach.
- **`fetch-mcp` / `searxng-mcp`** — `sentient-internal`-only, no `ports:` at
  all. `fetch-mcp` dereferences attacker-chosen URLs, so its egress
  confinement must be **network-enforced** (physically no route out except
  `egress-proxy`), not just `HTTP_PROXY`-advisable. Reachability comes from
  `ingress-proxy` (`gateway/templates/services/ingress-proxy.yaml`), an nginx
  container that spans both networks and forwards the loopback port inward
  over docker's embedded DNS (a literal upstream would go stale on the next
  addon recreate, since docker assigns it a new bridge IP).

**Why `ingress-proxy` has to exist at all:** docker silently drops port
publishing the moment *every* network a container is attached to is
`internal: true` — there is no error, the port mapping just comes back
empty (`NetworkSettings.Ports={}`). An internal-only MCP therefore cannot
publish its own port under any `ports:` spelling; something that straddles
both networks has to forward on its behalf. `enforcePublishReachable` in
`docker-driver.ts` fails the apply loudly if a template is ever shaped to
hit this silently (all-internal networks + a `ports:` entry).

## Migration checklist

When converting a `command:`-shaped MCP to the standard:

1. Add `gateway/mcp/<name>/Dockerfile` that installs the package,
   pins version, and runs FastMCP HTTP on a fixed port.
2. Add a `managed_services` entry to `gateway/config.yaml` and a template at
   `gateway/templates/services/<name>.yaml` (see the two examples above for
   the internal-vs-external egress decision). Add the image to the
   `build-only` profile in `deploy/mac-prod/docker-compose.yml` so
   `docker compose --profile build-only build` bakes it.
3. Update `gateway/src/profile-store/profile-renderer.ts` to emit
   `url:` for that MCP. Remove the legacy `command/args/env` branch
   for that server's slug.
4. Remove the per-user `MA_*` / similar env-var wiring from rendered
   config; the container owns those now.
5. Smoke-test from the gateway host:
   `curl http://127.0.0.1:<port>/mcp` (direct or via `ingress-proxy`,
   per the decision above) then a real `tools/list` round-trip via the
   existing MCP client.
