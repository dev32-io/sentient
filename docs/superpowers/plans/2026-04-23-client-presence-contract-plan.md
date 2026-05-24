# Client Presence Contract — Implementation Plan

> **For agentic workers:** use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to work this task-by-task. Checkbox (`- [ ]`) syntax is progress-trackable.

**Goal:** Every client SDK and device firmware implements a symmetric inactivity contract: detach on no-interaction timeout, reattach on user presence. The gateway's 30-min PersonSession idle-archive policy depends on this behaviour — without it, a forgotten tab keeps a Hermes chain alive indefinitely and profile-memory summarization never triggers a conversation boundary.

**Why this is separate from Phase B:** Phase B moves server-side conversation state into PersonSession. This plan is the corresponding client-side work that validates Phase B's archive assumption. Both must ship before the multi-profile refactor is user-facing, but neither blocks the other's development.

**Non-goals:**
- Not about WS reconnect-on-network-error (that's already in the SDK transport layer). This is reconnect-on-user-return.
- Not about voice wake-word detection on ESP32 (separate roadmap item). "Presence" on voice devices for v1 means "button or touch."
- Not about multi-user-per-device arbitration (deferred to proximity work).

---

## Contract summary

**Two-timer model (gateway + client run independently, in series):**
- Client: "user hasn't interacted with *me* for a while — save power, release resources." ~1 hr.
- Gateway: "nobody is attached to this PersonSession — archive the conversation." 30 min.
- They compose: Alice walks away → ~1 hr later kitchen ESP32 disconnects → 30 min later gateway archives her chain → total ~90 min before fresh chain. Plenty of slack for real-world gaps.

| Aspect | Rule |
|---|---|
| Idle threshold (client) | Disconnect WS after **1 hr** of no user interaction. Generous to avoid surprising the user after short absences; the gateway's 30-min archive fires *after* disconnect, so total time-to-fresh-chain is ~1.5 hrs. |
| Reconnect trigger | Any user-presence signal: tab/window focus, visibility `visible`, touch/pointer, keypress, mic speech onset. |
| Reattach behaviour | Same `profile` → same PersonSession if within server's 30-min window → same Hermes chain. Past that window → PersonSession archived → fresh chain (expected; Hermes profile memory carries context). |
| Backgrounded tabs | Tab backgrounded still accrues idle time (no visible interaction happening). After 1 hr → disconnect. On `visibilitychange` to visible → reconnect. |
| User input counts | Any user-originated event resets the idle timer: typing, voice onset, touch, button press, pointer, keypress. Passive TTS playback alone does NOT count as user interaction (but does suppress the disconnect action while it's running). |
| Active TTS | Do NOT disconnect while TTS is actively playing, even if input is idle. Disconnect timer resets on any assistant output activity. |
| Active cycle | Do NOT disconnect while a cycle is in flight. |

---

## Phase 1 — Web SDK (`shared/web-sdk/`)

Owner of client-side presence logic. All other clients mirror this pattern.

### 1.1 Idle detector utility

- [ ] `shared/web-sdk/src/presence/idle-detector.ts` — pure state machine: `(event, now) → newState`. States: `active | warning | idle`. Events: `interaction | tts.activity | cycle.activity | tick(ms)`.
- [ ] `shared/web-sdk/src/presence/idle-detector.test.ts` — unit tests: state transitions, timer math, no-interaction-for-3-min, reset-on-any-signal.
- [ ] Config: idle threshold configurable via `VoiceClientOptions` (default 1 hr, minimum 30 s for tests).

### 1.2 Presence signal aggregator

- [ ] `shared/web-sdk/src/presence/presence-source.ts` — binds DOM events (`visibilitychange`, `pointerdown`, `keydown`, `focus`, `blur`) + SDK-internal events (mic energy onset, TTS frame, cycle start/complete) to the idle detector. Tests may inject via a mock source.
- [ ] `shared/web-sdk/src/presence/presence-source.test.ts` — verify each event type feeds the detector; verify unsubscription on dispose.

### 1.3 VoiceClient transport integration

- [ ] Extend `shared/web-sdk/src/transport.ts` (or the voice-client orchestrator) with presence-driven lifecycle: `onIdle → ws.close(WS_NORMAL_CLOSURE, "idle-timeout")`; `onPresence → ws.open()`.
- [ ] Expose `VoiceStatus.idle` as an internal state (NOT a new public status — the single-surface rule stays: developer still sees one state machine). Presence-driven disconnect is invisible to integrating app code except through a brief `connecting` on return.
- [ ] Clean integration test: drive events through public API → assert socket open/close lifecycle matches contract.

### 1.4 Suppression guards

- [ ] While `cycle.active === true` OR `tts.playing === true`, the idle timer is paused (reset on every tts chunk / cycle event). Test both cases.
- [ ] `demandStay()` escape hatch for app code that wants to keep the socket alive during user-visible work (e.g. showing a long markdown reply the user hasn't scrolled past). Default: unused. Document but don't wire into the demo UI.

---

## Phase 2 — Web UI integration (`gateway/webui/`)

- [ ] Wire new SDK presence config through `VoiceClient` construction site in the chat page. No visible UI change — just confirms end-to-end wiring.
- [ ] Manual verification script in docs:
  - Open chat, interact, wait 1 hr untouched → socket closes (check devtools Network → WS → closed).
  - Return to tab → socket reopens → `session.configure` sent → same conversation renders (if within 30 min) or fresh (if past).
  - Backgrounded tab for > 1 hr → closes. Refocus → reopens.
  - Active playback → do NOT close even if untouched.
- [ ] Add to `agent/docs/testing-knowledge.md` once validated.

---

## Phase 3 — ESP32 firmware (deferred, separate repo)

Contract parity sketch; actual implementation is out of this repo's scope but the behaviour must match:

- Inactivity timer: no speech energy + no button press for N minutes → `wifi_ws_disconnect()`.
- Reconnect trigger: button press OR speech energy onset → `wifi_ws_connect()`.
- Same profile → same PersonSession if within server window.
- Document these requirements in the ESP32 repo's README before firmware v1.

---

## Phase 4 — Android / iOS (deferred, Phase 6+)

- [ ] When mobile clients come online, they inherit this contract: `onPause` → schedule 3-min idle disconnect; `onResume` → cancel + reconnect if closed. Lifecycle hooks are platform-native so implementation is straightforward once the gateway contract is stable.
- [ ] Voice wake-word (if added) = presence trigger.

---

## Gateway-side dependencies

None blocking this plan — but when it ships the following gateway work must be landed or landed-concurrently:

- [x] B3 — PersonSession owns `lastDetachedAtMs` (part of Phase B).
- [ ] Idle sweeper that archives PersonSession after 30 min of isIdle. Can live in Phase B (B4 or standalone B4.5) OR land alongside this plan. Without the sweeper, clients disconnecting is still *necessary* (prevents cross-session contamination / state leaks) but the archive doesn't yet fire — Hermes chains grow but the gateway eats the memory cost.
- [ ] MCP tools (Phase B5) are PersonSession-scoped, so reconnecting to the same profile correctly resumes tool state.

---

## Decisions captured

- **1 hr client idle vs 30 min server archive, running in series:** total ~1.5 hrs after last interaction before the chain resets. Client timer is about resource conservation (release mic/power/socket); server timer is about conversation lifetime. They don't need to match — they compose.
- **No scrollback on archive:** Hermes profile memory carries context; we don't build a past-conversations UI. Confirmed in `project_person_session_idle_archive.md`.
- **No public "idle" status on the SDK:** the single-surface rule wins — presence is internal.
- **Suppression while playing/cycling:** the worst UX bug would be "tab closes mid-TTS." We explicitly guard against it.

---

## Out of scope (for this plan)

- Server-side idle sweeper implementation (decide during or after Phase B).
- Per-device TTS routing ("last-to-speak wins" is Phase B4).
- Multi-person-per-device (voice ID, proximity).
- Background audio capture on mobile while screen locked.
