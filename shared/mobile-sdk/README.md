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

- `SentientSdk` — the orchestrator. Exposes continuous `StateFlow` surfaces for
  `connection`, committed `timeline`, full-state `tasks`, permissions/delegations, talk/audio
  state, and `currentSessionId`; commands cover text/voice, interrupt, preferences,
  session REST operations/activation, connection lifecycle, and liveness recovery.
- Split observable surface: **continuous complete state** over `StateFlow` (conflation fine) +
  **ordered one-shot notifications** over buffered `SharedFlow<SdkEvent>` (`MessageStarted`,
  every `MessageDelta`, commit/turn/session/permission/delegation/error/reopen events). Tool
  activity is complete state on `tasks`, not an event delta.
- Async ops are `suspend`, streams are `Flow` — both bridge cleanly to Swift async / SKIE
  `AsyncSequence`. No `Channel`/`Deferred`/raw `Job` crosses the public boundary.

## Transport boundary + resilience

The SDK follows the gateway's WS-vs-REST split (wire contract:
[`../protocol/WIRE.md`](../protocol/WIRE.md)). The **WebSocket carries the live chat
session only** — exact `turn.*`, conversation/session control, task/prompt state, audio,
and the resume handshake. `conversation.activate` focuses an existing session; history is
then fetched over REST. The gateway currently implements REST session listing and message
history under `/api/v1/sessions`; SDK methods for rename/delete must not be presented as a
supported server capability until matching handlers exist.

- **Resume handshake** — the SDK reads `seq` off every frame (peeling the 9-byte binary
  audio header), tracks `{epoch, lastSeq}`, and folds `resume` into `session.configure` on
  reconnect. `stream.resumed{recovered:true}` applies replayed frames in order;
  `recovered:false` clears/replaces local projection through REST history. The default
  cursor store is a no-op, so the cursor is in-memory unless an owner supplies persistence.
  The persisted `deviceId` identifies the client installation; replay comes from the durable
  session journal rather than a per-device conversation buffer.
- **Fire-and-forget Stop + stuck-state** — `interrupt()` clears local UI immediately and
  best-effort fires the interrupt frame (never gates on a server ack). A watchdog arms only
  when a turn is active AND the connection is not READY, resetting to idle after
  `client_stuck_state_timeout_ms` — transport-liveness-driven, NOT content-frame silence
  (a healthy slow turn can legitimately gap 30s+).

## Layout (commonMain)

```
sdk/         SentientSdk orchestrator, SdkLifecycle, SdkAudio, SdkConnectors,
             AudioFsm, StateDeriver, ConnectionState, SdkConfig
transport/   WsTransport, ReconnectController + backoff, SdkStatus, WebSocketEngine (expect)
protocol/    ClientMessage / ServerMessage — the gateway wire frames (DO NOT invent envelopes)
connectors/  sessions/history, in-flight turn text, cognition, full-state tasks,
             permissions/delegations, assistant audio (downlink), user audio (uplink)
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

Each platform capability is an `expect` or injected boundary in commonMain with a matching
platform implementation: WebSocket engine, voice audio, secure token/device-id storage,
clock, logging, and other platform services. `actual`s own platform lifecycle (acquire/release)
and adapt platform ↔ commonMain types — they hold **no business logic**, and no platform type
appears in an `expect` signature (`ByteArray`/`FloatArray`/`String`/`Flow`, never
`AVAudioPCMBuffer`/`AudioRecord`). Every `actual` has a fake commonTest double so the pure
logic runs without a device. See `.claude/rules/mobile-shared.md` and
`agents/docs/mobile-sdk/expect-actual-contract-details.md`.

## Design foundation v2

`design-foundation-v2.json` is the versioned source for the additive
`io.sentient.mobilesdk.design.v2` declarations and Web projections under
`gateway/webui/src/styles/tokens/`. Its design values and identity/material descriptors are
protocol/implementation constants: they are changed by versioning this contract, not by page
code or operator configuration. Runtime product behavior that operators may tune continues to
belong in the relevant YAML/config surface.

From the repository root, use `bun run design:foundation:generate` after an intentional
contract update and `bun run design:foundation:check` to validate locked values, Rive checksums,
and generated-file freshness. The existing unversioned `DesignTokens.kt` remains the Android
v1 compatibility surface and is not generated.

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
and **FSM invariants**; parity cases mirror the web SDK where the contract is shared. No API
keys in unit tests. See `.claude/rules/mobile-shared.md`, `agents/docs/testing-details.md`,
and `agents/docs/mobile-sdk/`.

## commonMain purity

commonMain MUST NOT import platform APIs (`android.*`, `platform.*`/Foundation, JVM `java.*`).
No `System.currentTimeMillis()` / `Date()` — inject the `Clock` so logic is testable and
deterministic. Logger tag root is `["sentient", "mobile-sdk", ...]`, matching web-sdk.
