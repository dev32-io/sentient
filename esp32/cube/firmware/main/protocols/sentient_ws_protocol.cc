// SPDX-License-Identifier: MIT
#include "sentient_ws_protocol.h"

#include <algorithm>
#include <cstring>
#include <esp_log.h>
#include <esp_random.h>
#include <esp_timer.h>

namespace sentient::cube {

namespace {

constexpr const char* TAG = "sentient.cube.sdk.ws";

// Reconnect / readiness tunables. Kept here so the constants live next to
// the impl that owns them.
constexpr int kReadyTimeoutMs = 10000;
constexpr int kReconnectBaseMs = 1000;
constexpr int kReconnectMaxMs = 30000;
constexpr int kReconnectMaxAttempts = 5;
constexpr int kReconnectJitterMs = 500;

constexpr size_t kLogPreviewMaxChars = 120;

// Read a string field off a cJSON object. Returns nullptr if missing or
// not a string.
const char* json_string(const cJSON* root, const char* key) {
    const cJSON* item = cJSON_GetObjectItem(root, key);
    return cJSON_IsString(item) ? item->valuestring : nullptr;
}

int json_int(const cJSON* root, const char* key, int fallback) {
    const cJSON* item = cJSON_GetObjectItem(root, key);
    return cJSON_IsNumber(item) ? item->valueint : fallback;
}

CognitionState map_cognition_state(const char* s) {
    if (s == nullptr) return CognitionState::Idle;
    if (strcmp(s, "idle") == 0) return CognitionState::Idle;
    if (strcmp(s, "thinking") == 0) return CognitionState::Thinking;
    if (strcmp(s, "acting") == 0) return CognitionState::Acting;
    return CognitionState::Idle;
}

constexpr int kWsBufferSizeBytes = 4096;

// WebSocket frame opcodes per RFC 6455 §5.2 (esp_websocket_client surfaces
// these directly in event_data->op_code). 0x00 = continuation, 0x01 = text,
// 0x02 = binary.
constexpr uint8_t kWsOpcodeContinuation = 0x00;
constexpr uint8_t kWsOpcodeText = 0x01;
constexpr uint8_t kWsOpcodeBinary = 0x02;

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
    ws_cfg.buffer_size = kWsBufferSizeBytes;
    // esp_websocket_client default task stack is 4096 bytes — too tight on
    // this build. The WS task processes inbound frames inside its own
    // context, calling our event handler which logs via ESP_LOGI. Each log
    // line walks the vprintf hook chain (devtool log_relay when enabled),
    // plus mbedTLS receive buffers on the TLS path. session.ready + the
    // first session/configure ACK reliably blew the 4 KB stack
    // (vApplicationStackOverflowHook fired with canary 0xa5a5a5a5). 8 KB
    // leaves headroom for the worst-case logging chain.
    ws_cfg.task_stack = 8192;
    if (cfg_.cert_pem != nullptr) {
        ws_cfg.cert_pem = cfg_.cert_pem;
    }
    if (cfg_.skip_tls_cn_check) {
        ws_cfg.skip_cert_common_name_check = true;
    }
    client_ = esp_websocket_client_init(&ws_cfg);
    if (client_ == nullptr) {
        ESP_LOGE(TAG, "connect: esp_websocket_client_init returned NULL");
        set_status(SdkStatus::Error);
        return ESP_FAIL;
    }
    esp_err_t err = esp_websocket_register_events(client_,
                                                  WEBSOCKET_EVENT_ANY,
                                                  ws_event_handler,
                                                  this);
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

std::string SentientWsProtocol::last_transcript() const {
    std::lock_guard<std::mutex> lock(state_mutex_);
    return last_transcript_;
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
    esp_websocket_client_send_bin(client_,
                                  reinterpret_cast<const char*>(data),
                                  len,
                                  portMAX_DELAY);
}

void SentientWsProtocol::ws_event_handler(void* arg,
                                          esp_event_base_t /*base*/,
                                          int32_t event_id,
                                          void* event_data) {
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
            if (s != nullptr) {
                self->send_text(s);
                cJSON_free(s);
            } else {
                ESP_LOGE(TAG, "auth: cJSON_PrintUnformatted OOM");
            }
            cJSON_Delete(root);
            break;
        }
        case WEBSOCKET_EVENT_DATA:
            if (ed->op_code == kWsOpcodeText || ed->op_code == kWsOpcodeContinuation) {
                self->handle_text(reinterpret_cast<const char*>(ed->data_ptr), ed->data_len);
            } else if (ed->op_code == kWsOpcodeBinary) {
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

// ---------------------------------------------------------------------------
// Stubs — bodies filled by Tasks 4-6. Each body is `{}` (or the
// minimum needed to link) so the firmware still builds while the
// implementation lands incrementally.
// ---------------------------------------------------------------------------

void SentientWsProtocol::start_streaming() {
    if (status() != SdkStatus::Ready) {
        ESP_LOGW(TAG, "start_streaming: not Ready, ignoring");
        return;
    }
    if (is_streaming_.exchange(true)) return;
    send_text("{\"type\":\"audio.start\"}");
    ESP_LOGI(TAG, "uplink: audio.start");
}

void SentientWsProtocol::stop_streaming() {
    if (!is_streaming_.exchange(false)) return;
    send_text("{\"type\":\"audio.end\"}");
    ESP_LOGI(TAG, "uplink: audio.end");
}

void SentientWsProtocol::notify_uplink_available() {
    pump_uplink();
}

void SentientWsProtocol::force_reconnect() {
    ESP_LOGI(TAG, "force_reconnect: tap-to-reconnect, resetting attempts");
    reconnect_attempts_.store(0);
    cancel_reconnect();
    if (client_ != nullptr) {
        esp_websocket_client_destroy(client_);
        client_ = nullptr;
    }
    connect();
}

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

void SentientWsProtocol::handle_auth_ok(const cJSON* root) {
    const char* session_id = json_string(root, "sessionId");
    if (session_id != nullptr) {
        std::lock_guard<std::mutex> lock(state_mutex_);
        session_id_ = session_id;
    }
    ESP_LOGI(TAG, "auth.ok: sessionId=%s", session_id ? session_id : "<missing>");

    // Send session.configure with the cube's capability advertisement.
    // clientType="cube" lets gateway-side policy gates (e.g. TTS) treat
    // headless devices differently from webui without mutating user prefs.
    cJSON* cfg = cJSON_CreateObject();
    cJSON_AddStringToObject(cfg, "type", "session.configure");
    cJSON_AddStringToObject(cfg, "clientType", "cube");
    cJSON* caps = cJSON_AddObjectToObject(cfg, "capabilities");
    cJSON* supports = cJSON_AddArrayToObject(caps, "supports");
    cJSON_AddItemToArray(supports, cJSON_CreateString("audio.input"));
    cJSON_AddItemToArray(supports, cJSON_CreateString("audio.output"));
    char* s = cJSON_PrintUnformatted(cfg);
    if (s != nullptr) {
        send_text(s);
        cJSON_free(s);
    } else {
        ESP_LOGE(TAG, "auth.ok: cJSON_PrintUnformatted OOM");
    }
    cJSON_Delete(cfg);

    arm_ready_timeout();
}

void SentientWsProtocol::handle_session_ready(const cJSON* root) {
    const char* encoding = json_string(root, "audioEncoding");
    int in_sr = json_int(root, "inputSampleRate", kSentientUplinkSampleRateHz);
    int out_sr = json_int(root, "outputSampleRate", kSentientDownlinkSampleRateHz);
    ESP_LOGI(TAG, "session.ready: encoding=%s inputSampleRate=%d outputSampleRate=%d",
             encoding ? encoding : "<missing>", in_sr, out_sr);
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        active_input_sample_rate_ = in_sr;
        active_output_sample_rate_ = out_sr;
    }
    set_status(SdkStatus::Ready);
    reconnect_attempts_.store(0);
    cancel_ready_timeout();
}

void SentientWsProtocol::handle_transcript_final(const cJSON* root) {
    const char* text = json_string(root, "text");
    if (text == nullptr) {
        ESP_LOGW(TAG, "connector.transcript.final: missing text");
        return;
    }
    std::string captured;
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        last_transcript_ = text;
        captured = last_transcript_;
    }
    ESP_LOGI(TAG, "connector.transcript.final: text=\"%.*s\"%s",
             static_cast<int>(std::min<size_t>(captured.size(), kLogPreviewMaxChars)),
             captured.c_str(),
             captured.size() > kLogPreviewMaxChars ? "..." : "");
    if (cfg_.on_transcript) cfg_.on_transcript(captured);
}

void SentientWsProtocol::handle_cycle_started(const cJSON* root) {
    const char* cycle_id = json_string(root, "cycleId");
    // NOTE: do NOT set active_cycle_id_ here — that field tracks the TTS
    // cycle and is owned by connector.audio.start. cycle.started fires before
    // any audio is produced and may not yield audio at all (text-only reply).
    ESP_LOGI(TAG, "cycle.started: cycleId=%s", cycle_id ? cycle_id : "<missing>");
}

void SentientWsProtocol::handle_cycle_completed(const cJSON* root) {
    const char* cycle_id = json_string(root, "cycleId");
    ESP_LOGI(TAG, "cycle.completed: cycleId=%s", cycle_id ? cycle_id : "<missing>");
    // Defensive: gateway may not always emit cognition.status=idle right after
    // cycle.completed. Fire it ourselves so the UI returns to idle reliably.
    if (cfg_.on_cognition_status) cfg_.on_cognition_status(CognitionState::Idle);
}

void SentientWsProtocol::handle_cognition_status(const cJSON* root) {
    const char* state = json_string(root, "state");
    if (state == nullptr) {
        ESP_LOGW(TAG, "cognition.status: missing state");
        return;
    }
    if (strcmp(state, "idle") != 0 && strcmp(state, "thinking") != 0 &&
        strcmp(state, "acting") != 0) {
        ESP_LOGW(TAG, "cognition.status: unknown state=%s (defaulting to idle)", state);
    }
    CognitionState mapped = map_cognition_state(state);
    ESP_LOGI(TAG, "cognition.status: state=%s", state);
    if (cfg_.on_cognition_status) cfg_.on_cognition_status(mapped);
}

void SentientWsProtocol::handle_connector_audio_start(const cJSON* root) {
    const char* cycle_id = json_string(root, "cycleId");
    int sample_rate = json_int(root, "sampleRate", kSentientDownlinkSampleRateHz);
    ESP_LOGI(TAG, "connector.audio.start: cycleId=%s sampleRate=%d",
             cycle_id ? cycle_id : "<missing>", sample_rate);
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        active_cycle_id_ = cycle_id ? cycle_id : "";
        active_output_sample_rate_ = sample_rate;
    }
    if (cfg_.on_playback_begin) cfg_.on_playback_begin(sample_rate);
}

