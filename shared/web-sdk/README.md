# @sentient/web-sdk

Browser transport and state SDK for Sentient's native gateway wire contract.
It owns WebSocket authentication/configuration, connectors, command binding,
session resume, and client-side live state. It does not run the agent loop or
decide authoritative utterance boundaries.

## Core API

- `SentientSDK` — connect/disconnect, reconnect and presence lifecycle,
  interrupt, command binding, and connector registration.
- `UserAudioInputConnector` — sends `audio.start`, binary audio, and
  `audio.end`; closes the app's mic latch on a user-triggered `turn.started`.
- `UserTextInputConnector` — sends `text.input`.
- `AssistantAudioResponseConnector` — receives turn-bracketed audio.
- `ConversationHistoryConnector` and `InFlightMessageConnector` — maintain
  committed and streaming conversation projections.
- `TaskListConnector`, `PermissionConfirmConnector`, and
  `DelegationProgressConnector` — expose current native-gateway tool state.
- `SessionsConnector` plus `createSessionsRest` — switch live sessions and load
  the implemented session list/history REST surface.

## Session and resume behavior

`SentientSDK` sends a stable `deviceId`, a per-tab `surfaceId`, client
capabilities, and the active conversation/draft in `session.configure`.
Session-lane frames use the gateway's session-scoped sequence space. The SDK
keeps the highest applied cursor and requests replay after reconnect.

On `stream.resumed { recovered: true }`, connector session state is preserved
and missed frames are applied idempotently. On a fresh or unrecoverable attach,
`conversation.snapshot` replaces the committed mirror. `conversation.activate`
switches the live attachment; message history is then loaded with
`GET /api/v1/sessions/:id/messages`.

## Audio utilities

The package provides transport-neutral pieces rather than a bundled VAD model:

- `createSpeechGate` — sustained-speech latch with pre-roll; the consuming app
  supplies the per-frame speech verdict.
- `createEchoGate` — playback-state echo suppression state machine.
- `createAudioPreRollRing` — capture pre-roll buffering.
- `createTurnAudioQueue` — strict turn-keyed FIFO. A new turn never preempts
  earlier audio; only barge-in/interrupt-driven cancellation flushes it.
- PCM16/Float32 conversion and capture/playback adapter interfaces.

The web UI currently supplies RNNoise speech probabilities and Opus encoding.
The gateway forwards audio to native whisper-stt at `ws://127.0.0.1:8768`; the
STT service owns VAD, semantic/manual turn handling, and transcription.

## Package checks

```bash
bun run test
bun run typecheck
```
