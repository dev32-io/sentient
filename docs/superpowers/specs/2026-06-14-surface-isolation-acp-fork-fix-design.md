# Surface-Isolation ACP Wire Model + Fork-Fix — Design Spec

- **Date:** 2026-06-14
- **Status:** Approved (brainstorming) → ready for implementation plan
- **Branch (planned):** `feature/acp-wire-surface-isolation`
- **Scope:** Gateway ACP wire pool + resume/attachment keying; `surfaceId` protocol field; web + mobile client id derivation. One combined change.

---

> **Addendum (2026-06-14, post-implementation — overlay co-fix):** §4's premise
> that `acp_ws_server.py` already "spawns a fresh Hermes child **per
> connection** (already its behavior)" was **incomplete**. The overlay also
> enforced ONE WS per profile, closing any prior connection (`active_ws` +
> `prior.close()`). So opening a second overlay connection — a second surface,
> OR the drawer's ephemeral `rest-list:<userId>` session-list wire
> (`server.ts` → `listSessionsForUser` → `listSessionsViaAcp`) — **kicked the
> first**. That kick, not a reconnect, is the proven root cause of the iOS
> "stuck at sending" bug: a fresh-session `session.new` was in flight on the
> surface wire when the drawer's rest-list dial closed it →
> `reject-inflight: acp-wire-flap` → `mint-session.failed` → no id → stuck.
> **Fix (commit `2c2ab1b`):** the overlay is now a dumb per-connection
> transport — the single-connection kill is removed; the gateway owns all
> pooling + gating; concurrent children per profile coexist (`state.db` is
> WAL-mode → concurrent-safe). The per-surface design below stands unchanged —
> the overlay constraint was the missing enabler, not a contradiction.

---

## 1. Problem

Mobile users see **duplicate / forked chat sessions** ("#2"-suffixed titles, full-history copies). Confirmed root cause, end-to-end from logs + Hermes' own store.

### Trigger (reproduced from 2026-06-13/14 logs)

A single iOS device, mid long cycle (web search), backgrounds + foregrounds repeatedly → a reconnect storm. During those windows Hermes **mints new timestamp-named sessions seeded with the loaded history** (full-copy forks) instead of appending to the real conversation.

### Evidence

- Hermes store (`~/.sentient/gateway/data/u_<id>/profiles/<id>/sessions/`):
  - Real conversation `session_dfddf397-…json` (`session_start=2026-06-13T23:52:28.282297`).
  - Fork `session_20260614_000829_2ef209.json` — **copied that exact `session_start` verbatim**, first user msg identical, last user msg = the live message. A duplicate, not a new chat.
  - A cascade of six timestamp-forks in the 19:42–19:52 window (a prior reconnect storm).
- Gateway log signatures at each fork window: `updateConversationId.unknown-session reason="session not bound"`, `conversationIdChanged=true`, repeated `client-disconnected` / `resume.reanchor` mid-cycle.

### Two distinct failure modes (previously conflated)

1. **Cross-surface contention.** All of a user's WS sessions/tabs/devices share **one** ACP wire (`AcpWireRegistry` keyed by `userId`, `acp-wire-registry.ts:67`) → one Hermes child with a single `inflight`/`nextRequestId` slot (`per-profile-connection.ts:94-95`). Concurrent cycles cross-wire → fork. **Design gap.**
2. **Within-surface reconnect overlap.** One surface backgrounds mid-cycle; the user cycle + an **internal "save-skill" dispatch** + reconnect anchor-churn interleave on the shared wire; the post-cycle `updateConversationId` drops because the originating transport was released → next dispatch resolves a stale anchor → Hermes forks. **This is what hit production last night** (single device).

### Why the gateway looked innocent

`acp-hermes-client.ts:174` **synthesizes** the `created` event from the id it *sent* (the forced id), never reading Hermes' actual session id. The gateway is structurally **blind** to a Hermes-side fork — it always reports the forced id.

---

## 2. Goals / Non-goals

**Goals**
- Each chat **surface** (mobile app instance, web browser tab) is a fully **isolated** session — chat / create / reconnect continuously, no cross-surface interference.
- Eliminate accidental forks (both failure modes).
- Preserve the wire pool's original purpose: **fast warm-up + fast reconnect**.
- Keep concurrency a *simplification* (isolation by construction), not added gates.

**Non-goals**
- Real-time cross-device continuation of one conversation (live "continue on another platform what you just typed"). Out of scope by design.
- Preventing forks when the user **deliberately opens the same past chat on a second surface** — that fork is **intended**.
- Intentional in-app branching UX (future, explicit feature).
- Per-tab device *presence* semantics beyond "N tabs = 1 device" (device-presence stays per `deviceId`).

---

## 3. Design

### §1 Identity model — two orthogonal ids

