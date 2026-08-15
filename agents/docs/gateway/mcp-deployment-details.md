# MCP deployment — details

The native gateway reaches addon MCPs over host loopback. Each addon MCP is a separately supervised container with a pinned image/template and a matching `gateway/config.yaml#mcp_catalog` entry. The gateway-hosted MCP is the deliberate exception: it runs in the gateway because its tools need native session and identity capabilities.

## Network shapes

- LAN-facing upstreams such as Home Assistant or Music Assistant use `sentient-external` for designed outbound reach and publish only `127.0.0.1:<port>`.
- Internal-only services such as fetch/searxng have no direct published port. `ingress-proxy` forwards from the host loopback into the internal network.
- Internet egress is enforced by network topology and the egress proxy, not merely `HTTP_PROXY` variables.

Never use Docker DNS or `host.docker.internal` in the native gateway's MCP URLs. Never publish an MCP with Docker's implicit `0.0.0.0` bind. Secrets are injected at runtime and are not baked into images or rendered profiles.

A new MCP normally requires:

1. A pinned Dockerfile and managed-service template with health check, resource limits, and explicit network intent.
2. The image in the build-only production compose profile.
3. A catalog entry with transport URL and explicit tool tiers/curation.
4. Renderer/client wiring using HTTP MCP, not legacy process spawning. The gateway-hosted MCP's local `nc` bridge is the deliberate exception and must not be copied to addon MCPs.
5. A host-loopback `tools/list` and representative tool-call smoke test.

Remember that Hermes is a one-shot delegated tool; it is not an MCP supervisor. The system orchestrator owns addon lifecycle, while the native runtime owns tool mediation and session state.
