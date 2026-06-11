# Connection & Session Simplification — Design

- **Date:** 2026-06-10
- **Status:** Approved (brainstorming) → ready for implementation plan
- **Supersedes parts of:** `2026-06-09-ws-resilience-and-chat-mirror-design.md` (Slices 3 + 4)
- **Branch context:** continues `feature/ws-resilience-hardening`

## 1. Problem

Real-device use surfaced a cluster of failures the happy-path e2e missed:

1. **Stuck "Sending…" + invisible reply** after a long idle. The socket died, the
   client reconnected with a **lost session anchor**, the next message dispatched as a
   fresh chain, the gateway **gate-minted a new conversation** and replied there, and
   the client — still showing the old conversation — never reconciled.
2. **"+" does nothing** from a fresh chat (iOS): `.id(nil)→.id(nil)` is a no-op.
3. **"no messages"** on every history row (gateway never populates a count).

Root analysis showed the underlying model is **over-complicated**: two anchors that
drift (SDK `_currentSessionId` vs the SQLDelight mirror's intent), a durable client
mirror that strips the reconcile key, an invisible "gate-mint" path, a `flushed`
double-send guard band-aid, and resume logic that silently falls to a fresh mint when
an idle session's replay buffer is gone.

The conversation is **not** gone after idle — it lives in Hermes history, **re-openable
by id** (it is in the past-chat list). The fix is to simplify the whole connection +
session model around that fact.

## 2. Goals / Non-Goals

**Goals**
- One mental model for connect / reconnect / attach / create.
- A reconnect to an idle-dead session **always re-establishes by id** (= the past-chat
  open path), never silently mints a new conversation.
- The user **sees the latest history on return to the app**, before they interact.
- Delete more than we add (SQLDelight mirror, gate-mint, flushed-guard, client idle timer).
- Durable across every realistic transition: long fg idle, long bg idle, rapid front/back,
  OS kill, lost echo, send-during-reconnect.

**Non-Goals**
- Durable client-side chat persistence (history always comes from the gateway/Hermes).
- Offline composing beyond the in-memory outbox lifetime.
- Per-user resource caps beyond the existing retention eviction (see §11).

## 3. Architecture — four layers, one attach operation

```
Hermes WORKER (1/user) ─ ACP WIRE (1/user, ref-counted, MULTIPLEXES) ─ ACP SESSIONS (N concurrent)
                                                                          ▲
WS CONNECTION (1/device, N/user) ── PersonSession ── attaches ───────────┘
```

- **Hermes worker:** one process per user; owns all the user's conversations.
- **ACP wire:** one per user (`AcpWireRegistry`, ref-counted by attachments). The
  gateway↔worker transport. **Multiplexes N sessions** — it does NOT cap conversations.
- **ACP session = a conversation** (`sessionId` uuid). Many concurrent per user.
- **WS connection:** one per device; many per user (mobile + webui + cube).

**One operation attaches a client to a conversation: `conversation.activate(sessionId)`.**
The gateway picks the flavor (warm/cold, §6); the client has a single path. The *only*
operation that creates a new conversation is starting a new chat (§7).

## 4. Connection lifecycle — reconnect on presence

The client maintains exactly one WS. It (re)connects **on user presence/engagement**,
never on a background timer and never eagerly while the user is away (battery).

```
ensure-connected() fires on:
  PRIMARY (proactive):  app foreground / scene-active        (existing fg liveness probe)
                        chat screen appears
                        composer focus ("about to type")     ← covers foreground-idle-for-hours
  FALLBACK (reactive):  send → detect-on-send (half-open that dodged every hook)
  NEVER:                a timer, or while backgrounded/away

ensure-connected():
  live WS?  ── yes ──► use it
       └─ no / half-open ──► reconnect (SINGLE-FLIGHT) ──► activate(currentId) ──► warm replay OR cold REST refresh (§6)
```

- **Half-open detection:** foreground probe (3 s pong) + detect-on-send (a flushed
  message unacked within the outbox timeout, §8, ⇒ socket dead ⇒ reconnect).
- **Single-flight:** at most one reconnect in flight; rapid front/back cannot double-connect.
- **Reconnect on demand = demand is the user being present at the chat**, not a heartbeat.
  Foreground means the user is here, so reconnecting is exactly right and costs no idle battery.

## 5. History-refresh UX

- **Process alive (bg→fg, or fg-idle):** the **in-memory timeline still holds last-known**,
  so it renders instantly on return; the presence-reconnect then **refreshes** it — cold REST
  history from Hermes after a long idle, or a warm replay of missed frames if the gap was
  short (§6). Cache-then-refresh, in-memory only.
- **Process dead (OS kill / relaunch):** new empty chat (nothing to show), consistent with
  relaunch = new chat (§7).
- **Reconnect gap:** while reconnecting, show last-known timeline plus the existing
  connection banner ("reconnecting…"); never a blank screen, never a blocking spinner.
- **Multi-device:** since history is server-sourced, the REST refresh on attach naturally
  shows messages another device added while this one was away — no client merge logic.

## 6. Session attach — `activate(id)`, warm or cold

On reconnect READY with a `currentId`, the client **always** sends
`conversation.activate(currentId)`. The gateway decides:

- **Warm** — per-device replay buffer is live and the client's cursor is valid
  (within retention TTL, same device): replay the missed frames from `lastSeq`,
  deduped by the client cursor. In-flight cycle state (THINKING/speaking) is preserved.
- **Cold** — buffer evicted / different: gateway emits `session.switched`; the client
  **REST-refetches history** from Hermes (the existing `ConversationHistoryConnector`
  path). The conversation continues by id.

`enforceOwnership(id)` then `switchFlow.switchTo(id)` already re-opens any owned session
by id, evicted or not — so "reconnect-by-id" and "open past chat" are the **same call**.

## 7. New chat — the only mint

```
NEW CHAT (route nil): eager session.new on entry → gateway mints + broadcasts session.created
                      → outbox holds messages → flush when the id is attached (§8)
```

- The user can type and send immediately; the outbox decouples the UI from the id round-trip.
- **`gate-mint` (lazy, invisible mint on a fresh-chain message) is deleted.** It was the
  orphan source. The 500 ms `session.new` rate-limit already guards conversation spam.
- **Relaunch = new chat.** No persisted anchor; a cold start enters route nil.
- **iOS "+" fix:** the host's `chatIdentity` is `activeSessionId ?? "new-<nonce>"`, and the
  nonce bumps on every new-chat, so `.id()` rebuilds a fresh nil-route VM even when already
  on a new chat (the nil→nil no-op is gone). *(Already implemented.)*

## 8. Sending — outbox + promoted `pendingId`

```
send → enqueue "sending" → flush when (WS ready AND id attached) → wire text.input(pendingId, text)
```

- The **flush gate is `(WS ready) AND (this chat's id is attached)`** — not WS-ready alone.
  This is the core bug fix: it prevents a message flushing before the conversation is
  re-established (which caused the fresh-mint orphan).
- **`pendingId` = client message id = reconcile key + server idempotency key.**
  - *Reconcile (client, already works):* the gateway echoes `pendingId` on the committed
    user entry; the client drops the matching optimistic bubble (handles identical text).
  - *Idempotency (server, new):* the gateway dedups in `handleTextInput` — a `text.input`
    whose `pendingId` was already processed for this session is **re-echoed but NOT
    re-dispatched**. The dedup window is bounded (per active session, recent ids).
- **The `flushed` double-send guard is deleted.** With server dedup, the client resends
  unacked messages freely on reconnect — a re-send can never create a duplicate.
- **Outbox unacked-timeout** (config, §10): a flushed "sending" message with no echo within
  the window ⇒ trigger `ensure-connected` + resend; if still offline after reconnect ⇒ mark
  **FAILED + Retry**. One timer doing double duty (half-open detect + resend + surface).
- Outbox states: `QUEUED → (flushed, internal) → removed on echo | FAILED → retry`. No `SENT`.

## 9. Storage — none durable

- **Delete the SQLDelight mirror** (`CachingConversationRepository`, `ChatDatabase`,
  `DatabaseDriverFactory`, durable `SyncCursorStore`/`ResumeCursorPersistence` backing).
  This also **deletes the `pendingId`-strip bug at the root** — there is no DB mapper to
  strip the reconcile key.
- **Live timeline = in-memory from WS frames.** History on attach = from gateway/Hermes.
- The client keeps only **`lastSeq` + `epoch`** (the in-memory `ResumeCursor`) as the warm-
  replay resync point. The gateway owns the frame buffer.

## 10. Timers — final set

| Timer | Value | Keep / Change |
|---|---|---|
| Gateway WS idle-close | 255 s | keep |
| Retention TTL (PersonSession + replay buffer) | 30 min | keep |
| Foreground liveness probe | 3 s pong | keep |
| Stuck-state watchdog | 8 s | keep |
| Reconnect backoff | 1→30 s, ±500 ms, maxAttempts 5 | keep (now demand-triggered) |
| `session.new` min interval | 500 ms | keep |
| **Client 60-min idle-disconnect** | — | **DELETE** (gateway owns idle; reconnect is on-demand) |
| **Gate-mint backstop** | 5 s | **DELETE** (gate-mint gone) |
| **Outbox unacked-timeout** | new, config (default 10 s, range 3–30 s) | **ADD** |

## 11. Caps

- **Delete the per-user-pool idea.** Retention eviction (30 min) already kills the ACP
  sessions that hold memory, so live per-user memory is self-bounding.
- Bump the global `max_sessions` **10 → 100** (a dumb ceiling; 10 breaks a single user
  spanning mobile + webui + cube).
- The ACP wire pool is already bounded (1/user, ref-counted) and multiplexes sessions — no
  change.

## 12. Deletions summary

| Deleted | Why |
|---|---|
| SQLDelight durable mirror (Slice 4) | over-complex; source of the `pendingId`-strip bug |
| `gate-mint` lazy invisible mint | orphan source; rate-limit + eager `session.new` replace it |
| Outbox `flushed` double-send guard | server `pendingId` dedup makes resend always safe |
| Client 60-min idle-disconnect timer | gateway owns idle; reconnect is on-demand |
| `messageCountLabel` + history count suffix | gateway never populates a count *(already done)* |

## 13. Change set by layer

| Layer | Change |
|---|---|
| **gateway** | dedup `text.input` by `pendingId` in `handleTextInput`; delete the gate-mint path (`mint-and-announce` fresh-chain branch in `ws-session-configure`); `max_sessions` → 100 (config); confirm `activate(id)` re-open (already works) |
| **mobile-sdk** | reconnect-on-presence (drop idle auto-reconnect + 60-min timer); add composer-focus / screen-appear engagement hooks; single-flight reconnect guard; always `activate(currentId)` on reconnect READY; keep in-memory `ResumeCursor` |
| **mobile-data** | delete SQLDelight mirror; in-memory timeline only; flush gate = ready **AND** id-attached; delete `flushed` guard; outbox unacked-timeout |
| **iOS / Android** | "+" fix (iOS done); re-anchor logic simplifies once the mirror is gone; history label fix (done); wire engagement hooks (composer focus, screen appear) |
| **protocol / config** | `min_new_interval_ms` (exists); add `outbox_unacked_timeout_ms`; `max_sessions` → 100 |

## 14. Error handling

- **Hermes session truly expired** (owned session that Hermes has dropped, so `activate(id)`
  cannot re-open): the gateway returns an ownership/not-found failure. The client falls back
  to **mint a fresh conversation** and surfaces a one-line notice ("Couldn't reopen that chat
  — started a new one."). This is the *only* legitimate fresh-mint-on-reconnect case.
- **Reconnect exhausts maxAttempts:** stop, stay disconnected; the next engagement signal
  retries (on-demand model). The connection banner reflects the state.
- **`activate` for a session the user does not own:** `forbidden` → drop the anchor; do not
  re-fire. (Existing `onSessionForbidden`.)
- Adapter `start()` never throws on transient dependency failure (error-handling rule).

## 15. Testing strategy

Per the testing rules — defensive tests only (wire/protocol contract, FSM/invariant,
security boundary). Specifically:

- **Wire contract (gateway):** `text.input` dedup by `pendingId` — second identical
  `pendingId` re-echoes, does not re-dispatch a cycle.
- **FSM (mobile-sdk):** `ensure-connected` triggers (presence vs send); single-flight
  reconnect; `decideOnReady` always activates on reconnect-with-anchor (no resume cursor
  needed for the activate path).
- **FSM (mobile-data):** flush gate requires id-attached; outbox `QUEUED→flushed→removed|FAILED`
  with no `SENT`, no `flushed`-guard resurrection; reconcile by live echo.
- Delete the SQLDelight mirror tests with the mirror.

## 16. End-to-end durability matrix (inline)

Driver: Maestro against the local Docker stack (`deploy/macos/`), Android + iOS.
Fault arming: socket-kill / idle simulation via the debug fault channel (Android `adb`
broadcast; iOS flagged where no arming channel exists).

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| long-fg-idle-return | mobile | chat Y, socket idle-dead | return focus to app | history refreshes before any send; no stuck send | screen-appear/focus → reconnect → `activate(Y)` → warm or cold REST |
| long-bg-idle-return | mobile | chat Y, backgrounded hours | foreground | history refreshes on arrival | fg probe → dead → reconnect → `activate(Y)` |
| fg-idle-tap-composer | mobile | chat Y, fg-idle, socket dead | tap composer | history refreshes on focus, then type+send works | composer-focus → ensure-connected → activate |
| rapid-front-back | mobile | chat Y | background/foreground ×5 fast | stable, no flicker, no dup connects | single-flight; ≤1 reconnect per real wake |
| os-kill-relaunch | mobile | chat Y | kill app, relaunch | new empty chat | cold start route nil; no stale anchor |
| lost-echo | mobile | chat Y, send, drop socket pre-echo | reconnect | exactly one bubble, no dup, reply renders | warm replay redelivers OR resend → gateway `pendingId` dedup |
| send-during-reconnect | mobile | chat Y, socket reconnecting | send | "sending" → sends once attached | flush gated on id-attached |
| new-chat-plus-fresh | mobile (iOS) | on a fresh/gate-minted chat | tap "+" | new empty chat opens | fresh nil-route VM rebuild |
| new-chat-send-reply | mobile | new chat | send first msg | reply renders, one bubble | eager `session.new` → `session.created` → outbox flush → echo reconciles |
| hermes-expired-reopen | mobile | chat Y, Hermes dropped Y | return + send | new chat + "couldn't reopen" notice | `activate(Y)` fails → fresh mint + notice |

No case is skipped; iOS fault-arming gaps (socket-kill without a debug channel) are flagged
for follow-up per the iOS testing rule, not silently dropped.

## 17. Risks / open items

- **Gateway dedup window sizing:** must cover a realistic reconnect gap without unbounded
  memory. Bound it per active session (recent `pendingId` set, evicted with the session).
- **iOS fault arming:** no `adb`-broadcast equivalent; some socket-kill cases need an in-app
  debug arming affordance or XCUITest. Flagged, not blocking.
- **Mirror deletion blast radius:** removing SQLDelight touches DI wiring + tests across
  `mobile-data`; the implementation plan sequences it after the gateway + SDK changes so the
  app stays buildable between steps.

## 18. Rollout

- Gateway changes are backward compatible (`pendingId` already optional on the wire; dedup is
  additive; gate-mint removal changes only an internal path).
- Mobile: delete SQLDelight (DB removal, no migration — non-durable), bump client versions.
- Sequence: **gateway (dedup + delete gate-mint + cap) → mobile-sdk (reconnect model) →
  mobile-data (delete mirror + flush gate) → iOS/Android wiring → e2e matrix.** Each step
  leaves the build green.
