# Past Sessions List + Resume + Reconnect Simplification — Design

**Status:** Draft (v1)
**Date:** 2026-05-06
**Branch (planned):** `feature/past-sessions-and-reconnect`

## Summary

Add a Claude/ChatGPT-style hamburger sidebar that lists the user's past
chat sessions with auto-generated titles, lets the user click any row
to resume that conversation in full context, and simplifies the
reconnect flow so a returning browser tab lands back on whatever
session it was last on. All v1 features ship in one milestone (search,
rename, delete, date-grouping, cross-tab sync, current-session
pointer, reconnect rework).

The design is grounded in upstream Hermes' existing capabilities — no
session storage layer is introduced on the gateway side; Hermes' SQLite
is the single source of truth.

## Motivation

Today the gateway opens a fresh `ConversationMirror` on every WS
connect; reconnecting browser tabs lose conversation history. The user
has no way to navigate to past chats — every session that scrolls off
the screen is invisible. Reconnect logic in `sdk-reconnect.ts` does
exponential backoff but doesn't carry session identity across the
hop, so even when Hermes still has the chain, the UI can't surface
it.

The fix is twofold and shares one primitive (a session id with an
authoritative store): expose the chains Hermes already keeps in SQLite
through the WS protocol, and use that same id on reconnect to land
the user back on their prior chat.

## Scope

### In v1

- Hamburger button → slide-out drawer.
- Sessions list with auto-generated titles, relative-time meta,
  current-session highlight, empty-state copy.
- Date grouping ("Today / Yesterday / Last 7 days / Older").
- Search box with FTS5-backed prefix search.
- Click-to-resume (snapshot rehydration of the chat view).
- New Chat button.
- Rename + Delete via row ellipsis menu.
- Cross-tab sync of delete + rename + switch via BroadcastChannel.
- Current-session pointer in `sessionStorage` (per-tab).
- Reconnect carries `?session_id=` on the WS URL; gateway resumes if
  valid, falls back to new chat if not.
- All v1 ships behind no feature flag (single-user-family scope).

### Out of scope (named for follow-up specs)

- History-paging in the SDK mirror beyond the existing 500-entry cap
  (Hermes has the data; "load older" UI ships later).
- Pin-to-top, archive folders, export-to-markdown.
- Cross-tab streaming sync (only metadata sync in v1; if tab A is
  mid-cycle and tab B opens the same id, tab B sees a stale snapshot
  until next message).
- Mobile gesture for drawer open/close (tap-only in v1).
- Voice-mode persistence on resume (resume always lands in text mode).
- Session sharing / read-only links.
- Insights / per-session token cost UI.
- Real iOS Safari smoke (agent runs chromium only — flagged for
  operator follow-up per `.claude/rules/e2e-testing.md`).

## Architecture

### Source of truth

| Concern | Owner |
|---|---|
| Conversation history | Hermes SQLite (`state.db`, `sessions` + `messages` tables) |
| Auto-generated title | Hermes (`agent/title_generator.py`) |
| Title override (user-renamed) | Gateway JSON store (`~/.sentient/gateway/session-titles/<userId>.json`) |
| Current session id | Browser `sessionStorage` (per tab) |
| In-flight conversation mirror | Gateway memory (existing `ConversationMirror`, hydrated from Hermes on resume) |

The only new persistent state on the gateway is the title-override
JSON store. It is small, per-profile, and recoverable from empty —
losing it falls back to Hermes' auto-titles. No DB, no schema.

### High-level flow

```
Browser (Preact)                    Gateway (Bun/TS)               Hermes (Python, per-profile process)
─────────────────                   ─────────────────              ──────────────────────────────────
hamburger click                                                    
    ↓                                                              
SessionsConnector.list() ────────►  ws: sessions.list                
                                       ↓
                                    HermesSessionsClient ────────► GET /api/sessions?source=sentient-user
                                                                        (pagination, lineage collapse,
                                                                         FTS5 search via separate route)
                                                                   ←── sessions[]
                                       ↓
                                    apply title overrides
                                    transform → SessionRow[]
                                       ↓
                                ◄── ws: sessions.list.result
list rendered ◄────────────────                                    

(user clicks an old session)
SessionsConnector.switchTo(id) ──►  ws: session.switch
                                       ↓
                                    interruptController.abort()    (cancel current cycle)
                                       ↓
                                    HermesSessionsClient.getMessages(id)
                                                            ────► GET /api/sessions/{id}/messages
                                                                ←── messages[]
                                       ↓
                                    transform → ConversationFeedItem[]
                                    mirror.replaceAll(items)
                                                                   
                                ◄── ws: session.switched
                                ◄── ws: conversation.snapshot
chat view rehydrates                                               
```