| id | scope | stable across | keys | status |
|---|---|---|---|---|
| **`deviceId`** | physical device / install | reinstall-life | device registry (`satellite-device-registry.ts`, `api/handlers/devices.ts`, `gateway/src/devices/`), satellites/cube, vitals, **device presence** | unchanged |
| **`surfaceId`** | one chat surface (tab / app instance) | that surface's reconnects | **ACP wire pool, resume buffer, replay attachment** | **new** |

`surfaceId` **layers on top of** `deviceId`; it does not replace it.

**Client derivation**
- **Mobile:** `surfaceId = deviceId` (1 app = 1 surface). No new storage. (`shared/mobile-sdk` `DeviceIdProvider` already stable per-install.)
- **Web:** new per-tab UUID in **sessionStorage** (`sentient.surfaceId`) — survives reload, unique per tab. `deviceId` stays in localStorage (per-browser). New helper alongside `shared/web-sdk/src/device-id.ts`.
- Both sent at `session.configure` — new optional field in `shared/protocol` (`SessionConfigure`). Old clients omit it.

### §2 Gateway re-keying + attachment split

Re-key from `userId`/`deviceId` → `surfaceId`:
- **ACP wire pool** (`AcpWireRegistry`): `userId` → `surfaceId`. Each surface dials its own ACP connection → `acp_ws_server.py` spawns a fresh Hermes child **per connection** (already its behavior — `deploy/hermes-overlay/acp_ws_server.py:5,77`). Reconnect with same `surfaceId` → reuse warm child.
- **Resume buffer** (`DeviceBufferStore`): `deviceId` → `surfaceId`. Two web tabs no longer collide on one buffer/epoch.
- **Replay attachment** (resume half): keyed by `surfaceId`.

**Split the conflated attachment** — today `attachmentId = deviceId` (`ws-session-configure.ts:262,272`) serves both replay-continuity and device-presence:
- replay/resume → `surfaceId`
- **device presence** (Steward "which devices attached", idle-archive) → stays `deviceId`; each surface attachment carries its `deviceId` so **N tabs = 1 device-presence, N surfaces**.

**Shared conversation store** — `HERMES_HOME` is per-**user** (`…/data/u_X/…/sessions/`), shared by all that user's children. Every surface's `sessions.list` drawer sees all conversations. Isolation is per *wire*, not per *store*.

**Cost** — a child per concurrent surface. Cheap: LLM is remote (`session_*.json` carries `base_url`/`model`; no local weights) → a child is a Python agent process, not GBs. Existing idle-TTL eviction (refCount→0) stays, now per-surface. Bounded by concurrent surfaces (a handful per family), not by reconnects.

### §3 Within-surface correctness (the actual last-night fix)

Per-surface keying kills *cross*-surface forks; the single-device fork needs three contained, gateway-only rules:

1. **One in-flight cycle per surface** (D1). The cycle-owner guard moves from per-transport (`cycleSlot`/`AttentionGate`) to per-surface; internal dispatches (save-skill) **queue** behind the active user cycle; reconnect **adopts** the in-flight cycle (output replays via the resume buffer), never restarts or cancels it. A simple per-surface mutex — no per-session map.
2. **Anchor never goes null across reconnect** (D2). The anchored `conversationId` lives on the **surface** (keyed by `surfaceId`), survives transport handover, so the queued internal/next cycle always forces the right id. Removes the `updateConversationId.unknown-session` drop.
3. **Read back Hermes' real session id.** Stop synthesizing the `created` event from the forced id (`acp-hermes-client.ts:174`); take the actual id from `session/update`. Gateway stops being blind — divergence is detected + logged (and can heal), not silently duplicated.

#1+#2 stop the fork; #3 ensures recurrence is *visible*.

### §4 Edge cases & error handling

- **Old client (no `surfaceId`):** gateway falls back to `deviceId` as key → today's per-device behavior. No break.
- **Web `sessionStorage` unavailable:** in-memory `surfaceId` fallback (mirrors existing `deviceId` memory fallback).
- **Surface child dial fails / crashes:** isolated — only that surface errors + retries; other surfaces untouched (today one wire failure hits the whole user).
- **Reconnect storm on one surface:** same `surfaceId` → reuse warm child, no respawn, no fork.
- **Same chat opened on a 2nd surface:** two children load it → fork, **intended**.
- **Internal save-skill dispatch mid user-cycle:** queues (§3.1).
- **Idle eviction:** unchanged lifecycle, now per-surface.

---

## 4. Testing

### Unit (defensive-bar only — wire/protocol/FSM/security)

- `AcpWireRegistry` keyed by `surfaceId` — acquire/reuse/release isolation; two surfaces → two wires.
- One-in-flight-cycle-per-surface — overlapping dispatch (user + internal) serializes; no second `session/prompt`.
- Real-id readback — `created` derives from `session/update`, not the forced id; divergence surfaces.
- `DeviceBufferStore` keyed by `surfaceId` — two surfaces don't share a buffer/epoch.
- Protocol: `SessionConfigure.surfaceId` round-trips; absence → `deviceId` fallback.

