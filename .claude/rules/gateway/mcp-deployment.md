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
- How a container's port reaches that loopback is a decision procedure, not a flat rule. Ask: **does this addon need LAN or internet egress by design?**
  - **Yes** (it dials an external device, e.g. `ha-mcp` → Home Assistant, `ma-mcp` → Music Assistant): attach `sentient-external` as a second network and/or route outbound through `egress-proxy`, AND publish its own loopback port directly (`"127.0.0.1:<port>:<port>"`) — it already has routable egress by design, so a direct publish adds no new exposure.
  - **No** (it only serves tool calls, or its outbound reach is itself the boundary under test — e.g. `fetch-mcp` dereferences attacker-chosen URLs): stay `sentient-internal`-only, publish NO port, and let `ingress-proxy` forward the loopback port inward. This confinement must be network-enforced, not env-advisory — `HTTP_PROXY` alone is bypassable by any client that ignores it.
- A `ports:` entry without the explicit `127.0.0.1` prefix is a defect — docker's default bind is `0.0.0.0`, which exposes the MCP to the LAN. MCP containers are never LAN-reachable; only the gateway's `8888` is.
- Docker silently drops port publishing when **every** attached network is `internal: true` — that is why `ingress-proxy` exists for internal-only MCPs. `enforcePublishReachable` in `docker-driver.ts` refuses a template shaped to hit this silently.
- MCP containers needing internet egress (outbound) route through `egress-proxy`; match the upstream port in `tinyproxy.conf#ConnectPort`. This is the OUTBOUND path, orthogonal to `ingress-proxy` (INBOUND, gateway → MCP).
- LAN target hostnames resolve via `extra_hosts:` static map in the compose service. Never rely on mDNS inside docker.
- Each built-in MCP image lives at `gateway/mcp/<name>/Dockerfile`. Pin the upstream package version.
- Secrets reach the container via `env_file: .env` + `${VAR}` interpolation. Never bake tokens into the image. Never write tokens into per-user rendered config.
- Shipping a new MCP container requires updating `gateway/config.yaml#mcp_catalog` with the tool definitions in the same change. Remove any deprecated stdio block at the same time.
