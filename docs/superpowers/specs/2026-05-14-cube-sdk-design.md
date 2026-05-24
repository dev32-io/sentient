# Cube SDK — Phase 6 Design

**Date:** 2026-05-14
**Branch:** `feature/phase6-cube-sdk`
**Status:** Design approved, awaiting plan
**Predecessor:** Phase 5.5 Opus End-to-End Pivot (`docs/superpowers/handovers/2026-05-14-phase5.5-opus-pivot.md`)

## Goal

Build `shared/cube-sdk/` — an ESP-IDF C++ component that gives the ESP32 cube a working toggle-to-talk client against the existing sentient gateway WS protocol. End product: cube boots, presses connect → speak → hear reply, identical to webui semantics.

## Non-goals

- Conversation history rendering on cube
- Task / tool-confirm UI on cube
- Text input (no keyboard)
- Cross-device session resume
- Idle-close / presence economy (cube stays connected)
- Host-side unit tests (HIL only this phase)
- Replacement of webui's web-sdk (independent codebase, same protocol target)

## Why now

Phase 5.5 made the gateway speak opus end-to-end. Cube currently runs vendored xiaozhi WS protocol — incompatible with sentient gateway (different handshake, framing, capabilities). With opus parity on both sides of the gateway, a thin SDK can let cube reuse the exact client protocol webui already speaks. No gateway changes required.

## Architecture overview

```
┌─────────────────────────── cube firmware ───────────────────────────┐
│                                                                     │
│   ┌─ application.cc ──────────────────────────────────────────┐    │
│   │  - Boot, WiFi, board init, UI loop                        │    │
│   │  - Owns SentientSdk instance + audio adapters             │    │
│   │  - Forwards toggle press → sdk.start_streaming() / stop() │    │
│   │  - Renders sdk events → LVGL state ring + transcript      │    │
│   └────────────────┬──────────────────────────┬───────────────┘    │
│                    │ injects                  │ injects             │
│   ┌────────────────▼────────┐    ┌────────────▼─────────────┐      │
│   │ CubeAudioCaptureAdapter │    │ CubeAudioPlaybackAdapter │      │
│   │  - wraps OpusEncoder    │    │  - wraps OpusDecoder     │      │
│   │  - I2S mic → 16k opus   │    │  - 24k opus → I2S spkr   │      │
│   └────────────────┬────────┘    └────────────▲─────────────┘      │
│                    │ opus bytes                │ opus bytes         │
│   ┌────────────────▼────────────────────────────┴────────────┐    │
│   │  shared/cube-sdk/  (ESP-IDF component)                   │    │
│   │  ┌─────────────────────────────────────────────────────┐ │    │
│   │  │  SentientSdk            (connect/auth/status/recon) │ │    │
│   │  │  ├─ UserAudioInputConnector                         │ │    │
│   │  │  ├─ AssistantAudioResponseConnector                 │ │    │
│   │  │  └─ CognitionStatusConnector  (read-only)           │ │    │
│   │  │  ReconnectController                                │ │    │
│   │  │  MessageRouter                                      │ │    │
│   │  │  WsTransport  (esp_websocket_client wrapper)        │ │    │
│   │  └─────────────────────────────────────────────────────┘ │    │
│   └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │ same WS protocol as web-sdk
                                  ▼
                          gateway client WS
```

Key boundaries:
- **Cube-sdk is hardware-agnostic.** Pure C++17, depends only on ESP-IDF system components (`esp_websocket_client`, `cJSON`, `freertos`, `esp_log`). No opus, no I2S, no board headers inside the SDK.
- **Firmware owns adapters.** `CubeAudioCaptureAdapter` reuses existing `firmware/main/audio/audio_service` opus encoder + I2S mic. `CubeAudioPlaybackAdapter` reuses existing opus decoder + speaker I2S. Both implement pure-virtual interfaces from cube-sdk.
- **Single protocol target.** Matches web-sdk's gateway WS exactly: `auth` → `auth.ok` → `session.configure` → `session.ready` → binary opus uplink + JSON control. xiaozhi `protocols/` deleted.
- **State surface = 3 callbacks.** `on_status_change`, `on_cognition_status`, `on_transcript`. Firmware UI binds LVGL state to these.

