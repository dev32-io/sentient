# ACP Pivot — Sentient as an ACP Client of Hermes

> **Status:** Implemented. Phase 7 cleanup landed on `feature/acp-pivot` 2026-05-08; ACP wire is the only path. This document is retained as historical design context.
> **Date:** 2026-05-07
> **Branch:** `feature/acp-pivot`
> **Scope:** Replace the custom Hermes platform-adapter integration with a pure ACP-conformant client model. Retire 9 of 10 overlay patches and the 929 LOC `sentient_gateway.py`. Resolve the past-sessions follow-up todos (P0–P4) as side effects of the rearchitecture.

## Problem

The past-sessions feature (`feature/past-sessions-and-reconnect`, shipped at v0.3.0) needed seven fix-rounds and ended with several unresolved issues (`todo.md`):

- **P0** Drawer-empty regression after a failed switch — root cause: `sessions.user_id` column is `NULL` because the adapter never passes `user_id` into `AIAgent`.
- **Title is always "New chat"** — root cause: Hermes ships an internal auto-title generator (`agent/title_generator.py`); it's called by `gateway/run.py` (GatewayRunner) and `acp_adapter/server.py`. Our P16.5 refactor mirrored `api_server.py` which does NOT call it.
- **P1** Delete-current does not clear the chat pane — small client-side fix.
- **P2** Search-result preview snippet missing — DROPPED as a feature; the past-sessions row no longer renders a preview snippet at all.
- **P3** SQLite I/O race on macOS Docker — environmental, not addressed here.
- **P4** Cumulative architectural debt — the deeper issue.

When the user pointed out "auto-title should be Hermes' internal responsibility, gateway shouldn't call it," it became clear that our adapter had drifted into reimplementing what Hermes already provides through its supported integration paths (GatewayRunner, ACP adapter). Each fix-round added overlay patches and internal-API knowledge:

- 9 overlay patches touching Hermes internals
- 929 LOC `sentient_gateway.py` with direct calls into `AIAgent`, `SessionDB`, raw SQL `UPDATE` on `sessions.source`
- Coupling that grows whenever Hermes changes shape

The pivot in this spec replaces that surface with a clean ACP client.

## Goal

**Make sentient an ACP-conformant client of Hermes.** The gateway↔Hermes wire becomes ACP JSON-RPC over WebSocket. Hermes' upstream `acp_adapter` runs unmodified inside the overlay container. Future Hermes upgrades stop being patch-rebase exercises; future agents (any ACP-conformant runtime) become drop-in replacements.

## Non-goals

- Adopting ACP's draft Streamable HTTP / WebSocket transport RFD (still in spec phase upstream).
- Contributing custom WS transport upstream as a standardized ACP transport (could be a follow-up).
- Replacing Hermes with a different ACP agent (this spec just stops blocking that future).
- Changing the SDK / webui client-facing wire (preserved exactly).
- Addressing P3 SQLite I/O race on macOS (environmental, Pi unaffected).

## §1 — Architecture

```
Bun gateway ◀─── ACP JSON-RPC over WebSocket (one msg per WS frame) ───▶ acp_ws_server.py (overlay)
   │                                                                              │
   │ (gateway-internal: cerebrum, attention-gate,                                  ▼
   │  task mirror, conversation mirror — UNCHANGED)                       acp.run_agent(
   │                                                                          HermesACPAgent(),  ◀ upstream, unmodified
   │                                                                          input_stream=ws_writer,
   │                                                                          output_stream=ws_reader,
   ▼                                                                        )
SDK (web-sdk) ◀─── existing client-facing WS protocol (UNCHANGED) ─── webui

REST side-channel (unchanged):
Bun gateway ──▶ http://hermes-<profile>:8650/api/sessions/{search,delete,id,id/messages}
```

**Key invariants:**

