# Sentient — Mobile SDK (`shared/mobile-sdk`)

The **blackbox client SDK** for the Sentient mobile apps, written in **Kotlin Multiplatform**
(commonMain logic + `expect`/`actual` platform edges for Android and iOS). It owns everything
between the UI and the gateway: the WebSocket transport, the wire protocol, the
session/audio/reconnect state machines, the voice pipeline (capture → gate → opus uplink,
opus downlink → playback), and tagged logging. The native apps see **one observable state
surface** and a small command API — never the gateway's internals (providers, Hermes, etc.).

It **mirrors the role and surface of `shared/web-sdk`**: same status states, same connector
capabilities, the **exact same wire frames**, and the same pure state machines (ported with
their web-sdk tests as commonTest). When the gateway protocol changes, web-sdk and mobile-sdk
change together.

## Public surface

- `SentientSdk` — the orchestrator. Exposes `connection: StateFlow<ConnectionState>`,
  `timeline`/events, `currentSessionId`, and commands (`sendText`, `startMic`/`stopMic`,
  `interrupt`, `setTtsEnabled`, sessions list/switch/new/rename/delete, `connect`/`disconnect`,
  `forceReconnect`, `onForeground`).
- Split observable surface: **continuous state** over `StateFlow` (conflation fine) +
  **one-shot no-loss notifications** over a buffered `SharedFlow` (token deltas, task upserts,
  cycle/commit, errors). Errors are a notification, never thrown across the boundary.
- Async ops are `suspend`, streams are `Flow` — both bridge cleanly to Swift async / SKIE
  `AsyncSequence`. No `Channel`/`Deferred`/raw `Job` crosses the public boundary.

## Layout (commonMain)

```
sdk/         SentientSdk orchestrator, SdkLifecycle, SdkAudio, SdkConnectors,
             AudioFsm, StateDeriver, ConnectionState, SdkConfig
transport/   WsTransport, ReconnectController + backoff, SdkStatus, WebSocketEngine (expect)
protocol/    ClientMessage / ServerMessage — the gateway wire frames (DO NOT invent envelopes)
connectors/  sessions, cognition-status, assistant-audio (downlink), user-audio (uplink), tasks
audio/       EchoGate, SpeechGate, AudioPreRollRing, opus/ (downlink decoder, uplink encoder,
             OGG demux, lazy native-codec ports)
audioio/     AudioPipeline (the voice flow manager), UplinkPump,
             AudioCaptureAdapter + AudioPlaybackAdapter (expect)
presence/    IdleDetector (disconnect-on-idle policy)
secure/ util/ log/  SecureTokenStore, Clock, tagged LogSink — all expect/actual
design/      shared design tokens (colors, spacing, type scale) the native themes mirror
dev/         FaultHooks (debug-only fault injection for E2E)
```

## expect/actual contract

Each platform capability is ONE `expect` in commonMain with one `actual` per target
(`androidMain` / `iosMain`): WebSocket engine, audio capture, audio playback, secure token
store, push-token provider, clock, log sink. `actual`s own platform lifecycle (acquire/release)
and adapt platform ↔ commonMain types — they hold **no business logic**, and no platform type
appears in an `expect` signature (`ByteArray`/`FloatArray`/`String`/`Flow`, never
`AVAudioPCMBuffer`/`AudioRecord`). Every `actual` has a fake commonTest double so the pure
logic runs without a device. See `.claude/rules/mobile-sdk/expect-actual-contract.md`.

## Build

KMP targets: `androidTarget`, `iosArm64`, `iosSimulatorArm64`. The apps consume it via the
`MobileData` XCFramework (iOS, exported from `shared/mobile-data`) and as a Gradle module
(Android).

```bash
source scripts/env.sh
./gradlew :shared:mobile-sdk:testDebugUnitTest                     # commonMain unit tests (JVM)
./gradlew :shared:mobile-data:assembleMobileDataDebugXCFramework   # iOS framework (re)build
```

## Testing

Pure state machines, codecs, gates, connectors, and reconnect logic are unit-tested in
**commonTest with NO platform** (native libopus does not load under the host-JVM target, so
the opus ports are lazy + faked). Tests pin **wire/protocol contracts** at the gateway boundary
and **FSM invariants** with documented learnings; web-sdk unit tests are ported verbatim to
hold parity. No API keys in any unit test. See `.claude/rules/mobile-sdk/*.md`,
`.claude/rules/testing.md`, and `agents/docs/mobile-sdk/`.

## commonMain purity

commonMain MUST NOT import platform APIs (`android.*`, `platform.*`/Foundation, JVM `java.*`).
No `System.currentTimeMillis()` / `Date()` — inject the `Clock` so logic is testable and
deterministic. Logger tag root is `["sentient", "mobile-sdk", ...]`, matching web-sdk.
