# Phase 6 — Cube SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

---

## Progress checkpoint (2026-05-15)

Execution paused mid-Phase-6a to brainstorm the agent dev-tool refactor
(see `docs/superpowers/specs/2026-05-15-esp32-devtool-design.md` when
written). Resume from Phase 6a smoke verification once devtool lands and
the new HTTP-based snapshot path is wired.

### Completed (committed)

- [x] **Task 1** — `OPUS_FRAME_DURATION_MS` set to 20 + `CUBE_SDK_TRACE_AUDIO_FRAMES` Kconfig added. (commits `2173d0a`, `22d8e4d`)
- [x] **Task 2** — `SentientWsProtocol` header (`firmware/main/protocols/sentient_ws_protocol.h`). (commits `0bf4b37`, `39bd322`)
- [x] **Task 3** — Connect / auth scaffold + WS event handler. (commits `1fd5b2d`, `73124d6`)
- [x] **Task 4** — JSON message dispatch + 10 per-type handlers. (commit `8e9207c`)
- [x] **Task 5** — Binary opus uplink + downlink + `notify_uplink_available`. (commit `96e4408`)
- [x] **Task 6** — Reconnect controller (exp backoff + jitter + max-attempts) + 10s `arm_ready_timeout`. (commit `3eefe65`)
- [x] **Task 7** — Gutted `application.cc` / `device_state_machine.*`, wired `SentientWsProtocol`. Concerns: kept dead `DeviceState` enum values (50+ external case branches reference them — deferred cleanup); 1-line fix in `boards/sentient-cube/sentient_cube.cc`. (commit `49792f5`)
- [x] **Task 8** — Deleted xiaozhi `protocols/protocol.{h,cc}`, `protocols/websocket_protocol.{h,cc}`, `verbs/ws.cc`. Extracted `AudioStreamPacket` to `firmware/main/audio/audio_stream_packet.h` so `audio_service.h` no longer depends on the deleted `protocol.h`. (commits `050b619`, `e07c864`)
- [x] **Task 9** — Added `sentient.status`, `sentient.force_reconnect`, `sentient.last_transcript` HIL verbs. Used callback-provider pattern (not direct include) to honor `main↔agent_console` layering rule. (commit `f5b4d8b`)
- [x] **Task 10** — Phase 6a HIL tests + fixtures: `test_sentient_audio_toggle.py`, `test_sentient_reconnect.py`, `test_sentient_barge_in.py`, `test_sentient_bad_token.py`. WAV fixtures `hello_16k.wav`, `long_question_16k.wav`. Verb-signature fixes (`button.toggle`, `params=` kwarg, `pcm_b64` for inject). (commits `30dcf06`, `e3f8ac6`)

### Off-plan work that landed (kept; useful)

- **Thermal mitigation:** `CONFIG_CUBE_DEV_AGGRESSIVE_POWER_SAVE` + `CONFIG_CUBE_DEV_LOW_BRIGHTNESS_PERCENT=30` in `sdkconfig.defaults.debug`, board init honors both. Drops AMOLED self-heat ~3× for hour-long dev sessions and re-enables 60s idle dim while USB-tethered.
- **bake-creds.sh hardening:** auto-resolves Mac LAN IP (no static `GATEWAY_HOST` in `.e2e-testing` for debug profile) AND mints a fresh PASETO token via `gateway/scripts/mint-cube-token.ts` on every bake. `.e2e-testing` `GATEWAY_WS_PATH` corrected from `/api/v1/ws/xiaozhi` → `/api/v1/ws`.
- **TLS pin + SAN bypass:** `SentientWsProtocolConfig.cert_pem` + `.skip_tls_cn_check` plumbed; application.cc passes the embedded dev cert with name-check off (dev cert SAN is `localhost+127.0.0.1`, cube dials Mac LAN IP).
- **Protocol clientType:** `clientTypeSchema` added to `shared/protocol/src/messages.ts` (REQUIRED, fail-loud on missing). Gateway side records `ws.data.clientType` and routes through `tts-policy.ts` `ttsSkipReason()` — cube bypasses `ttsEnabled`, webui respects it. Web-sdk sends `clientType:"webui"`. Cube sends `clientType:"cube"`.
- **Hermes-error reconnect on cube:** `handle_error_frame` calls `force_reconnect()` on `code` starting `"hermes"` (gateway ACP wire dead → mint fresh chain on next configure).
- **Toggle screen visual feedback hooks:** UI controller exposes `sentient_cube_set_transcript` + driven from `application.cc`. Each `OnSdk*` handler pushes a short `sdk:/cognition:/playback:` event line into the hint label. Button shrunk 320→220px. Montserrat 28pt baked. **UI iteration still incomplete — toggle visual feedback observed dimming-only by operator; needs more cycles in lvgl-sim once the screen is sim-buildable.**
- **`esp32/todo.md`:** two entries logged — `ui.tap_at` generic touch-event verb, `lvgl-sim coverage for toggle_button_screen`.

### Smoke status

- **S1 boot→Ready** — green via pytest (`test_boot_to_ready`).
- **S2 toggle→transcript** — verified manually end-to-end. STT transcribed user audio; Hermes cycle ran (127 chars assistant response, MCP tool calls). Pytest variant still uses `button.toggle` verb path which doesn't fully exercise the LVGL touch handler.
- **S4 barge-in** — Group B operator-only, deferred.
- **S5 reconnect** — green via pytest (`test_reconnect_after_gateway_restart`).
- **S7 bad-token** — Group B operator-only, deferred.

### Outstanding before Phase 6a can be called green

- [ ] **Snapshot path foundation rebuild** — current `ui.snapshot` USB-CDC chunked path is fundamentally broken (USB-Serial-JTAG drops bytes when host stalls). Two fix attempts reverted (`5dc8ad3` → reverted in `cef27b3`; `291de1b` → reverted in `11590fa`). **Decision: pivot to HTTP-over-WiFi snapshot via new `esp32-devtool` CLI.** See devtool design spec when written.
- [ ] **Toggle screen UX rework** — operator observation: physical tap on the smaller 220px button shows only a brightness dim, no state ring or transcript reflection. SDK callbacks fire but the visual coupling isn't expressive enough. Needs lvgl-sim iteration loop, which itself is blocked on the `toggle_button_screen` sim-buildability gap (see `esp32/todo.md`).
- [ ] **Pytest S2 against the actual LVGL touch handler** — current `button.toggle` verb bypasses LVGL. Blocked on `ui.tap_at` verb (see `esp32/todo.md`).
- [ ] **Per-user audio-prefs scoping bug** (gateway-side) — webui session flipping `ttsEnabled` doesn't propagate to cube's session. Out of Phase 6 scope but flagged for follow-up; cube's bypass-via-clientType makes this moot for cube. File it as a separate gateway ticket.

### Phase 6b — Lift into `shared/cube-sdk/`

- [ ] **Tasks 11-26** — not started. Phase 6a SDK is feature-complete in `firmware/main/protocols/sentient_ws_protocol.{h,cc}`; tasks 11-25 extract that into the shared component without behavior change. Resume after Phase 6a smoke fully green.

### Phase 6c — Toggle screen UI

- [ ] **Tasks 27-29** — partially started in off-plan work (resize, font, hint+transcript). Full re-design + lvgl-sim integration deferred until devtool lands.
- [ ] **Task 30** — handover, deferred to end.

---

**Goal:** Replace cube's xiaozhi WS client with a thin sentient-protocol SDK so the ESP32-S3 cube speaks the same gateway WS as web-sdk and reaches working toggle-to-talk.

**Architecture:** Vertical-slice first (Phase 6a: in-firmware `SentientWsProtocol` replaces xiaozhi `protocols/`). Then lift into `shared/cube-sdk/` as an ESP-IDF component (Phase 6b: extract WsTransport, MessageRouter, connectors, adapter interfaces). Then polish the LVGL toggle screen (Phase 6c). Each phase ends with a HIL smoke gate.

**Tech Stack:** ESP-IDF 5.x, C++17, FreeRTOS, `esp_websocket_client`, `cJSON`, LVGL 9, PASETO v4.local (token consumed opaquely — no crypto on device), pytest-embedded for HIL.

**Spec:** `docs/superpowers/specs/2026-05-14-cube-sdk-design.md`

**Worktree:** `feature/phase6-cube-sdk` (already checked out at `.claude/worktrees/phase6-cube-sdk/`).

---

## Working notes for the implementer

- **Source of truth for the wire protocol:** `shared/protocol/src/messages.ts`. The gateway side stays unchanged.
- **Source of truth for client behavior:** `shared/web-sdk/src/sentient-sdk.ts`, `shared/web-sdk/src/sdk-reconnect.ts`, `shared/web-sdk/src/connectors/user-audio-input-connector.ts`, `shared/web-sdk/src/connectors/assistant-audio-response-connector.ts`. Mirror semantics; do not copy structure verbatim — C++ idiom differs.
- **Flash discipline (`.claude/rules/esp32/cube/flash-discipline.md`):** one flash per smoke-bar unit. Build between edits. Edit-build-edit-build until ready, then one flash + smoke.
- **Daemon must be running before every smoke:** `bash esp32/cube/scripts/flash.sh` eager-spawns it. Killing + restarting daemon counts as a reset.
- **Logging budget (`.claude/rules/esp32/cube/logging.md`):** lifecycle INFO unconditional; per-frame DEBUG gated behind a Kconfig flag (default off). Tag scheme `sentient.cube.sdk.<area>` for cube-sdk code, `sentient.cube.<area>` for firmware-side glue. ≤120-char previews; never log raw tokens or audio.
- **C/C++ clean code (`.claude/rules/esp32/cube/clean-code.md`):** header ≤300 lines, impl ≤600 lines per class, functions ≤40 lines, snake_case for variables/methods, RAII, no magic numbers (use Kconfig or config struct).
- **PR scope:** Phase 6a, 6b, 6c land as three separable commit ranges on the same feature branch. Smoke green at each boundary before continuing.

---

## File structure overview

### New files

**Phase 6a (in-firmware sentient WS):**
- `esp32/cube/firmware/main/protocols/sentient_ws_protocol.h` — single-class header, ≤300 lines
- `esp32/cube/firmware/main/protocols/sentient_ws_protocol.cc` — impl, ≤600 lines
- `esp32/cube/firmware/components/agent_console/verbs/sentient.cc` — new HIL verbs
- `esp32/cube/tests/hil/test_sentient_audio_toggle.py`
- `esp32/cube/tests/hil/test_sentient_reconnect.py`
- `esp32/cube/tests/hil/test_sentient_bad_token.py`

**Phase 6b (cube-sdk component):**
- `shared/cube-sdk/CMakeLists.txt`
- `shared/cube-sdk/idf_component.yml`
- `shared/cube-sdk/README.md`
- `shared/cube-sdk/Kconfig`
- `shared/cube-sdk/include/sentient/cube-sdk/sentient_sdk.h`
- `shared/cube-sdk/include/sentient/cube-sdk/status.h`
- `shared/cube-sdk/include/sentient/cube-sdk/cognition_state.h`
- `shared/cube-sdk/include/sentient/cube-sdk/config.h`
- `shared/cube-sdk/include/sentient/cube-sdk/connectors/audio_capture_adapter.h`
- `shared/cube-sdk/include/sentient/cube-sdk/connectors/audio_playback_adapter.h`
- `shared/cube-sdk/include/sentient/cube-sdk/connectors/user_audio_input_connector.h`
- `shared/cube-sdk/include/sentient/cube-sdk/connectors/assistant_audio_response_connector.h`
- `shared/cube-sdk/include/sentient/cube-sdk/connectors/cognition_status_connector.h`
- `shared/cube-sdk/src/sentient_sdk.cc`
- `shared/cube-sdk/src/ws_transport.{h,cc}`
- `shared/cube-sdk/src/message_router.{h,cc}`
- `shared/cube-sdk/src/status_machine.{h,cc}`
- `shared/cube-sdk/src/reconnect_controller.{h,cc}`
- `shared/cube-sdk/src/frame_codec.{h,cc}`
- `shared/cube-sdk/src/log.h`
- `shared/cube-sdk/src/connectors/user_audio_input_connector.cc`
- `shared/cube-sdk/src/connectors/assistant_audio_response_connector.cc`
- `shared/cube-sdk/src/connectors/cognition_status_connector.cc`
- `esp32/cube/firmware/main/sentient_glue/cube_audio_capture_adapter.{h,cc}`
- `esp32/cube/firmware/main/sentient_glue/cube_audio_playback_adapter.{h,cc}`
- `esp32/cube/firmware/main/sentient_glue/sdk_owner.{h,cc}`