## Component layout

```
shared/cube-sdk/
├── CMakeLists.txt              # idf_component_register, exposes include/, deps
├── idf_component.yml           # depends: esp_websocket_client, cJSON
├── README.md
├── include/sentient/cube-sdk/  # public headers (firmware includes these)
│   ├── sentient_sdk.h
│   ├── connectors/
│   │   ├── audio_capture_adapter.h        # IAudioCaptureAdapter (pure virtual)
│   │   ├── audio_playback_adapter.h       # IAudioPlaybackAdapter (pure virtual)
│   │   ├── user_audio_input_connector.h
│   │   ├── assistant_audio_response_connector.h
│   │   └── cognition_status_connector.h
│   ├── status.h                # enum class SdkStatus
│   ├── cognition_state.h       # enum class CognitionState
│   └── config.h                # SentientSdkConfig (url, token, adapters, callbacks)
├── src/                        # private, not exposed
│   ├── sentient_sdk.cc
│   ├── ws_transport.cc / .h
│   ├── message_router.cc / .h
│   ├── reconnect_controller.cc / .h
│   ├── status_machine.cc / .h
│   ├── frame_codec.cc / .h     # JSON encode/decode helpers (cJSON wrappers)
│   ├── connectors/
│   │   ├── user_audio_input_connector.cc
│   │   ├── assistant_audio_response_connector.cc
│   │   └── cognition_status_connector.cc
│   └── log.h                   # tagged log macros (sentient.cube.sdk.<area>)
└── tests/                      # deferred — empty in Phase 6
```

Rules per file (per `.claude/rules/esp32/cube/clean-code.md`):
- Header ≤300 lines. Impl ≤600 lines per class. Free-function files ≤300.
- Functions ≤40 lines. Max nesting 3.
- One class per `(.h + .cc)` pair. Class name == filename.
- All public types in `sentient::cube_sdk` namespace.
- No file under `src/` is included from firmware.

Firmware side (Phase 6a glue, not part of `shared/cube-sdk/`):
```
esp32/cube/firmware/main/
├── sentient_glue/                          # NEW — replaces protocols/
│   ├── cube_audio_capture_adapter.{h,cc}   # impl IAudioCaptureAdapter
│   ├── cube_audio_playback_adapter.{h,cc}  # impl IAudioPlaybackAdapter
│   └── sdk_owner.{h,cc}                    # constructs + owns SentientSdk, bridges to LVGL
├── application.cc                           # gutted: drop Protocol/ListeningMode/AbortReason
├── protocols/                               # DELETED
└── ui-shared/toggle_screen.{c,h}            # NEW (or restored) — wires sdk callbacks
```

`esp32/cube/firmware/CMakeLists.txt` adds:
```cmake
set(EXTRA_COMPONENT_DIRS ${CMAKE_SOURCE_DIR}/../../../shared/cube-sdk)
```

## Wire protocol mapping

Identical to web-sdk. SDK speaks the existing client WS — gateway needs zero changes.

### Connect flow

```
cube                                      gateway
  ─── WS open (ws://host:8080/) ─────────►
  ◄── (101 Switching Protocols) ─────────
  ─── {type:"auth", token:"<paseto>"} ──►
  ◄── {type:"auth.ok", sessionId, role}──
  ─── {type:"session.configure",
        capabilities:{supports:["audio.input","audio.output"]}} ►
  ◄── {type:"session.ready",
        audioEncoding:"opus",
        inputSampleRate:16000,
        outputSampleRate:24000} ─────────
                  (idle, WS stays open)
```

### Toggle press (start turn)

```
  ─── {type:"audio.start"} ──────────────►
  ─── <binary opus frame> ───────────────►   (50 Hz, 20 ms each, 16 kHz)
  ─── <binary opus frame> ───────────────►
  ...
  ─── {type:"audio.end"} ────────────────►   (on toggle release)
  ◄── {type:"connector.transcript.final",
        text:"hello"} ───────────────────
  ◄── {type:"cycle.started", cycleId} ───
  ◄── {type:"cognition.status",
        state:"thinking"} ───────────────
  ◄── {type:"connector.audio.start",
        cycleId, encoding:"opus",
        sampleRate:24000} ───────────────
  ◄── <binary opus frame> ───────────────   (TTS playback frames, 24 kHz)
  ...
  ◄── {type:"connector.audio.done"} ─────
  ◄── {type:"cycle.completed"} ──────────
```

