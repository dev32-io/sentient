# Managed network infrastructure

Core Web, Home Assistant, and Music Assistant capabilities are first-class
native gateway tools. Their former MCP adapters are retired.

The remaining directories here package network infrastructure rather than core
tool surfaces:

| Directory | Purpose |
|---|---|
| `searxng/` | Metasearch backend consumed by `outbound-worker`. |
| `ingress-proxy/` | Loopback-only bridge from the native gateway to internal-only `outbound-worker`. |

General third-party MCP support remains available through
`gateway/config.yaml#mcp_catalog`; the gateway-hosted per-user MCP socket also
remains the mediated reach-back boundary for delegated Hermes runs.