**Phase 6c (UI):**
- `esp32/cube/firmware/ui-shared/toggle_screen.{h,c}` (new — replaces test screen as default boot UI)

### Deleted files

- `esp32/cube/firmware/main/protocols/protocol.{h,cc}` (after 6a verifies new path)
- `esp32/cube/firmware/main/protocols/websocket_protocol.{h,cc}` (after 6a verifies new path)
- `esp32/cube/firmware/main/protocols/sentient_ws_protocol.{h,cc}` (at end of 6b after extraction)
- `esp32/cube/firmware/components/agent_console/verbs/ws.cc` (replaced by `sentient.cc`)

### Modified files

- `esp32/cube/firmware/main/application.{h,cc}` — gut audio/state hooks tied to xiaozhi Protocol
- `esp32/cube/firmware/main/CMakeLists.txt` — add new source files, drop old protocols/
- `esp32/cube/firmware/CMakeLists.txt` — add `EXTRA_COMPONENT_DIRS` for cube-sdk (Phase 6b)
- `esp32/cube/firmware/main/Kconfig.projbuild` — add `CONFIG_CUBE_SDK_TRACE_AUDIO_FRAMES`
- `esp32/cube/firmware/main/device_state_machine.{h,cc}` — strip listening-mode / wake-word states (keep idle / connecting / listening / speaking / error)

---

# Phase 6a — In-firmware sentient WS path

Goal at end of 6a: cube boots, connects to gateway with sentient protocol, toggle press → spoken response heard from speaker. HIL smoke S1, S2, S5, S7 green.

---

### Task 1: Lock OPUS_FRAME_DURATION_MS to 20 + add Kconfig flag for audio-frame trace logs

**Files:**
- Modify: `esp32/cube/firmware/main/Kconfig.projbuild`
- Modify: `esp32/cube/firmware/main/audio/audio_service.h` (verify the macro path)

- [ ] **Step 1: Find current OPUS_FRAME_DURATION_MS definition**

Run:
```bash
grep -rn "OPUS_FRAME_DURATION_MS" esp32/cube/firmware/main/Kconfig.projbuild esp32/cube/firmware/sdkconfig.defaults
```

Expected: a `CONFIG_OPUS_FRAME_DURATION_MS` entry. Note its current value (likely 60).

- [ ] **Step 2: Add CONFIG_CUBE_SDK_TRACE_AUDIO_FRAMES Kconfig entry**

In `esp32/cube/firmware/main/Kconfig.projbuild`, append a new menu entry:

```kconfig
menu "Sentient cube SDK"

config CUBE_SDK_TRACE_AUDIO_FRAMES
    bool "Trace every audio frame at DEBUG level"
    default n
    help
        When enabled, the sentient cube SDK logs an ESP_LOGD line for
        every uplink and downlink opus frame. Useful for diagnostic
        runs; leave off in production because it produces ~100 UDP
        log lines/sec which can saturate the net_logger sink.

endmenu
```

- [ ] **Step 3: Set OPUS_FRAME_DURATION_MS to 20 in sdkconfig.defaults**

Edit `esp32/cube/firmware/sdkconfig.defaults`: change the existing `CONFIG_OPUS_FRAME_DURATION_MS=60` line (if present) to `CONFIG_OPUS_FRAME_DURATION_MS=20`. If the symbol doesn't exist, leave a TODO comment and stop — the audio frame duration is centralized elsewhere; do not bypass.

- [ ] **Step 4: Build and confirm no regression**

Run:
```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -30
```

Expected: clean build, no new warnings related to OPUS macros. The encoder now produces 20 ms frames.

- [ ] **Step 5: Commit**

```bash
git add esp32/cube/firmware/main/Kconfig.projbuild esp32/cube/firmware/sdkconfig.defaults
git commit -m "chore(cube): opus 20ms frames + CUBE_SDK_TRACE_AUDIO_FRAMES Kconfig

EOF"
```

---

### Task 2: Write the SentientWsProtocol header (Phase 6a in-firmware)

**Files:**
- Create: `esp32/cube/firmware/main/protocols/sentient_ws_protocol.h`

- [ ] **Step 1: Write the header**

Create `esp32/cube/firmware/main/protocols/sentient_ws_protocol.h`:

```cpp
#pragma once

#include <cJSON.h>
#include <esp_err.h>
#include <esp_event.h>
#include <esp_websocket_client.h>

#include <atomic>
#include <chrono>
#include <functional>
#include <mutex>
#include <string>

namespace sentient::cube {

enum class SdkStatus {
    Disconnected,
    Connecting,
    Authenticating,
    Ready,
    Reconnecting,
    Error,
};

enum class CognitionState {
    Idle,
    Thinking,
    Acting,
};

struct SentientWsProtocolConfig {
    std::string gateway_url;
    std::string token;
    // Callbacks (all optional; the protocol logs INFO regardless).
    std::function<void(SdkStatus)> on_status_change;
    std::function<void(CognitionState)> on_cognition_status;
    std::function<void(const std::string&)> on_transcript;
    // Uplink: protocol calls this to fetch a single opus packet from the firmware's
    // audio service send queue. Returns true if a packet was placed in *out_data
    // (caller-owned heap buffer in *out_data) and its size in *out_len. Returns false
    // if no packet is available right now.
    std::function<bool(uint8_t** out_data, size_t* out_len)> on_pop_uplink_frame;
    // Downlink: protocol calls this on each inbound binary opus packet during an
    // active TTS cycle. Caller must copy bytes before returning.
    std::function<void(const uint8_t* data, size_t len, int sample_rate)> on_playback_frame;
    // Playback lifecycle.
    std::function<void(int sample_rate)> on_playback_begin;
    std::function<void(bool aborted)> on_playback_end;
};

// Single-class in-firmware sentient WS client. Phase 6b extracts the internals
// into shared/cube-sdk/. This class is intentionally larger than typical Phase 6a
// scope because it consolidates connect/auth/router/reconnect into one unit for
// the vertical-slice smoke. ≤600 lines impl per clean-code rule; if it threatens
// the cap, split out frame_codec helpers first.
class SentientWsProtocol {
public:
    explicit SentientWsProtocol(SentientWsProtocolConfig cfg);
    ~SentientWsProtocol();

    SentientWsProtocol(const SentientWsProtocol&) = delete;
    SentientWsProtocol& operator=(const SentientWsProtocol&) = delete;

    esp_err_t connect();
    void disconnect();
    SdkStatus status() const;

    // Toggle press / release.
    void start_streaming();
    void stop_streaming();

    // UI "tap to reconnect".
    void force_reconnect();

    // Latest user transcript seen for the active session (for HIL verb).
    std::string last_transcript() const;

private:
    void set_status(SdkStatus next);
    void send_text(const std::string& text);
    void send_binary(const uint8_t* data, size_t len);

    void handle_text(const char* data, size_t len);
    void handle_binary(const uint8_t* data, size_t len);
    void handle_auth_ok(const cJSON* root);
    void handle_session_ready(const cJSON* root);
    void handle_transcript_final(const cJSON* root);
    void handle_cycle_started(const cJSON* root);
    void handle_cycle_completed(const cJSON* root);
    void handle_cognition_status(const cJSON* root);
    void handle_connector_audio_start(const cJSON* root);
    void handle_connector_audio_done(const cJSON* root);
    void handle_playback_stop(const cJSON* root);
    void handle_error_frame(const cJSON* root);

    void pump_uplink();
    void schedule_reconnect();
    void cancel_reconnect();

    static void ws_event_handler(void* arg,
                                 esp_event_base_t base,
                                 int32_t event_id,
                                 void* event_data);

    SentientWsProtocolConfig cfg_;
    esp_websocket_client_handle_t client_ = nullptr;

    mutable std::mutex state_mutex_;
    SdkStatus status_ = SdkStatus::Disconnected;
    std::string session_id_;
    std::string active_cycle_id_;        // current TTS cycle, "" if none
    std::string last_transcript_;
    int active_input_sample_rate_ = 16000;
    int active_output_sample_rate_ = 24000;

    std::atomic<bool> is_streaming_{false};
    std::atomic<int> reconnect_attempts_{0};
    esp_timer_handle_t reconnect_timer_ = nullptr;
    esp_timer_handle_t ready_timeout_timer_ = nullptr;
};

}  // namespace sentient::cube
```

- [ ] **Step 2: Build verifies the header**

Run:
```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -30
```

Expected: header is unused so far; build passes.

- [ ] **Step 3: Commit**

```bash
git add esp32/cube/firmware/main/protocols/sentient_ws_protocol.h
git commit -m "feat(cube/protocols): SentientWsProtocol header (Phase 6a)

EOF"
```

---

### Task 3: Implement SentientWsProtocol — connect + auth + session.configure

**Files:**
- Create: `esp32/cube/firmware/main/protocols/sentient_ws_protocol.cc`

- [ ] **Step 1: Scaffold the impl with connect / disconnect / set_status / send_text**

Create `esp32/cube/firmware/main/protocols/sentient_ws_protocol.cc` with the constructor, destructor, `connect`, `disconnect`, `set_status`, `send_text`, and the `esp_websocket_client` event handler. Key implementation points:

```cpp
#include "sentient_ws_protocol.h"

#include <cstring>
#include <esp_log.h>
#include <esp_timer.h>

namespace sentient::cube {

namespace {

constexpr const char* TAG = "sentient.cube.sdk.ws";
constexpr int kReadyTimeoutMs = 10000;
constexpr int kReconnectBaseMs = 1000;
constexpr int kReconnectMaxMs = 30000;
constexpr int kReconnectMaxAttempts = 5;
constexpr int kReconnectJitterMs = 500;

const char* status_name(SdkStatus s) {
    switch (s) {
        case SdkStatus::Disconnected: return "Disconnected";
        case SdkStatus::Connecting: return "Connecting";
        case SdkStatus::Authenticating: return "Authenticating";
        case SdkStatus::Ready: return "Ready";
        case SdkStatus::Reconnecting: return "Reconnecting";
        case SdkStatus::Error: return "Error";
    }
    return "?";
}

}  // namespace

SentientWsProtocol::SentientWsProtocol(SentientWsProtocolConfig cfg)
    : cfg_(std::move(cfg)) {
    ESP_LOGI(TAG, "ctor gateway_url=%s token_preview=%.8s...",
             cfg_.gateway_url.c_str(),
             cfg_.token.c_str());
}

SentientWsProtocol::~SentientWsProtocol() {
    disconnect();
}

esp_err_t SentientWsProtocol::connect() {
    if (client_ != nullptr) {
        ESP_LOGW(TAG, "connect: client already exists, ignoring");
        return ESP_OK;
    }
    set_status(SdkStatus::Connecting);
    esp_websocket_client_config_t ws_cfg = {};
    ws_cfg.uri = cfg_.gateway_url.c_str();
    ws_cfg.reconnect_timeout_ms = 0;     // we own reconnect, not esp_websocket_client
    ws_cfg.disable_auto_reconnect = true;
    ws_cfg.buffer_size = 4096;
    client_ = esp_websocket_client_init(&ws_cfg);
    if (client_ == nullptr) {
        ESP_LOGE(TAG, "connect: esp_websocket_client_init returned NULL");
        set_status(SdkStatus::Error);
        return ESP_FAIL;
    }
    esp_err_t err = esp_websocket_register_events(client_, WEBSOCKET_EVENT_ANY, ws_event_handler, this);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "connect: register_events failed err=%d", err);
        set_status(SdkStatus::Error);
        return err;
    }
    return esp_websocket_client_start(client_);
}

void SentientWsProtocol::disconnect() {
    cancel_reconnect();
    if (client_ != nullptr) {
        esp_websocket_client_stop(client_);
        esp_websocket_client_destroy(client_);
        client_ = nullptr;
    }
    set_status(SdkStatus::Disconnected);
}

SdkStatus SentientWsProtocol::status() const {
    std::lock_guard<std::mutex> lock(state_mutex_);
    return status_;
}

void SentientWsProtocol::set_status(SdkStatus next) {
    SdkStatus prev;
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        if (status_ == next) return;
        prev = status_;
        status_ = next;
    }
    ESP_LOGI(TAG, "status: %s -> %s", status_name(prev), status_name(next));
    if (cfg_.on_status_change) cfg_.on_status_change(next);
}

void SentientWsProtocol::send_text(const std::string& text) {
    if (client_ == nullptr || !esp_websocket_client_is_connected(client_)) {
        ESP_LOGW(TAG, "send_text: not connected, dropping len=%zu", text.size());
        return;
    }
    esp_websocket_client_send_text(client_, text.c_str(), text.size(), portMAX_DELAY);
}

void SentientWsProtocol::send_binary(const uint8_t* data, size_t len) {
    if (client_ == nullptr || !esp_websocket_client_is_connected(client_)) return;
    esp_websocket_client_send_bin(client_, reinterpret_cast<const char*>(data), len, portMAX_DELAY);
}

void SentientWsProtocol::ws_event_handler(void* arg, esp_event_base_t, int32_t event_id, void* event_data) {
    auto* self = static_cast<SentientWsProtocol*>(arg);
    auto* ed = static_cast<esp_websocket_event_data_t*>(event_data);
    switch (event_id) {
        case WEBSOCKET_EVENT_CONNECTED: {
            ESP_LOGI(TAG, "ws: connected, sending auth");
            self->set_status(SdkStatus::Authenticating);
            cJSON* root = cJSON_CreateObject();
            cJSON_AddStringToObject(root, "type", "auth");
            cJSON_AddStringToObject(root, "token", self->cfg_.token.c_str());
            char* s = cJSON_PrintUnformatted(root);
            self->send_text(s);
            cJSON_free(s);
            cJSON_Delete(root);
            break;
        }
        case WEBSOCKET_EVENT_DATA:
            if (ed->op_code == 0x01 /* text */ || ed->op_code == 0x00 /* continuation text */) {
                self->handle_text(reinterpret_cast<const char*>(ed->data_ptr), ed->data_len);
            } else if (ed->op_code == 0x02 /* binary */) {
                self->handle_binary(reinterpret_cast<const uint8_t*>(ed->data_ptr), ed->data_len);
            }
            break;
        case WEBSOCKET_EVENT_DISCONNECTED:
        case WEBSOCKET_EVENT_CLOSED:
            ESP_LOGI(TAG, "ws: disconnect event=%d", static_cast<int>(event_id));
            self->set_status(SdkStatus::Reconnecting);
            self->schedule_reconnect();
            break;
        case WEBSOCKET_EVENT_ERROR:
            ESP_LOGW(TAG, "ws: error event");
            break;
        default: break;
    }
}

}  // namespace sentient::cube
```

