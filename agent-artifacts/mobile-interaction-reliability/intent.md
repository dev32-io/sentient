# Intent: Reliable mobile conversations, voice interaction, and settings navigation

## Problem

The iOS and Android clients have several related interaction failures: explicit New Chat only clears the local timeline while continuing the previous conversation, hold-to-talk can interrupt TTS without opening capture, assistant output abruptly auto-scrolls chat, the recording waveform is decorative rather than mic-driven, Fish browsing lacks web-equivalent filters, and nested settings Back can jump to the Settings root instead of the previous page.

## Desired Outcome

Both mobile clients preserve conversation boundaries, make voice barge-in reliable, use predictable send-anchored scrolling, render real mic levels within the existing waveform design, provide Fish filter parity, and navigate every settings page through a natural history stack.

## Scope — Included

- iOS and Android explicit New Chat behavior and conversation isolation
- Hold-to-talk barge-in sequencing and native gesture synchronization
- Mobile chat send-anchored scrolling
- Privacy-safe real-input waveform behavior built on the existing visual design
- Mobile Fish catalog filter and sort parity with web
- Natural stack-based Back behavior across nested settings pages
- Deterministic automated boundary verification plus user-owned final physical-microphone testing

## Success Signals

- A user-triggered New Chat produces an isolated durable conversation while restart does not create a phantom session
- A single hold press during TTS both stops the assistant and begins the new manual speech turn
- A sent user message anchors at the viewport top and assistant output never programmatically moves it
- The existing waveform visibly follows real mic energy without changing its established design language
- Mobile Fish results support the same search, facets, sorting, and reset semantics as web
- Back always returns to the immediately previous visible settings page with route-scoped state preserved
- All approved driveable E2E cases pass locally and manual device voice verification is completed by the user

## Scope — Excluded

- Changing web chat scrolling
- Replacing Fish browsing or changing the Fish import and local-TTS bundling pipeline
- Audio-reactive assistant playback visualization
- Redesigning settings information architecture or the existing mobile visual language
- Agent-driven physical microphone or acoustic E2E testing
- Production testing or production mutation

## Constraints

- Current repository architecture remains authoritative: shared mobile layers own session/audio semantics and native apps remain thin UI layers
- All UI work reuses current components, typography, spacing, colors, motion, accessibility conventions, and navigation patterns
- Raw audio and high-frequency level history must not enter UI state, logs, or retained evidence
- App launch/resume and explicit user-requested New Chat must remain distinct operations
- Production remains observational-only