### Logical-thread collapse

Hermes' `list_sessions_rich` walks `parent_session_id` chains by
default (`project_compression_tips=True`) so one logical conversation
maps to one row. The gateway leans on this — no chain walking on the
TS side. The leaf session id is what we resume against, ensuring the
next user message lands on the live chain.

### Source filter

Every session created via the sentient adapter is tagged
`source='sentient-user'`. Future gateway-triggered system or cron runs
will use other tags (`sentient-system`, `sentient-cron`) and stay out
of the user-facing list. Hermes' `list_sessions_rich` supports
`source=<value>` natively; the HTTP layer needs a one-line patch to
expose it as a query param (see Patches section).

## Components

### Gateway

#### `gateway/src/hermes-adapter-client/sessions-client.ts` (new)

```typescript
interface HermesSessionsClient {
  list(opts: { limit: number; offset: number }): Promise<HermesSessionRow[]>;
  search(q: string, limit: number): Promise<HermesSearchHit[]>;
  getMessages(sessionId: string): Promise<HermesRawMessage[]>;
  delete(sessionId: string): Promise<void>;
  rename(sessionId: string, title: string): Promise<void>;
}
```

- HTTP client to the per-profile Hermes process. Base URL resolved
  alongside the existing WS URL in `PerProfileConnection`.
- `?source=sentient-user` filter applied on every list call.
- Logical-thread collapse handled by Hermes; client passes through.
- `rename` updates the gateway-side title-override store; never
  patches Hermes.
- 5 s timeout per call (config-driven).

#### `gateway/src/sessions/title-store.ts` (new)

- Per-profile JSON store at
  `~/.sentient/gateway/session-titles/<userId>.json`.
- Read on every list-render to override Hermes auto-titles.
- Write on rename.
- File mode 0600. Corrupt JSON → log WARN, treat as empty.

#### `gateway/src/sessions/switch-flow.ts` (new)

- State machine for `session.switch`. Single instance per WS session.
- States: `idle → cancelling → fetching → rehydrating → ready`.
- Concurrent switches: AbortController on the in-flight one; latest
  wins.
- Refuses inbound `user.message` while not in `idle` or `ready`
  (returns `sessions.error { code: "switching" }`).

#### `gateway/src/cerebrum/conversation-mirror.ts` (modified)

- Add `replaceAll(items: ConversationFeedItem[]): void`.
- Add `onSnapshot(cb)` — emits exactly once on `replaceAll`, separate
  from `onAppend`.
- `replaceAll` honors the existing 500-entry cap (keeps tail).
- Existing `onAppend` listeners (presence wiring, attention gate)
  unaffected — snapshot does not fire append.

#### `gateway/src/cerebrum/attention-gate.ts` (modified)

- On switch start, clear conversation salience accumulator (consistent
  with the interrupt code path per `architecture.md`).
- Ambient salience preserved (sensor backlog, future triggers stay).

#### `gateway/src/session-handlers/ws-session-configure.ts` (modified)

- Read `?session_id=` from connect URL on auth.
- Validate against profile ownership.
- Run the switch flow as part of session-ready (single round-trip;
  no separate `session.switch` frame needed for reconnect).
- 404 on Hermes → empty snapshot, log WARN, continue. SDK observes
  empty snapshot + missing `session.switched`, clears
  `sessionStorage.currentSessionId`.

#### `gateway/src/session-handlers/sessions-handlers.ts` (new)

- Handlers for: `sessions.list`, `sessions.search`,
  `sessions.delete`, `sessions.rename`, `session.new`, `session.switch`.
- Cross-profile guard at every entry point: `sessionId ∈ profile`.

### Sentient overlay (`deploy/hermes-overlay/`)

#### `sentient_gateway.py` (modified)

- `user.message` frame (gateway → Hermes) grows optional `session_id`
  field.
- On receipt: if set, force Hermes' active session for the profile to
  that id before invoking the agent.
- Emit Hermes-side `session.created` event on first message of a
  fresh chain (carries new `session_id`).
- Emit Hermes-side `session.switched` event whenever the active
  session changes — gateway-initiated OR Hermes-initiated (e.g.
  compression rotation).
- The gateway translator (`hermes-event-translator.ts`) consumes
  these events and emits the SDK-facing WS frames of the same names.
  Layering is consistent with how `cycle.done` flows today.