(Methods `handle_text`, `handle_binary`, `schedule_reconnect`, `cancel_reconnect`, `pump_uplink`, etc. defined as `{}` stubs for now — Tasks 4-6 fill them in.)

- [ ] **Step 2: Register sentient_ws_protocol.cc in main CMakeLists.txt**

Edit `esp32/cube/firmware/main/CMakeLists.txt`: add `protocols/sentient_ws_protocol.cc` to the `SRCS` list. Do NOT remove the existing `protocols/websocket_protocol.cc` or `protocols/protocol.cc` yet (Task 8 deletes them).

- [ ] **Step 3: Build**

Run:
```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -20
```

Expected: clean build. Unused-stub warnings are acceptable for this task.

- [ ] **Step 4: Commit**

```bash
git add esp32/cube/firmware/main/protocols/sentient_ws_protocol.cc esp32/cube/firmware/main/CMakeLists.txt
git commit -m "feat(cube/protocols): SentientWsProtocol connect/auth scaffold

EOF"
```

---

### Task 4: Implement JSON message dispatch in SentientWsProtocol

**Files:**
- Modify: `esp32/cube/firmware/main/protocols/sentient_ws_protocol.cc`

- [ ] **Step 1: Implement handle_text + the message dispatch table**

Fill in `handle_text` and the per-type handlers. Critical points:
- `auth.ok` → `set_status(Ready)` is **not** the right move yet; the gateway sends `session.ready` afterward; set status `Authenticating` already; record `sessionId`. Send `session.configure` immediately.
- `session.ready` → set status `Ready`. Record `inputSampleRate`, `outputSampleRate`. Cancel ready-timeout timer.
- `connector.transcript.final` → store in `last_transcript_`, fire `on_transcript`.
- `cycle.started` → record `cycleId` (NOT in `active_cycle_id_` — that field is for the TTS cycle which arrives via `connector.audio.start`).
- `cognition.status` → map state string → `CognitionState`, fire `on_cognition_status`.
- `connector.audio.start` → record `cycleId` in `active_cycle_id_`, fire `on_playback_begin(sampleRate)`.
- `connector.audio.done` → if `cycleId` matches `active_cycle_id_`, clear `active_cycle_id_`, fire `on_playback_end(false)`.
- `playback.stop` → if `cycleId` matches `active_cycle_id_`, clear `active_cycle_id_`, fire `on_playback_end(true)`. Log reason.
- `cycle.completed` → no action beyond INFO log (UI may want this — fire `on_cognition_status(Idle)` defensively if cognition was Acting/Thinking).
- `error` → log WARN with code + message. If `code == "auth.error"` or `code == "auth.expired"`, set status `Error` and stop the reconnect loop.

Acceptance via test in Task 5; here just implement the dispatch.

Code (skeleton for `handle_text` — the full per-type body uses `cJSON_GetObjectItem(root, "type")` then `strcmp` against each literal):

```cpp
void SentientWsProtocol::handle_text(const char* data, size_t len) {
    cJSON* root = cJSON_ParseWithLength(data, len);
    if (root == nullptr) {
        ESP_LOGW(TAG, "handle_text: parse error len=%zu", len);
        return;
    }
    const cJSON* type = cJSON_GetObjectItem(root, "type");
    if (!cJSON_IsString(type)) {
        ESP_LOGW(TAG, "handle_text: missing type");
        cJSON_Delete(root);
        return;
    }
    const char* t = type->valuestring;
    if      (strcmp(t, "auth.ok") == 0)                    handle_auth_ok(root);
    else if (strcmp(t, "session.ready") == 0)              handle_session_ready(root);
    else if (strcmp(t, "connector.transcript.final") == 0) handle_transcript_final(root);
    else if (strcmp(t, "cycle.started") == 0)              handle_cycle_started(root);
    else if (strcmp(t, "cycle.completed") == 0)            handle_cycle_completed(root);
    else if (strcmp(t, "cognition.status") == 0)           handle_cognition_status(root);
    else if (strcmp(t, "connector.audio.start") == 0)      handle_connector_audio_start(root);
    else if (strcmp(t, "connector.audio.done") == 0)       handle_connector_audio_done(root);
    else if (strcmp(t, "playback.stop") == 0)              handle_playback_stop(root);
    else if (strcmp(t, "error") == 0)                      handle_error_frame(root);
    else if (strcmp(t, "pong") == 0)                       { /* ignore */ }
    else ESP_LOGD(TAG, "handle_text: unhandled type=%s", t);
    cJSON_Delete(root);
}
```

Implement each `handle_*` per the points above.

- [ ] **Step 2: Build**

Run:
```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add esp32/cube/firmware/main/protocols/sentient_ws_protocol.cc
git commit -m "feat(cube/protocols): SentientWsProtocol JSON dispatch table

EOF"
```

---

### Task 5: Implement binary opus uplink + downlink

**Files:**
- Modify: `esp32/cube/firmware/main/protocols/sentient_ws_protocol.cc`

- [ ] **Step 1: Implement handle_binary**

```cpp
void SentientWsProtocol::handle_binary(const uint8_t* data, size_t len) {
    std::string current_cycle;
    int sample_rate;
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        current_cycle = active_cycle_id_;
        sample_rate = active_output_sample_rate_;
    }
    if (current_cycle.empty()) {
        ESP_LOGD(TAG, "handle_binary: no active cycle, dropping len=%zu", len);
        return;
    }
#if CONFIG_CUBE_SDK_TRACE_AUDIO_FRAMES
    ESP_LOGD(TAG, "rx opus cycle=%s len=%zu sr=%d", current_cycle.c_str(), len, sample_rate);
#endif
    if (cfg_.on_playback_frame) cfg_.on_playback_frame(data, len, sample_rate);
}
```

- [ ] **Step 2: Implement start_streaming + stop_streaming + pump_uplink**

```cpp
void SentientWsProtocol::start_streaming() {
    if (status() != SdkStatus::Ready) {
        ESP_LOGW(TAG, "start_streaming: not Ready, ignoring");
        return;
    }
    if (is_streaming_.exchange(true)) return;
    send_text("{\"type\":\"audio.start\"}");
    ESP_LOGI(TAG, "uplink: audio.start");
    // pump_uplink runs on a FreeRTOS task spawned here; alternatively the firmware
    // glue calls pump_uplink() from the on_send_queue_available callback. Phase 6a
    // uses the callback path because AudioServiceCallbacks::on_send_queue_available
    // already fires every time an opus packet is encoded.
}

void SentientWsProtocol::stop_streaming() {
    if (!is_streaming_.exchange(false)) return;
    send_text("{\"type\":\"audio.end\"}");
    ESP_LOGI(TAG, "uplink: audio.end");
}

void SentientWsProtocol::pump_uplink() {
    if (!is_streaming_.load()) return;
    if (!cfg_.on_pop_uplink_frame) return;
    uint8_t* buf = nullptr;
    size_t len = 0;
    while (is_streaming_.load() && cfg_.on_pop_uplink_frame(&buf, &len)) {
        if (buf == nullptr || len == 0) break;
#if CONFIG_CUBE_SDK_TRACE_AUDIO_FRAMES
        ESP_LOGD(TAG, "tx opus len=%zu", len);
#endif
        send_binary(buf, len);
        free(buf);  // contract: on_pop_uplink_frame returns heap-allocated buffer
        buf = nullptr;
        len = 0;
    }
}
```

- [ ] **Step 3: Wire pump_uplink to be callable from application.cc** (the actual call site is added in Task 7)

No code change here — just confirm `pump_uplink` is public via a passthrough or that the firmware glue can call it (the design says: AudioService callback → application.cc → `protocol.pump_uplink()`). Add a public method:

In header, add:
```cpp
public:
    void notify_uplink_available();
```

In cc:
```cpp
void SentientWsProtocol::notify_uplink_available() {
    pump_uplink();
}
```

- [ ] **Step 4: Build**

Run:
```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
```

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add esp32/cube/firmware/main/protocols/sentient_ws_protocol.h esp32/cube/firmware/main/protocols/sentient_ws_protocol.cc
git commit -m "feat(cube/protocols): binary opus uplink + downlink wiring

EOF"
```

---

### Task 6: Implement reconnect controller + ready-timeout in SentientWsProtocol

**Files:**
- Modify: `esp32/cube/firmware/main/protocols/sentient_ws_protocol.cc`

- [ ] **Step 1: Implement schedule_reconnect + cancel_reconnect**

```cpp
void SentientWsProtocol::schedule_reconnect() {
    int attempts = reconnect_attempts_.fetch_add(1) + 1;
    if (attempts > kReconnectMaxAttempts) {
        ESP_LOGW(TAG, "reconnect: exhausted attempts=%d, setting Error", attempts);
        set_status(SdkStatus::Error);
        return;
    }
    int delay_ms = std::min(kReconnectBaseMs * (1 << (attempts - 1)), kReconnectMaxMs);
    delay_ms += esp_random() % kReconnectJitterMs;
    ESP_LOGI(TAG, "reconnect: attempt=%d delay_ms=%d", attempts, delay_ms);
    cancel_reconnect();
    esp_timer_create_args_t args = {};
    args.callback = [](void* arg) {
        auto* self = static_cast<SentientWsProtocol*>(arg);
        if (self->client_ != nullptr) {
            esp_websocket_client_destroy(self->client_);
            self->client_ = nullptr;
        }
        self->connect();
    };
    args.arg = this;
    esp_timer_create(&args, &reconnect_timer_);
    esp_timer_start_once(reconnect_timer_, static_cast<uint64_t>(delay_ms) * 1000);
}

