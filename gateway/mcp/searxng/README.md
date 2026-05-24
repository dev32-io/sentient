# SearXNG (built-in metasearch backend)

Self-hosted SearXNG instance. Backs the `searxng-mcp` adapter (sibling
directory) which exposes a `web_search` MCP tool to Hermes.

- Image: `searxng/searxng:latest` (upstream — no Dockerfile here).
- Network: `sentient-internal` only. Outbound to upstream engines via `egress-proxy`.
- Config seed: `gateway/templates/services/searxng/settings.yml`. Copied to
  `${HOST_CONFIG_DIR}/searxng/settings.yml` on first boot via the
  `SEED_FILES` mechanism in `gateway/src/bootstrap/phase-orchestrator.ts`
  (idempotent — operator edits are never clobbered).
- Secret: `secret_key` resolved from `${SEARXNG_SECRET}` (internal-secrets v2).

See `gateway/templates/services/searxng.yaml` for the orchestrator
template, `.claude/rules/gateway/mcp-deployment.md` for the deployment
standard, and `agents/docs/gateway/mcp-deployment-details.md` for the
rationale.

## Engine list

Operator-tunable. Edit `${HOST_CONFIG_DIR}/searxng/settings.yml` after
first boot — the container is restarted to pick up changes via the apply
pipeline. The seed at `gateway/templates/services/searxng/settings.yml`
is the baked-in default; do not edit it on a running install.
