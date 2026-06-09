# Mobile Opus Parity + Device-Test UX Gaps

**Date:** 2026-06-05
**Branch:** `feature/mobile-client`
**Mode:** subagent-driven-development (fresh implementer per task → spec review → quality review, continuous)

## Why

Physical-iPhone device testing surfaced a batch of defects. The headline is an
**audio codec parity gap**: the gateway pivoted to **end-to-end Opus** (Phase 5.5,
`gateway/config.yaml:138 format: opus`); the mobile SDK is still **PCM16 end-to-end**
and never implemented Opus (it was explicitly deferred). Result — BOTH audio
directions are broken on mobile:

- **Downlink (TTS):** gateway streams OGG-Opus (48 kHz, 32 kbps); web decodes via
  `ogg-opus-decoder` WASM; mobile feeds the OGG-Opus bytes straight into
  `pcm16ToFloat32` → **pure static**.
- **Uplink (STT):** gateway opens the STT socket `?audioFormat=opus`
  (`gateway/src/bootstrap/stt-factory.ts:38`, gateway-wide, NOT per-client); web
  sends raw Opus packets; mobile sends raw PCM16 → STT decodes garbage → **no
  transcripts**.

`session.ready.audioEncoding="pcm16"` is stale/misleading — the real per-stream
encoding is in `connector.audio.start.encoding="opus"`. The real downlink rate is
48 kHz, but mobile ignores `session.ready.outputSampleRate` and uses the 24 kHz
config default.

Plus 5 UX defects (new-chat spinner, history hang/spinner, account header
"You"/centering, drawer drag-back, local-network permission first-connect failure).

## Locked decisions

- **Codec lib:** `eu.buney.kopus:kopus:1.6.1.2` (MIT) — KMP wrapper over libopus,
  prebuilt binaries for `androidTarget`, `iosArm64`, `iosSimulatorArm64` (verified
  on Maven Central). Single `commonMain` Gradle dep, no cinterop/NDK work. Does raw
  opus packet encode + decode only.
- **OGG-Opus downlink demux:** hand-rolled streaming demuxer in `commonMain` (pure
  Kotlin, fully `commonTest`-able) feeding kopus's raw-packet decoder. Do NOT pull
  in `libopusfile`/`libogg`. Pure-Kotlin Concentus is NOT viable for iOS K/N — not used.
- **Encoder params:** 16 kHz mono, 20 ms frames, application=VOIP, 24 kbps (matches
  existing 16 kHz capture; opus is rate-flexible, STT server resamples). One capture
  frame (320 samples @16k) → one packet → one WS binary frame.
- **Decoder output:** libopus decodes to 48 kHz; output PCM16 LE @ 48 kHz, enqueue to
  the existing playback adapter unchanged; connect the player at **48 kHz** (apply
  `session.ready.outputSampleRate`). No resample needed (player runs at decode rate).
- **Encoding branch:** the downlink keys on `connector.audio.start.encoding` —
  `"opus"` → demux+decode, `"pcm16"` → passthrough (keeps the SDK correct if the
  gateway ever serves pcm16).
- **Test placement:** the pure-Kotlin OGG demuxer + PCM convert are tested in
  `commonTest` (run everywhere). The kopus encode/decode round-trip touches native
  libopus, which is NOT loadable in host Android unit tests (`testDebugUnitTest`) — a
  single round-trip sanity test runs as **`iosSimulatorArm64Test`** instead; broader
  proof comes from e2e.
- **iOS drawer:** native left-edge interactive — UIKit `UIScreenEdgePanGestureRecognizer`
  + interactive transition bridged via `UIViewControllerRepresentable`; replaces the
  hand-rolled `panelDrag`/`panelX` overlay.
- **Android drawer:** switch to Material3 `ModalNavigationDrawer` (native interactive
  drag in+out) if the current impl is hand-rolled — Android parity of the "native way".
- **New-chat spinner:** delete the `.sessionStarting` affordance entirely (both
  platforms). An empty chat is a normal typeable state, not a loading state.