- **Client-facing protocol unchanged.** SDK / webui see no wire change.
- **Hermes ACP adapter unmodified.** We provide custom transport (WebSocket); we do NOT patch `acp_adapter/server.py`.
- **Gateway-internal semantics unchanged.** Cerebrum, AttentionGate, ConversationMirror, TaskMirror, BargeIn / Interrupt controllers stay. Only the wire to Hermes changes.
- **REST endpoints stay public Hermes API.** Delete, search, get, get-messages already exist in `hermes_cli/web_server.py`. No patches needed.

## §2 — Wire protocol

**Transport.** WebSocket text frames. One ACP JSON-RPC message per WS text frame. WS framing is the boundary; no embedded newlines required.

**Connection lifecycle:**

1. Bun gateway opens WS to `ws://hermes-<profile>:8650/acp` with `Authorization: Bearer <shared-token>`.
2. `acp_ws_server.py` validates Bearer; accepts.
3. Bun gateway sends `initialize` request → server responds with capabilities.
4. Bun gateway sends `session/list` to populate drawer.
5. Bun gateway sends `session/new` or `session/load` to land on a session.
6. Per turn: `session/prompt` → server streams `session/update` notifications → server returns prompt response.

**Auth.** Bearer-token shared secret env var (today's contract preserved). ACP `authenticate` method unused — trust is established at WS upgrade.

**Stream adapter (Python sketch inside overlay):**

```python
class WSStreamReader:
    """Adapter: WS incoming text frames -> asyncio.StreamReader-compatible bytes stream.
    ACP expects newline-delimited JSON; we synthesize a trailing \n per frame."""
    def __init__(self, ws):
        self._ws = ws
        self._reader = asyncio.StreamReader()
        asyncio.create_task(self._pump())

    async def _pump(self):
        async for msg in self._ws:
            if msg.type == web.WSMsgType.TEXT:
                self._reader.feed_data(msg.data.encode() + b"\n")
        self._reader.feed_eof()
    # delegate readline/read/etc. to self._reader

class WSStreamWriter:
    """Adapter: bytes written by ACP -> outbound WS text frames.
    Strips trailing \n; one frame per message."""
    ...

async def serve_profile(ws):
    reader = WSStreamReader(ws)
    writer = WSStreamWriter(ws)
    await acp.run_agent(
        HermesACPAgent(),
        input_stream=writer,   # acp signature: writer == output to client
        output_stream=reader,  # reader == input from client
        use_unstable_protocol=True,
    )
```

## §3 — ACP method/notification usage map

**Methods used (Bun gateway → ACP server):**

| ACP method | When | Maps to today's gateway-internal |
|---|---|---|
| `initialize` | WS handshake | New (no current equivalent) |
| `session/new` | "+ New chat"; first message in fresh state | Today: gateway-minted UUID + adapter writes back |
| `session/load` | User picks drawer row; reconnect with `?session_id=` | Today: `session.switch` frame |
| `session/list` | Drawer open / refresh / cross-tab broadcast | Today: `sessions.list` frame |
| `session/prompt` | User sends a turn (text or voice transcript) | Today: `user.message` frame |
| `$/cancelRequest` | Barge-in or interrupt | Today: `user.cancel` frame |
| `session/close` | Disconnect / archive | Today: implicit on WS close |

**Notifications received (ACP server → Bun gateway):**

| ACP notification | sessionUpdate | Maps to today's gateway-internal |
|---|---|---|
| `session/update` | `agent_message_chunk` | `assistant.message` → ConversationMirror append + TTS stream |
| `session/update` | `tool_call` (start) | `tool.start` → TaskMirror create entry |
| `session/update` | `tool_call_update` (in-progress) | `tool.progress` → TaskMirror update |
| `session/update` | `tool_call_update` (completed/failed) | `tool.end` → TaskMirror finalize |
| `session/update` | `session_info_update` (title) | New: webui drawer auto-title live update via `sessions.renamed` SDK event with `source: "auto"` |
| `session/update` | `available_commands_update` | Cached for slash command UI |

**Methods we do NOT use (and why):**

| ACP feature | Why skipped |
|---|---|
| `authenticate` | Trust established at WS Bearer-token; ACP auth unused |
| `session/resume` | We use `session/load` semantically |
| `fs/read_text_file` / `fs/write_text_file` | Editor file capabilities; not relevant for voice gateway |
| `terminal/*` | Editor/terminal integrations; not used |

**REST side-channel (NOT ACP):**

| Operation | Endpoint | Why not ACP |
|---|---|---|
| Delete session | `DELETE /api/sessions/{id}` | ACP has no session/delete (RFD) |
| Search | `GET /api/sessions/search?q=...` | ACP has no session/search |
| Get messages (history rehydrate) | `GET /api/sessions/{id}/messages` | ACP has no equivalent message fetch |
| Rename | gateway-side titleStore JSON | UX-only override; ACP `session/update` is agent→client only |

**Auto-title flow (the "New chat" bug fix):**

```
1. session/prompt request
2. acp_adapter runs AIAgent.run_conversation
3. acp_adapter posts maybe_auto_title (background thread)
4. ~5-10s later: title generated -> session_db.set_session_title
5. acp_adapter emits session/update notification: sessionUpdate=session_info_update, title="..."
6. Bun gateway receives notification -> fires SDK event sessions.renamed (source: "auto")
7. webui drawer: row title updates live
```

Zero gateway-side title-gen code. Pure relay.

**Title resolution priority in `toSessionRow`:**

1. `titleStore[sessionId]` (user-set rename override) — highest priority
2. ACP-supplied title (Hermes auto-gen) — fills the slot
3. `"New chat"` literal fallback — only when neither is set

This matches Claude / ChatGPT behavior: agent owns content-derived titles; client owns user UX overrides.

**Future-proofed gateway-side per-user storage layout:**

```
~/.sentient/gateway/users/<userId>/
├── sessions/
│   ├── titles.json         # rename overrides (today's titleStore moves here)
│   ├── pins.json           # future: pinned chats
│   └── archived.json       # future: archived chats
├── preferences/
│   └── ui.json             # future: per-user UI prefs
├── memory/                 # future: gateway-owned per-user memory if ever needed
└── ...
```

User-level isolation is the outermost dir. Categories nested per user. Mode `0700` on `users/<userId>/`, `0600` on files. One-shot migrator on first boot moves the legacy `~/.sentient/gateway/session-titles/<userId>.json` to the new location.

## §4 — Gateway-side TS rewrite scope

**Big picture.** The wire to Hermes changes from custom WS frames to ACP JSON-RPC. Anything that knew the custom protocol gets rewritten. Everything above the wire — cerebrum, mirrors, SDK, webui — stays.

**What rewrites (`gateway/src/hermes-adapter-client/` ≈ 500–700 LOC delta):**

| File | Change | Disposition |
|---|---|---|
| `ws-frames.ts` | Drop custom frame schemas. New module: ACP JSON-RPC envelope + zod schemas for `initialize`, `session/new`, `session/load`, `session/list`, `session/prompt`, `session/update`, `$/cancelRequest`, `session/close`. | Rewrite |
| `event-translator.ts` | Translate ACP `session/update` notifications → existing internal events (assistant.message, tool.start/progress/end, sessions.renamed). Internal event shape unchanged so cerebrum stays unaware. | Rewrite |
| `per-profile-connection.ts` | Owns one ACP client per profile. JSON-RPC request/response correlation by id. Notification dispatch. Cancel support. | Rewrite |
| `sessions-client.ts` | List moves to ACP `session/list`; search/delete/get/getMessages stay HTTP REST. | Modify |
| Tests for the above | Mocks updated to ACP wire | Rewrite |

**What stays unchanged:**

| Layer | Files | Why |
|---|---|---|
| Cerebrum | `gateway/src/cerebrum/*` | Operates on internal event types, not wire frames |
| Session handlers | `gateway/src/session-handlers/*` | Same — internal events |
| Sessions title store | `gateway/src/sessions/title-store.ts` | Path config tweak only (per §3) |
| Sessions switch flow | `gateway/src/sessions/switch-flow.ts` | Drives ACP via per-profile-connection abstraction |
| MCP host | `gateway/src/mcp-host/*` | Tool definitions unchanged; bridge passes `mcpServers` in `session/new` params |
| Web SDK | `shared/web-sdk/*` | Client-facing protocol unchanged |
| Webui | `gateway/webui/*` | Unchanged |
| Shared protocol | `shared/protocol/src/sessions.ts` | SDK↔webui contract; unchanged |

**Key abstraction.** `event-translator.ts` is where the ACP→internal mapping lives. Cerebrum stays naive. If ACP wire later changes, only translator + per-profile-connection update.

**MCP servers passed per-session.** When calling `session/new`, gateway sends `mcpServers: [...]` array per ACP spec. Bun gateway reads `gateway/config.yaml#mcp_catalog` and forwards. Hermes acp_adapter consumes.

**Slash commands (`/personality`, `/model`, `/new`).** Hermes acp_adapter emits `available_commands_update` notification listing valid slash commands. Bun gateway caches. When user types a slash command, gateway sends as `session/prompt` with the slash command as prompt content. Hermes interprets via existing slash-command pipeline.

**Cycle / cancel semantics.** Bun gateway tracks active `session/prompt` request id. Barge-in / interrupt sends `$/cancelRequest` with that id. AttentionGate / bargeInController / interruptController logic unchanged — translator absorbs the wire detail.

## §5 — Hermes overlay shape

**File: `deploy/hermes-overlay/acp_ws_server.py` (new, ≈ 150–250 LOC).**

```
acp_ws_server.py
├── WSStreamReader / WSStreamWriter           # asyncio Stream adapters over aiohttp WS
├── ACPSession (per WS connection)            # holds reader/writer, runs acp.run_agent
├── auth_middleware                           # Bearer token validation
├── handle_acp_ws (aiohttp WS endpoint)       # /acp endpoint
└── main(profile, port)                       # bind aiohttp server
```

**Single-client model preserved.** One Bun gateway dials one Hermes-profile worker. Server accepts one WS at a time; subsequent connections close the prior WS before accepting.

**Hermes runtime path:**

```python
async def serve(ws):
  reader = WSStreamReader(ws)
  writer = WSStreamWriter(ws)
  agent  = HermesACPAgent()              # upstream, unmodified
  await acp.run_agent(
    agent,
    input_stream=writer,                 # acp: writer == output to client
    output_stream=reader,                # acp: reader == input from client
    use_unstable_protocol=True,          # required for full session/* semantics
  )
```

**What dies in overlay:**

| File / patch | Status |
|---|---|
| `sentient_gateway.py` (929 LOC) | DELETE |
| `patches/0001-config-platform-enum.patch` | DELETE |
| `patches/0002-run-adapter-factory.patch` | DELETE |
| `patches/0003-run-auth-maps.patch` | DELETE |
| `patches/0004-toolsets.patch` | DELETE |
| `patches/0005-run-adapter-tool-callbacks.patch` | DELETE |
| `patches/0006-platforms-registry.patch` | DELETE |
| `patches/0008-sentient-stream-token-passthrough.patch` | DELETE |
| `patches/0009-sentient-buffer-only-stream.patch` | DELETE |
| `patches/0010-sessions-source-filter.patch` | DELETE |

**What stays:**

| File | Status |
|---|---|
| `Dockerfile` | Modify: drop platform-enum / adapter copy steps; add acp_ws_server.py copy; CMD unchanged (still supervisord) |
| `HERMES_VERSION` | Verify (current pin v2026.4.23 already ships `agent-client-protocol >= 0.9.0`) |
| `supervisord.conf` (template) | Modify: per-profile program runs `acp_ws_server.py --profile <p> --port <port>` instead of `hermes -p <p> gateway run` |
| `patches/0007-docker-network-config.patch` | KEEP — pure infra |
| `README.md` | Rewrite to describe ACP-client model |

**Net overlay diff:**

- Delete: ≈ 929 LOC adapter + 9 patches
- Add: ≈ 150–250 LOC `acp_ws_server.py`
- Modify: Dockerfile (~5 lines), supervisord template (~5 lines), README rewrite

**Bonus decoupling.** The "register Sentient as a Hermes platform" model goes away entirely. Sentient is no longer a Hermes platform. Hermes treats us as an external ACP client. The entire `Platform.SENTIENT_GATEWAY` enum surface, auth maps, toolset wiring, factory branches retire.

## §6 — Lifecycle / supervisord

**Per-profile process model:**

```
container: sentient-hermes
  └─ supervisord (PID 1)
       ├─ python /opt/hermes-overlay/acp_ws_server.py --profile alice --port 8643 \
       │    --hermes-home /data/profiles/alice
       ├─ python /opt/hermes-overlay/acp_ws_server.py --profile bob   --port 8644 ...
       └─ python /opt/hermes-overlay/acp_ws_server.py --profile family --port 8645 ...
```

**Per-profile bringup (inside `acp_ws_server.py main()`):**

1. Load env from `/data/profiles/<profile>/.env`
2. Set `HERMES_HOME=/data/profiles/<profile>`
3. Configure logging to stderr
4. Bind aiohttp WS server on `--port`
5. Wait for Bun gateway WS connect
6. On connect: validate Bearer → spawn ACP server task → idle until disconnect
7. On disconnect: cancel ACP task → loop back to #5

**Restart behavior.** `supervisorctl restart hermes-alice` tears down acp_ws_server for Alice → respawns. Bun gateway sees WS close → existing reconnect logic handles. SOUL.md / personality file edits flow through profile restart per existing UX.

**REST endpoints (`/api/sessions/*`).** Today's `hermes -p <profile> gateway run` exposes both the platform-adapter WS AND REST endpoints on the same port. After: `acp_ws_server.py` exposes ACP WS at `/acp` and mounts Hermes' upstream `web_server.py` aiohttp app at `/api/*` on the same port (single bind, two apps).

**Auth on REST.** REST shares the worker's Bearer-token. Bun gateway sends `Authorization: Bearer ...` to both `/acp` (WS) and `/api/sessions/*` (REST).

**Health checks.** Bun gateway dials `/acp`, completes ACP `initialize`, considered up. Optional: `GET /healthz` aiohttp route returning 200 for docker healthcheck.

## §7 — Mic regression + small fixes (orthogonal, same branch)

**Mic icon regression** — `gateway/webui/src/styles/components.css:106-114` mobile rule:

```css
@media (hover: none), (max-width: 620px) {
  .icon-btn { min-width: 44px; min-height: 44px; width: 44px; height: 44px; }
}
```

`min-width: 44px` clamps width up; composer-row override (`width: 32px`) loses. Fix:

```css
@media (hover: none), (max-width: 620px) {
  .composer__bottom-row .icon-btn {
    min-width: 32px;
    min-height: 32px;
    width: 32px;
    height: 32px;
  }
}
```

≈ 6 LOC CSS. WCAG 44×44 stays for topbar / drawer / standalone icon buttons. Composer is high-density; small tightly-packed controls expected.

**Other deferred items from `todo.md`:**

| todo.md | Resolution |
|---|---|
| P0 Drawer-empty (user_id NULL) | Resolved — Hermes acp_adapter populates user_id correctly |
| P1 Delete-current does not clear chat pane | Small webui hook tweak (≈ 10–15 LOC), include in same branch |
| P2 Search-result preview snippet missing | DROPPED — preview feature retired; rows render title + lastActive + messageCount only. |
| P3 SQLite I/O race on macOS Docker | Not addressed (environmental, Pi unaffected) |
| P4 Cumulative architectural debt | Resolved — this entire spec |

**Branch order:** mic CSS + P1 delete-current land first as quick green commits before the ACP pivot bulk.

## §8 — Migration / cutover

**Branch.** `feature/acp-pivot` off `develop`.

**Phased commits (smallest blast radius first):**

1. **Quick fixes.** Mic CSS, P1 delete-current. Independent of ACP.
2. **Storage layout migration.** Move `~/.sentient/gateway/session-titles/<userId>.json` → `~/.sentient/gateway/users/<userId>/sessions/titles.json`. One-shot migrator on first boot.
3. **Overlay scaffolding.** Add `acp_ws_server.py` (skeleton) alongside existing `sentient_gateway.py`. Don't switch CMD yet.
4. **Verify Hermes acp_adapter behavior.** Standalone Python ACP test client → boot acp_ws_server with one profile → exercise `initialize` / `session/new` / `session/prompt` / streaming / cancel / `session/list`. Capture parity gaps with current gateway behavior.
5. **Gateway-side TS rewrite.** New `hermes-adapter-client/` ACP wire (frames + translator + per-profile-connection + cancel). Old code stays compiled but unused via feature flag `gateway.use_acp_wire = false`.
6. **Dev cutover.** Flip `use_acp_wire = true` in dev config. Switch supervisord template to spawn `acp_ws_server.py`. Smoke matrix run.
7. **Smoke matrix passes.** Run §9 cases, capture evidence.
8. **Pi rollout.** Update Pi compose to new image. Monitor for one observation cycle.
9. **Cleanup commit.** Delete `sentient_gateway.py`, retired patches, `Platform.SENTIENT_GATEWAY` references, the feature flag itself. Update README. Bump gateway version.

**Data migration.** Hermes `state.db` schema unchanged. Sessions created under old `sentient-user` source tag remain visible — ACP `session/list` returns all sessions for the user_id. No user-visible data loss.

**Rollback plan.** Each commit independent. If smoke fails on macOS, revert just the supervisord template + Dockerfile commit. Old `sentient_gateway.py` stays in tree until cleanup commit.

**Pi-specific.** ARM64 wheel for `agent-client-protocol` — pure-Python; verify in §8 step 8.

**Version bump.** Gateway `+0.1.0` (1.1.0 → 1.2.0).

**Documentation deltas:**

| Doc | Change |
|---|---|
| `gateway/CLAUDE.md` | Update wire description from "Hermes worker (per user)" to "Hermes (per user) via ACP" |
| `.claude/rules/gateway/cerebrum.md` | Note translator absorbs ACP wire; cerebrum stays naive |
| `deploy/hermes-overlay/README.md` | Rewrite — ACP-client model, no platform registration, drop "Patches" section to just 0007 |
| `docs/research/` (optional) | ACP RFD links + decision rationale |

## §9 — Smoke matrix

Reuse past-sessions matrix where applicable. Add ACP-specific cases. Viewport matrix every run: desktop (1280×900) + mobile (390×844). Per `.claude/rules/e2e-testing.md`.

| # | Case | Expected behavior | New under ACP? |
|---|---|---|---|
| C1 | First-ever message (fresh stack, no sessions) | + New chat → `session/new` → message sends → assistant streams → ~10s later auto-title arrives → drawer row title live-updates from "New chat" to a content-aware title | YES — auto-title is the headline new behavior |
| C2 | Resume existing session via drawer click | `session/load` → list refresh → conversation history rehydrates → next message persists to same id | Modified |
| C3 | Mid-cycle switch | Click another row mid-stream → `$/cancelRequest` → ACP cycle aborts cleanly → `session/load` succeeds → no orphan text | Modified |
| C4 | Reconnect with `?session_id=` | Reload page with sessionStorage set → `session/load` → conversation history rehydrates | Modified |
| C5 | Mobile viewport tap targets | Drawer ≥44×44; composer mic 32×32 (per §7 fix); send button 32×32 | New verification (mic fix) |
| C6 | Search hit / no-hit / prefix | `GET /api/sessions/search?q=...` (still REST) → results render with title + lastActive | Modified (preview dropped) |
| C7 | Rename live update + persistence | Drawer rename → titleStore JSON write → broadcast → other tabs update → reload preserves rename → rename overrides auto-title | Modified (auto-title precedence rule new) |
| C8 | Delete current session clears chat pane | Per §7 P1 fix → row disappears → chat pane clears → land on fresh empty state | New |
| C9 | Delete non-current session | Row disappears → current chat pane unchanged | Same |
| C10 | Tool call streaming (HA, MA, search) | Tool pill appears → progress messages → completion → assistant continues | Modified — verify ACP `tool_call_update` mapping correct |
| C11 | Slash command `/personality`, `/model`, `/new` | Slash command suggestion list comes from `available_commands_update` notification → executing slash command works | Modified — wire change verification |
| C12 | Barge-in (mic onset during TTS) | TTS aborts → cycle cancels via `$/cancelRequest` → mic captures next utterance | Modified |
| C13 | Interrupt button (UI Stop) | Cycle aborts via `$/cancelRequest` + task cancel routed | Modified |
| C14 | Cross-tab sync (BroadcastChannel) | Rename in one tab → other tab updates row | Same |
| C15 | Drawer empty state on fresh user | First-ever load with zero sessions → empty state | Same |
| C16 | Drawer-empty regression (reproduce P0 trigger) | Run case C3-failure path repeatedly → list still returns rows | YES — verify pivot fixes P0 |
| C17 | Long conversation (50+ turns, multi-tool) | Auto-title still single-shot after first turn; no flicker | New |
| C18 | Hermes worker restart (`supervisorctl restart hermes-<userId>`) | WS reconnects automatically → drawer state reloads → no data loss | Modified |
| C19 | Network blip (kill tab WS, wait 3s, restore) | SDK reconnects → resumes session via `?session_id=` | Modified |
| C20 | Performance: 100+ sessions in drawer | Pagination works (`session/list` cursor) → no UI hang | New (cursor pagination is ACP) |

**Evidence per case:** screenshots at decision points, console messages, network requests where contract matters. Save under `.playwright-mcp/`.

**Pre-handover gate:** every case green, evidence captured, lint + typecheck + unit-tests clean, deployable artifact built (Mac local docker stack healthy), Pi rollout green for one observation cycle.

## §10 — Risks + open questions

**To verify in §8 step 4 (standalone ACP test client):**

| # | Risk | Verification | Mitigation if gap |
|---|---|---|---|
| R1 | Hermes acp_adapter `available_commands_update` actually emits all our slash commands (`/personality`, `/model`, `/new`, `/clear`, `/skills`, etc.) | Test client; capture emitted command list; diff against today's surface | One small upstream patch to expand `_available_commands` if needed |
| R2 | ~~ACP `session/list` returns `preview` field per row~~ | DROPPED — preview feature retired; rows return title + lastActive + messageCount only. |
| R3 | Tool-call streaming under ACP — `tool_call` + `tool_call_update` notifications match our internal events 1:1 | Smoke run with HA, MA, web search; capture wire | If mismatch: extend translator |
| R4 | `$/cancelRequest` aborts AIAgent mid-stream cleanly (no orphan tokens, no half-written messages-table rows) | Test client mid-`session/prompt` → cancel → verify state.db state | If broken: only place a Hermes patch would be tolerable; otherwise revisit barge-in semantics |
| R5 | ACP `_meta` extensibility lets us pass `cycleId` through if cerebrum needs it | Schema review; round-trip test | If unsupported: cerebrum tracks cycleId locally; never round-trips |
| R6 | `mcpServers` array per `session/new` works for our MCP catalog (HA, MA, DDG, gateway-hosted) | Test client send list; verify Hermes routes tool calls correctly | Keep YAML-side config + integration tests |
| R7 | Custom WS transport compatible with `acp.run_agent`'s `asyncio.StreamReader/StreamWriter` requirement | Build adapter → single round-trip → verify framing | Increase frame buffering; worst case line-delimited framing within frames |
| R8 | Bun gateway WS client correctly handles ACP JSON-RPC id correlation under concurrent requests | Concurrent `session/list` + `session/prompt` → verify no id collisions | Standard JSON-RPC client pattern |
| R9 | Persona / SOUL.md still loaded on session start | Test client → `session/new` → first prompt → verify system prompt includes persona content | If broken: investigate Hermes `_create_agent` path in acp_adapter |
| R10 | Auto-title timing — `maybe_auto_title` runs on background thread under ACP wire too; latency from final response to title arrival | Smoke C1 → measure delay | Keep "New chat" fallback; add observability |
| R11 | ARM64 (Pi) compatibility of `agent-client-protocol` package | Build Pi image; smoke C1–C5 on Pi | Use sdist; package is pure-Python so should be fine |
| R12 | ACP `use_unstable_protocol=True` — what counts as unstable; does Hermes hide capabilities behind it | Read schema annotations; test both modes | Default to True per Hermes' existing entry.py |
| R13 | Single-client model — what happens if Bun gateway reconnects while ACP server is mid-prompt | Test sequence | Server cancels in-flight prompt + closes prior WS before accepting new |

**Open questions for spec self-review:**

- Does Hermes acp_adapter expose REST `/api/sessions/*` on the same port, or is that owned by a separate process?
  → Verify in §8 step 4. Likely same `web_server.py` works alongside; if not, run as second supervisord program.
- Auth-token lifetime — does the ACP `initialize` flow expect a separate auth dance?
  → Bearer token gates the WS upgrade; ACP `authenticate` skipped. Confirm `HermesACPAgent` doesn't reject sessions without auth.
- Does ACP have a way to set `user_id` on a new session, or does Hermes derive it from environment?
  → Hermes acp_adapter likely derives from `HERMES_HOME` / profile config (per today's GatewayRunner). Verify.

**Out of scope (explicitly defer):**

- ACP HTTP/WS draft RFD adoption — wait for upstream stabilization
- Contributing custom WS transport upstream as standard ACP transport — could be a follow-up after we have working code
- Replacing Hermes with another ACP agent — this spec just stops blocking it

## Appendix A — Why this beats incremental fixes

We considered three lighter alternatives and rejected each:

| Alternative | Why rejected |
|---|---|
| Mirror `acp_adapter/server.py` behavior in `sentient_gateway.py` (call `maybe_auto_title`, pass `user_id`) | Same coupling depth as today inside the worker. Stops missing hooks but doesn't address user's red flag about reaching into Hermes internals. |
| Frame-preserving WS↔ACP-stdio bridge | Half-measure. Bun-gateway-side stays unchanged but the bridge becomes maintenance debt mirroring two protocols. Doesn't deliver the "future-proof, swap any ACP agent" payoff. |
| Gateway-side metadata store (hermes-webui pattern) | Trades Hermes-coupling for self-coupling — gateway runs its own title-gen LLM. Title gen has to happen somewhere; better that it lives where the LLM already runs. |

The pure ACP-client model is the only one that delivers all three: minimal coupling, future-proof against Hermes upgrades, swap-able agent runtime.

## Appendix B — References

- ACP introduction: https://agentclientprotocol.com/get-started/introduction
- ACP transports: https://agentclientprotocol.com/protocol/transports
- ACP session list: https://agentclientprotocol.com/protocol/session-list
- HTTP/WS transport RFD (draft): https://agentclientprotocol.com/rfds/streamable-http-websocket-transport
- Hermes ACP adapter source (in-container): `/opt/hermes/acp_adapter/server.py`
- Hermes upstream pin: `deploy/hermes-overlay/HERMES_VERSION`
- Past-sessions spec (predecessor work): `docs/superpowers/specs/2026-05-06-past-sessions-and-reconnect-design.md`
- Past-sessions plan (predecessor work): `docs/superpowers/plans/2026-05-06-past-sessions-and-reconnect.md`
- Outstanding follow-ups (resolved by this spec): `todo.md`