### Barge-in (toggle pressed during playback)

```
  ─── {type:"audio.start"} ──────────────►
  ─── <binary opus frame> ───────────────►   (mic-onset)
  ◄── {type:"playback.stop",
        cycleId, reason:"barge-in"} ─────   (gateway aborts TTS)
                                              cube drops queued playback frames
                                              for that cycleId
  ─── <binary opus frame> ───────────────►   (uplink continues)
```

### Reconnect

Mirror `web-sdk/src/sdk-reconnect.ts` policy: exp backoff base 1 s → max 30 s, jitter 500 ms, max 5 attempts, then `Error` status. After WiFi flap, `esp_netif` connected event triggers eager reconnect.

### Frame discipline

- Uplink opus = raw RFC 6716 packets, one packet per WS binary message. No length prefix, no header. Matches Phase 5.5 webui after silence-carrier removal.
- Downlink opus = same, raw packets. Cube decoder consumes packet-at-a-time.
- JSON control = WS text message, UTF-8.
- Cube never sends `audio.start` without a fresh toggle press. Cube never sends `audio.end` without a matching `audio.start`.

### Auth header alternative — rejected

xiaozhi vendor sends `Authorization: Bearer <token>` HTTP header. Sentient gateway expects in-band `{type:"auth"}` first frame. Cube-sdk follows sentient pattern; HTTP header path is gone.

## Audio parameters

| Direction | Sample rate | Frame duration | Bitrate target | Codec |
|---|---|---|---|---|
| Uplink (mic → gateway) | 16 kHz | 20 ms (320 samples) | ~24 kbps | opus voip mode |
| Downlink (gateway → speaker) | 24 kHz | variable (Fish Audio frame size) | matches TTS output | opus voip mode |

16 kHz uplink matches STT internal rate — no resample on gateway. 24 kHz downlink matches Fish Audio TTS native rate.

## Class-level breakdown

### Public surface (`include/sentient/cube-sdk/`)

`sentient_sdk.h` — main entry, mirrors `SentientSDK` from web-sdk:

```cpp
namespace sentient::cube_sdk {

enum class SdkStatus { Disconnected, Connecting, Authenticating, Ready,
                       Reconnecting, Error };
enum class CognitionState { Idle, Thinking, Acting };

struct SentientSdkConfig {
    std::string gateway_url;          // ws://host:8080/
    std::string token;                // PASETO v4.local, baked at flash time
    IAudioCaptureAdapter*  capture;   // non-owning; firmware owns lifetime
    IAudioPlaybackAdapter* playback;  // non-owning
    std::function<void(SdkStatus)>           on_status_change;
    std::function<void(CognitionState)>      on_cognition_status;
    std::function<void(const std::string&)>  on_transcript;
};

class SentientSdk {
public:
    explicit SentientSdk(SentientSdkConfig cfg);
    ~SentientSdk();

    esp_err_t connect();
    void      disconnect();
    SdkStatus status() const;

    void start_streaming();               // toggle press
    void stop_streaming();                // toggle release

    void force_reconnect();
};

}  // namespace sentient::cube_sdk
```

`audio_capture_adapter.h` — pure virtual, firmware implements:

```cpp
class IAudioCaptureAdapter {
public:
    virtual ~IAudioCaptureAdapter() = default;
    virtual esp_err_t start() = 0;
    virtual void      stop()  = 0;
    virtual void set_frame_sink(std::function<void(const uint8_t*, size_t)> sink) = 0;
};
```

`audio_playback_adapter.h` — pure virtual, firmware implements:

```cpp
class IAudioPlaybackAdapter {
public:
    virtual ~IAudioPlaybackAdapter() = default;
    virtual esp_err_t begin_track(uint32_t sample_rate) = 0;
    virtual void      push_frame(const uint8_t* data, size_t len) = 0;
    virtual void      end_track(bool aborted) = 0;
};
```

### Private (`src/`)

