# Intent: Reliable mobile conversations, voice interaction, and settings navigation

## Problem

The iOS and Android clients have several related interaction failures: New Chat clears the local timeline while continuing the previous conversation, hold-to-talk can interrupt TTS without opening capture, assistant output abruptly auto-scrolls chat, the recording waveform is decorative rather than mic-driven, Fish browsing lacks web-equivalent filters, and nested settings Back can jump to the Settings root instead of the previous page.

## Desired Outcome

Both mobile clients eagerly prepare a fresh chat on cold launch and explicit New Chat without blocking input, preserve conversation boundaries, make shared-SDK voice barge-in reliable, use predictable send-anchored scrolling, render an SDK-owned real-input envelope within the existing waveform design, provide Fish filter parity, and navigate every settings page through natural history.

## Scope — Included

- iOS and Android eager fresh-chat preparation on cold launch and explicit New Chat, with durable conversation isolation on first send
- Shared-SDK hold-to-talk barge-in sequencing and authoritative talk mode with thin native gesture rendering
- Mobile chat send-anchored scrolling
- SDK-owned rolling 32-level microphone envelope using fixed 50 ms windows and the existing waveform design
- Mobile Fish catalog filter and sort parity with web
- Natural stack-based Back behavior across nested settings pages
- Fully agentic E2E for driveable journeys and deterministic automated verification at voice/audio boundaries

## Success Signals

- Cold launch and every explicit New Chat prepare a fresh gateway boundary immediately without blocking the composer; the first sent message creates and belongs only to the new durable conversation
- One fresh-chat route entry emits one preparation request despite recomposition, while intentional rapid taps remain bounded by existing idempotence/debounce behavior
- Shared deterministic tests prove one hold press orders interrupt before manual capture, survives transient inactive projection, and drives both native controls from shared TalkMode
- A sent user message anchors at the viewport top and assistant output never programmatically moves it
- The SDK derives a rolling 32-level, 1.6-second envelope from the existing uplink signal and native waveform views render it without receiving audio buffers or redesign
- Mobile Fish results support the same search, facets, sorting, and reset semantics as web
- Back always returns to the immediately previous visible settings page with route-scoped state preserved
- All approved fully agentic E2E cases pass locally; physical-device voice behavior remains residual risk for later owner build testing outside the workflow

## Scope — Excluded

- Changing web chat scrolling
- Replacing Fish browsing or changing the Fish import and local-TTS bundling pipeline
- Audio-reactive assistant playback visualization
- Redesigning settings information architecture or the existing mobile visual language
- A client-generated/local draft model or a second microphone capture path
- Physical microphone, acoustic, spoken-turn, or other user-assisted workflow verification
- Production testing or production mutation

## Constraints

- Cold app launch intentionally starts a fresh chat rather than resuming the previous conversation
- Entering a fresh-chat route immediately sends the gateway preparation request; the composer never waits and outbound sends queue until the gateway draft handshake/attachment is ready
- The append-only gateway session store remains authoritative; durable session allocation continues on the first message according to the existing gateway contract
- TalkModeController is the sole Idle/Hold/Continuous authority; native controls retain only pointer, drag, animation, and haptic presentation state
- The SDK capture layer owns PCM access, fixed-duration framing, level derivation, normalization, smoothing, rolling history, and lifecycle; native ViewModels/UI only consume the resulting envelope
- All UI work reuses current components, typography, spacing, colors, motion, accessibility conventions, and navigation patterns
- Raw PCM must not cross into native UI state, logs, or retained evidence
- Every planned E2E case must execute to completion without user intervention
- Production remains observational-only