#### `patches/0010-sessions-source-filter.patch` (new)

- Adds `source: str = None` query param to
  `GET /api/sessions` in `hermes_cli/web_server.py`.
- Threads through to the existing `list_sessions_rich(source=...)`
  kwarg.
- ≤5 lines, additive only. Rebases trivially across upstream changes.

#### `README.md` (modified)

- Document patch 0010 (function it touches, additive guarantee).
- Note `source='sentient-user'` convention and the reserved tag space
  (`sentient-system`, `sentient-cron`, …).

### SDK (`shared/web-sdk/`)

#### `connectors/sessions-connector.ts` (new)

```typescript
interface SessionsConnector {
  list(opts: { limit; offset }): Promise<{ items, total, hasMore }>;
  search(q: string, limit?: number): Promise<SessionRow[]>;
  delete(sessionId: string): Promise<void>;
  rename(sessionId: string, title: string): Promise<void>;
  newChat(): Promise<{ sessionId: string }>;
  switchTo(sessionId: string): Promise<void>;
  onSessionsChanged(fn: (event: SessionsChangeEvent) => void): () => void;
}
```

- Request/response correlation via `requestId` (uuid).
- All requests bounded by config timeout.
- WS disconnect mid-request → reject with typed error; UI re-issues
  on reconnect.

#### `connectors/conversation-history-connector.ts` (modified)

- Snapshot during a session-switch REPLACES the local mirror, not
  merges.
- Snapshot generation counter — concurrent switches stay sane
  (last-write-wins by gen). Stale `conversation.entry` after a switch
  is dropped.

#### `cross-tab-sync.ts` (new)

- Per-user BroadcastChannel: `sentient-sessions:${userId}`.
- Tab broadcasts on receipt of `session.switched` /
  `sessions.deleted` / `sessions.renamed` from gateway.
- Other tabs update their list views; if the deleted id was theirs,
  drop to "new chat" mode.

### WebUI (`gateway/webui/`)

New components (Preact + signals):

- `Drawer.tsx` — slide-out panel triggered by hamburger.
- `SessionList.tsx` — virtualized list (~50 rows/page; load-more on
  scroll bottom).
- `SessionRow.tsx` — title, preview, relative time, ellipsis menu,
  active highlight.
- `SessionSearchBox.tsx` — debounced (300 ms) input → search.
- `DateGroupHeader.tsx` — derived from `lastActiveAt`.
- `NewChatButton.tsx` — top of drawer.

Bubble rehydration de-dup: bubble keys are stable
`${kind}:${ts}:${hash(content)}` (or Hermes message id if exposed).
Preact reconciles existing bubbles on snapshot, minimal DOM churn.
Snapshot generation counter drops stale `conversation.entry` events
from a previous session.

Mobile drawer (≤620 px breakpoint, existing): ~85 % width, backdrop
overlay, tap-outside to close, all rows ≥44 px tap target. Reuses
existing density tokens from the prior UI refinement pass.

### Protocol additions (`shared/protocol/`)

New file: `src/sessions.ts` — `SessionRow`, request/result schemas
via zod (per `bun-typescript.md`).

New WS frames (additive, do not change existing):

| Direction | Frame | Payload |
|---|---|---|
| client → gw | `sessions.list` | `{ requestId, limit, offset }` |
| gw → client | `sessions.list.result` | `{ requestId, items, total, hasMore }` |
| client → gw | `sessions.search` | `{ requestId, q, limit }` |
| gw → client | `sessions.search.result` | `{ requestId, items }` |
| client → gw | `sessions.delete` | `{ requestId, sessionId }` |
| gw → client | `sessions.deleted` | `{ sessionId }` |
| client → gw | `sessions.rename` | `{ requestId, sessionId, title }` |
| gw → client | `sessions.renamed` | `{ sessionId, title }` |
| client → gw | `session.new` | `{ requestId }` |
| gw → client | `session.created` | `{ sessionId, title?, ts }` |
| client → gw | `session.switch` | `{ requestId, sessionId }` |
| gw → client | `session.switched` | `{ sessionId, title?, ts }` |
| gw → client | `sessions.error` | `{ requestId, code, message }` |

Existing frames reused unchanged: `conversation.snapshot`,
`conversation.entry`.

### Configuration (`gateway/config.yaml`)

