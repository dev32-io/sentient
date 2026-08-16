# Task Brief: Make shared TalkMode authoritative for hold-to-talk barge-in

## Contribution Goal

One hold press during assistant activity remains Hold, interrupts the active turn/playback, starts manual capture, and drives both native controls from shared TalkMode until release or a genuine shared failure transition.

## Boundary — Included

- Shared TalkMode authoritative lifecycle including forced Idle on genuine failure/teardown
- Android and iOS MicCorner conversion to presentation-only gesture adapters
- Interrupt/manual-capture command ordering and transient inactive-state regression coverage
- Thin ChatComponent/ViewModel/state wiring needed to render shared TalkMode

## Required Work

- 1. Preserve TalkModeController as the semantic FSM and make its transition ordering explicit: a valid Idle press commits/retains Hold while interrupting active cognition/TTS and requesting manual capture; release/lock/continuous-stop remain shared intents.
- 2. Add the shared authoritative transition for permission denial, capture startup failure, disconnect, audio teardown, or other genuine capture loss. Ensure it is idempotent and does not emit a duplicate release/stop intent.
- 3. Integrate VoiceAudioState/SDK lifecycle with TalkMode so transient interrupt-driven micActive=false cannot force Idle, while a real Error/teardown does. Use typed/shared state rather than timing sleeps or native heuristics.
- 4. Refactor Android MicCorner and iOS MicCorner to consume shared TalkMode as rendered mode. Remove their competing micActive external-off FSM logic; keep only pointer/drag progress, lock threshold calculation, animation, haptics, accessibility actions, and intent emission.
- 5. Thread TalkMode through existing ChatComponent/ViewModels/Composer without giving native code transport/audio authority. Preserve permission gating and text-only usability.
- 6. Extend TalkModeControllerTest and TalkModeSeamIntegrationTest for active-TTS press ordering, optimistic Hold through transient inactive projection, manual start, release finalization, forced Idle on genuine failure, duplicate-failure idempotence, and lock/continuous regressions.
- 7. Replace native MicCorner tests that assert local authority with tests proving pointer outcomes emit the four shared intents and rendering follows externally supplied TalkMode. Preserve existing threshold and accessibility coverage.
- 8. Add sanitized state-transition diagnostics only; never log content, raw frames, or transcripts.
- 9. Run shared SDK/data, Android, iOS, and diff checks.

## Integration Expectation

Deliver this contribution for integration in stage state-and-navigation.

## Context

- TalkModeController already owns the intended interrupt → hold defer → manual capture sequence, but Android and iOS MicCorner also maintain an authoritative local mode and reset it from micActive true→false.
- Interrupt clears playback/cognition and can transiently project micActive=false before asynchronous capture becomes active, causing the native external-sync race reported by the user.
- The shared SDK must own Idle/Hold/Continuous and failure reset. Native views may retain pointer ownership, drag offset, animation, and haptics only.

## Boundary — Excluded

- Physical microphone or acoustic E2E
- Implementing the real-input waveform envelope
- Duplicating TalkMode logic in Swift or Android Kotlin
- Changing gateway interrupt/audio wire contracts
- Redesigning the mic control

## Interfaces and Dependencies

- Consumes TalkModeController, VoiceAudioState, SentientSdk voice command lane, and existing four mic intents.
- Produces authoritative shared TalkMode including genuine-failure Idle and native presentation-only MicCorner adapters.
- Proof seam: shared FSM/command-lane tests and native gesture-adapter tests; no manual verification dependency.