void SentientWsProtocol::handle_connector_audio_done(const cJSON* root) {
    const char* cycle_id = json_string(root, "cycleId");
    bool cleared = false;
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        if (cycle_id != nullptr && active_cycle_id_ == cycle_id) {
            active_cycle_id_.clear();
            cleared = true;
        }
    }
    if (cleared) {
        ESP_LOGI(TAG, "connector.audio.done: cycleId=%s playback ended (natural)", cycle_id);
        if (cfg_.on_playback_end) cfg_.on_playback_end(false);
    } else {
        ESP_LOGW(TAG, "connector.audio.done: cycleId mismatch incoming=%s (no active cycle)",
                 cycle_id ? cycle_id : "<missing>");
    }
}

void SentientWsProtocol::handle_playback_stop(const cJSON* root) {
    const char* cycle_id = json_string(root, "cycleId");
    const char* reason = json_string(root, "reason");
    ESP_LOGI(TAG, "playback.stop: cycleId=%s reason=%s",
             cycle_id ? cycle_id : "<missing>", reason ? reason : "<missing>");
    bool cleared = false;
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        if (cycle_id != nullptr && active_cycle_id_ == cycle_id) {
            active_cycle_id_.clear();
            cleared = true;
        }
    }
    if (cleared) {
        if (cfg_.on_playback_end) cfg_.on_playback_end(true);
    } else {
        ESP_LOGD(TAG, "playback.stop: cycleId mismatch incoming=%s (older cycle, ok)",
                 cycle_id ? cycle_id : "<missing>");
    }
}