| File | Class | Role |
|---|---|---|
| `ws_transport.cc/.h` | `WsTransport` | Wraps `esp_websocket_client`. JSON text in/out, binary bytes in/out. Owns reconnect timer. |
| `message_router.cc/.h` | `MessageRouter` | Parses inbound JSON (cJSON), dispatches by `type` to registered handlers. Binary frames route to playback connector. |
| `status_machine.cc/.h` | `StatusMachine` | `SdkStatus` FSM. Transitions traced via `ESP_LOGI`. |
| `reconnect_controller.cc/.h` | `ReconnectController` | Exp-backoff timer, jitter, max-attempts, force-reconnect entry. |
| `frame_codec.cc/.h` | (free fns) | `build_auth_frame(token)`, `build_session_configure(caps)`, `parse_session_ready(json)`, `build_audio_start()`, `build_audio_end()`, `build_interrupt()`. |
| `connectors/user_audio_input_connector.cc/.h` | `UserAudioInputConnector` | Owns capture lifecycle (`start_streaming` → `adapter.start()` + send `audio.start`; sinks adapter frames into `ws.send_binary`; `stop_streaming` → `adapter.stop()` + send `audio.end`). Listens for `connector.transcript.final` → fires `on_transcript`. |
| `connectors/assistant_audio_response_connector.cc/.h` | `AssistantAudioResponseConnector` | Tracks active `cycleId` from `connector.audio.start`. Routes inbound binary frames to `playback.push_frame`. `connector.audio.done` → `playback.end_track(false)`. `playback.stop` with matching `cycleId` → `playback.end_track(true)` + filter further binary frames until next `connector.audio.start`. |
| `connectors/cognition_status_connector.cc/.h` | `CognitionStatusConnector` | Listens `cognition.status` → maps state string → enum → fires `on_cognition_status`. |
| `log.h` | macros | `CUBE_SDK_LOGI(tag, fmt, ...)`, etc. Per-frame DEBUG gated on `CONFIG_CUBE_SDK_TRACE_AUDIO_FRAMES` Kconfig (default n). |

### Threading model

- `esp_websocket_client` runs its own RX task. JSON parse + router dispatch happen on that task. Fast, no allocations beyond cJSON.
- Capture adapter pushes opus frames from the audio capture task (existing `audio_service` codec task). SDK forwards bytes straight to `WsTransport::send_binary` → `esp_websocket_client_send_bin` (thread-safe per ESP-IDF docs).
- Playback adapter receives `push_frame` calls on the WS RX task. Adapter pushes into its own ring buffer; codec/I2S task drains. Backpressure: SDK does not block RX task — if adapter ring full, drop frame + WARN log (matches webui behavior).
- Status callbacks fire on the WS RX task. UI consumers (LVGL) must marshal to LVGL task — firmware glue does that, not SDK.

### What cube-sdk does NOT own

- Opus codec (firmware reuses existing `audio_service` encoder/decoder).
- I2S, mic, speaker (firmware audio drivers).
- LVGL, UI rendering, touch handler (firmware UI).
- PASETO crypto (cube never decrypts; opaque token).
- WiFi connect / network bring-up (firmware boot).

## Sequencing (vertical-slice plan)

Approach A from brainstorm. Each step lands as one commit batch, one HIL flash, green smoke before next.

### Phase 6a — In-firmware sentient WS path (no `shared/cube-sdk/` yet)

Goal: working toggle-to-talk against gateway using sentient WS, code lives in `firmware/main/protocols/sentient_ws_protocol.{h,cc}` alongside xiaozhi.

1. Drop xiaozhi `Protocol` base + `WebsocketProtocol`. Replace with new `SentientWsProtocol` class file (no inheritance hierarchy). Stub minimal: connect, auth, session.configure, session.ready, binary uplink/downlink, JSON dispatch.
2. Gut `application.cc` audio loop. Remove `kListeningMode*`, `AbortReason`, wake-word hooks, MCP hooks. Keep WiFi bring-up + board init. Audio service hooks into `SentientWsProtocol::send_audio_frame` for uplink and a new playback queue for downlink.
3. Auth frame + token bake. Reuse `scripts/bake-creds.sh` PASETO baking (already present). Cube reads `SENTIENT_GATEWAY_TOKEN` from `sentient_creds.h`.
4. Cognition state UI hook. Add LVGL state ring driven by `cognition.status` callback (placeholder visual — refined in 6c). Bind to existing toggle screen.
5. HIL smoke gate (Group A): flash cube, press toggle, speak "hello", receive TTS reply, observe ring transitions (idle → thinking → speaking → idle). Verify gateway log shows opus uplink, transcript, cycle.completed.

