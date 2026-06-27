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
- MCP containers attach to `sentient-internal` and publish NO host ports. Adding `ports:` to an MCP service is forbidden; document this inline.
- MCP containers needing internet egress route through `egress-proxy`. Match the upstream port in `tinyproxy.conf#ConnectPort`.
- MCP containers needing LAN egress that the proxy cannot tunnel attach to `sentient-external` as a second network. They still publish no host port. Document the reason inline.
- LAN target hostnames resolve via `extra_hosts:` static map in the compose service. Never rely on mDNS inside docker.
- Each built-in MCP image lives at `gateway/mcp/<name>/Dockerfile`. Pin the upstream package version.
- Secrets reach the container via `env_file: .env` + `${VAR}` interpolation. Never bake tokens into the image. Never write tokens into per-user rendered config.
- Hermes-callable URLs follow `http://<service-name>:<port>/mcp`. Service name in compose matches the host token in user config.
- Shipping a new MCP container requires updating `gateway/config.yaml#mcp_catalog` with the tool definitions in the same change. Remove any deprecated stdio block at the same time.
