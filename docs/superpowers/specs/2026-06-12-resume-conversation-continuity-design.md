# Resume Conversation Continuity — Design

**Status:** approved (brainstormed in-thread 2026-06-12)
**Branch:** `feature/resume-conversation-continuity` (off `develop` @ PR#7 merge)

## Problem

On a WebSocket reconnect, a follow-up message in an existing chat is routed to a
**brand-new Hermes conversation** — prior context is lost and a new chat row
appears in the drawer. Production repro (Pi, 2026-06-12 ~13:35 PDT, mobile):
conversation "spacex ipo market frenzy" completed; the app was backgrounded on
screen-lock (WS dropped, app alive), then foregrounded (warm reconnect, buffer
replayed fine); the follow-up "lol nothing in this market makes sense" forked
into a fresh thread with no spacex context.

Log proof: two dispatches, different per-WS sessionIds, both `cycle-1`, both
`hasPreviousResponseId=false`; the reconnect emitted `resume.recovered`
(replayCount=34) yet the follow-up hit `dispatch.session-new.lazy` → new
conversationId.

## Root cause

A reconnect juggles two **orthogonal** things; the gateway restores one and
drops the other:

| Concern | Keyed by | Survives reconnect? |
|---|---|---|
| **Screen** (displayed bubbles) | `deviceId` (replay buffer) | yes — replay / REST-refetch |
| **Thread** (which Hermes conversation the *next* message continues) | ephemeral per-WS `sessionId` binding | **no** — `bind()` resets `conversationId: null` (session-router.ts:58); old binding released |

The buffer replay restores the *screen*, which makes the reconnect *look*
recovered while the *thread* silently forks. Concretely: the gateway's
`recovered:true` path returns early at `ws-session-configure.ts:932`, **before**
the re-anchor block at `:963` — so the conversation re-anchor
(`setPendingNewSessionId`) is skipped on every warm (buffer-resume) reconnect,
for all clients. Web mostly dodges it (cold reconnects/reloads re-anchor via the
`?session_id=` upgrade query param → `conversation.activate`); mobile uses the
base URL and re-anchors only via a *post-ready* `conversation.activate` that
fires on `recovered:false` / no-cursor — so the `recovered:true` warm reconnect
(the common backgrounding case) forks.

## Continuity model (verified)

- **One token: `conversationId`** — the ACP/Hermes session id, sent to Hermes as
  `session/prompt.sessionId`. It is the *only* continuity signal.
- **`previousResponseId` is not a second token.** `responseId` is literally the
  cycleId echoed (`acp-hermes-client.ts:174`); `hasPreviousResponseId` is just a
  readout of `binding.conversationId !== null`. Carry one id, not two.
- **Both clients already hold the current conversationId** they display, from
  `session.created` / `session.switched`: web in
  `sessionStorage["sentient.currentSessionId"]`; mobile in `_currentSessionId`
  (StateFlow, `SentientSdk.kt:108`).
- **Continuing an evicted thread already works** — proven live: tapping a past
  chat forces its id (`setPendingNewSessionId`) and Hermes `session/load`s it
  with full context. The reconnect path simply never performs that re-anchor.

## Fix

The client asserts the conversationId it is displaying **inside
`session.configure`** (declarative, synchronous — no frame-order race, same
rationale as folding `resume` into configure). The gateway seeds the re-anchor
**before the `recovered:true` early-return**, so it applies to warm reconnects:

```
reanchorId = configure.conversationId  ??  ws.data.resumeSessionId   // mobile field, web URL fallback
if (reanchorId) pendingNewSessionId = reanchorId                     // before handleResumeOrFresh
```

The next user message then resolves through the existing rail
(`resolveAcpSessionId`: forcedSessionId → continue) → warm continue (in-memory)
or Hermes `session/load` (evicted). No new machinery — it reuses the exact rails
`conversation.activate` already proves.

**Why this also fixes web for free:** the early seed reads `ws.data.resumeSessionId`
too, so web's latent `recovered:true` warm-reconnect fork is closed without any
web-client change.

## Scope & non-goals

- **In scope:** `shared/protocol` (optional `conversationId` on configure),
  `gateway` (thread param + early re-anchor seed), `shared/mobile-sdk` (send the
  id in configure). Version bumps: gateway 1.11.1→1.11.2; mobile-sdk + android +
  ios 0.1.0→0.1.1.
- **Web client: unchanged** (its `?session_id=` path stays; the gateway seed
  covers its latent case).
- **Non-goal:** retiring the redundant re-anchor mechanisms (web URL param,
  mobile post-ready activate). They remain as harmless, idempotent
  belt-and-suspenders. A later "one re-anchor path" cleanup can collapse them.
- **No config change / no schema_version migration** — this is wire-protocol +
  behavior only.

## Security

A client-asserted conversationId only ever routes to *this user's own* per-user
Hermes worker (per-port isolation). It cannot reach another family member's
thread. Worst case of a stale/bogus id = a fresh/empty session in the user's own
worker — never a misfire into a different real thread. No pre-validation needed
(mirrors the existing `?session_id=` activate, which does not pre-validate);
unknown id degrades to fresh.

## E2E matrix

> Native mobile = Maestro (Android `adb` + iOS `simctl`); web = Playwright.
> Web is unchanged here, so web rows are regression-only.

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| Warm-reconnect continues (Android) | Android app | In chat A with ≥1 exchanged turn | Background app (HOME/lock) → foreground → send follow-up referencing prior context | Reply continues chat A in-context; **no new drawer row** | configure carries `conversationId=A`; re-anchor seed sets pendingNewSessionId; next `dispatch.begin` forced id; **no `dispatch.session-new.lazy`**; same conversationId |
| Warm-reconnect continues (iOS) | iOS app | In chat A with ≥1 exchanged turn | Same as above (`simctl` background/foreground) | Same | Same |
| Fresh reconnect stays fresh | Android/iOS | App open on a brand-new/empty chat (no conversation yet) | Background → foreground → send first message | New conversation as normal; no spurious continue | configure omits `conversationId`; lazy mint as today; one new drawer row |
| Evicted-buffer continues | Android/iOS | In chat A; buffer evicted (long idle → `recovered:false`) | Reconnect → send follow-up | History refetched; reply continues chat A in-context | `stream.resumed recovered:false`; re-anchor seed forces A; Hermes `session/load`; no new row |
| Web regression (desktop) | 1280×900 | In chat A, warm reconnect | Drop WS → reconnect → follow-up | Continues chat A (unchanged) | Web `?session_id=` path + gateway seed; no `session-new.lazy` |
| Web regression (mobile-sized) | 390×844 | In chat A, warm reconnect | Same | Same | Same |

A case is green only when user-visible behavior **and** the log trail (no
`session-new.lazy` on continue, no unexpected WARN/ERROR) match.