```yaml
sessions:
  list_page_size: 20         # default page size for sessions.list (1-100)
  search_max_results: 20     # cap on FTS results (1-50)
  search_min_chars: 2        # debounce floor; queries shorter dropped
  search_debounce_ms: 300    # client-side debounce — surfaced for tuning
  title_max_chars: 200       # rename input bound
  title_override_dir: ~/.sentient/gateway/session-titles  # per-profile JSON store
  source_tag: sentient-user  # sentient adapter writes this on every new chain
  hermes_http_timeout_ms: 5000
  switch_teardown_timeout_ms: 3000  # max wait for cycle-cancel before switch proceeds
```

Defaults in YAML, code reads at startup, fail loudly if missing.
Operator config (`~/.sentient/gateway/config.yaml`) merged manually
per `feedback_dont_clobber_host_config`.

## Switch flow (canonical)

```
Trigger: ws frame `session.switch { requestId, sessionId }`

1.  switchFlow.transition(idle → cancelling)
2.  interruptController.abort()
       — aborts active cycle + TTS + routes task-cancel to Hermes
       — ConversationMirror is NOT cleared yet
3.  await pending stream cleanups (existing teardown), bounded by
    config.switch_teardown_timeout_ms (default 3 s)
4.  switchFlow.transition(cancelling → fetching)
5.  HermesSessionsClient.getMessages(sessionId)
6.  transform Hermes raw messages → ConversationFeedItem[] via
    existing translator
7.  switchFlow.transition(fetching → rehydrating)
8.  mirror.replaceAll(items)
       → onSnapshot fires → WS handler emits conversation.snapshot
9.  PersonSession binding: conversationId = sessionId
10. emit ws frame `session.switched { sessionId, title, ts }`
11. AttentionGate: clear conversation salience accumulator
12. switchFlow.transition(rehydrating → ready)
13. ready for next user.message
```

`session.new` runs the same flow but skips steps 5–6 (no history to
fetch); `mirror.replaceAll([])` clears the chat view.

## Reconnect flow

```
Tab opens or reconnects:
1. Read sessionStorage.currentSessionId (if present).
2. Open WS to: wss://host/sentient?session_id=<id>&token=<paseto>
3. Gateway auth-gate validates token + reads session_id query param.
4. Gateway resolves session_id against profile; if owned, runs the
   switch flow as part of session-ready (single round-trip).
5. Gateway emits session.ready, conversation.snapshot, session.switched
   (in that order).
6. Tab renders rehydrated chat.

Failure modes:
- session_id not owned by profile → reject auth (1008).
- session_id not found in Hermes (404) → empty snapshot, no
  session.switched, log WARN. SDK observes the missing switch frame,
  clears sessionStorage, shows new chat.
- session_id absent → fresh new chat (matches today's behavior).
```

The existing `sdk-reconnect.ts` (exponential backoff, ping/pong probe,
visibility/online triggers) stays unchanged. Only the connect URL
gains the `session_id` query param.

## Patches summary

**Patches added: 1.**

`deploy/hermes-overlay/patches/0010-sessions-source-filter.patch` —
adds `source: str = None` query param to `GET /api/sessions` route in
`hermes_cli/web_server.py`, threads through to existing
`list_sessions_rich(source=...)` kwarg. Two-line additive change.
README updated alongside.

**No rename patch.** Gateway-side title override store handles rename
without upstream changes — saves a patch maintenance burden.

**Patch policy formalized in this spec:**
- Patches MUST be additive only (new args with defaults, new
  endpoints, never modified signatures).
- One feature = one numbered patch.
- If a feature can be done gateway-side without patching, do that.

## Error handling

| Failure | Where | Behavior |
|---|---|---|
| Hermes HTTP unreachable | `HermesSessionsClient.*` | Typed error → `sessions.error` to SDK. UI shows inline retry. List view keeps last good page. Adapter `start()` non-throwing per `error-handling.md`. |
| Hermes returns 404 | resume / switch | Gateway logs WARN, drops to fresh-new behavior, snapshot empty array. SDK clears `sessionStorage.currentSessionId`. |
| Switch teardown timeout | `interruptController.abort()` race | Switch waits up to `config.switch_teardown_timeout_ms`, then proceeds. Active flag clears regardless. |
| Concurrent switches | two `session.switch` in flight | AbortController on the in-flight one; latest wins. |
| Cross-profile sessionId | any sessions handler | Reject with `sessions.error { code: "forbidden" }`. Logged WARN with sanitized ids. Never honored. |
| Title-override store corrupt | gateway boot | Log WARN, treat as empty store, continue. Renames thereafter rebuild it. |
| WS reconnect with stale `?session_id=` | post-auth lookup fails | Same as 404 path. |

