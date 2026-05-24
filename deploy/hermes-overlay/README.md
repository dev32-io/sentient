# Hermes Overlay

This directory builds our customized Hermes image on top of the official
`nousresearch/hermes-agent` upstream. We do **not** maintain a fork. We pin a
specific upstream tag and apply minimal source patches at image-build time.

## Pinned upstream version

Current pin lives in `HERMES_VERSION`. Bump deliberately — never auto-track
`:latest`.

```
$ cat HERMES_VERSION
v2026.4.23
```

## Why this overlay exists (post-ACP)

Sentient is no longer a Hermes platform. The voice gateway is an **ACP
client** — it dials each per-user Hermes worker over Anthropic's Agent
Client Protocol (JSON-RPC over WebSocket).

Hermes ships an upstream `hermes -p <profile> acp` agent entrypoint
(stdio-based JSON-RPC). We bridge that to a WebSocket endpoint via
`acp_ws_server.py` so the Bun gateway can dial it like any other WS
service. ACP doesn't cover past-sessions search / get / getMessages /
delete; for those surfaces we run a per-profile `hermes -p <profile>
dashboard` sidecar that mounts the bundled `sentient-plugin` REST tree
at `/api/plugins/sentient-plugin/`.

The previous sentient platform-adapter shape (`sentient_gateway.py` +
9 source patches) was retired in the ACP cleanup. Only one upstream
patch remains: `0007-docker-network-config.patch` (binds Hermes' web_server
to `0.0.0.0` so the gateway container can reach it across the docker
network — pure ops concern, unrelated to protocol).

## Layout

```
deploy/hermes-overlay/
├── README.md            # this file
├── HERMES_VERSION       # pinned upstream tag (single line)
├── Dockerfile           # FROM nousresearch/hermes-agent:${HERMES_VERSION} + overlay
├── supervisord.conf     # supervisord daemon config; per-profile programs are
│                        # rendered into /data/supervisor/programs/ at runtime
├── acp_ws_server.py     # ACP-over-WS bridge — wraps `hermes -p X acp`
└── patches/
    └── 0007-docker-network-config.patch
```

## Build

```sh
# Build context is the repo root so the image can pull in both the overlay
# sources (deploy/hermes-overlay/*) and the bundled sentient-plugin tree
# (hermes/plugins/sentient-plugin/) in a single build.
cd <repo-root>
docker build \
  --build-arg HERMES_VERSION=$(cat deploy/hermes-overlay/HERMES_VERSION) \
  -f deploy/hermes-overlay/Dockerfile \
  -t sentient/hermes:local .
```

The Dockerfile:
1. `FROM nousresearch/hermes-agent:${HERMES_VERSION}`
2. Installs `supervisor`, `patch`, `netcat-openbsd` (apt).
3. Copies `acp_ws_server.py` into `/opt/hermes-overlay/`.
4. Copies the bundled `sentient-plugin` tree into `/opt/hermes/plugins/`.
5. Applies every patch in `patches/` (just `0007` today).
6. Copies `supervisord.conf` to `/etc/supervisor/`.
7. `CMD` execs supervisord in the foreground.

## Process model at runtime

One supervisord process per container; **two** programs per active user
profile (one for the ACP bridge, one for the dashboard sidecar):

```
container: sentient-hermes
  └─ supervisord (PID 1)
       ├─ hermes-alice-acp        (port 8643 — acp_ws_server.py wraps `hermes -p alice acp`)
       ├─ hermes-alice-dashboard  (port 9643 — `hermes -p alice dashboard`, sentient-plugin mounted)
       ├─ hermes-bob-acp          (port 8644)
       ├─ hermes-bob-dashboard    (port 9644)
       └─ ...
```

Dashboard port = ACP port + `DASHBOARD_PORT_OFFSET` (1000). Per-profile
restart = `supervisorctl restart hermes-alice-acp hermes-alice-dashboard`.
SOUL.md / `agent.personalities` edits go through the gateway's
`profile-restart-orchestrator` which calls supervisord directly.

## Patches

### 0007-docker-network-config.patch

**Touches:** Hermes' web_server bind address.

**Change:** Lets the dashboard sidecar bind `0.0.0.0` so the gateway
container can reach it over the docker network. Trivial config-level
patch; not protocol-related.

**Why retained:** The dashboard sidecar is the only path for ACP-uncovered
session surfaces (search / get / messages / delete). Without 0.0.0.0
binding it would only listen on localhost inside its own container, which
is unreachable from the gateway container.

## Rebase strategy when bumping HERMES_VERSION

1. Update `HERMES_VERSION` to the new tag.
2. Build locally: `docker build …`. The single remaining patch fails to
   apply if upstream touched the relevant config file.
3. If 0007 fails: read the upstream file at the new tag, apply the
   equivalent change manually, save with `git format-patch`.
4. Smoke test: boot one profile, verify the gateway can dial
   `ws://hermes:<port>/acp` and the dashboard responds at
   `http://hermes:<port+1000>/api/plugins/sentient-plugin/`.

The remaining patch is small and surgical (config bind address). Worst-case
rebase on a major Hermes release: minutes.

## What is **not** here

- Custom MCP servers (DuckDuckGo, Music Assistant, ha-mcp): each is its own
  compose service. They are not baked into this overlay image.
- The Bun gateway: lives in `gateway/`, deployed via `deploy/docker/`.
- The `sentient-plugin` REST sources: live at the repo root in
  `hermes/plugins/sentient-plugin/`. Copied into the image at build time.
- Per-user data: `~/.sentient/gateway/data/<userId>/` is bind-mounted into
  this container as `/data/profiles/<profile>` at runtime.
