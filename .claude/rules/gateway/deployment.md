---
paths:
  - "gateway/config.yaml"
  - "gateway/mcp/**"
  - "gateway/src/system-orchestrator/**"
  - "deploy/**"
---
# Gateway deployment guardrails

- The gateway is a native host process, not a container. Docker addons are supervised dependencies; Hermes is a one-shot delegated tool, never a managed service.
- Never use `bun --hot`; use process-restarting `bun --watch` in development. Production lifecycle is owned by `launchd` and the health-gated installer/rollback flow.
- Addon MCP servers are one container per service and are reached by the host gateway over loopback. The gateway-hosted MCP is the deliberate in-process exception because it exposes native session/identity capabilities. Never configure addon access through Docker DNS or `host.docker.internal`.
- Container ports must bind explicitly to `127.0.0.1`; never rely on Docker's `0.0.0.0` default. Services without designed LAN/internet egress remain internal and enter through `ingress-proxy`.
- Egress confinement is network-enforced, not proxy-environment advisory. Secrets enter at runtime and are never baked into images or rendered user config.
- Adding an MCP requires its pinned image/service and `gateway/config.yaml#mcp_catalog` tool definitions in the same change.

When a rule is unclear, read `agents/docs/gateway/mcp-deployment-details.md`, `agents/docs/gateway/config-details.md`, or `agents/docs/gateway/architecture-details.md`.
