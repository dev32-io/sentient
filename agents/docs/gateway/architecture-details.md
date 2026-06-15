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
6. The ACP wire is **pooled per surfaceId, ref-counted** across that surface's
   reconnects (`hermes-adapter-client/acp-wire-registry.ts`). A surface (web tab
   = per-tab sessionStorage `surfaceId`; mobile = `deviceId`) dials
   `ws://sentient-hermes:<acpPort>/acp` via `bootstrapAcpWire` on first attach
   (runs `initialize`, reaches the AcpHermesClient adapter); reconnects with the
   SAME surfaceId reuse the live wire (refCount++), and it is disposed only when
   the surface's last attachment releases. `acquire`/`release` are driven from
   `ws-session-configure.ts`. WHY per-surface: the Hermes overlay
   (`acp_ws_server.py`) spawns a fresh Hermes child **per WS connection**, so one
   wire per surface = one isolated child = no cross-surface conversation forks.
   The overlay is a **dumb transport** — it does NOT evict prior connections;
   concurrent connections per profile (multiple surfaces PLUS the ephemeral
   `rest-list:<userId>` session-list wire) coexist, each with its own child. The
   gateway owns all pooling + single-flight gating. (`state.db`, the shared
   per-profile memory chain, is WAL-mode → concurrent children write safely.)
7. The wire **self-heals**. A *remote* close (any code, including 1000 — overlay
   restart / network flap) is NOT terminal: it lazily reconnects on the next
   dispatch, bounded by `hermes.acp_wire.reconnect_max_attempts`
   (`acp-wire-socket.ts`). Only a *local* `dispose()` (last attachment released) is
   terminal. An in-flight prompt is un-stuck two ways: WS reject-on-abnormal-close
   (`per-profile-connection.ts#rejectInflight`) AND a `hermes.defaults.request_timeout_ms`
   backstop on the AcpClient.
8. Force-restart removes + rewrites the .conf and signals `restart`. The
   restart orchestrator reports ready optimistically (no eager probe); the next
   dispatch on the (reconnecting) wire proves dispatch end-to-end.

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

## Client contract notes

- **clientTypes** = `webui | cube | mobile` (`shared/protocol` `clientTypeSchema`). TTS is per-clientType (`session-handlers/tts-policy.ts`); the `mobile` arm v1 mirrors webui (honour channel + `ttsEnabled`), with the webui playback fallback.
- **`pendingId`** round-trips optimistic sends: optional on `text.input` and the user conversation-feed item (`shared/protocol`). The gateway threads the client id onto the committed user echo (`adapters/user-text-input-adapter.ts` → `cerebrum/conversation-feed.ts`) so the client reconciles by id. Absent ⇒ legacy text-FIFO dedup still applies.
- **Conversation-feed `ts` is a guaranteed non-negative int.** NaN/null/negative are backstopped to 0 with a WARN (`cerebrum/conversation-feed.ts#safeTs`; resume backfill in `sessions/hermes-message-to-mirror.ts`) — NaN serialises to `null` and crashes the strict KMP SDK decoder.

## Stubbed paths under ACP (open todos)

`apply` / restart / dispatch-reset paths used to fire `/reset` /
`/personality <name>` over a pooled custom-WS connection. ACP has no
slash-command equivalent today. Stubbed with WARN logs and TODO
comments; see `docs/research/2026-05-08-apply-restart-acp-rewire-todo.md`
for the gap and required equivalents.
