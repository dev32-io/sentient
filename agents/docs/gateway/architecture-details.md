# Architecture Details — Gateway

Gateway-specific architecture details. Pairs with the cross-cutting
root: `agents/docs/architecture-details.md` and the gateway rule
`.claude/rules/gateway/cerebrum.md`.

## Per-Profile Hermes Process Lifecycle (supervisord)

Single `sentient-hermes` overlay container hosts all per-user Hermes
workers under supervisord. The gateway drives lifecycle via
`supervisorctl` over a shared unix socket on a docker volume mounted into
both containers.

**Two programs per active user** (post-ACP pivot):
- `hermes-<userId>-acp` on `acpPort` — `acp_ws_server.py` wraps
  `hermes -p <userId> acp` (stdio JSON-RPC) and bridges it to a
  WebSocket endpoint on path `/acp`.
- `hermes-<userId>-dashboard` on `acpPort + 1000` — `hermes -p <userId>
  dashboard` runs as a sidecar and exposes the bundled `sentient-plugin`
  REST surface (search / get / getMessages / delete) at
  `/api/plugins/sentient-plugin/`. ACP doesn't cover those surfaces.

**Lifecycle:**
1. Auth resolves a user → gateway provisions in `users.json` if new.
2. Apply renders `<gatewayRoot>/<userId>/{config.yaml,SOUL.md}` and writes
   `/data/supervisor/programs/<userId>.conf` (supervisord program config,
   both programs above).
3. Gateway calls `supervisorctl reread && update`.
4. supervisord spawns both programs as managed children.
5. Per-profile-renderer regenerates `config.yaml` on every gateway boot
   so stale models / MCP catalogs never land at the worker
   (`gateway/src/admin/boot-migration.ts#renderConfigsForExistingUsers`).
6. Each gateway WS-session dials `ws://sentient-hermes:<acpPort>/acp`
   on demand via `bootstrapAcpWire`, runs `initialize`, and reaches the
   AcpHermesClient adapter. There is **no long-lived gateway-owned
   connection pool** under ACP — every WS-session owns its ACP
   connection for its lifetime.
7. Force-restart removes + rewrites the .conf and signals `restart`. The
   restart orchestrator reports ready optimistically (no eager probe);
   the next WS-session bootstrap proves dispatch end-to-end.

**State:** supervisord tracks each program's state machine
(STOPPED / STARTING / RUNNING / BACKOFF / FATAL / EXITED). RPC events are
`PROCESS_STATE:<process_name>:<event>` — colon notation, not dot.

## ACP wire surfaces

| Surface | Transport | Notes |
|---|---|---|
| `session/new`, `session/list`, `session/prompt`, `session/cancel`, `session/update` | ACP JSON-RPC over WS at `/acp` | Owned by upstream `hermes acp` agent. |
| `session.created` / `session.switched` / `commands.available` / `sessions.renamed` | ACP `session/update` notifications | Routed via `acpConn.onEvent` in `ws-session-configure.ts`. Multiple subscribers OK. |
| Past-sessions search / get / getMessages / delete | sentient-plugin REST (port = acpPort + 1000) | `SentientPluginClient` in `hermes-adapter-client/plugin-client.ts`. Bearer auth via `SENTIENT_HERMES_BEARER`. |
| `/healthz` | HTTP at acpPort | Boot health check. ACP itself has no `/healthz` equivalent — the bridge (`acp_ws_server.py`) exposes one. |

## Stubbed paths under ACP (open todos)

`apply` / restart / dispatch-reset paths used to fire `/reset` /
`/personality <name>` over a pooled custom-WS connection. ACP has no
slash-command equivalent today. Stubbed with WARN logs and TODO
comments; see `docs/research/2026-05-08-apply-restart-acp-rewire-todo.md`
for the gap and required equivalents.