## Security

- All new WS frames pass through the existing PASETO-validated WS —
  no new auth surface.
- Cross-profile leak guard: every `sessionId` validated against
  `userId` bound to the WS at every entry point. Defense-in-depth:
  gateway double-checks the returned `source` field is
  `sentient-user` before forwarding.
- Rename payload sanitized: ≤200 chars, no control chars (existing
  log-sanitizer pattern). Persisted as plain text — no HTML, no
  markdown rendering on the row.
- Search query length-bounded (≤200 chars). Hermes parameterizes the
  FTS5 query — gateway forwards raw `q` after the bound.
- Title-override store path: per-profile, mode 0600, no symlink
  follow.

## Logging (per `logging.md`)

Tagged loggers:

- `["sentient", "sessions", "client"]` — HermesSessionsClient (HTTP).
- `["sentient", "sessions", "ws"]` — WS frame handlers.
- `["sentient", "sessions", "switch"]` — switch-flow state machine.
- `["sentient", "sessions", "title-store"]` — override store.

Levels:

- INFO: list request (count, source, latency_ms), switch (from/to id),
  new chat created, delete/rename success.
- DEBUG: per-row transform, snapshot size at rehydration, mirror
  replaceAll size, broadcast emit/receive.
- WARN: 404 fallback, cross-profile reject, override-store
  corruption, switch-during-active-cycle (always tagged with
  `cycleId`).

IDs on every entry where available: `sessionId`, `userId`, `cycleId`,
`requestId`.

## Testing (per `testing.md`)

Tests we KEEP:

- Wire/protocol contract: `sessions.list` request → result frame
  shape (zod parse round-trip); `session.switch` emits
  `session.switched` then `conversation.snapshot` in order;
  `session.new` emits `session.created` with non-empty sessionId;
  cross-profile `session.switch` → `forbidden`, no Hermes call;
  reconnect with stale id → empty snapshot, no error to UI;
  `HermesSessionsClient` 404 → typed error.
- FSM/invariant: `ConversationMirror.replaceAll` emits `onSnapshot`
  exactly once, NOT N `onAppend`; snapshot generation drops stale
  entries; AttentionGate clears conversation salience on switch,
  preserves ambient; switch-during-active-cycle aborts cycle before
  snapshot lands; concurrent switches latest-wins, no torn mirror.
- Security boundary: title >200 chars rejected; control-char input
  sanitized; sessionId not owned by profile rejected at every entry
  point.

Tests we will NOT write (per `testing.md` keep-bar):

- Pure presentation (date-grouping helper, relative-time formatter).
- Connector DI / factory wiring.
- WebUI component snapshot tests.
- HermesSessionsClient internals beyond contract.
- Title-override file I/O happy path.

## E2E smoke matrix (per `.claude/rules/e2e-testing.md`)

Owner: agent. Driver: Playwright MCP. Stack: Mac local
(`deploy/macos/docker-compose.yml`). Viewports: desktop (1280×900) +
mobile-sized (390×844). All cases must be green before handover.

### Desktop matrix

