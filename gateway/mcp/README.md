# Built-in MCPs

Each subdirectory packages one MCP server that the gateway orchestrates as a
sibling container. The deployment standard (`Dockerfile` location, build
context, network membership, healthcheck) is documented in
`.claude/rules/gateway/mcp-deployment.md`.

| Directory | Tool surface | Image | Notes |
|---|---|---|---|
| `searxng/` | (backend, no MCP) | `searxng/searxng:latest` (upstream) | Metasearch engine. Backs `searxng-mcp`. |
| `searxng-mcp/` | `search_web` | `sentient/searxng-mcp:local` | Wraps the searxng-mcp adapter; talks to `searxng:8080`. |
| `fetch-mcp/` | `fetch` | `sentient/fetch-mcp:local` | Wraps Anthropic's `mcp-server-fetch`. |
| `ma-mcp/` | Music Assistant tools | `sentient/ma-mcp:local` | Davidpadbury fork; LAN egress on `sentient-external`. |
| `ingress-proxy/` | (no MCP — reverse proxy) | `sentient/ingress-proxy:local` | The ONLY container on both networks. Publishes the loopback ports `fetch-mcp` and `searxng-mcp` cannot publish themselves (docker drops publishing on an internal-only container) and forwards inward, so those two keep network-enforced egress confinement. Inverse of `egress-proxy`. |

Templates that bind these images to their per-container config (env,
networks, secrets, healthcheck) live at
`gateway/templates/services/<name>.yaml`. The catalog policy (image
allowlist, secret bindings, optional/required) lives in
`gateway/config.yaml#managed_services`. The gateway's MCP catalog (server
endpoints + per-tool curation) lives in `gateway/config.yaml#mcp_catalog`.
