# WS Resilience Hardening + Client Chat Mirror — Design

**Date:** 2026-06-09
**Branch:** `feature/ws-resilience-hardening`
**Status:** Design — pending implementation plan

## 1. Context & Problem

Investigation of a prod (Pi) run — user "Kevin", session `s-mq69c6ug-lbbtf5a7`,
cycle-2, 2026-06-08 23:30 ("Removing Bitcoin for World News") — plus a code/log audit
surfaced five issues. Evidence is in the gateway logs and cited file:line refs below.

| # | Issue | Root cause |
|---|-------|------------|
| 1 | Intermediate narration not shown live as its own bubble | gateway merges Hermes micro-turns into one entry (`hermes-event-translator.ts:289-301`) — **parked in `todo.md`** |
| 2 | Blocky text (no typewriter) | Hermes emits one complete block per micro-turn; gateway already passthrough — **parked in `todo.md`** (Hermes-side) |
| 3 | Forced full history reload after ~2 min background | Bun `idleTimeout` default 120s never overridden (`server.ts:167`); reconnect = full `session.switch` snapshot, no delta resume |
| 4 | Backgrounding mid-response loses output/audio | on disconnect the gateway neither aborts nor buffers; in-flight frames written to a dead socket and lost (`ws-handlers.ts:220-292`) |
| 5 | Stuck "thinking/speaking" + dead Stop button | client UI state only clears on server end-frames that never arrive after silent socket death; `interrupt()` sends to a possibly-null transport and never clears local state (`SentientSdk.kt:257-264`) |

**This spec covers #3, #4, #5.** #1 and #2 are parked in `todo.md` (they share the
stable-`entryId` introduced here and should follow this work).

### Scope

- **In scope:** gateway resumable sequenced WS stream + replay buffer; client resume
  protocol; client persistent chat mirror (SQLDelight); client fire-and-forget Stop +
  stuck-state recovery.