void SentientWsProtocol::cancel_reconnect() {
    if (reconnect_timer_ != nullptr) {
        esp_timer_stop(reconnect_timer_);
        esp_timer_delete(reconnect_timer_);
        reconnect_timer_ = nullptr;
    }
}

void SentientWsProtocol::force_reconnect() {
    reconnect_attempts_.store(0);
    cancel_reconnect();
    if (client_ != nullptr) {
        esp_websocket_client_destroy(client_);
        client_ = nullptr;
    }
    connect();
}
```

- [ ] **Step 2: Implement ready-timeout — close socket if session.ready doesn't arrive in 10 s**

Add the timer setup at the end of `handle_auth_ok` (since at that point we've sent `session.configure` and expect `session.ready` within 10 s). On firing, close the WS client → triggers WEBSOCKET_EVENT_DISCONNECTED → `schedule_reconnect`. In `handle_session_ready`, stop + delete the timer.

- [ ] **Step 3: Clear reconnect_attempts on successful session.ready**

In `handle_session_ready`, after setting status to `Ready`, call `reconnect_attempts_.store(0);`.

- [ ] **Step 4: Build + run gateway-down smoke (no flash yet — just gateway log inspection)**

Run:
```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
```

Expected: clean build. (Real reconnect smoke is in Task 11 HIL.)

- [ ] **Step 5: Commit**

```bash
git add esp32/cube/firmware/main/protocols/sentient_ws_protocol.cc
git commit -m "feat(cube/protocols): reconnect controller + ready-timeout

EOF"
```

---

### Task 7: Gut application.cc + wire SentientWsProtocol

**Files:**
- Modify: `esp32/cube/firmware/main/application.h`
- Modify: `esp32/cube/firmware/main/application.cc`
- Modify: `esp32/cube/firmware/main/device_state_machine.{h,cc}` (drop wake-word and listening-mode states)

This is the biggest single edit in Phase 6a. The xiaozhi `Application` class currently owns the `Protocol` pointer, the listening-mode state machine, wake-word lifecycle, and MCP plumbing. None of that survives.

- [ ] **Step 1: List what stays vs goes**

Keeps:
- Board init, codec init, WiFi bring-up wait.
- AudioService construction + `Initialize(codec)` + `Start()`.
- LVGL task creation.
- DeviceStateMachine — but only `kDeviceStateIdle`, `kDeviceStateConnecting`, `kDeviceStateListening`, `kDeviceStateSpeaking`, `kDeviceStateFatalError`. Remove `kDeviceStateUnknown`, `kDeviceStateStarting` (collapse into Connecting), `kDeviceStateWifiConfiguring`, `kDeviceStateUpgrading`, `kDeviceStateActivating`, `kDeviceStateAudioTesting`.

Removes:
- `Protocol*` member + `WebsocketProtocol` construction.
- `ListeningMode`, `AbortReason`, `SendWakeWordDetected`, `SendStartListening`, `SendStopListening`, `SendAbortSpeaking`, `SendMcpMessage`.
- Wake-word hooks (`EnableWakeWordDetection`).
- Any `OnIncomingJson`-style callbacks tied to xiaozhi protocol.
- The whole "main task" loop that polled the protocol — `SentientWsProtocol` is event-driven via esp_websocket_client.

Replaces:
- `protocol_` → `sentient_ws_` (unique_ptr<SentientWsProtocol>).
- After WiFi up: read `SENTIENT_GATEWAY_URL` and `SENTIENT_GATEWAY_TOKEN` from `sentient_creds.h`. Build `SentientWsProtocolConfig`. Wire `on_pop_uplink_frame` → calls `AudioService::PopPacketFromSendQueue()` and copies the bytes into a freshly malloc'd buffer. Wire `on_playback_frame` → wraps in `AudioStreamPacket` + `AudioService::PushPacketToDecodeQueue`. Wire `on_playback_begin(sample_rate)` → `AudioService::SetDecodeSampleRate(sample_rate, 20)` + `AudioService::ResetDecoder()`. Wire `on_playback_end(aborted)` → `AudioService::ResetDecoder()` if aborted.
- Wire `AudioServiceCallbacks::on_send_queue_available` → `sentient_ws_->notify_uplink_available()`.
- Wire `on_status_change` → DeviceStateMachine transitions: `Ready`→Idle, `Connecting`→Connecting, `Reconnecting`→Connecting, `Error`→FatalError.
- Wire `on_cognition_status` → Idle/Thinking/Acting → DeviceStateMachine: Acting→Listening or Speaking depending on whether playback active.
- Wire `on_playback_begin/end` → DeviceStateMachine Speaking ↔ Idle.

- [ ] **Step 2: Apply the edits**

Make the edits in `application.h`, `application.cc`, `device_state_machine.{h,cc}`. The diff will be large (probably 500-800 lines removed, 200-300 lines added). Do not delete `protocols/protocol.{h,cc}` or `protocols/websocket_protocol.{h,cc}` yet — Task 8 handles deletion after we verify the new path builds.

Treat this as one edit pass. Each helper function inside `application.cc` should remain ≤40 lines per clean-code rule; if the wiring grows, factor into a helper like `wire_audio_service(SentientWsProtocol&, AudioService&)` and `wire_state_callbacks(SentientWsProtocol&, DeviceStateMachine&)`.

- [ ] **Step 3: Build**

Run:
```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -30
```

Expected: clean build. If the build references symbols from removed `Protocol`-based files, investigate — those references must move.

- [ ] **Step 4: Commit**

```bash
git add esp32/cube/firmware/main/application.h esp32/cube/firmware/main/application.cc esp32/cube/firmware/main/device_state_machine.h esp32/cube/firmware/main/device_state_machine.cc
git commit -m "refactor(cube/application): gut xiaozhi Protocol, wire SentientWsProtocol

EOF"
```

---

### Task 8: Delete xiaozhi `protocols/protocol.{h,cc}` + `websocket_protocol.{h,cc}`

**Files:**
- Delete: `esp32/cube/firmware/main/protocols/protocol.h`
- Delete: `esp32/cube/firmware/main/protocols/protocol.cc`
- Delete: `esp32/cube/firmware/main/protocols/websocket_protocol.h`
- Delete: `esp32/cube/firmware/main/protocols/websocket_protocol.cc`
- Modify: `esp32/cube/firmware/main/CMakeLists.txt`
- Delete: `esp32/cube/firmware/components/agent_console/verbs/ws.cc` (covered by the new `sentient.cc` in Task 9)

- [ ] **Step 1: Delete the files**

```bash
git rm esp32/cube/firmware/main/protocols/protocol.h \
       esp32/cube/firmware/main/protocols/protocol.cc \
       esp32/cube/firmware/main/protocols/websocket_protocol.h \
       esp32/cube/firmware/main/protocols/websocket_protocol.cc \
       esp32/cube/firmware/components/agent_console/verbs/ws.cc
```

- [ ] **Step 2: Update main/CMakeLists.txt — remove the deleted sources**

Strip the four protocol entries from the SRCS list.

- [ ] **Step 3: Update components/agent_console/CMakeLists.txt — remove ws.cc**

- [ ] **Step 4: Build**

Run:
```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
```

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "refactor(cube): drop xiaozhi Protocol + WebsocketProtocol

EOF"
```

---

### Task 9: Add HIL verbs `sentient.status`, `sentient.force_reconnect`, `sentient.last_transcript`

**Files:**
- Create: `esp32/cube/firmware/components/agent_console/verbs/sentient.cc`
- Modify: `esp32/cube/firmware/components/agent_console/CMakeLists.txt`
- Modify: `esp32/cube/firmware/main/application.{h,cc}` (expose a hook to query state from a verb)

- [ ] **Step 1: Add an accessor in Application**

In `application.h`, declare:
```cpp
SentientWsProtocol* sentient_ws();
```

In `application.cc`, return `sentient_ws_.get()`.

- [ ] **Step 2: Write the verb file**

```cpp
// esp32/cube/firmware/components/agent_console/verbs/sentient.cc
#include "dispatcher.h"
#include "application.h"
#include "protocols/sentient_ws_protocol.h"

#include <cJSON.h>

using sentient::cube::SdkStatus;

namespace {

const char* status_str(SdkStatus s) {
    switch (s) {
        case SdkStatus::Disconnected:   return "Disconnected";
        case SdkStatus::Connecting:     return "Connecting";
        case SdkStatus::Authenticating: return "Authenticating";
        case SdkStatus::Ready:          return "Ready";
        case SdkStatus::Reconnecting:   return "Reconnecting";
        case SdkStatus::Error:          return "Error";
    }
    return "?";
}

int verb_status(const cJSON*, cJSON* out, int*, const char**) {
    auto* ws = Application::Instance().sentient_ws();
    cJSON_AddStringToObject(out, "status", ws ? status_str(ws->status()) : "uninit");
    return 0;
}

int verb_force_reconnect(const cJSON*, cJSON* out, int*, const char**) {
    auto* ws = Application::Instance().sentient_ws();
    if (ws) ws->force_reconnect();
    cJSON_AddBoolToObject(out, "ok", ws != nullptr);
    return 0;
}

int verb_last_transcript(const cJSON*, cJSON* out, int*, const char**) {
    auto* ws = Application::Instance().sentient_ws();
    cJSON_AddStringToObject(out, "text", ws ? ws->last_transcript().c_str() : "");
    return 0;
}

__attribute__((constructor)) void register_verbs() {
    agent_dispatcher_register("sentient.status", verb_status);
    agent_dispatcher_register("sentient.force_reconnect", verb_force_reconnect);
    agent_dispatcher_register("sentient.last_transcript", verb_last_transcript);
}

}  // namespace
```

- [ ] **Step 3: Register the source + WHOLE_ARCHIVE**

Edit `esp32/cube/firmware/components/agent_console/CMakeLists.txt`: add `verbs/sentient.cc` to SRCS. Confirm `WHOLE_ARCHIVE` is set on the `idf_component_register` (`.claude/rules/esp32/cube/build.md` requires this for constructor-attribute registration).

- [ ] **Step 4: Build**

Run:
```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
```

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add esp32/cube/firmware/components/agent_console/verbs/sentient.cc esp32/cube/firmware/components/agent_console/CMakeLists.txt esp32/cube/firmware/main/application.h esp32/cube/firmware/main/application.cc
git commit -m "feat(cube/agent_console): sentient.* verbs for HIL

EOF"
```

---

### Task 10: HIL smoke S1 + S2 + S5 + S7 + flash

**Files:**
- Create: `esp32/cube/tests/hil/test_sentient_audio_toggle.py`
- Create: `esp32/cube/tests/hil/test_sentient_reconnect.py`
- Create: `esp32/cube/tests/hil/test_sentient_bad_token.py`

- [ ] **Step 1: Write test_sentient_audio_toggle.py (S1 + S2)**

```python
# esp32/cube/tests/hil/test_sentient_audio_toggle.py
"""S1 boot → ready; S2 toggle press → opus uplink → final transcript."""
from __future__ import annotations
import time
import pytest

WAVE_PCM_PATH = "esp32/cube/tests/hil/fixtures/hello_16k.wav"  # generated once, committed

@pytest.mark.group_a
def test_boot_to_ready(cube_dut, gateway_logs):
    pos = gateway_logs.position()
    rsp = cube_dut.cmd("sentient.status")
    assert rsp["result"]["status"] == "Ready", f"expected Ready, got {rsp}"
    assert gateway_logs.grep(r"auth\.ok.*deviceId", since_pos=pos)
    assert gateway_logs.grep(r"session\.configure", since_pos=pos)
    assert gateway_logs.grep(r"session\.ready", since_pos=pos)

@pytest.mark.group_a
def test_toggle_uplink_transcript(cube_dut, gateway_logs):
    cube_dut.cmd("touch.tap", {"x": 233, "y": 233})  # toggle button center
    time.sleep(0.2)
    cube_dut.cmd("audio.inject_pcm", {"wav": WAVE_PCM_PATH})
    cube_dut.cmd("touch.tap", {"x": 233, "y": 233})  # release
    time.sleep(2.0)
    rsp = cube_dut.cmd("sentient.last_transcript")
    text = rsp["result"]["text"]
    assert text, f"empty transcript: {rsp}"
    assert gateway_logs.grep(r"connector\.transcript\.final.*hello", since_pos=None) or "hello" in text.lower()
