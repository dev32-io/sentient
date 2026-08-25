# Task Brief: Implement capture-aware KMP voice uplink and talk-state semantics

## Contribution Goal

Give iOS and existing Android voice callers a serialized capture engine that emits identified start/end/cancel controls, stops frames before terminal, and implements Hold, Send, Cancel, and Auto transitions safely.

## Boundary — Included

- KMP wire serialization for the capture-aware protocol, capture ID generation/state, commit/cancel outcomes, generation-gated frames, Hold-to-Auto behavior, lifecycle cancellation, and public iOS-facing intents.
- Focused common tests and Android shared compatibility proof.

## Required Work

- 1. Extend KMP ClientMessage and serialization to match the accepted TypeScript protocol: AudioStart(captureId, manual|semantic), AudioEnd(captureId), and AudioCancel(captureId). New KMP clients always send opaque non-content capture IDs; do not expose IDs as authorization or user-visible text.
- 2. Refactor UserAudioInputConnector/SdkVoice around one serialized active-capture record and generation. Start allocates one ID; commit and cancel are distinct idempotent terminal intents; first accepted terminal wins; repeated/stale terminal calls do not affect the current/newer capture.
- 3. Preserve strict ordering: invalidate producer callbacks, stop and join the capture pipeline, and prevent further binary sends before AudioEnd or AudioCancel is emitted. Start of a new capture cannot overlap terminal cleanup. External engine or transport failures resolve through typed state rather than logging content.
- 4. Implement talk intents without changing Android UI files: pointer/press begins manual Hold; ordinary existing release commits with AudioEnd; an explicit new cancel intent emits AudioCancel; Hold-to-Auto commits the held manual segment, waits for terminal serialization, then starts a fresh semantic capture ID; activating Auto again commits/finalizes that semantic segment and returns idle.
- 5. Expose bounded KMP/ChatComponent methods and state needed by iOS VoiceCaptureControl: hold start, send held, cancel held, enter Auto, exit Auto, and lifecycle/system cancel. Screens must not assemble wire commands directly.
- 6. On disconnect, permission loss, view disappearance, foreground-session replacement, or SDK close, cancel the active capture locally when safe, stop frames, clear deferred playback state, and never replay Cancel after reconnect. Assistant interrupt and background-task cancellation remain separate.
- 7. Preserve current barge-in/deferred playback behavior: mic onset may interrupt foreground assistant output; cancel discards user speech but does not restore the prior assistant output. Auto remains semantic Smart-Turn mode.
- 8. Extend UserAudioInputConnectorTest, UplinkWireContractTest, TalkModeControllerTest, SdkVoiceTest, and TalkModeSeamIntegrationTest for exact wire payloads, manual Send, manual Cancel, Hold-to-Auto two-ID ordering, Auto exit, first-terminal-wins, no frames after terminal, stale terminal isolation, teardown cancellation, and unchanged legacy Android callback behavior.

## Integration Expectation

Deliver this contribution for integration in stage platform-foundations.

## Context

- Current KMP ownership is shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/voice/talk/TalkModeController.kt, sdk/SdkVoice.kt, connectors/UserAudioInputConnector.kt, and protocol/ClientMessage.kt.
- Current serialized start order is audio.start then engine/pipeline; stop order is pipeline stop/join then audio.end. Preserve and strengthen this seam.
- Existing Android UI callbacks flow through shared mobile ChatComponent/TalkModeController and must keep current visual/interaction behavior; no android/ UI file may change.

## Boundary — Excluded

- SwiftUI or Compose UI changes
- Gateway/STT implementation owned by capture-protocol-gateway
- Automated microphone/STT/TTS/audio E2E
- Changes to message outbox, authorization, sessions, or assistant/background-task cancellation

## Interfaces and Dependencies

- Consumes the capture-aware audio wire accepted by capture-protocol-gateway.
- Produces KMP state/intents consumed by iOS ChatViewModel/VoiceCaptureControl while preserving existing Android UI callback compatibility.
