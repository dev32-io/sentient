# Configuration Details — Gateway

Gateway-specific config sections and patterns. Pairs with the cross-cutting
root: `agents/docs/config-details.md`.

## Config sections in `gateway/config.yaml`

| Section | Covers |
|---------|--------|
| server (root) | Port, host, max sessions, auth |
| session | Turn detection, barge-in, inactivity, channel |
| stt | Local STTService URL, model, energy gate, EOT timeout |
| tts | local-tts (ChatterboxTTSService) URL, voice, format, sample rate, connect timeout |
| providers | Catalog cache TTLs, external fetch timeout |
| mcp_catalog | Operator-managed MCP server inventory |
| webui | Server-authoritative client tunables (e.g. playback). The `mobile` clientType reuses the webui playback fallback. |
| hermes | Per-user Hermes (ACP) wiring. `acp_wire` = wire resilience tunables (`open_timeout_ms`, `reconnect_base_ms`, `reconnect_max_ms`, `reconnect_jitter_ms`, `reconnect_max_attempts`); `defaults.request_timeout_ms` = per-prompt deadline backstop. Schema: `shared/config/src/schemas/hermes-config.ts`. |

The gateway no longer has a top-level `llm` section — Hermes owns the LLM
call and reads its own config from per-user rendered profiles in
`<gatewayRoot>/<userId>/config.yaml`.

## MCP Tool Curation for TTFT

When adding MCPs to `gateway/config.yaml#mcp_catalog`, use `tools.include`
to whitelist only the essential tools for the persona. Full MCP tool lists
add ~12k+ tokens to the LLM cycle prefix and dominate TTFT.

- **home_assistant**: full ha-mcp surface is ~80 tools (state, history,
  template, areas, zones, cameras, services, automations, scenes, scripts,
  blueprints, admin). Curated essential set is 17 tools — query/state,
  spatial, action (call_service + bulk_control), todos, calendar. The
  remaining ~63 tools (automation editing, helpers, blueprints, restart,
  backup, hacs, addon mgmt) stay off until voice-driven authoring becomes
  a real workflow.
- **gateway** (gateway-hosted MCP via unix socket): 4 tools —
  identify_user, pause_audio, resume_audio, update_user_settings.
- **searxng**: curated — `tools.include: [search_web]` (single-tool exposure of the search surface).
- **fetch / music_assistant**: no curation (small toolsets).

Tuning is per-catalog-entry — the rendered profile YAML inherits whatever
`tools.include` is set on the catalog entry, so a rebuild/restart is not
needed; just edit the YAML and trigger apply for affected users.