```

- [ ] **Step 2: Write test_sentient_reconnect.py (S5)**

```python
# esp32/cube/tests/hil/test_sentient_reconnect.py
"""S5 cube survives a gateway restart within 30 s."""
from __future__ import annotations
import subprocess, time
import pytest

@pytest.mark.group_a
def test_reconnect_after_gateway_restart(cube_dut, gateway_logs):
    pos = gateway_logs.position()
    subprocess.check_call(
        ["docker", "compose", "-f", "deploy/macos/docker-compose.yml", "restart", "gateway"]
    )
    deadline = time.time() + 30
    last = None
    while time.time() < deadline:
        rsp = cube_dut.cmd("sentient.status")
        last = rsp["result"]["status"]
        if last == "Ready":
            return
        time.sleep(1.0)
    pytest.fail(f"cube did not reach Ready within 30s; last status={last}")
```

- [ ] **Step 3a: Write test_sentient_barge_in.py (S4 — Group B, operator-confirmed)**

```python
# esp32/cube/tests/hil/test_sentient_barge_in.py
"""S4 toggle press during TTS playback cuts the playback within 200ms."""
import time
import pytest

WAVE = "esp32/cube/tests/hil/fixtures/hello_16k.wav"
LONG_TURN_TEXT = "esp32/cube/tests/hil/fixtures/long_question_16k.wav"  # ~3s clip

@pytest.mark.group_b  # operator confirms toggle screen behavior
def test_barge_in_cuts_playback(cube_dut, gateway_logs):
    # 1) trigger a long turn so TTS plays for several seconds.
    cube_dut.cmd("touch.tap", {"x": 233, "y": 233})
    time.sleep(0.2)
    cube_dut.cmd("audio.inject_pcm", {"wav": LONG_TURN_TEXT})
    cube_dut.cmd("touch.tap", {"x": 233, "y": 233})  # release
    # 2) wait until gateway log shows TTS playback start.
    pos = gateway_logs.position()
    deadline = time.time() + 5
    while time.time() < deadline:
        if gateway_logs.grep(r"connector\.audio\.start.*encoding.*opus", since_pos=pos):
            break
        time.sleep(0.2)
    else:
        pytest.fail("TTS playback did not start within 5s")
    # 3) press toggle again to barge in.
    barge_pos = gateway_logs.position()
    cube_dut.cmd("touch.tap", {"x": 233, "y": 233})
    time.sleep(0.5)
    # 4) gateway should emit playback.stop reason=barge-in.
    assert gateway_logs.grep(r"playback\.stop.*reason=barge-in", since_pos=barge_pos), \
        "gateway did not emit playback.stop within 500ms"
```

A second fixture is needed — a longer clip that elicits a 3+ second response (e.g. "What is the capital of France and why is it the capital?"):

```bash
say -o /tmp/long_question.aiff "What is the capital of France and why is it the capital"
ffmpeg -y -i /tmp/long_question.aiff -ar 16000 -ac 1 -sample_fmt s16 \
    esp32/cube/tests/hil/fixtures/long_question_16k.wav
```

- [ ] **Step 3: Write test_sentient_bad_token.py (S7)**

```python
# esp32/cube/tests/hil/test_sentient_bad_token.py
"""S7 corrupt token in creds → Error, no retry storm."""
import pytest

@pytest.mark.group_b  # operator-confirmed because it requires re-flash with bad creds
def test_bad_token_yields_error(cube_dut, gateway_logs):
    rsp = cube_dut.cmd("sentient.status")
    assert rsp["result"]["status"] == "Error"
    # Ensure no retry storm: ≤5 attempts.
    count = gateway_logs.count(r"sentient.cube.sdk.ws.*reconnect: attempt=", since_pos=None)
    assert count <= 5, f"retry storm: {count} attempts"
```

- [ ] **Step 4: Generate test fixture wav** (one-time committed artifact)

Record "hello" via macOS `say` and convert to 16 kHz mono PCM16 WAV:

```bash
mkdir -p esp32/cube/tests/hil/fixtures
say -o /tmp/hello.aiff "hello"
ffmpeg -y -i /tmp/hello.aiff -ar 16000 -ac 1 -sample_fmt s16 \
    esp32/cube/tests/hil/fixtures/hello_16k.wav
```

Verify:
```bash
file esp32/cube/tests/hil/fixtures/hello_16k.wav
```
Expected output contains `WAVE audio, Microsoft PCM, 16 bit, mono 16000 Hz`.

Commit the WAV (it's a small, stable test fixture).

- [ ] **Step 5: Flash and run S1 + S2 + S5**

```bash
bash esp32/cube/scripts/flash.sh
cd esp32/cube && pytest tests/hil/test_sentient_audio_toggle.py tests/hil/test_sentient_reconnect.py -v
```

Expected: all three test functions pass. Inspect daemon ring buffer if any fail:
```bash
python3 -c "import socket,json,sys; s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.connect('/tmp/cube-daemon.sock'); s.sendall(json.dumps({'kind':'events','n':20000}).encode()); buf=b''
while True:
    c=s.recv(65536)
    if not c: break
    buf+=c
sys.stdout.write(buf.decode())"
```

- [ ] **Step 6: Run S7 (operator-confirmed)**

The implementer flags this in handover for manual confirmation. Steps for the operator are documented in `esp32/cube/.e2e-testing` (add a section for it).

- [ ] **Step 7: Commit**

```bash
git add esp32/cube/tests/hil/test_sentient_audio_toggle.py \
        esp32/cube/tests/hil/test_sentient_reconnect.py \
        esp32/cube/tests/hil/test_sentient_barge_in.py \
        esp32/cube/tests/hil/test_sentient_bad_token.py \
        esp32/cube/tests/hil/fixtures/hello_16k.wav \
        esp32/cube/tests/hil/fixtures/long_question_16k.wav
git commit -m "test(cube/hil): Phase 6a S1/S2/S4/S5/S7 smoke

EOF"
```

**Phase 6a gate: stop unless S1, S2, S5 (Group A) are green. S4 (Group B) requires operator confirmation. S3 (TTS audible) is operator ear-check — flag in handover. S6 (WiFi drop) is operator-only (Group C) — flag in handover. S7 requires operator re-flash with bad creds — flag in handover. Maximum 3 flashes for Phase 6a.**

---

# Phase 6b — Lift into shared/cube-sdk/

Goal: identical behavior, code relocated. Same HIL smoke green after each extraction. Maximum 2 flashes for Phase 6b.

---

### Task 11: Scaffold shared/cube-sdk/ ESP-IDF component

**Files:**
- Create: `shared/cube-sdk/CMakeLists.txt`
- Create: `shared/cube-sdk/idf_component.yml`
- Create: `shared/cube-sdk/Kconfig`
- Create: `shared/cube-sdk/README.md`
- Create: `shared/cube-sdk/src/log.h`
- Modify: `esp32/cube/firmware/CMakeLists.txt`

- [ ] **Step 1: Write CMakeLists.txt**

```cmake
# shared/cube-sdk/CMakeLists.txt
idf_component_register(
    SRCS
        "src/sentient_sdk.cc"
        "src/ws_transport.cc"
        "src/message_router.cc"
        "src/status_machine.cc"
        "src/reconnect_controller.cc"
        "src/frame_codec.cc"
        "src/connectors/user_audio_input_connector.cc"
        "src/connectors/assistant_audio_response_connector.cc"
        "src/connectors/cognition_status_connector.cc"
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "src"
    REQUIRES esp_websocket_client json esp_timer
    PRIV_REQUIRES log
)
```

- [ ] **Step 2: Write idf_component.yml**

```yaml
description: "Sentient gateway client SDK for ESP32 cube"
version: "0.1.0"
dependencies:
  espressif/esp_websocket_client: "^1.5"
```

- [ ] **Step 3: Write Kconfig**

```kconfig
menu "Sentient cube SDK"

config CUBE_SDK_TRACE_AUDIO_FRAMES
    bool "Trace every audio frame at DEBUG level"
    default n
    help
        Same as the firmware-side Kconfig from Phase 6a. The cube-sdk
        respects the same symbol so a single Kconfig flip enables
        per-frame tracing across both layers.

config CUBE_SDK_RECONNECT_MAX_ATTEMPTS
    int "Maximum reconnect attempts before Error status"
    default 5
    range 1 20

config CUBE_SDK_RECONNECT_BASE_MS
    int "Base reconnect backoff (ms)"
    default 1000

config CUBE_SDK_RECONNECT_MAX_MS
    int "Maximum reconnect backoff (ms)"
    default 30000

config CUBE_SDK_READY_TIMEOUT_MS
    int "session.ready timeout after auth.ok (ms)"
    default 10000

endmenu
```

Drop the matching Kconfig entry from `esp32/cube/firmware/main/Kconfig.projbuild` since it now lives with the component.

- [ ] **Step 4: Write src/log.h**

```cpp
#pragma once

#include <esp_log.h>

#define CUBE_SDK_LOGE(tag, fmt, ...) ESP_LOGE(tag, fmt, ##__VA_ARGS__)
#define CUBE_SDK_LOGW(tag, fmt, ...) ESP_LOGW(tag, fmt, ##__VA_ARGS__)
#define CUBE_SDK_LOGI(tag, fmt, ...) ESP_LOGI(tag, fmt, ##__VA_ARGS__)
#define CUBE_SDK_LOGD(tag, fmt, ...) ESP_LOGD(tag, fmt, ##__VA_ARGS__)

#if CONFIG_CUBE_SDK_TRACE_AUDIO_FRAMES
#define CUBE_SDK_LOG_FRAME(tag, fmt, ...) ESP_LOGD(tag, fmt, ##__VA_ARGS__)
#else
#define CUBE_SDK_LOG_FRAME(tag, fmt, ...) do { } while (0)
#endif
```

- [ ] **Step 5: Wire EXTRA_COMPONENT_DIRS in cube firmware**

In `esp32/cube/firmware/CMakeLists.txt`, before `project(...)`:

```cmake
set(EXTRA_COMPONENT_DIRS ${CMAKE_SOURCE_DIR}/../../../shared/cube-sdk)
```

- [ ] **Step 6: Write README.md** (≤30 lines, points at spec)

```markdown
# shared/cube-sdk

C++17 ESP-IDF component. Lets a cube speak the sentient gateway's
client WebSocket protocol (same wire as `shared/web-sdk`).

- Design spec: `docs/superpowers/specs/2026-05-14-cube-sdk-design.md`
- Wire protocol source of truth: `shared/protocol/src/messages.ts`
- Web reference implementation: `shared/web-sdk/`

## Build

Consumed by `esp32/cube/firmware/` via `EXTRA_COMPONENT_DIRS`.
Component requirements: `esp_websocket_client`, `json`, `esp_timer`.
```

- [ ] **Step 7: Create empty src/ + include/ skeleton (placeholder .cc files with `namespace sentient::cube_sdk { }`)**

For each file in the CMakeLists.txt SRCS list, create an empty stub with the right namespace + a `// TODO Phase 6b extraction` comment. The build should succeed against this skeleton — that's the gate for Task 11.

- [ ] **Step 8: Build**

Run:
```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -20
```

Expected: clean build. cube-sdk component links into firmware as an empty no-op.

- [ ] **Step 9: Commit**

```bash
git add shared/cube-sdk/ esp32/cube/firmware/CMakeLists.txt esp32/cube/firmware/main/Kconfig.projbuild
git commit -m "scaffold(cube-sdk): ESP-IDF component skeleton + Kconfig

EOF"
```

---

### Task 12: Define public headers — config, status, cognition_state

**Files:**
- Create: `shared/cube-sdk/include/sentient/cube-sdk/status.h`
- Create: `shared/cube-sdk/include/sentient/cube-sdk/cognition_state.h`
- Create: `shared/cube-sdk/include/sentient/cube-sdk/config.h`

- [ ] **Step 1: Write status.h + cognition_state.h** (≤30 lines each)

```cpp
// status.h
#pragma once
namespace sentient::cube_sdk {
enum class SdkStatus { Disconnected, Connecting, Authenticating, Ready, Reconnecting, Error };
const char* to_string(SdkStatus s);
}
```

```cpp
// cognition_state.h
#pragma once
namespace sentient::cube_sdk {
enum class CognitionState { Idle, Thinking, Acting };
const char* to_string(CognitionState s);
}
```

