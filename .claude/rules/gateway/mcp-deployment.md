---
paths:
  - "deploy/docker/**/*.yml"
  - "deploy/docker/**/*.yaml"
  - "deploy/docker/**/Dockerfile"
  - "deploy/mac-prod/**/*.yml"
  - "gateway/config.yaml"
  - "gateway/mcp/**"
  - "gateway/src/profile-store/profile-renderer.ts"
  - "shared/config/src/schema.ts"
---
# MCP Deployment Rules

> When a rule is unclear, read `agents/docs/gateway/mcp-deployment-details.md`.

- Every MCP server runs as its own docker container. The `command:`/`args:` stdio-spawn-inside-hermes shape is deprecated and MUST NOT be used for new MCPs.
- Stdio-only upstream packages MUST be wrapped behind an HTTP MCP transport before they get a container.
- One container per MCP, shared by all users. Per-user differentiation lives in tool-include lists and per-user secrets, not in container instances.
- User profile config references MCP servers by `url:` only. Never `command:`.
- The native gateway dials every MCP over loopback (`http://127.0.0.1:<port>/mcp`), never docker DNS or `host.docker.internal` — the gateway is a host process, not a container.
- Whether a container publishes its own loopback port is decided by one question: does it need LAN or internet egress by design?
- An addon that does attaches `sentient-external` and publishes its own loopback port (`"127.0.0.1:<port>:<port>"`) — a direct publish adds no exposure it does not already have.
- An addon that does not stays `sentient-internal`-only, publishes NO port, and is reached inward through `ingress-proxy`. Its egress confinement MUST be network-enforced, never `HTTP_PROXY`-advisory.
- A `ports:` entry without the explicit `127.0.0.1` prefix is a defect — docker's default bind is `0.0.0.0`, which exposes the MCP to the LAN. MCP containers are never LAN-reachable; only the gateway's `8888` is.
- Docker silently drops port publishing when **every** attached network is `internal: true`. `enforcePublishReachable` in `docker-driver.ts` refuses a template shaped to hit this silently.
- Outbound internet egress routes through `egress-proxy`; match the upstream port in `tinyproxy.conf#ConnectPort`. `ingress-proxy` is the INBOUND path (gateway → MCP) and is orthogonal.
- LAN target hostnames resolve via `extra_hosts:` static map in the compose service. Never rely on mDNS inside docker.
- Each built-in MCP image lives at `gateway/mcp/<name>/Dockerfile`. Pin the upstream package version.
- Secrets reach the container via `env_file: .env` + `${VAR}` interpolation. Never bake tokens into the image. Never write tokens into per-user rendered config.
- Shipping a new MCP container requires updating `gateway/config.yaml#mcp_catalog` with the tool definitions in the same change. Remove any deprecated stdio block at the same time.
