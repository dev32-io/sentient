# Sentient Hermes overlay image.
#
# We do NOT fork hermes-agent. We pin an upstream tag (see HERMES_VERSION),
# drop our platform adapter into the right path, apply minimal source patches,
# and run multiple per-profile gateway processes under supervisord.
#
# Build context is the repo root so we can COPY both the overlay sources
# (deploy/hermes-overlay/*) and the bundled sentient-plugin tree
# (hermes/plugins/sentient-plugin/) into one image. Build via:
#
#   cd <repo-root>
#   docker build \
#     --build-arg HERMES_VERSION=$(cat deploy/hermes-overlay/HERMES_VERSION) \
#     -f deploy/hermes-overlay/Dockerfile \
#     -t sentient/hermes:local .
#
# Signal is handled by a shared bbernhard/signal-cli-rest-api sidecar
# (sentient-signal-cli container). No signal-cli binary in this image.
#
# See README.md in this directory for the rationale and rebase workflow.

ARG HERMES_VERSION=v2026.4.23

FROM nousresearch/hermes-agent:${HERMES_VERSION}

# Re-declare ARG after FROM so the value is accessible in this stage.
ARG HERMES_VERSION

# Bake the build-time version into the container environment so the
# entrypoint wrapper can write it to the shared supervisor volume.
ENV HERMES_VERSION=${HERMES_VERSION}
# docker inspect / image metadata: `docker inspect --format '{{index .Config.Labels "org.sentient.version"}}' sentient/hermes:local`
LABEL org.sentient.version=${HERMES_VERSION}

# supervisor manages two per-profile programs:
#   1. acp_ws_server.py wraps `hermes -p <name> acp` and bridges JSON-RPC
#      over WebSocket on /acp.
#   2. `hermes -p <name> dashboard` runs as a sidecar and exposes the
#      sentient-plugin REST surface (search / get / getMessages / delete)
#      that ACP doesn't cover.
# patch is needed to apply the docker-network integration patch over the
# upstream tree (only patch left after the ACP cleanup).
# netcat-openbsd provides `nc` — used by the gateway-MCP STDIO transport
# (`nc -U /run/sentient/mcp-<userId>.sock`); without it Hermes can't connect
# to the gateway-hosted MCP host (identify_user, pause_audio, etc.).

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends supervisor patch netcat-openbsd curl \
    && rm -rf /var/lib/apt/lists/*

# ACP-over-WebSocket bridge.
COPY deploy/hermes-overlay/acp_ws_server.py /opt/hermes-overlay/acp_ws_server.py

# Sentient dashboard plugin — provides the REST surface (search / get
# session / get messages / delete) that ACP doesn't cover. Hermes' built-in
# dashboard plugin scanner (hermes_cli/web_server.py#_discover_dashboard_plugins)
# walks <repo>/plugins/<name>/dashboard/manifest.json on startup, so dropping
# the tree here makes the per-profile `hermes -p <userId> dashboard` sidecar
# discover and mount it at /api/plugins/sentient-plugin/. Auth is gated by
# SENTIENT_HERMES_BEARER (validated by plugin_api.py).
COPY --chown=hermes:hermes hermes/plugins/sentient-plugin /opt/hermes/plugins/sentient-plugin

# Apply integration patches. Build fails fast if any patch does not apply
# cleanly — that's the signal to rebase against the new HERMES_VERSION.
COPY deploy/hermes-overlay/patches/ /tmp/sentient-patches/
RUN set -e \
    && cd /opt/hermes \
    && for p in /tmp/sentient-patches/*.patch; do \
         [ -f "$p" ] || continue; \
         echo "Applying $(basename "$p")"; \
         patch -p1 --forward --no-backup-if-mismatch < "$p"; \
       done \
    && rm -rf /tmp/sentient-patches

# Multi-profile process supervision.
COPY deploy/hermes-overlay/supervisord.conf /etc/supervisor/supervisord.conf

# Per-profile programs are rendered into this dir at runtime by the Bun
# gateway (one .conf per active user). Created here so supervisord's
# `[include]` glob does not error on first boot before any user exists.
RUN mkdir -p /data/supervisor/programs \
    && chown -R hermes:hermes /data/supervisor

USER hermes

# Each profile binds its own port; default range starts at 8643 for the
# ACP WS bridge. The dashboard sidecar binds at acpPort + 1000 (9643+).
# Actual ports come from the rendered per-profile .conf files.
EXPOSE 8643 8644 8645 8646 8647
EXPOSE 9643 9644 9645 9646 9647

# Inline entrypoint: write $HERMES_VERSION to the shared supervisor volume
# so the gateway's companion-versions.ts can read it at boot without any
# docker-inspect calls. The file is written before supervisord starts so
# the gateway's retry loop (5x 500 ms) always finds it on warm starts.
# Using sh -c exec-form keeps PID 1 as supervisord (proper signal handling).
CMD ["sh", "-c", "mkdir -p /data/supervisor/.versions && echo -n \"$HERMES_VERSION\" > /data/supervisor/.versions/hermes && exec supervisord -n -c /etc/supervisor/supervisord.conf"]
