# Gateway TODO

This file intentionally contains no legacy platform backlog. Active gateway
work must be shaped against the current native architecture and tracked in a
reviewed story or specification before implementation.

## Current constraints for future work

- Extend the existing `SessionRuntime` and native ReAct loop; do not add a
  second agent runtime, conversation mirror, task mirror, or ambient
  current-user authority.
- Keep the append-only session store authoritative for model and client
  projections. New live state must preserve replay/live convergence.
- Keep WebSocket work within the implemented live-session contract. The
  sessions REST surface currently implements only list and message history;
  any additional endpoint requires an explicit reviewed contract rather than a
  placeholder in this file.
- Route every model-requested tool through `ToolBroker` role and per-tool
  mediation. A one-shot delegated Hermes process is background tool execution,
  not session ownership or authorization.
- Run the gateway natively. Docker remains limited to supervised
  MCP/infrastructure addons reached through loopback or the configured ingress
  policy.
- Preserve privacy-safe observability: no prompts, transcripts, text/tool
  previews, raw frames, audio payloads, or per-chunk logs.
- Use `bun --watch` for gateway development. Never use `bun --hot` with the
  in-process service supervisor.
