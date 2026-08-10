---
id: smoke
area: chat
auth: seeded
concurrency_key: null
risk_hint: medium
oracles:
  - shared.console-error-free
  - shared.network-no-5xx
  - shared.no-uncaught-promise-rejection
  - shared.few-hiccupps.product-consistency
  - shared.few-hiccupps.history
  - shared.no-stuck-state
  - web.no-blank-render-after-3s
  - web.no-broken-images
---

# Charter: smoke (sentient)

**Mission:** Walk the most critical chat flows end-to-end in under 90
seconds. Surface anything that breaks the cycle lifecycle, audio
playback, presence, or task visibility.

## Why this charter exists

Sentient's user-visible contract is "send a message, hear the reply,
see the tools that ran." Smoke covers each leg of that. It's broad
enough to catch most regressions; deeper exploration of specific
flows (interrupts, idle close, voice mode) belongs in dedicated
charters that don't yet exist.

## Preconditions

- Stack is up at `https://localhost:8888`.
- A fresh `qa/web/.playwright/profiles/default.json` exists (the
  login charter runs first if not).
- The gateway has at least one MCP tool registered that the prompts
  below can trigger (default config includes
  `mcp_duckduckgo_search` for the weather query).

## Touchpoints (translated from agents/docs/testing-knowledge.md)

These map to the manual smoke procedures already documented for
sentient. Run them in order; each builds on the cycle state from the
previous one.

### 1. Text round-trip + tool pill

**Action:** Type "what's the weather in Vancouver" into the composer
and click Send.

**Expect:**
- Optimistic user bubble appears within one frame.
- A tool pill appears in the composer's task strip
  (`composer-task-strip.tsx`) for the duration of the tool call, and
  the strip is empty again once the turn ends.
- ZERO tool pills on any chat bubble. The composer strip is the ONLY
  tool surface: `turn.tool.update` and the `kind: "tool"` feed item
  are deleted, and `tool-pill-strip.tsx` no longer exists.
- The assistant reply streams in as ONE bubble that grows through every
  narration stretch of the turn, and stays one row after it commits.
- Turn ends with `turn.completed` (visible in the
  `[sentient.sdk.turn-audio-queue]` console logs).

**Oracle hits:** if a tool pill renders on a chat bubble, or the reply
splits into more than one bubble for a single uninterrupted turn →
fire `shared.few-hiccupps.product-consistency`. Do NOT file a bug for
"the pill is only in the strip" — that is the contract.

### 2. Speaking state tracks audio drain

**Action:** Send "tell me a story about ravens, ~50 words".

**Expect:**
- Speaking indicator (`bubble-speaking-wave.tsx`) lights up when
  TTS audio starts.
- Indicator stays lit through the LAST syllable of audio.
- Indicator drops on `onPlaybackEnded`, NOT on `cycle.done`.

**Oracle hits:** if the indicator drops before audio finishes
(silent gap with the wave still implying speech, or speech still
playing with no wave) → fire
`shared.few-hiccupps.product-consistency`. This is a known regression
class (cycle.done fires before audio drains).

### 3. Interrupt cuts audio within ~30ms

**Action:** Send "write a 200-word essay on something boring". When
audio begins, click the Stop button (`interrupt-button.tsx`).

**Expect:**
- Audio cuts within the preempt-fadeout window (~30ms).
- The assistant bubble shows a cutoff marker
  (`interrupt-chip.tsx`) — verify by snapshot.
- Speaking indicator drops immediately.

**Oracle hits:** if audio bleeds for hundreds of ms after Stop →
fire `shared.no-stuck-state`. Likely cause is the WebRTC peer not
being destroyed in `clear()`.

### 4. Interrupt button visibility bridge

**Action:** Click Send on any prompt; observe the Interrupt button
continuously from click through end of TTS.

**Expect:**
- Button appears within one frame of clicking Send.
- Button stays visible the entire time (no flicker between
  `cycle.done` and `onAudioStart`).
- Button drops on `onPlaybackEnded`.

**Oracle hits:** any flicker in the gap between cycle.done and
audio start → fire `shared.few-hiccupps.product-consistency`. Means
the AwaitingTracker FSM isn't wired correctly (see
`agents/docs/gateway/webui/awaiting-tracker-fsm-details.md`).

### 5. Cycle serialization (no audio overlap)

**Action:** Send "what's the weather in Vancouver"; wait for audio
to start. While audio is playing, send "and what about Toronto".

**Expect:**
- Either the first cycle's audio drains naturally before the second
  starts, OR the second preempts with a brief fade (if elapsed >
  `min_eager_end_ms`).
- No overlapping speech (this would be unintelligible).

**Oracle hits:** any overlap → fire `shared.no-stuck-state` and
flag as severity:critical (overlap can't be recovered without a
full reload).

## Things to actively look for (beyond the touchpoints)

- Visual: broken images in any avatar, missing icons in tool pills,
  blank gray flashes during transitions.
- Layout: composer widening or jumping when a tool pill appears;
  message list scroll position lurching.
- Console: any warnings from `[sentient.webui.cycle-audio-queue]`
  or `[sentient.web-sdk.presence]` other than the routine `idle-tick`
  heartbeat.

## Things to skip (handed off explicitly)

These belong in dedicated charters or future runs:

- Idle-close timing — needs >30 minutes of dwell time (or a dev
  override of `IDLE_THRESHOLD_MS`); not smoke material.
- Voice/mic flow — requires real audio input; can't be verified in
  headless Chrome without `--use-fake-device-for-media-stream`.
- TTS audio quality — perceptual; ALWAYS handed off to human.
- AEC effectiveness — requires real speaker + mic + room.

## Notes for the Reporter

Smoke is broad-and-shallow by design. A confirmed bug here usually
means the build is regressed in a user-visible way — flag it as
severity:major or higher and surface in `needs_fixer_agent`. UX
oddities, layout jank, and "something felt off" go to `issues`.
