# Gateway configuration — details

`gateway/config.yaml` is the operator surface. The native orchestrator reads `orchestrator.provider`, `orchestrator.tools`, `orchestrator.memory`, `orchestrator.skills`, `orchestrator.permission`, `orchestrator.compaction`, and `orchestrator.delegation`. The schema and composition root are in `shared/config` and `gateway/src/bootstrap/phase-services.ts`.

Other important sections:

- `server`, `session`, `tls`, and `inbound_proxy` control the native gateway and its outward door.
- `stt` and `tts` describe local voice adapters.
- `mcp_catalog` is the operator's inventory and per-tool tier/curation policy.
- `managed_services` / `system_orchestrator` describe supervised addon containers and health checks.
- `webui` carries server-authoritative client defaults; it does not replace client state ownership.

The provider connection is resolved from the secrets store, with `orchestrator.provider` supplying non-secret defaults and optional endpoint/model overrides. Do not put credentials in YAML or rendered user profiles.

Keep tool catalogs small with `tools.include` where appropriate. The gateway-hosted MCP is a deliberate exception to containerized addon MCPs: it is exposed by the native gateway over its local MCP transport because it needs the gateway's own identity/session capabilities. Container MCPs use the system orchestrator and host loopback.

Hermes settings under `orchestrator.delegation` are for one-shot delegated executions (profile and timeout), not a long-running service lifecycle. Change a tunable in YAML only when its consumer exists in the current composition root; otherwise remove stale configuration rather than documenting a dead knob.