`to_string` impls live in `src/status_machine.cc` and a new free-function file `src/cognition_state.cc` (add to CMakeLists.txt SRCS).

- [ ] **Step 2: Write config.h**

```cpp
#pragma once

#include <functional>
#include <string>

#include "sentient/cube-sdk/cognition_state.h"
#include "sentient/cube-sdk/connectors/audio_capture_adapter.h"
#include "sentient/cube-sdk/connectors/audio_playback_adapter.h"
#include "sentient/cube-sdk/status.h"

namespace sentient::cube_sdk {

struct SentientSdkConfig {
    std::string gateway_url;
    std::string token;
    IAudioCaptureAdapter*  capture  = nullptr;   // non-owning
    IAudioPlaybackAdapter* playback = nullptr;   // non-owning
    std::function<void(SdkStatus)>           on_status_change;
    std::function<void(CognitionState)>      on_cognition_status;
    std::function<void(const std::string&)>  on_transcript;
};

}  // namespace sentient::cube_sdk
```

- [ ] **Step 3: Build**

Run:
```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
```

Expected: clean build (config.h includes audio adapter headers which don't exist yet — create empty placeholder files at this step too).

Create empty placeholders:
- `shared/cube-sdk/include/sentient/cube-sdk/connectors/audio_capture_adapter.h`
- `shared/cube-sdk/include/sentient/cube-sdk/connectors/audio_playback_adapter.h`

With just `#pragma once\nnamespace sentient::cube_sdk { class IAudioCaptureAdapter; }` etc. Task 13 fills them in.

- [ ] **Step 4: Commit**

```bash
git add shared/cube-sdk/include/sentient/cube-sdk/
git commit -m "feat(cube-sdk): public status/cognition_state/config headers

EOF"
```

---

### Task 13: Define audio adapter interfaces

**Files:**
- Modify: `shared/cube-sdk/include/sentient/cube-sdk/connectors/audio_capture_adapter.h`
- Modify: `shared/cube-sdk/include/sentient/cube-sdk/connectors/audio_playback_adapter.h`

- [ ] **Step 1: Write audio_capture_adapter.h**

```cpp
#pragma once

#include <cstddef>
#include <cstdint>
#include <esp_err.h>
#include <functional>

namespace sentient::cube_sdk {

class IAudioCaptureAdapter {
public:
    virtual ~IAudioCaptureAdapter() = default;

    using FrameSink = std::function<void(const uint8_t* data, size_t len)>;

    virtual esp_err_t start() = 0;
    virtual void      stop()  = 0;
    virtual void      set_frame_sink(FrameSink sink) = 0;
};

}  // namespace sentient::cube_sdk
```

- [ ] **Step 2: Write audio_playback_adapter.h**

```cpp
#pragma once

#include <cstddef>
#include <cstdint>
#include <esp_err.h>

namespace sentient::cube_sdk {

class IAudioPlaybackAdapter {
public:
    virtual ~IAudioPlaybackAdapter() = default;

    virtual esp_err_t begin_track(uint32_t sample_rate)              = 0;
    virtual void      push_frame(const uint8_t* data, size_t len)    = 0;
    virtual void      end_track(bool aborted)                        = 0;
};

}  // namespace sentient::cube_sdk
```

- [ ] **Step 3: Build**

Run:
```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
```

Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add shared/cube-sdk/include/sentient/cube-sdk/connectors/
git commit -m "feat(cube-sdk): IAudioCaptureAdapter + IAudioPlaybackAdapter interfaces

EOF"
```

---

### Task 14: Implement frame_codec (JSON encode/decode helpers)

**Files:**
- Create: `shared/cube-sdk/src/frame_codec.h`
- Create: `shared/cube-sdk/src/frame_codec.cc`

- [ ] **Step 1: Write frame_codec.h**

```cpp
#pragma once

#include <cJSON.h>
#include <optional>
#include <string>

namespace sentient::cube_sdk::frame_codec {

std::string build_auth(const std::string& token);
std::string build_session_configure();
std::string build_audio_start();
std::string build_audio_end();
std::string build_interrupt();

struct SessionReady {
    std::string session_id;
    int input_sample_rate;
    int output_sample_rate;
};

std::optional<SessionReady> parse_session_ready(const cJSON* root);

struct AudioStart {
    std::string cycle_id;
    int sample_rate;
};

std::optional<AudioStart> parse_connector_audio_start(const cJSON* root);

struct PlaybackStop {
    std::string cycle_id;
    std::string reason;
};

std::optional<PlaybackStop> parse_playback_stop(const cJSON* root);

}  // namespace sentient::cube_sdk::frame_codec
```

- [ ] **Step 2: Write frame_codec.cc**

Implement each function using cJSON. ≤300 lines total. Each `build_*` returns a UTF-8 JSON string. Each `parse_*` returns `std::nullopt` on missing-required-field.

- [ ] **Step 3: Build**

Run:
```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
```

Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add shared/cube-sdk/src/frame_codec.h shared/cube-sdk/src/frame_codec.cc
git commit -m "feat(cube-sdk): frame_codec JSON helpers

EOF"
```

---

### Task 15: Implement WsTransport

**Files:**
- Create: `shared/cube-sdk/src/ws_transport.h`
- Create: `shared/cube-sdk/src/ws_transport.cc`

- [ ] **Step 1: Write ws_transport.h**

```cpp
#pragma once

#include <esp_websocket_client.h>
#include <functional>
#include <string>

namespace sentient::cube_sdk {

class WsTransport {
public:
    using TextHandler   = std::function<void(const char* data, size_t len)>;
    using BinaryHandler = std::function<void(const uint8_t* data, size_t len)>;
    using EventHandler  = std::function<void(int32_t event_id)>;

    WsTransport();
    ~WsTransport();
    WsTransport(const WsTransport&) = delete;
    WsTransport& operator=(const WsTransport&) = delete;

    esp_err_t connect(const std::string& url);
    void      disconnect();
    bool      is_connected() const;

    void send_text(const std::string& text);
    void send_binary(const uint8_t* data, size_t len);

    void set_text_handler(TextHandler h);
    void set_binary_handler(BinaryHandler h);
    void set_event_handler(EventHandler h);

private:
    static void ws_event_handler(void* arg,
                                 esp_event_base_t base,
                                 int32_t event_id,
                                 void* event_data);

    esp_websocket_client_handle_t client_ = nullptr;
    TextHandler   text_handler_;
    BinaryHandler binary_handler_;
    EventHandler  event_handler_;
};

}  // namespace sentient::cube_sdk
```

- [ ] **Step 2: Write ws_transport.cc**

Implementation lifts the corresponding chunks from `firmware/main/protocols/sentient_ws_protocol.cc` (created in Phase 6a). Identical logic, just packaged.

- [ ] **Step 3: Build**

Run:
```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
```

Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add shared/cube-sdk/src/ws_transport.h shared/cube-sdk/src/ws_transport.cc
git commit -m "feat(cube-sdk): WsTransport wrapping esp_websocket_client

EOF"
```

---

### Task 16: Implement StatusMachine + ReconnectController

**Files:**
- Create: `shared/cube-sdk/src/status_machine.{h,cc}`
- Create: `shared/cube-sdk/src/reconnect_controller.{h,cc}`

- [ ] **Step 1: status_machine.h**

```cpp
#pragma once

#include <functional>
#include <mutex>

#include "sentient/cube-sdk/status.h"

namespace sentient::cube_sdk {

class StatusMachine {
public:
    using Listener = std::function<void(SdkStatus)>;

    explicit StatusMachine(Listener listener);

    SdkStatus get() const;
    bool      set(SdkStatus next);  // returns true if changed

private:
    mutable std::mutex mu_;
    SdkStatus current_ = SdkStatus::Disconnected;
    Listener listener_;
};

}  // namespace sentient::cube_sdk
```

- [ ] **Step 2: status_machine.cc** — ≤80 lines. Includes `to_string(SdkStatus)` impl.

- [ ] **Step 3: reconnect_controller.h**

```cpp
#pragma once

#include <atomic>
#include <esp_timer.h>
#include <functional>

namespace sentient::cube_sdk {

struct ReconnectConfig {
    int base_ms;
    int max_ms;
    int jitter_ms;
    int max_attempts;
};

class ReconnectController {
public:
    using ConnectFn = std::function<void()>;
    using ExhaustFn = std::function<void()>;

    ReconnectController(ReconnectConfig cfg, ConnectFn connect, ExhaustFn on_exhaust);
    ~ReconnectController();

    void schedule();    // called on disconnect event
    void cancel();
    void reset();       // call after successful session.ready

private:
    static void timer_cb(void* arg);

    ReconnectConfig cfg_;
    ConnectFn connect_;
    ExhaustFn on_exhaust_;
    std::atomic<int> attempts_{0};
    esp_timer_handle_t timer_ = nullptr;
};

}  // namespace sentient::cube_sdk
```

- [ ] **Step 4: reconnect_controller.cc** — ≤120 lines, lifted from Phase 6a `schedule_reconnect`.

- [ ] **Step 5: Build + commit**

```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
git add shared/cube-sdk/src/status_machine.* shared/cube-sdk/src/reconnect_controller.*
git commit -m "feat(cube-sdk): StatusMachine + ReconnectController

EOF"
```

---

### Task 17: Implement MessageRouter

**Files:**
- Create: `shared/cube-sdk/src/message_router.{h,cc}`

- [ ] **Step 1: message_router.h**

```cpp
#pragma once

#include <cJSON.h>
#include <functional>
#include <string>
#include <unordered_map>

namespace sentient::cube_sdk {

class MessageRouter {
public:
    using Handler = std::function<void(const cJSON* root)>;

    void on(const std::string& type, Handler h);
    void dispatch(const char* data, size_t len);    // parses + dispatches

    // Convenience: dispatch with a pre-parsed root (caller owns the cJSON*).
    void dispatch_root(const cJSON* root);

private:
    std::unordered_map<std::string, Handler> handlers_;
};

}  // namespace sentient::cube_sdk
```

- [ ] **Step 2: message_router.cc** — ≤80 lines.

`dispatch(data, len)` parses JSON, reads `type` field, looks up handler, calls it. Drops + logs at WARN on parse error. Logs at DEBUG on unknown type.

- [ ] **Step 3: Build + commit**

```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
git add shared/cube-sdk/src/message_router.*
git commit -m "feat(cube-sdk): MessageRouter dispatch

EOF"
```

---

### Task 18: Implement UserAudioInputConnector

**Files:**
- Create: `shared/cube-sdk/include/sentient/cube-sdk/connectors/user_audio_input_connector.h`
- Create: `shared/cube-sdk/src/connectors/user_audio_input_connector.cc`

- [ ] **Step 1: Header**

```cpp
#pragma once

#include <functional>
#include <string>

#include "sentient/cube-sdk/connectors/audio_capture_adapter.h"

namespace sentient::cube_sdk {

class WsTransport;
class MessageRouter;

class UserAudioInputConnector {
public:
    using TranscriptFn = std::function<void(const std::string& text)>;

    UserAudioInputConnector(IAudioCaptureAdapter* adapter,
                            WsTransport* ws,
                            MessageRouter* router,
                            TranscriptFn on_transcript);

    void start_streaming();
    void stop_streaming();
    std::string last_transcript() const;

private:
    void handle_transcript_final(const cJSON* root);

    IAudioCaptureAdapter* adapter_;
    WsTransport*          ws_;
    bool                  is_streaming_ = false;
    mutable std::mutex    mu_;
    std::string           last_transcript_;
    TranscriptFn          on_transcript_;
};

}  // namespace sentient::cube_sdk
```

- [ ] **Step 2: Impl**

`start_streaming`:
1. `adapter_->set_frame_sink([ws=ws_](const uint8_t* d, size_t l){ ws->send_binary(d, l); });`
2. Send `frame_codec::build_audio_start()` via ws.
3. `adapter_->start()`.

`stop_streaming`:
1. `adapter_->stop()`.
2. Send `frame_codec::build_audio_end()` via ws.

Register handler with router for `connector.transcript.final`. Update `last_transcript_` under mutex; fire callback.

- [ ] **Step 3: Build + commit**

```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
git add shared/cube-sdk/include/sentient/cube-sdk/connectors/user_audio_input_connector.h shared/cube-sdk/src/connectors/user_audio_input_connector.cc
git commit -m "feat(cube-sdk): UserAudioInputConnector

EOF"
```

---

### Task 19: Implement AssistantAudioResponseConnector (cycleId-aware)

**Files:**
- Create: `shared/cube-sdk/include/sentient/cube-sdk/connectors/assistant_audio_response_connector.h`
- Create: `shared/cube-sdk/src/connectors/assistant_audio_response_connector.cc`

- [ ] **Step 1: Header**

```cpp
#pragma once

#include <mutex>
#include <string>

#include "sentient/cube-sdk/connectors/audio_playback_adapter.h"

namespace sentient::cube_sdk {

class WsTransport;
class MessageRouter;

class AssistantAudioResponseConnector {
public:
    AssistantAudioResponseConnector(IAudioPlaybackAdapter* adapter,
                                    WsTransport*          ws,
                                    MessageRouter*        router);

    // Called by SentientSdk on each inbound binary frame from WsTransport.
    void on_binary(const uint8_t* data, size_t len);

private:
    void handle_audio_start(const cJSON* root);
    void handle_audio_done(const cJSON* root);
    void handle_playback_stop(const cJSON* root);

    IAudioPlaybackAdapter* adapter_;
    mutable std::mutex     mu_;
    std::string            active_cycle_id_;   // "" if no active TTS cycle
};

}  // namespace sentient::cube_sdk
```

- [ ] **Step 2: Impl**

Critical correctness points:
- `handle_audio_start` records `cycle_id` and `sample_rate`, calls `adapter_->begin_track(sample_rate)`.
- `on_binary` reads `active_cycle_id_` under lock; if empty, drops + DEBUG log. Otherwise calls `adapter_->push_frame`.
- `handle_audio_done` checks `cycle_id` matches; if so clears active cycle + calls `adapter_->end_track(false)`.
- `handle_playback_stop` checks `cycle_id` matches; if so clears active cycle + calls `adapter_->end_track(true)`. Logs `reason`.

- [ ] **Step 3: Build + commit**

```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
git add shared/cube-sdk/include/sentient/cube-sdk/connectors/assistant_audio_response_connector.h shared/cube-sdk/src/connectors/assistant_audio_response_connector.cc
git commit -m "feat(cube-sdk): AssistantAudioResponseConnector with cycleId tracking

EOF"
```

---

### Task 20: Implement CognitionStatusConnector

**Files:**
- Create: `shared/cube-sdk/include/sentient/cube-sdk/connectors/cognition_status_connector.h`
- Create: `shared/cube-sdk/src/connectors/cognition_status_connector.cc`

- [ ] **Step 1: Header**

```cpp
#pragma once

#include <functional>

#include "sentient/cube-sdk/cognition_state.h"

namespace sentient::cube_sdk {

class MessageRouter;

class CognitionStatusConnector {
public:
    using Listener = std::function<void(CognitionState)>;

    CognitionStatusConnector(MessageRouter* router, Listener listener);

private:
    void handle_status(const cJSON* root);
    Listener listener_;
};

}  // namespace sentient::cube_sdk
```

- [ ] **Step 2: Impl** — ≤80 lines. Maps `"idle"`/`"thinking"`/`"acting"` strings to enum.

- [ ] **Step 3: Build + commit**

```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
git add shared/cube-sdk/include/sentient/cube-sdk/connectors/cognition_status_connector.h shared/cube-sdk/src/connectors/cognition_status_connector.cc
git commit -m "feat(cube-sdk): CognitionStatusConnector

EOF"
```

---

### Task 21: Compose SentientSdk class

**Files:**
- Create: `shared/cube-sdk/include/sentient/cube-sdk/sentient_sdk.h`
- Create: `shared/cube-sdk/src/sentient_sdk.cc`

- [ ] **Step 1: Header**

```cpp
#pragma once

#include <memory>

#include "sentient/cube-sdk/config.h"

namespace sentient::cube_sdk {

class SentientSdk {
public:
    explicit SentientSdk(SentientSdkConfig cfg);
    ~SentientSdk();

    SentientSdk(const SentientSdk&)            = delete;
    SentientSdk& operator=(const SentientSdk&) = delete;

    esp_err_t connect();
    void      disconnect();
    SdkStatus status() const;

    void start_streaming();
    void stop_streaming();
    void force_reconnect();

    std::string last_transcript() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace sentient::cube_sdk
```

- [ ] **Step 2: Impl (PIMPL — keeps header free of internal headers)**

`Impl` owns:
- `WsTransport`
- `MessageRouter`
- `StatusMachine`
- `ReconnectController`
- `UserAudioInputConnector`
- `AssistantAudioResponseConnector`
- `CognitionStatusConnector`

Construction wires them together. `connect()` sends auth on WS_CONNECTED via WsTransport event handler. Same logic as Phase 6a, just split. ≤500 lines.

- [ ] **Step 3: Build + commit**

```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
git add shared/cube-sdk/include/sentient/cube-sdk/sentient_sdk.h shared/cube-sdk/src/sentient_sdk.cc
git commit -m "feat(cube-sdk): SentientSdk composition

EOF"
```

---

### Task 22: Firmware glue — CubeAudioCaptureAdapter

**Files:**
- Create: `esp32/cube/firmware/main/sentient_glue/cube_audio_capture_adapter.{h,cc}`

- [ ] **Step 1: Header**

```cpp
#pragma once

#include "sentient/cube-sdk/connectors/audio_capture_adapter.h"

class AudioService;

namespace sentient::cube::glue {

class CubeAudioCaptureAdapter : public sentient::cube_sdk::IAudioCaptureAdapter {
public:
    explicit CubeAudioCaptureAdapter(AudioService* audio);

    esp_err_t start() override;
    void      stop()  override;
    void      set_frame_sink(FrameSink sink) override;

private:
    void on_send_queue_available();

    AudioService* audio_;
    FrameSink     sink_;
};

}  // namespace sentient::cube::glue
```

- [ ] **Step 2: Impl**

`start()`:
- Install `AudioServiceCallbacks` with `on_send_queue_available = [this]{ on_send_queue_available(); }` (preserve other callbacks already wired by firmware).
- `audio_->EnableVoiceProcessing(true)`.

`stop()`:
- `audio_->EnableVoiceProcessing(false)`.

`on_send_queue_available`:
- Drain `audio_->PopPacketFromSendQueue()` in a loop.
- For each packet, `sink_(pkt->payload.data(), pkt->payload.size())`.

- [ ] **Step 3: Build + commit**

```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
git add esp32/cube/firmware/main/sentient_glue/cube_audio_capture_adapter.h esp32/cube/firmware/main/sentient_glue/cube_audio_capture_adapter.cc
git commit -m "feat(cube/sentient_glue): CubeAudioCaptureAdapter

EOF"
```

---

### Task 23: Firmware glue — CubeAudioPlaybackAdapter

**Files:**
- Create: `esp32/cube/firmware/main/sentient_glue/cube_audio_playback_adapter.{h,cc}`

- [ ] **Step 1: Header**

```cpp
#pragma once

#include "sentient/cube-sdk/connectors/audio_playback_adapter.h"

class AudioService;

namespace sentient::cube::glue {

class CubeAudioPlaybackAdapter : public sentient::cube_sdk::IAudioPlaybackAdapter {
public:
    explicit CubeAudioPlaybackAdapter(AudioService* audio);

    esp_err_t begin_track(uint32_t sample_rate) override;
    void      push_frame(const uint8_t* data, size_t len) override;
    void      end_track(bool aborted) override;

private:
    AudioService* audio_;
};

}  // namespace sentient::cube::glue
```

- [ ] **Step 2: Impl**

`begin_track(sample_rate)`:
- `audio_->SetDecodeSampleRate(sample_rate, /*frame_duration_ms=*/20);`
- `audio_->ResetDecoder();`

`push_frame(data, len)`:
- Build `AudioStreamPacket` (copy bytes into `payload` vector).
- `audio_->PushPacketToDecodeQueue(std::move(pkt), /*wait=*/false);` If returns false (queue full), log WARN with rate-limit.

`end_track(aborted)`:
- If aborted: `audio_->ResetDecoder();` (drops queued frames).
- Else: noop (queue drains naturally).

- [ ] **Step 3: Build + commit**

```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
git add esp32/cube/firmware/main/sentient_glue/cube_audio_playback_adapter.h esp32/cube/firmware/main/sentient_glue/cube_audio_playback_adapter.cc
git commit -m "feat(cube/sentient_glue): CubeAudioPlaybackAdapter

EOF"
```

---

### Task 24: Firmware glue — SdkOwner + swap application.cc to consume cube-sdk

**Files:**
- Create: `esp32/cube/firmware/main/sentient_glue/sdk_owner.{h,cc}`
- Modify: `esp32/cube/firmware/main/application.cc`
- Modify: `esp32/cube/firmware/main/CMakeLists.txt`

- [ ] **Step 1: SdkOwner**

Encapsulates the cube-sdk lifetime + adapter ownership. Constructor takes `AudioService*` + `DeviceStateMachine*` + creds. Builds `SentientSdkConfig` (callbacks marshal to LVGL task as needed). Exposes the same surface as `SentientWsProtocol` for the verb file.

```cpp
// header
#pragma once
#include <memory>
#include "sentient/cube-sdk/sentient_sdk.h"

class AudioService;
class DeviceStateMachine;

namespace sentient::cube::glue {

class SdkOwner {
public:
    SdkOwner(AudioService* audio,
             DeviceStateMachine* state,
             const std::string& url,
             const std::string& token);

    sentient::cube_sdk::SentientSdk& sdk();

private:
    std::unique_ptr<CubeAudioCaptureAdapter>  capture_;
    std::unique_ptr<CubeAudioPlaybackAdapter> playback_;
    std::unique_ptr<sentient::cube_sdk::SentientSdk> sdk_;
};

}  // namespace sentient::cube::glue
```

- [ ] **Step 2: Replace `SentientWsProtocol` in application.cc with `SdkOwner` + `SentientSdk`**

Adjust:
- `Application` holds `std::unique_ptr<sentient::cube::glue::SdkOwner>` instead of `std::unique_ptr<SentientWsProtocol>`.
- Verb file (`sentient.cc`) updated to call into `sdk_owner_->sdk()` instead.

- [ ] **Step 3: Update agent_console/verbs/sentient.cc to call new SDK**

`Application::Instance().sentient_sdk()` returns `sentient::cube_sdk::SentientSdk*`. Adjust the verb to use it.

- [ ] **Step 4: Update CMakeLists for new sentient_glue/ sources**

- [ ] **Step 5: Build**

Run:
```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
```

Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add esp32/cube/firmware/main/sentient_glue/ esp32/cube/firmware/main/application.h esp32/cube/firmware/main/application.cc esp32/cube/firmware/main/CMakeLists.txt esp32/cube/firmware/components/agent_console/verbs/sentient.cc
git commit -m "refactor(cube): switch application.cc to cube-sdk via SdkOwner

EOF"
```

---

### Task 25: Delete firmware-local SentientWsProtocol

**Files:**
- Delete: `esp32/cube/firmware/main/protocols/sentient_ws_protocol.{h,cc}`
- Modify: `esp32/cube/firmware/main/CMakeLists.txt`

- [ ] **Step 1: Remove the files**

```bash
git rm esp32/cube/firmware/main/protocols/sentient_ws_protocol.h \
       esp32/cube/firmware/main/protocols/sentient_ws_protocol.cc
```

- [ ] **Step 2: Remove the source from CMakeLists.txt SRCS**

If `protocols/` is now empty, decide whether to delete the directory. Keep it for now if other files (e.g. binary protocol headers) live there.

- [ ] **Step 3: Build**

Run:
```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
```

Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add -u
git commit -m "refactor(cube): drop firmware-local SentientWsProtocol (now in cube-sdk)

EOF"
```

---

### Task 26: Phase 6b HIL smoke — rerun S1, S2, S5

**Files:**
- (no new files; reuse Phase 6a tests)

- [ ] **Step 1: Flash + run**

```bash
bash esp32/cube/scripts/flash.sh
cd esp32/cube && pytest tests/hil/test_sentient_audio_toggle.py tests/hil/test_sentient_reconnect.py -v
```

Expected: all tests pass. Gateway log shape identical to Phase 6a run.

**Phase 6b gate: stop unless all rerun tests are green. Maximum 2 flashes for Phase 6b.**

- [ ] **Step 2: Record flash count + faults in working note**

Append to a `phase6b-flash-log.md` working note (uncommitted; folded into the eventual handover).

---

# Phase 6c — Toggle screen UI

Goal: cube screen reflects connection + cognition + transcript per spec. Mockup in lvgl-sim first, then one device flash.

---

### Task 27: lvgl-sim mockup of toggle screen states

**Files:**
- Modify: `esp32/cube/lvgl-sim/...` (depends on existing sim structure — implementer reads `lvgl-sim/README.md` first)
- Create: `esp32/cube/firmware/ui-shared/toggle_screen.{h,c}` (pure LVGL, host-buildable per `.claude/rules/esp32/cube/lvgl-sim.md`)

- [ ] **Step 1: Define screen API in toggle_screen.h**

```c
#pragma once
#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    TOGGLE_SCREEN_STATE_IDLE,
    TOGGLE_SCREEN_STATE_CONNECTING,
    TOGGLE_SCREEN_STATE_LISTENING,
    TOGGLE_SCREEN_STATE_THINKING,
    TOGGLE_SCREEN_STATE_SPEAKING,
    TOGGLE_SCREEN_STATE_ERROR,
} toggle_screen_state_t;

lv_obj_t* toggle_screen_create(lv_obj_t* parent);
void      toggle_screen_set_state(lv_obj_t* screen, toggle_screen_state_t state);
void      toggle_screen_set_transcript(lv_obj_t* screen, const char* text);
void      toggle_screen_set_connection_error(lv_obj_t* screen, const char* message);
void      toggle_screen_set_toggle_press_cb(lv_obj_t* screen, lv_event_cb_t cb, void* user_data);

#ifdef __cplusplus
}
#endif
```

- [ ] **Step 2: Implement toggle_screen.c with a state ring (LVGL arc) + transcript label + center toggle button**

Layout for 466×466 round AMOLED:
- Outer arc (`lv_arc`) drawing a colored ring (color depends on state).
- Center large circular button (LVGL `lv_btn`, ~200 px diameter).
- Transcript label below the button, scrolling for overflow, max 3 lines.
- Error banner overlay across the top when `toggle_screen_set_connection_error` is called.

Each state maps to a ring color: Idle = neutral grey, Connecting = pulsing blue, Listening = solid green, Thinking = pulsing yellow, Speaking = pulsing magenta, Error = solid red.

- [ ] **Step 3: Iterate in lvgl-sim**

```bash
cd esp32/cube/lvgl-sim && cmake --build build -j
./build/sentient_cube_lvgl_sim --snapshot /tmp/toggle_idle.png
```

Then `Read /tmp/toggle_idle.png` to verify the design. Loop until each state renders correctly. Save reference screenshots:

```
esp32/cube/docs/screenshots/toggle-idle.png
esp32/cube/docs/screenshots/toggle-connecting.png
esp32/cube/docs/screenshots/toggle-listening.png
esp32/cube/docs/screenshots/toggle-thinking.png
esp32/cube/docs/screenshots/toggle-speaking.png
esp32/cube/docs/screenshots/toggle-error.png
```

- [ ] **Step 4: Build firmware (no flash yet)**

```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
```

Expected: clean build (firmware references `toggle_screen.c` but it's not wired into the boot UI yet).

- [ ] **Step 5: Commit**

```bash
git add esp32/cube/firmware/ui-shared/toggle_screen.h esp32/cube/firmware/ui-shared/toggle_screen.c esp32/cube/docs/screenshots/toggle-*.png
git commit -m "feat(cube/ui): toggle screen LVGL layout (lvgl-sim iterated)

EOF"
```

---

### Task 28: Wire toggle screen into firmware boot UI + SDK callbacks

**Files:**
- Modify: `esp32/cube/firmware/main/application.cc`
- Modify: `esp32/cube/firmware/main/sentient_glue/sdk_owner.{h,cc}` (the place callbacks are constructed; sdk_owner_ holds a pointer to the screen and marshals to LVGL task)

- [ ] **Step 1: Replace boot test_screen with toggle_screen**

In `application.cc`, swap the call that creates `test_screen` for `toggle_screen_create(lv_scr_act())`. Stash the screen pointer on the application.

- [ ] **Step 2: Marshal SDK callbacks to LVGL task**

SDK callbacks fire on the WS RX task. LVGL is single-threaded. Marshal via `lv_async_call(...)` — a typed `struct UiEvent` argument carrying the state/text payload.

Wire:
- `on_status_change` → `Ready` → `TOGGLE_SCREEN_STATE_IDLE`; `Connecting`/`Reconnecting` → `_CONNECTING`; `Error` → `_ERROR`.
- `on_cognition_status` → `Thinking` → `_THINKING`; `Acting` (while playback active) → `_SPEAKING`; `Idle` → `_IDLE`.
- `on_transcript` → `toggle_screen_set_transcript`.
- Playback start/end → state transitions `_LISTENING` (during mic uplink) and `_SPEAKING` (during TTS).
- Toggle button press → `sdk_->start_streaming()` / on release `sdk_->stop_streaming()`.

- [ ] **Step 3: Build + flash**

```bash
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10
bash esp32/cube/scripts/flash.sh
```

Expected: clean build, cube boots into toggle screen.

- [ ] **Step 4: Smoke S8 — snapshot at each state**

```bash
bash esp32/cube/scripts/cube-snapshot.sh /tmp/cube_boot.png
# trigger a turn via existing tests, snapshot at each state
bash esp32/cube/scripts/cube-snapshot.sh /tmp/cube_listening.png
# ... etc
```

Compare `/tmp/cube_*.png` against `esp32/cube/docs/screenshots/toggle-*.png` reference images.

- [ ] **Step 5: Commit**

```bash
git add esp32/cube/firmware/main/application.cc esp32/cube/firmware/main/sentient_glue/sdk_owner.h esp32/cube/firmware/main/sentient_glue/sdk_owner.cc
git commit -m "feat(cube/ui): wire toggle screen to cube-sdk callbacks

EOF"
```

---

### Task 29: Write S8 HIL test (snapshot diff)

**Files:**
- Create: `esp32/cube/tests/hil/test_toggle_screen_states.py`

- [ ] **Step 1: Test**

```python
# esp32/cube/tests/hil/test_toggle_screen_states.py
"""S8 toggle screen renders the right state at each lifecycle event."""
import os, time, subprocess
import pytest

REF_DIR = "esp32/cube/docs/screenshots"
TMP_DIR = "/tmp"
WAVE = "esp32/cube/tests/hil/fixtures/hello_16k.wav"

def snapshot(name):
    path = f"{TMP_DIR}/cube_{name}.png"
    subprocess.check_call(["bash", "esp32/cube/scripts/cube-snapshot.sh", path])
    return path

@pytest.mark.group_a
def test_idle_screenshot(cube_dut):
    rsp = cube_dut.cmd("sentient.status")
    assert rsp["result"]["status"] == "Ready"
    p = snapshot("idle")
    assert os.path.exists(p)
    # Agent compares against REF_DIR/toggle-idle.png via Read tool.

@pytest.mark.group_a
def test_listening_screenshot(cube_dut):
    cube_dut.cmd("touch.tap", {"x": 233, "y": 233})  # toggle on
    time.sleep(0.3)
    p = snapshot("listening")
    cube_dut.cmd("touch.tap", {"x": 233, "y": 233})  # toggle off
    assert os.path.exists(p)

@pytest.mark.group_a
def test_thinking_screenshot(cube_dut, gateway_logs):
    cube_dut.cmd("touch.tap", {"x": 233, "y": 233})
    cube_dut.cmd("audio.inject_pcm", {"wav": WAVE})
    cube_dut.cmd("touch.tap", {"x": 233, "y": 233})
    # Wait for cognition.status=thinking
    pos = gateway_logs.position()
    deadline = time.time() + 5
    while time.time() < deadline:
        if gateway_logs.grep(r"cognition.status.*thinking", since_pos=pos):
            break
        time.sleep(0.1)
    else:
        pytest.skip("cognition.status thinking did not arrive in 5s")
    p = snapshot("thinking")
    assert os.path.exists(p)

@pytest.mark.group_a
def test_speaking_screenshot(cube_dut, gateway_logs):
    # Run a turn; wait for connector.audio.start; snapshot during playback.
    cube_dut.cmd("touch.tap", {"x": 233, "y": 233})
    cube_dut.cmd("audio.inject_pcm", {"wav": WAVE})
    cube_dut.cmd("touch.tap", {"x": 233, "y": 233})
    pos = gateway_logs.position()
    deadline = time.time() + 8
    while time.time() < deadline:
        if gateway_logs.grep(r"connector\.audio\.start", since_pos=pos):
            break
        time.sleep(0.1)
    else:
        pytest.skip("connector.audio.start did not arrive in 8s")
    time.sleep(0.3)
    p = snapshot("speaking")
    assert os.path.exists(p)

@pytest.mark.group_a
def test_error_screenshot(cube_dut):
    # Disconnect by forcing a status query while WS is being recycled.
    # Approach: temporarily corrupt gateway URL via force_reconnect into a known-bad path.
    # Simplest stable trigger: stop gateway container, wait until status flips to Reconnecting,
    # snapshot, restore.
    subprocess.check_call(
        ["docker", "compose", "-f", "deploy/macos/docker-compose.yml", "stop", "gateway"]
    )
    try:
        deadline = time.time() + 15
        while time.time() < deadline:
            rsp = cube_dut.cmd("sentient.status")
            if rsp["result"]["status"] in ("Reconnecting", "Error"):
                p = snapshot("error")
                assert os.path.exists(p)
                return
            time.sleep(0.5)
        pytest.fail("status never left Ready after gateway stopped")
    finally:
        subprocess.check_call(
            ["docker", "compose", "-f", "deploy/macos/docker-compose.yml", "start", "gateway"]
        )
```

- [ ] **Step 2: Run**

```bash
cd esp32/cube && pytest tests/hil/test_toggle_screen_states.py -v
```

- [ ] **Step 3: Commit**

```bash
git add esp32/cube/tests/hil/test_toggle_screen_states.py
git commit -m "test(cube/hil): S8 toggle screen state snapshots

EOF"
```

**Phase 6c gate: stop unless S1, S2, S4 (barge-in operator test), S5, S7, S8 are green. Maximum 1 device flash for 6c (after lvgl-sim iteration converges).**

---

### Task 30: Write Phase 6 handover

**Files:**
- Create: `docs/superpowers/handovers/2026-05-14-phase6-cube-sdk.md`

- [ ] **Step 1: Document**

Sections:
- What landed (cube-sdk component, firmware glue, toggle screen)
- What you need to know (PASETO baking, EXTRA_COMPONENT_DIRS, opus 20 ms frames, Kconfig trace flag)
- Smoke evidence (S1-S8 results + screenshots, flash count, AXP2101 faults, daemon restarts)
- Known gaps for Phase 7+ (text input, conversation history rendering, idle-close)

- [ ] **Step 2: Commit + merge prep**

```bash
git add docs/superpowers/handovers/2026-05-14-phase6-cube-sdk.md
git commit -m "docs(phase6): Phase 6 cube-sdk handover

EOF"
```

Pre-merge gate per `.claude/rules/e2e-testing.md`:
```bash
source scripts/env.sh
bun run ci  # no gateway regressions
```

---

# Pre-handover checklist

Per `.claude/rules/e2e-testing.md` and the spec's "Pre-merge gate":

- [ ] All 8 smoke cases (S1-S8) green — Group A automated, Group B/C operator-confirmed.
- [ ] Evidence captured: gateway log excerpts + cube screenshots in `esp32/cube/docs/screenshots/` + state ring snapshots in `/tmp/cube_*.png` referenced from the handover.
- [ ] `bun run ci` green on the host monorepo (gateway side regression check).
- [ ] Flash count + AXP2101 faults + daemon restarts recorded in the handover.
- [ ] `feature/phase6-cube-sdk` merges cleanly into `develop`.
- [ ] `shared/cube-sdk/` README is accurate.
- [ ] No raw tokens, audio payloads, or full transcripts > 120 chars in any log line.