- **Display name:** persist the logged-in user's display name at login; expose via the
  app store; replace the hardcoded `"You"` (iOS `ChatView`/`HistorySidePanel`/
  `MessageList`; Android `ChatScreen`).

## Phases

### Audio — shared SDK (commonMain)

**A1. kopus dependency + PCM convert util**
- Add `eu.buney.kopus:kopus:1.6.1.2` to `gradle/libs.versions.toml` + `shared/mobile-sdk`
  `commonMain.dependencies`. Confirm `:shared:mobile-sdk:assembleMobileSdkDebugXCFramework`
  + `:android:assembleDebug` still resolve/build for all targets.
- `commonMain/.../audio/PcmConvert.kt`: `floatToPcm16Shorts`/`pcm16ShortsToFloat` and
  `pcm16LeBytes↔ShortArray` helpers (kopus encode wants `ShortArray`; decode returns
  PCM the pipeline serializes to LE bytes). Reuse the existing `AudioCodec.kt` math.
- Tests (commonTest): PcmConvert round-trip + endianness.

**A2. OggOpusDemuxer (pure Kotlin, commonMain)** — the risky core.
- `commonMain/.../audio/opus/OggOpusDemuxer.kt`: stateful, chunked. `push(bytes): List<ByteArray>`
  (raw opus packets) + `preSkip: Int` from `OpusHead` + `reset()`.
- Handle: rolling input buffer (partial pages across WS chunks); 27-byte page header +
  lacing table; packet reassembly (255-run continuation, cross-page via continuation
  flag); `OpusHead` parse (channels, pre-skip, input rate) + `OpusTags` skip; BOS/EOS.
- Tests (commonTest): byte-split fixtures (split mid-header, mid-lacing, mid-packet),
  cross-page packet reassembly, pre-skip extraction, reset clears state, EOS. Test sad
  paths hard (truncated page, garbage capture pattern → skip+resync).
- Fixtures: a small real OGG-Opus blob captured from the gateway (commit as a test resource).

**A3. Opus encoder + decoder wrappers (commonMain, kopus)**
- `OpusUplinkEncoder.kt`: wraps `kopus.OpusEncoder(16000, 1, OpusApplication.Voip)`,
  `setBitrate(24000)`; `encode(ShortArray): ByteArray?`; `close()`. Logs per-packet bytes.
- `OpusDownlinkDecoder.kt`: owns an `OggOpusDemuxer` + `kopus.OpusDecoder(48000, 1)`;
  `decode(oggChunk): List<ByteArray>` (PCM16 LE @48k frames, pre-skip dropped); `reset()`;
  `close()`. Logs packets-in/frames-out/preskip-dropped.
- Tests (iosSimulatorArm64Test): encode→decode round-trip on a known sine frame →
  non-empty, RMS within tolerance. (NOT in testDebugUnitTest — native lib absent on host.)

**A4. Downlink integration (AudioPipeline + connector)**
- Thread `connector.audio.start.encoding` through to `AudioPipeline.onAudioStart(cycleId, encoding)`
  (ServerMessage already carries `encoding`). On start: if `opus`, `decoder.reset()` and mark
  opus mode; if `pcm16`, passthrough mode.
- `onAudioFrame`: opus mode → `decoder.decode(chunk)` → each PCM16 frame goes through the
  existing `playbackReady`/`pendingFrames` buffer → `playback.enqueue`. pcm16 mode →
  current behavior.
- `onAudioDone`/`onPlaybackStop`/`release`: `decoder.reset()`/`close()`.
- Apply 48 kHz: stop ignoring `session.ready.outputSampleRate`. Make the pipeline's
  `outputSampleRate` reflect the negotiated 48 k (apply session.ready, or set
  `DEFAULT_OUTPUT_SAMPLE_RATE = 48_000` and have `playback.start` use it). Player connects
  at 48 k.
- Tests (commonTest): downlink FSM with a fake decoder + fake playback — opus chunk →
  decoded frames enqueued in order; pcm16 passthrough unchanged; barge-in discards pending.

