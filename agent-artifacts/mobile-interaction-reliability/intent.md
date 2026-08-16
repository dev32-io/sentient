# Intent: Reliable mobile conversations, voice interaction, and settings navigation

## Problem

The iOS and Android clients have several related interaction failures: explicit New Chat only clears the local timeline while continuing the previous conversation, hold-to-talk can interrupt TTS without opening capture, assistant output abruptly auto-scrolls chat, the recording waveform is decorative rather than mic-driven, Fish browsing lacks web-equivalent filters, and nested settings Back can jump to the Settings root instead of the previous page.

## Desired Outcome

Both mobile clients preserve conversation boundaries, make voice barge-in reliable, use predictable send-anchored scrolling, render real mic levels within the existing waveform design, provide Fish filter parity, and navigate every settings page through a natural history stack.

## Scope — Included

- iOS and Android explicit New Chat behavior and conversation isolation
- Hold-to-talk barge-in sequencing and native gesture synchronization
- Mobile chat send-anchored scrolling
- SDK-owned privacy-safe rolling microphone-level envelope rendered through the existing waveform design
- Mobile Fish catalog filter and sort parity with web
- Natural stack-based Back behavior across nested settings pages
- Fully agentic E2E for driveable journeys and deterministic automated verification at voice/audio boundaries

## Success Signals

- A user-triggered New Chat produces an isolated durable conversation while restart does not create a phantom session
- Deterministic tests prove one hold press orders interrupt before manual capture and survives transient inactive state
- A sent user message anchors at the viewport top and assistant output never programmatically moves it
- The SDK derives a bounded rolling 32-level envelope from existing capture PCM and native waveform views render it without receiving audio buffers
- Mobile Fish results support the same search, facets, sorting, and reset semantics as web
- Back always returns to the immediately previous visible settings page with route-scoped state preserved
- All approved fully agentic E2E cases pass locally; physical-device voice behavior remains an explicit residual risk for later owner build testing outside the workflow

## Scope — Excluded

- Changing web chat scrolling
- Replacing Fish browsing or changing the Fish import and local-TTS bundling pipeline
- Audio-reactive assistant playback visualization
- Redesigning settings information architecture or the existing mobile visual language
- Physical microphone, acoustic, spoken-turn, or other user-assisted workflow verification
- Production testing or production mutation

## Constraints

- Current repository architecture remains authoritative: the SDK capture layer owns PCM access, level derivation, normalization, smoothing, history, and lifecycle; native ViewModels/UI only consume the resulting level signal
- All UI work reuses current components, typography, spacing, colors, motion, accessibility conventions, and navigation patterns
- Raw PCM and high-frequency level history must not cross into native UI state, logs, or retained evidence
- App launch/resume and explicit user-requested New Chat must remain distinct operations
- Every planned E2E case must be executable to completion by an agent without user intervention
- Production remains observational-only