**Stop condition:** end-to-end loop green on one flash, no AXP2101 fault.

### Phase 6b — Lift into `shared/cube-sdk/`

Goal: identical behavior, code relocated as a proper ESP-IDF component.

1. Scaffold `shared/cube-sdk/`. CMakeLists.txt, idf_component.yml (deps: `esp_websocket_client`, `json`), include/src tree.
2. Wire firmware to consume it. `firmware/CMakeLists.txt` adds `EXTRA_COMPONENT_DIRS`. Firmware `sentient_glue/` dir replaces `protocols/`.
3. Extract classes one at a time. Migrate `SentientWsProtocol` internals → `WsTransport` + `MessageRouter` + connectors. Each extraction is one commit. After each, firmware still builds and links.
4. Replace direct audio calls with adapter interfaces. `CubeAudioCaptureAdapter` + `CubeAudioPlaybackAdapter` implement the pure-virtuals; inject into SDK via `SentientSdkConfig`.
5. Cube-sdk header surface frozen — public API matches Section "Class-level breakdown" exactly.
6. HIL smoke gate (Group A re-run): same script as 6a green again — confirms no behavior regression across the refactor.

**Stop condition:** same smoke green, no diff in gateway log shape, flash count ≤ 2.

### Phase 6c — Toggle screen UI design

Goal: cube screen feels alive. State ring + transcript matching webui shape, sized for 466×466 round AMOLED + touch.

1. lvgl-sim mockup first. Iterate state ring (idle/connecting/listening/thinking/speaking/error) visuals at ~2 s edit-build-snapshot loop. No device flash during this iteration.
2. Final design checked against device (one flash). Confirm AMOLED color reproduction, touch zone for toggle button, refresh rate during ring animation.
3. Wire SDK callbacks → LVGL task marshal → screen. Status, cognition, transcript paths. Connection-lost banner overlay if `Error` status hits.

**Stop condition:** HIL smoke includes visual checks via `cube-snapshot.sh` at each state.

### Flash budget

- 6a: 1 flash target, up to 3 if WS quirks surface.
- 6b: 1-2 flashes (re-validate after refactor).
- 6c: 1 device flash (after lvgl-sim iteration converges).

Total target: ≤ 5 flashes for Phase 6. Within `.claude/rules/esp32/cube/flash-discipline.md`.

## Error handling

Per `.claude/rules/error-handling.md`: failable ops return error code, no throw from biz logic.

| Scenario | SDK action | UI / firmware effect |
|---|---|---|
| WS connect refused (gateway down) | retry per ReconnectController; status → `Connecting` then `Reconnecting` | banner "reconnecting…", toggle disabled |
| WS handshake 401 / `auth.error` | status → `Error`, error kind = `auth`, stop retry loop | banner "auth failed — re-flash creds" |
| WS open but no `session.ready` within 10 s | close + retry; status → `Reconnecting` | banner "reconnecting…" |
| WiFi flap mid-session | `esp_netif` disconnect → SDK closes WS; on reconnect, retry; status → `Reconnecting` → `Ready` | banner during outage; clear on Ready |
| Gateway sends `error` frame | log WARN with code+message; surface via status callback if fatal | banner with code |
| Inbound JSON parse fail | log WARN, drop frame, do not crash | none (transient) |
| Inbound binary on no active cycle | drop, log DEBUG | none |
| Playback adapter ring full | drop frame, log WARN (rate-limited 1/s) | none (audio glitch tolerable) |
| Capture adapter start fails | log ERROR, send `audio.end`, status callback fires `Error` | banner "mic init failed" |
| `playback.stop` received | call `playback.end_track(true)`, drop further frames for that cycleId | TTS cuts immediately |
| 5 reconnect attempts exhausted | status → `Error`, error kind = `network`, stop loop | banner "tap to reconnect"; UI calls `force_reconnect()` |