**A5. Uplink integration (UserAudioInputConnector / AudioPipeline)**
- Insert the encoder AFTER the echo gate / pre-roll ring (gate stays PCM-domain, per web).
  Each forwarded PCM frame → `encoder.encode(shorts)` → `sendBinary(packet)`.
- Encoder lifecycle tied to mic start/stop (`startStreaming`/`stopStreaming`): create on
  start, `close()` on stop.
- Tests (commonTest): with a fake encoder, each accepted frame yields exactly one sent
  packet; rejected frames send nothing; pre-roll flush encodes each buffered frame once.

**A6. Build artifacts**
- Rebuild XCFramework + iOS app + Android APK (`--rerun-tasks` to bust stale incremental).

### Audio — verification (agent-driven, log-based + listen)

**A7. iOS audio e2e** (sim for frame-flow; physical device for true audibility — flag device-only).
**A8. Android audio e2e** parity.

### UI — iOS

**U1. New-chat spinner removal** — delete `.sessionStarting` from `LoadingAffordance` +
  `ChatLoadingView`; `chatLoading()` returns `.none` when `.ready`. Empty chat is typeable.

**U2. History hang/spinner** — add a timeout to the sessions fetch (SDK `listSessions` or
  the store wrapper; per error-handling rule "timeout every external call") → surfaces the
  existing `SessionsErrorEmpty`; trigger `historyModel.refresh()` whenever the panel becomes
  visible (drag-open AND hamburger), not only `openPanel()`.

**U3. Account header centering** — `HistoryAccountHeader`: omit the `household` `Text` when
  empty so the single name line centers against the avatar.

**U4. Display-name surface** — persist the selected user's display name at login
  (`AuthModel.performLogin` success → save name alongside token); expose `SdkStore.displayName`;
  replace `"You"` in `ChatView` (MessageList userName + side panel userName), `MessageBubble`
  user avatar initial. (Confirm the `AuthUserLite` name field.)

**U5. Native left-edge drawer** — replace `ChatView` hand-rolled `panelDrag`/`panelX` ZStack
  overlay with a UIKit interactive presentation: `UIViewControllerRepresentable` hosting a
  container whose leading-edge `UIScreenEdgePanGestureRecognizer` + interactive transition
  drives the history panel in/out (system-grade finger tracking both directions, scrim,
  velocity, tap-to-dismiss). History panel content (`HistorySidePanel`) reused as the
  presented content. Keep a11y id `history-open` (toolbar fallback button) for tests.

**U6. Local-network permission** — add `NSLocalNetworkUsageDescription` to `ios/project.yml`
  Info.plist properties; pre-trigger the iOS Local Network prompt on `BackendSetupView`
  appear via a short-lived `NWBrowser` (Bonjour scan) so the dialog resolves before Connect;
  add a one-shot auto-retry in `BackendSetupModel.probeThenApply` (and the login/connect
  probe) so a just-granted permission is absorbed instead of shown as failure.

### UI — Android (parity)

**U7. Android parity** — drop the `.sessionStarting`/sessionStarting `LoadingPill` case;
  wire the display name into `ChatScreen` (replace the `userName="You"` TODO); add the
  sessions-fetch timeout + refresh-on-open; account-header centering if applicable; switch
  the history drawer to Material3 `ModalNavigationDrawer` if hand-rolled (native interactive
  drag in+out).

### Final

**U8. Quality gate + full e2e** — `:shared:mobile-sdk:testDebugUnitTest` +
  `:iosSimulatorArm64Test`; iOS + Android builds; lint; every e2e matrix row green.

## E2E matrix (inline — mandatory)

> Mobile-adapted columns. iOS sim id `DB6D8CAF-B12E-44CA-87EB-6A0DD51FFA75`; Android
> `emulator-5554`. Real-audio audibility + Local-Network dialog are **physical-device-only**
> — flagged for operator/user follow-up where the sim/emulator can't reproduce.