### E2E matrix (inline)

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| Repro: bg mid-search | iOS (Maestro) | Chat in convo A, send msg that triggers web search | Background app mid-search, foreground, send follow-up | Answer lands in **A**; no dup in drawer | **Zero `session_<timestamp>` forks** in Hermes store; no `updateConversationId.unknown-session`; resume on same `surfaceId` |
| Two tabs, diff chats | web 1280×900 ×2 | Tab1 convo A, Tab2 convo B | Send in both ~concurrently | Each answer in its own tab/convo | 2 distinct `surfaceId` wires; no cross-write; no fork |
| Same chat, two surfaces | iOS + web | Convo A open on both | Send on each | Fork (two A's) — **intended** | 2 children load A; documented, not an error |
| Reconnect storm | iOS (Maestro) | Active convo | Toggle bg/fg rapidly ×5 mid-cycle | Stream resumes, one answer | Same `surfaceId` child reused; no respawn; no fork |
| Old client fallback | web (no surfaceId build) | — | Normal chat + reconnect | Works as today | Gateway keys by `deviceId`; no error |

- Local `deploy/macos` Docker stack. Mobile = Maestro (`adb`/`simctl`); web = Playwright MCP, viewport matrix per rule. Evidence under QA dirs.
- A case is green only when user-visible behavior **and** the Hermes store / gateway log trail match (zero forks is the hard signal).

---

## 5. Affected components

**Protocol** — `shared/protocol`: `SessionConfigure.surfaceId?` (optional).

**Web client** — `shared/web-sdk/src/`: new `surface-id.ts` (sessionStorage, per-tab, memory fallback); send `surfaceId` in `session.configure` (`sentient-sdk.ts`).

**Mobile client** — `shared/mobile-sdk/`: derive `surfaceId = deviceId`; include in `SessionConfigure` (`SdkLifecycle.kt`, `ClientMessage.kt`).

**Gateway**
- `hermes-adapter-client/acp-wire-registry.ts` — key by `surfaceId`; wire lifetime tied to the surface attachment, not transport refCount (D3).
- `person-session/device-buffer-store.ts`, `device-attachment.ts` — replay/resume keyed by `surfaceId`; presence stays `deviceId`; owns the surface lifecycle the wire rides on (D3).
- `session-handlers/ws-session-configure.ts` — read `surfaceId` (fallback `deviceId`); move `cycleSlot`/`AttentionGate` cycle-owner guard to per-surface (D1); handover adopts in-flight cycle.
- `hermes-adapter-client/per-profile-connection.ts` — one-in-flight-per-surface; safe handover (no racing `cancelInflight` on the adopted cycle).
- `hermes-adapter-client/acp-hermes-client.ts` — real-id readback from `session/update` (drop synthesized `created` at `:174`).
- `session-router.ts` — conversation anchor keyed by `surfaceId`, follows the surface across transport handover (D2).

**Rollout** — gateway + clients ship together; gateway tolerates absent `surfaceId` (→ `deviceId`) so a mixed fleet degrades gracefully, never breaks.

---

## 6. Resolved design decisions

Grounded in code; folded into §2/§3 above.

### D1 — Cycle-atomicity guard moves per-surface (handover = adopt, not restart)

Today the one-active-cycle guard is **per-transport**: `cycleSlot = createAbortSlot("cycle")` (`ws-session-configure.ts:154`) and `AttentionGate` (`:596`) are created per WS-handler. On reconnect a fresh guard is blind to the old transport's still-running cycle → the overlap that forks.

**Decision:** the cycle-owner guard is **per-surface**, spanning the surface's transport sessions. On reconnect the in-flight cycle is **adopted, not cancelled** — its output already flows to the resume buffer and replays to the new transport (observed in logs: the web-search cycle continued across background and completed post-reconnect). The new transport (and any internal save-skill dispatch) consults the per-surface guard and **queues**. The old transport's resumable-disconnect teardown must **not** `cancelInflight` the adopted cycle.

### D2 — Conversation anchor moves per-surface

`session-router` binds per transport `sessionId` (`Map<sessionId, …>`); the `conversationId` anchor dies with the released transport → the dropped `updateConversationId.unknown-session`. **Decision:** the **conversation anchor** is keyed by `surfaceId` and survives transport handover. Transport-level binding (userId/url) may stay per-transport; only the anchor relocates.

### D3 — Wire lifetime = surface lifetime (no new TTL constant)

The wire disposes immediately at refCount→0 (`acp-wire-registry.ts:113-117`); reconnect avoids respawn only via overlapping refCount, so a full-disconnect blip would kill + respawn the child. **Decision:** bind wire lifetime to the **surface attachment** lifecycle, which already has the resumable-disconnect grace + reap (`session.idle_timeout_ms: 900000`). The wire is created on the surface's first connect, reused across reconnects, and disposed when the surface attachment is reaped — same lifecycle as the buffer + attachment. **Reuses the existing reap value; introduces no new magic number.** This also unifies wire + buffer + attachment under one per-surface lifecycle.