| Case | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|
| Empty list, fresh user | no sessions | open drawer | empty-state copy renders | INFO list, count=0 |
| New chat from empty | no sessions | new chat → first message | list grows to 1 row, auto-title appears after Hermes generates | session.created + title generated |
| Multi-session ordering | 5 sessions across days | open drawer | ordered by recency, date groups correct | — |
| Resume idle session | cycle idle | click old row | snapshot → bubbles render → next message extends same chain | session.switched + snapshot, no cycle.aborted |
| Resume mid-cycle | cycle streaming | click old row | current cycle aborts, then snapshot lands | cycle.aborted, session.switched, snapshot |
| Search hit | several sessions | type query | matching rows only | INFO search |
| Search no-hit | several sessions | nonsense query | empty-results state | INFO search hits=0 |
| Search prefix | several sessions | partial word | matches via FTS5 prefix wildcard | — |
| Date grouping | seed `started_at` to span groups | open drawer | "Today / Yesterday / Last 7 days / Older" headers | — |
| Rename | row exists | ellipsis → rename | row updates, persists across reload | INFO title-store write |
| Delete current | current session active | ellipsis → delete | drops to new chat | sessions.deleted broadcast |
| Delete non-current | row exists | ellipsis → delete | list shrinks, chat unaffected | sessions.deleted broadcast |
| Active highlight | one session current | open drawer | current row visually distinct | — |
| Reconnect with valid `?session_id=` | session in storage | restart gateway | tab reconnects, snapshot rehydrates same chat | session-ready + snapshot |
| Reconnect with stale `?session_id=` | session deleted via DB | restart gateway | falls back to new chat, sessionStorage cleared | WARN 404 fallback |
| Cross-profile guard | tab attempts forge | `evaluate_script` to send foreign sessionId | gateway rejects, console error | WARN forbidden |
| Cross-tab sync delete | two tabs same user | delete in tab A | tab B list updates within 1 s | broadcast |
| Cross-tab sync rename | two tabs same user | rename in tab A | tab B reflects | broadcast |
| Long title rename | row exists | rename to 250 chars | rejected at 200 char bound | WARN bound |
| Long preview | seed long first message | open drawer | row preview truncated with ellipsis | — |
| Pagination | 25 sessions (>page_size) | scroll list | page 2 loads | INFO list offset>0 |
| Hermes unreachable | gateway up, Hermes down | open drawer | error toast, last-good page retained | WARN HTTP unreachable |
| Concurrent switches | two rows clicked rapidly | rapid double-click | latest wins, mirror not torn | switch state machine |
| Empty session resumed | session with no messages | resume | empty snapshot lands, composer ready | snapshot size=0 |
| Send → switch → switch back | active cycle | switch mid-stream then back | no orphaned bubbles, no double-rendering | gen counter drops stale |

### Mobile matrix (390×844)

| Case | Action | Expected |
|---|---|---|
| Hamburger visible | open page | button tappable, ≥44 px |
| Drawer open | tap hamburger | ~85 % width, backdrop overlay |
| Backdrop close | tap outside | drawer closes |
| Tap targets | inspect every row | all ≥44 px tall |
| Drawer scroll independence | scroll list while chat scrolled | independent |
| Switch from drawer | tap row | drawer auto-closes after switch |

### Operator follow-up (out of agent scope)

- Real iOS Safari smoke (drawer, scroll, tap targets, audio quirks).
- Pi rebuild + healthy + log smoke (`docker compose ... build/up`,
  `docker compose ps`, log grep WARN/ERROR).

## Migration / rollout

- No DB migration on the gateway side. Hermes' state.db gets
  `source='sentient-user'` written by the patched adapter on new
  chains.
- Pre-existing chains carry whatever source the unpatched adapter
  wrote (the exact value is not load-bearing for v1 — confirm
  during implementation by inspecting an existing state.db row).
  Those rows won't appear in the filtered list — historical
  visibility loss accepted given current single-user-family scope.
- Optional bulk-update at deploy time, scoped to the discovered
  legacy source value:
  `UPDATE sessions SET source='sentient-user' WHERE source='<legacy>'`.
  Decide before merge whether to ship this remediation.
- Feature flag: none.
- `deploy/hermes-overlay/README.md` updated alongside the patch.
- `gateway/config.yaml` template updated. Operator config merged
  manually.

## Definition of done

- All KEEP tests pass (vitest + tsc + biome clean).
- Every smoke case in the matrix above is green on the Mac local
  stack — evidence (screenshots, console messages) captured.
- Pi push verified: rebuild + `docker compose ps` healthy + log grep
  shows no unexpected WARN / ERROR.
- `deploy/hermes-overlay/README.md` updated.
- `gateway/config.yaml` template updated.
- No new lint/typecheck regressions.
- Real iOS Safari smoke flagged for operator follow-up.

## Open questions resolved during brainstorm

- **Hermes capability**: confirmed via inspection of
  `nousresearch/hermes-agent:v2026.4.23` — SQLite-backed sessions,
  HTTP `/api/sessions[/search|/{id}|/{id}/messages]`, auto-titles,
  90-day retention, `parent_session_id` chain projection.
- **Reference for integration patterns**: `nesquena/hermes-webui`
  studied for HTTP integration patterns. NOT used for visual or
  interaction patterns — the sentient design language stays
  authoritative.
- **Pointer location**: `sessionStorage` (per-tab), not localStorage,
  to avoid cross-tab interference.
- **Switch-during-cycle semantics**: auto-cancel current cycle (Stop
  semantics), then switch.
- **Source filter**: `sentient-user` (with reserved space for
  `sentient-system`, `sentient-cron`).
- **Logical-thread row**: collapse via Hermes' default
  `project_compression_tips=True` — no TS-side chain walking.