- **Non-goals (parked):** live narration un-merge (`todo.md` #1); ACP token-level
  streaming (`todo.md` #2, Hermes-side); Pi/prod deploy (separate explicit approval);
  any change to Hermes-side session retention.

## 2. The keystone

The gateway's outbound conversation stream has **no stable per-entry id and no sequence
number** today (client keys on `ts`, which collides and can be `0` —
`ConversationFeedItem.kt:16,37`). Adding two identifiers fixes every issue in scope:

- **`seq`** — a monotonic sequence stamped on *every* outbound application frame,
  per device-session. Doubles as the **resume cursor** (replay from `lastSeq+1`) and the
  client mirror's ordering key.
- **`entryId`** — a stable, gateway-minted id on each committed `conversation.entry`.
  The mirror's **upsert key** (replaces blind full-replace).

One mechanism — a **resumable sequenced WS stream, mirrored to device** — then covers
transport resilience (#3/#4) and fast/durable loading.

### Prior art (researched; build-not-buy)

No drop-in library survives our constraints (pinned raw WS over Bun, Pi, KMP). We copy
proven *designs*:

- **Server resume protocol:** Centrifuge's `{offset, epoch, recovered}` triplet +
  socket.io Connection-State-Recovery's "seed the cursor with one frame" + MQTT
  persistent-session expiry timer. Buffer = in-memory ring (not Redis; `epoch` already
  handles gateway-restart correctly via snapshot).
- **Client mirror sync:** ElectricSQL's shape-log protocol (`offset` / `up-to-date` /
  `must-refetch`) over SQLDelight. CRDTs unnecessary — single-writer (gateway) →
  read-only device mirrors.

## 3. Architecture overview

```
Hermes ──ACP──> Gateway ──── sequenced WS frames (seq, epoch) ────> Client SDK
                  │                                                    │
                  │  per device-session ring buffer                    │  write-through
                  │  {seq, frame}, 16MB cap, 30min TTL                  ▼
                  │  (survives short disconnect)                  SQLDelight mirror
                  │                                               (keyed by entryId)
                  └── on reconnect: client sends {epoch, lastSeq}       │
                      ├─ in-window  → replay seq>lastSeq (recovered)    │  cache-then-refresh
                      └─ too old / epoch mismatch → recovered:false ────┘  → REST history refetch
```

Single-writer authority: the gateway is the only writer; the device mirror is a
read-only cache. Idempotent upsert-by-`entryId` makes replay/live overlap harmless.

### 3.1 Transport boundary (governing principle)

**WebSocket is exclusively for the live chat session that must sync in real time;
everything else is REST.** Standing architectural rule, not just for this work:

- **WebSocket (real-time, resumable, buffered):** the live conversation session — mic
  audio in, TTS audio out, `cycle.*`, `message.delta` / `message.done`,
  `cognition.status`, `task.status` — plus the resume handshake. *Everything on the WS
  push channel is seq-stamped and replay-buffered.* A lightweight WS
  `conversation.activate` control tells the gateway which conversation's live stream +
  replay buffer this connection is focused on (carries no history payload).
- **REST (client-driven, stateless, never buffered):** session list, conversation
  history (paginated `getMessages`), search, preferences/settings, rename, delete,
  devices. Client re-issues on demand; no resume/buffer semantics.

**Migration (part of this work):** these are WS request/response RPCs today
(`SessionsConnector.list`, `session.switch`→`conversation.snapshot`, preferences) — they
move to client-facing gateway REST routes. The gateway already has this data over REST
via the Hermes dashboard sidecar (`/api/plugins/sentient-plugin/`), so the routes are
thin passthroughs; auth reuses the existing PASETO / shared-token model. The KMP + web
SDKs gain a REST client path (Ktor already present). After migration the WS message
schema no longer carries query RPCs → the replay-buffer rule becomes trivially "buffer
everything on the push channel."

Consequences threaded into the components below: resume `recovered:false` → **REST-refetch
history** (not a WS snapshot); the mirror's cache-then-refresh loads history via **REST**
while live entries arrive via **WS**; smart-async deletion diffs against the **REST**
session list.

## 4. Component 1 — Gateway resumable stream

| ID | Change | Where |
|----|--------|-------|
| G1 | Stamp monotonic `seq` on every outbound app frame. Binary audio (today untagged) carries `seq` in an **8-byte big-endian header + 1 type byte** prepended to the payload, so JSON, text, and audio all sequence uniformly. | `audio-frame-sender.ts`, the WS send path (`device-attachment.ts:58`, `ws-session-configure.ts:128`) |
| G2 | Per device-session `epoch` (process/boot id). Sent at connect and on the first frame. | session configure |
| G3 | Per device-session **in-memory ring buffer** `{seq, frame}`. Bounded by **16 MB** hard cap (evict-oldest) AND the retention TTL. **Audio coalesced to ~1s segments** before buffering to bound object count (see §9 footgun). Keyed by stable **device id** (per-device-session, not shared across a user's devices). | new `SessionReplayBuffer` on the device-session / PersonSession |
| G4 | On disconnect: **keep the in-flight cycle running and journal its frames** into the buffer (fixes #4). Cycle abort stays the explicit interrupt path only. | `ws-handlers.ts:cleanupSession` |
| G5 | **Resume handshake:** client reconnects sending `{epoch, lastSeq, deviceId}`. Gateway: `epoch` matches **and** `lastSeq ≥ oldest buffered seq` → replay frames `> lastSeq`, then go live, reply `recovered:true`. Else → reply `recovered:false`; client **REST-refetches** the conversation history (§3.1, Component 4). Additive — low risk. | new resume handler |
| G6 | Stable `entryId` on each committed `conversation.entry`. | `hermes-event-translator.ts:289-301`, `hermes-message-to-mirror.ts` |
| G7 | WS `idleTimeout` → 255s (Bun max). New app-level **session + buffer retention TTL → 30 min** (currently no eviction at all; PersonSession never freed — `ws-handlers.ts:278`). After 30 min zero-attachment → evict session + free buffer. | `server.ts:167`; new retention timer on the registry |

**Why two timers (correcting the original premise):** Bun caps `idleTimeout` at 255s, so
the *socket* cannot be kept alive for 30 min. Instead the socket dies at ≤255s when
backgrounded, but the **app-level session+buffer survives 30 min** — reconnect within
that window resumes cheaply; beyond it falls back to a REST history refetch.

**Backward compatibility:** gate the binary header + resume behind a `stream.resume`
capability advertised at session configure. Clients that don't advertise it get the
current untagged-binary + full-snapshot behavior. Protects older clients and the
not-yet-live ESP32 cube; lets web/mobile opt in independently.

### Memory math (worked)

TTS = Opus @ 32 kbps (`config.yaml:139`) = **4 KB/s**; text/control negligible.
Worst case = continuous speech for the whole window.

| Window | Audio data/session | Per-session (coalesced) |
|--------|--------------------|--------------------------|
| 30 min | 7.0 MB | ~7.1 MB |

16 MB cap = ~66 min of continuous audio → the 30-min TTL always frees the buffer before
the cap bites (pure safety headroom). Worst-of-worst: 5 users × 3 device-sessions ×
16 MB = **240 MB** (Pi 5: 3–6% RAM). Realistic (2–3 users, ~1 audio stream each):
single-digit MB.

## 5. Component 2 — Protocol changes (`shared/protocol`)

- Frame envelope gains `seq: number` and `epoch: string` (`messages.ts`).
- Live `conversation.entry` (WS) **and** the REST history payload both carry
  `entryId: string` (`messages.ts:210`) — the mirror upsert key, same on both paths.
- Binary frame header spec: `[8-byte BE seq][1-byte type][payload]`.
- New frames: `resume` (client→gateway: `{epoch, lastSeq, deviceId}`) and `resume.result`
  (gateway→client: `{recovered: boolean, fromSeq?, toSeq?}`).
- `session.switch`→`conversation.snapshot` is **replaced** by a lightweight WS
  `conversation.activate` (focus the live stream + replay buffer; **no** history payload).
  Session list, history, search, and preferences **leave the WS schema entirely** → REST
  (§3.1).
- `stream.resume` added to the capability list.

All three SDKs (web `shared/web-sdk`, mobile `shared/mobile-sdk`, and the gateway sender)
update in lockstep behind the capability flag.

## 6. Component 3 — Client resume (`shared/mobile-sdk` + `shared/web-sdk`)

- Parse `seq` off every frame (JSON + binary header); track `{epoch, lastSeq}` per
  conversation, persisted (cursor).
- On reconnect / foreground probe failure (`SentientSdk.kt:398-420`): send `resume`
  with the persisted cursor instead of unconditionally re-issuing `session.switch`.
- `recovered:true` → apply replayed frames in seq order, continue live.
- `recovered:false` → drop the conversation's local rows, **REST-refetch history**
  (replaces the `onReadyReached` `session.switch` snapshot — `SentientSdk.kt:475-490`),
  reset cursor.
- Idempotent: applying a replayed frame whose `entryId` already exists is a no-op upsert.

## 7. Component 4 — Client chat mirror (SQLDelight)

**Storage:** SQLDelight (KMP; greenfield — no storage lib today). Cursor in
multiplatform-settings / Preferences DataStore.

**Schema (sketch):**
```sql
sessions(id TEXT PRIMARY KEY, title TEXT, updated_at INTEGER);
messages(entry_id TEXT PRIMARY KEY, conversation_id TEXT, seq INTEGER,
         role TEXT, content TEXT, ts INTEGER, cutoff_kind TEXT);
-- index (conversation_id, seq) for ordered paging
sync_cursor(conversation_id TEXT PRIMARY KEY, epoch TEXT, last_seq INTEGER);
```

- **Write-through (eager — anti-staleness):** every live `conversation.entry` frame
  `UPSERT … ON CONFLICT(entry_id) DO UPDATE` immediately; reactive
  `asFlow().mapToList()` repaints. The live frame *is* the write → mirror never lags.
- **Cache-then-refresh:** on conversation-open / foreground, `SELECT … ORDER BY seq`
  paints instantly (local, no network). Reconcile = **REST** history fetch (paginated)
  upserted by `entryId`; live updates then arrive over **WS** (resume delta) and upsert
  too. Kills the history spinner (`ChatModel.historyLoading`); speeds past-chat loading.
- **Audio is NOT persisted** — replayed transiently via the gateway ring buffer, never
  stored on device. Bounds the mirror to text → ~10–20 MB for a heavy 90-day user.

**Placement & rule exception:** the mirror is a stateful cache, which the
`mobile-data/repositories.md` "stateless repository" rule forbids. We carve a deliberate
exception: a dedicated cache component behind the **existing** `ConversationRepository` /
`SessionsRepository` interfaces, wired in `ChatComponent`. ViewModels/usecases are
unchanged. Update `repositories.md` to document the exception.

### Smart-async deletion (server-list-authoritative)

- The gateway session list is the source of truth for what exists. On list refresh, diff
  it against the local `sessions` table.
- Sessions **local-but-absent-from-server** = Hermes pruned them → **background-delete
  locally** (cascade `messages`), off the UI thread, low priority.
- **Do not hardcode Hermes' retention (≈90 days, unverified — see §11) on the client.**
  Drive deletion off server *absence* so client/server never drift and Hermes can change
  retention without a client update.
- **Pagination guard (critical):** the REST list endpoint (migrated from
  `SessionsConnector.list`, today `limit=100, offset=0`) paginates. Deletion-by-absence is
  only safe against a **full** fetch.
  The reconcile pass must paginate the full session-id set (ids + `updated_at` only) and
  only delete a local session absent from that complete set. Never delete from a partial
  page. Guard the active / just-created conversation.
- **Defense-in-depth cap:** retain at most last N sessions / X MB locally as a backstop.

## 8. Component 5 — Client unstuck safety (#5)

- **Fire-and-forget Stop:** `interrupt()` clears local UI state immediately (cognition→idle
  via the connector, `isSpeaking→false`, stop audio playback) **and** best-effort fires the
  interrupt frame. Never gates on server ack. `noteInterrupt` pre-classifies a late
  `cycle.aborted` as self-initiated so it is ignored.
- **Connection-driven stuck recovery (A1 — chosen 2026-06-09):** the recovery trigger is
  **transport liveness, NOT content-frame silence.** A healthy slow cycle can legitimately
  produce 30s+ gaps between frames (tool calls — confirmed in the prod logs: `cycle-gap`
  WARNs to 38s during a single `memory` tool call), so a content-frame timer would
  false-reset live cycles. Instead a watchdog arms **only when a cycle is active
  (`cognition != IDLE || isSpeaking`) AND the connection is not READY** (socket dropped →
  RECONNECTING/DISCONNECTED); on timeout (grace = `stuckStateTimeoutMs`) it resets to idle.
  Additionally, a reconnect-after-drop resets the orphaned cycle indicator in
  `onReadyReached` (pre-resume the prior cycle did not survive; **Slice 3 makes this
  resume-aware** — only reset on `recovered:false`). All resets go through a shared
  `clearActiveToIdle()` that also calls `CognitionStatusConnector.reset()`, so the
  connector's internal `currentState` never drifts from the deriver (otherwise the next
  `cycle.started` short-circuits on the stale THINKING value and the cycle shows no
  thinking indicator + no watchdog).
- Independent of the resume/mirror work — can ship first.

## 9. Risks & footguns

- **Audio object-count footgun:** buffering raw ~20 ms Opus frames (50/s) makes per-frame
  JS-object overhead dominate (~13 MB overhead @30 min). **Mitigation:** coalesce audio
  into ~1 s segments (or one growing contiguous buffer per cycle with seq markers) before
  buffering. Measure actual Fish/OGG frame cadence during impl.
- **Binary-header lockstep:** changing binary framing breaks current parsing on both
  ends; the `stream.resume` capability gate makes the change opt-in and protects
  older clients / the cube.
- **Device identity:** per-device-session buffers need a stable device id across
  reconnects. Reuse the existing device-identity concept (device ≠ PersonSession); the
  SDK generates + persists one if absent.
- **Cursor atomicity:** advance `last_seq` only on a completed, acknowledged resume/sync
  batch — never partial-apply, to avoid a torn cursor.

## 10. Config additions (`gateway/config.yaml`)

```yaml
session:
  ws_idle_timeout_ms: 255000        # 255s — Bun WS socket idle close. Bun's idleTimeout takes SECONDS, cap 255; gateway converts ms→s.
  retention_ttl_ms: 1800000         # 30 min — session + replay buffer survive disconnect this long
  replay_buffer_max_bytes: 16777216 # 16 MB per device-session ring cap (evict-oldest)
  replay_audio_coalesce_ms: 1000    # coalesce audio into ~1s segments before buffering
client_stuck_state_timeout_ms: 8000 # (SDK config) grace before resetting cognition/isSpeaking→idle when a cycle is active AND the connection is not READY (socket dropped/reconnecting/lost). NOT a content-frame timer.
```

## 11. Open items to verify during implementation

- **Hermes session retention period** — not in this repo (Hermes-side runtime). Verify
  the actual value; the client design intentionally does not depend on it.
- **Actual audio wire-frame cadence** — measure to size the coalescing correctly.
- **Device-id source** — confirm/define the stable per-device identifier.

## 12. Build order (one spec, three shippable slices)

1. **Unstuck safety (#5 / Component 5)** — SDK-only, independent, highest immediate
   relief. Can merge alone.
2. **Transport migration (§3.1)** — move session list / history / search / preferences /
   rename / delete to gateway REST routes + a REST path in the SDKs; drop the WS query
   RPCs (`session.switch` → `conversation.activate`). Prereq for a clean buffer rule.
3. **Gateway resumable WS layer (Component 1) + protocol (Component 2) + client resume
   (Component 3)** — cheap delta reconnect; no DB yet.
4. **Device mirror (Component 4)** — instant paint, fast loading, durable resume.

## 13. E2E test matrix (inline — required)

Driver per `.claude/rules/e2e-testing.md`: native mobile = **Maestro** (`adb` /
`xcrun simctl`); web = **Playwright MCP** (desktop 1280×900 + mobile 390×844). Smoke
against the local Docker stack (`deploy/macos/`), never mocks. New reusable cases below
to be added to `agents/docs/testing-knowledge.md`.

| Case | Viewport / Driver | Pre-state | Action | Expected user-visible | Expected log trail |
|------|-------------------|-----------|--------|------------------------|--------------------|
| resume-within-window | Maestro iOS | active chat, cursor saved, `stream.resume` on | background 1 min, foreground | transcript stays; NO history spinner; no reload fl. | `resume` recv; `recovered=true`; replay N frames |
| resume-beyond-window | Maestro iOS | active chat | background >30 min, foreground | brief graceful history reload | `recovered=false`; REST history refetch |
| background-mid-response-text | Maestro Android | assistant mid-cycle (text) | background during cycle, foreground after done | full response present, no loss | cycle ran to completion; frames journaled; replayed on resume |
| background-mid-speech-audio | Maestro iOS (voice) | assistant speaking | background mid-audio, foreground | missed audio replayed (client may skip if superseded) | audio frames buffered + replayed by seq |
| fire-forget-stop-dead-socket | Maestro iOS | stuck "speaking"/"thinking" after silent socket death | tap Stop | UI clears to idle immediately, no hang | local stop; no server-ack gate; late `cycle.aborted` ignored |
| stuck-state-conn-reset | Maestro Android | thinking/speaking, socket dropped (status ≠ READY), no reconnect | wait `client_stuck_state_timeout_ms` | state auto-returns to idle | watchdog armed on conn≠READY; `stuck-state.reset` logged |
| slow-cycle-no-false-reset | Maestro iOS | healthy long cycle (status READY) with a 30s+ tool gap | observe through the gap | thinking persists; NO reset; response arrives | no `stuck-state.reset`; watchdog never armed while READY |
| instant-paint-past-chat | Maestro iOS | conversation previously cached | open it from drawer | transcript paints instantly, then reconciles | local read; then REST history reconcile |
| query-not-buffered | Maestro iOS | active live chat (cycle running) | fetch session list / open settings | list/settings load over REST; live stream untouched | REST request; no `seq` stamped; replay buffer size unchanged |
| history-rest-live-ws | Maestro Android | conversation open, reply streaming | scroll to load older history mid-reply | older history loads (REST), live reply continues (WS), no dup | REST `getMessages` paginated; WS `message.delta`; upsert by `entryId` |
| smart-async-deletion | Maestro Android | local has sessions Hermes pruned | refresh session list (full fetch) | pruned sessions vanish from drawer | reconcile diff; background-delete N sessions |
| concurrent-devices | web (Playwright desktop) + Maestro iOS, same user | both attached | one backgrounds, other active | each resumes its own stream independently | per-device-session seq/buffer; no cross-talk |
| reconnect-flap | Maestro iOS | rapid background/foreground | repeat | no full reloads; no duplicate messages | `recovered=true` each; no dup `entryId` |
| web-reconnect-parity | Playwright desktop 1280×900 + mobile 390×844 | active web chat | network blip / tab background | resume, no full reload | web SDK resume handshake; `recovered=true` |
| epoch-mismatch-restart | Maestro iOS | gateway restarts (new epoch) | reconnect | history re-fetched, no stale/dup | `epoch` mismatch → `recovered=false` → REST refetch |

**Flagged for follow-up (driver limits):** true iOS OS-suspension socket-kill timing may
need a real device; simulate via forced disconnect in Maestro. Paid-TTS audio cases use
the free voice path only where possible per the e2e rule.

**Pre-handover gate:** every case green; evidence captured under the QA dir; lint +
typecheck + unit tests clean; deployable artifact built. Local macOS stack smoke before
any Pi consideration (separate approval).

## 14. Docs & versioning (part of the work)

### Doc updates
- **WS wire contract (`shared/protocol`)** — document the new envelope fields (`seq`,
  `epoch`), `entryId` on conversation entries, the binary frame header
  `[8B BE seq][1B type][payload]`, the `resume` / `resume.result` frames,
  `conversation.activate`, and the `stream.resume` capability. Authoritative gateway↔SDK
  contract; keep in lockstep with `messages.ts`.
- **REST query API + transport boundary (§3.1)** — document the new client-facing gateway
  REST routes (session list, history, search, preferences, rename, delete) and the
  WS-vs-REST rule (WS = live chat session only; everything else REST) in
  `gateway/README.md` and the SDK READMEs. This boundary is a standing convention for
  future endpoints.
- **`gateway/README.md`** — resumable stream, replay buffer + retention TTL, the
  two-timer model (255s socket vs 30-min session TTL).
- **`shared/mobile-sdk/README.md`** — resume handshake, device-session cursor, persistent
  chat mirror, fire-and-forget Stop + stuck-state timeout.
- **`shared/web-sdk/README.md`** — resume parity.
- **`android/README.md`, `ios/README.md`** — local mirror/persistence (SQLDelight),
  smart-async deletion, version note.
- **Rules / details:** update `.claude/rules/mobile-data/repositories.md` for the
  stateful-mirror exception; add a learning to `agents/docs/learnings.md` (resume
  protocol + audio-coalescing footgun); add the new reusable e2e cases (§13) to
  `agents/docs/testing-knowledge.md`.
- **Not touched:** `capabilityServices/STTService/CONTRACT.md` — STT mic-input wire is
  unaffected by TTS-output framing.

### Version bumps (+0.1.0)
| Artifact | Current | Target | Where |
|----------|---------|--------|-------|
| Gateway | 1.10.0 | **1.11.0** | `gateway/package.json:3` (+ root `package.json` if mirrored) |
| Android app | 0.0.1 (code 1) | **0.1.0 (code 2)** | `android/build.gradle.kts:27` |
| iOS app | 0.0.1 | **0.1.0** | `MARKETING_VERSION` — verify location (`project.pbxproj` / Info.plist) |
| Mobile shared src (KMP) | none today | **set to 0.1.0** (add a version declaration) | `shared/mobile-sdk/build.gradle.kts`, `shared/mobile-data/build.gradle.kts` |

Bump at the end of the work, once the deployable artifact is green.