All branches log INFO at entry + outcome. No silent swallows.

## Testing strategy

Per `.claude/rules/esp32/cube/testing.md`: HIL only, real cube + real gateway, no mocks. No host-side unit tests in Phase 6 (deferred).

**Test surfaces:**
- `esp32/cube/tests/hil/test_sentient_audio_toggle.py` — Group A, agent-driven.
- `esp32/cube/tests/hil/test_sentient_reconnect.py` — Group A.
- `esp32/cube/tests/hil/test_sentient_barge_in.py` — Group B (needs `cube-cmd audio.inject_pcm` from Phase 4.5; user confirms manually before run).

**Fixtures:** existing `cube_dut`, `serial_dut`, `gateway_logs`. New verbs:
- `sentient.status` — returns current `SdkStatus` for assertion.
- `sentient.force_reconnect` — UI button equivalent.
- `sentient.last_transcript` — agent reads last transcript string.

## Smoke matrix

Phase 6 done = every row green.

| # | Case | How | Stop condition |
|---|---|---|---|
| S1 | Boot → WS connect → `session.ready` | flash, wait, `sentient.status` returns `Ready` within 8 s | gateway log shows auth.ok + session.configure + session.ready for cube's deviceId |
| S2 | Toggle press → audio uplink → transcript | `touch.tap` on toggle, inject PCM "hello", release | gateway log shows `connector.transcript.final` with non-empty text; `sentient.last_transcript` matches |
| S3 | Cycle → TTS playback audible | continue from S2 | gateway log `cycle.completed`; cube speaker emits audio (operator ear-check; agent verifies `connector.audio.done` log + state transitions via `sentient.status`) |
| S4 | Barge-in mid-TTS | start playback, `touch.tap` again, inject PCM | gateway log `playback.stop reason=barge-in`; cube cuts playback within 200 ms |
| S5 | Reconnect after gateway restart | `docker compose restart gateway`, wait | cube status Ready → Reconnecting → Ready within 30 s; no AXP2101 fault |
| S6 | WiFi drop simulation | unplug → replug AP (operator step, Group B) | cube status cycles correctly; resumes on AP up |
| S7 | Invalid token (corrupt creds) | flash with bad token | status reaches `Error`, kind `auth`, no retry storm in log |
| S8 | UI state ring matches state | snapshot after each state in S1-S4 via `cube-snapshot.sh` | colors/shape match design in 6c spec |

S1, S2, S4, S5, S7, S8 are agent-automated (Group A). S3 and S6 require operator (Group B/C) — flagged in handover.

## Logging budget verification

- During S1-S5 capture, gateway UDP log sink ingest rate must stay ≤ 100 lines/sec from cube. Per-frame DEBUG is OFF by default; if enabled (`CONFIG_CUBE_SDK_TRACE_AUDIO_FRAMES=y`), rate is ~50 lines/sec/direction = ~100 lines/sec sustained. Acceptable for diagnostic use; agent flips off after.
- Lifecycle INFO during one full turn: ~12 lines (auth, configure, ready, audio.start, transcript, cycle.started, cognition, audio.start, audio.done, cycle.completed, audio.end, status changes).
- No raw token bytes, no raw audio payload, no full transcript > 120 chars in any log.

## Pre-merge gate

Per `.claude/rules/e2e-testing.md` pre-handover gate:
- All 8 smoke cases green, evidence captured (`.playwright-mcp/`-equivalent dir for cube screenshots).
- Lint + typecheck + unit-tests clean (gateway side regression check).
- Flash count + AXP2101 faults + daemon restarts recorded in handover.
- `bun run ci` green.

## Open questions

None — all decisions converged in brainstorm.

## Related artifacts

- Phase 5.5 handover: `docs/superpowers/handovers/2026-05-14-phase5.5-opus-pivot.md`
- Web-sdk reference: `shared/web-sdk/src/sentient-sdk.ts`
- Cube v2 rescope: `docs/superpowers/specs/2026-05-11-esp32-cube-v2-rescope-design.md`
- Cube C/C++ rules: `.claude/rules/esp32/cube/clean-code.md`
- Wire protocol source of truth: `shared/protocol/src/messages.ts`