void SentientWsProtocol::handle_error_frame(const cJSON* root) {
    const char* code = json_string(root, "code");
    const char* message = json_string(root, "message");
    size_t msg_len = message ? strlen(message) : 0;
    ESP_LOGW(TAG, "error: code=%s message=\"%.*s\"%s",
             code ? code : "<missing>",
             static_cast<int>(std::min<size_t>(msg_len, kLogPreviewMaxChars)),
             message ? message : "",
             msg_len > kLogPreviewMaxChars ? "..." : "");
    if (code != nullptr && strncmp(code, "auth.", 5) == 0) {
        ESP_LOGW(TAG, "error: auth-class code=%s — entering Error state, halting reconnect", code);
        set_status(SdkStatus::Error);
        cancel_reconnect();
        // Defense-in-depth: bump attempts so any future schedule_reconnect bails.
        reconnect_attempts_.store(kReconnectMaxAttempts);
        return;
    }
    // Gateway-side Hermes wire is dead (e.g. ACP WS timed out after long idle).
    // The gateway creates a fresh ACP wire on every new client WS session, so
    // dropping + reconnecting our WS is enough to recover — same shape as
    // webui reopening a tab. force_reconnect resets the backoff counter so
    // recovery is immediate, not subject to the exhaustion cap.
    if (code != nullptr && strncmp(code, "hermes", 6) == 0) {
        ESP_LOGW(TAG, "error: hermes-class code=%s — forcing reconnect to mint a fresh ACP wire", code);
        force_reconnect();
    }
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
        free(buf);
        buf = nullptr;
        len = 0;
    }
}
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

void SentientWsProtocol::arm_ready_timeout() {
    cancel_ready_timeout();
    esp_timer_create_args_t args = {};
    args.callback = [](void* arg) {
        auto* self = static_cast<SentientWsProtocol*>(arg);
        ESP_LOGW(TAG, "ready-timeout: %dms with no session.ready, closing", kReadyTimeoutMs);
        if (self->client_ != nullptr) {
            esp_websocket_client_close(self->client_, portMAX_DELAY);
        }
    };
    args.arg = this;
    esp_timer_create(&args, &ready_timeout_timer_);
    esp_timer_start_once(ready_timeout_timer_, static_cast<uint64_t>(kReadyTimeoutMs) * 1000);
}

void SentientWsProtocol::cancel_ready_timeout() {
    if (ready_timeout_timer_ != nullptr) {
        esp_timer_stop(ready_timeout_timer_);
        esp_timer_delete(ready_timeout_timer_);
        ready_timeout_timer_ = nullptr;
    }
}

}  // namespace sentient::cube