| Case | Platform/Device | Pre-state | Action | Expected user-visible | Expected log trail |
|------|-----------------|-----------|--------|------------------------|--------------------|
| TTS-audible | iOS device | logged in, TTS on, text chat | send "say hi" | assistant voice plays **clearly, no static** | `audio.start encoding=opus` → demuxer `packets=N preskip-dropped` → decode `frames=M` → `downlink-frame`→enqueue → player `session-open playerRate=48000 playing=true` → `downlink-done`; no `enqueue-no-player`/`frame-dropped` |
| TTS-frameflow | iOS sim | as above | send "say hi" | (no audio on sim) | same decode→enqueue trail present (frame flow proven without audibility) |
| STT-transcript | iOS device | logged in, mic granted | tap mic, say "what time is it" | transcript preview fills; assistant answers | uplink `opus packet` frames sent → gateway STT `turn_started`→`transcript` → `connector.transcript.final` |
| TTS-bargein | iOS device | TTS playing | tap mic / Stop mid-TTS | audio stops immediately | `playback.stop` → decoder `reset` → pending discarded; next cycle decodes clean |
| pcm16-fallback | iOS sim | force gateway `format: pcm` | send msg | audio plays (passthrough path) | `audio.start encoding=pcm16` → passthrough enqueue (no demux) |
| TTS-audible-android | Android emu | logged in, TTS on | send "say hi" | voice plays clearly | decode→enqueue→AudioTrack trail; no `enqueue-no-track`/`frame-dropped` |
| STT-android | Android emu | mic granted | tap mic, speak | transcript + answer | uplink opus packets → transcript.final |
| newchat-no-spinner | iOS sim + Android emu | logged in | tap "+" / open empty chat | composer immediately typeable; **no "Starting a new chat…" spinner** | no `.sessionStarting`; `sendQueue`/`newChat` only |
| history-spinner | iOS sim + Android emu | logged in | open drawer (slow/unreachable sidecar) | spinner shows, then list OR error affordance — **never indefinite hang** | `refresh` → `loading=true` → `loaded` or timeout→`load-failed`+error UI |
| history-refresh-on-drag | iOS sim | logged in | drag-open the drawer (not hamburger) | list loads (spinner→rows) | `refresh` fires on drag-open path too |
| account-name | iOS sim + Android emu | logged in as "Kevin" | open drawer header | shows **"Kevin"** (not "You"), vertically centered against avatar, no empty household line | display-name surfaced; header single-line centered |
| account-centering-visual | iOS device/sim | logged in, empty household | screenshot drawer header | **visual**: avatar circle and name baseline vertically centered (screenshot assert, not just a11y-id existence) | — |
| drawer-native-drag | iOS device | in chat | edge-swipe drawer out, then drag it back | panel **follows the finger both directions**, velocity-dismiss, scrim dims | interactive transition events; no jank/stick |
| drawer-android-drag | Android emu | in chat | swipe drawer in/out | ModalNavigationDrawer tracks finger both ways | drawer state transitions |
| localnet-firstconnect | iOS device | fresh install, unconfigured | enter LAN host:port, tap Connect | Local Network prompt appears **before**/at connect; after Allow, connect **succeeds on first real attempt** (no spurious failure) | NWBrowser probe on setup-appear; probe retry absorbs grant; `save.ok` |

> Sad/edge coverage: barge-in mid-TTS, pcm16 fallback, unreachable-sidecar timeout, drag-back,
> first-connect permission race, byte-split OGG chunks (unit). Device-only: true audibility,
> Local-Network dialog — flag in handover.

## Risks

- **kopus bus factor** (single maintainer, MIT). Mitigation: thin libopus wrapper, vendorable;
  fallback `io.voxkit:kopus` (Apache-2.0). Pin the version; do not float.
- **OGG streaming buffering** (partial pages, cross-page packets, pre-skip) is the real
  engineering — exhaustive commonTest with byte-split fixtures.
- **Native handle lifecycle** on K/N — `encoder.close()`/`decoder.close()` on teardown (no GC).
- **Sim vs device** — codec round-trip + frame-flow verifiable on sim; true audibility +
  Local-Network dialog need the physical iPhone (user/operator).
- **Encoder rate** — 16 kHz mono confirmed compatible (STT server resamples); web uses 48 kHz
  but either is valid Opus.
