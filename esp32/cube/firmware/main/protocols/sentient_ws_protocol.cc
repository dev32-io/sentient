// SPDX-License-Identifier: MIT
#include "sentient_ws_protocol.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <esp_crt_bundle.h>
#include <esp_log.h>
#include <esp_random.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>

namespace sentient::cube {
namespace {
constexpr const char* TAG = "sentient.cube.sdk.ws";
constexpr int kReadyTimeoutMs = 10000;
constexpr int kReconnectMaxAttempts = 5;
constexpr int kUplinkWaitMs = 5000;
constexpr uint32_t kReconnectSignal = 1, kReadySignal = 2,
                   kStopSignal = 4, kFailSignal = 8, kPumpSignal = 16;

const char* field(const cJSON* obj, const char* name) {
    const cJSON* value = cJSON_GetObjectItemCaseSensitive(obj, name);
    return cJSON_IsString(value) ? value->valuestring : nullptr;
}
std::string value(const char* s) { return s ? s : ""; }
void binding(cJSON* obj, const std::string& session, int generation) {
    if (!session.empty() && generation > 0) {
        cJSON_AddStringToObject(obj, "sessionId", session.c_str());
        cJSON_AddNumberToObject(obj, "attachmentGeneration", generation);
    }
}
const char* status_name(SdkStatus status) {
    switch (status) {
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

SentientWsProtocol::SentientWsProtocol(SentientWsProtocolConfig cfg) : cfg_(std::move(cfg)) {}
SentientWsProtocol::~SentientWsProtocol() { disconnect(); }

esp_err_t SentientWsProtocol::connect() {
    if (client_) return ESP_ERR_INVALID_STATE;
    { std::lock_guard<std::mutex> lock(state_mutex_);
      if (wire_.terminal_auth || stopping_) return ESP_ERR_INVALID_STATE; }
    // Neither plaintext nor a TLS connection without a trust anchor is supported.
    if (cfg_.gateway_url.rfind("wss://", 0) != 0 || cfg_.device_id.empty()) {
        set_status(SdkStatus::Error);
        return ESP_ERR_INVALID_ARG;
    }
    if (!worker_) {
        worker_done_ = xSemaphoreCreateBinary();
        if (!worker_done_ || xTaskCreate(worker_entry, "sentient_ws", 8192, this, 4, &worker_) != pdPASS) {
            if (worker_done_) vSemaphoreDelete(worker_done_);
            worker_done_ = nullptr;
            set_status(SdkStatus::Error);
            return ESP_ERR_NO_MEM;
        }
    }
    set_status(SdkStatus::Connecting);
    esp_websocket_client_config_t config = {};
    config.uri = cfg_.gateway_url.c_str();
    config.disable_auto_reconnect = true;
    config.buffer_size = 4096;
    config.task_stack = 8192;
    config.network_timeout_ms = 2000;
    if (cfg_.cert_pem) config.cert_pem = cfg_.cert_pem;
    else config.crt_bundle_attach = esp_crt_bundle_attach;
    client_ = esp_websocket_client_init(&config);
    if (!client_) {
        set_status(reconnect_attempts_ > 0 ? SdkStatus::Reconnecting : SdkStatus::Error);
        if (reconnect_attempts_ > 0) schedule_reconnect();
        return ESP_FAIL;
    }
    esp_err_t err = esp_websocket_register_events(client_, WEBSOCKET_EVENT_ANY, ws_event_handler, this);
    if (err == ESP_OK) err = esp_websocket_client_start(client_);
    if (err != ESP_OK) {
        esp_websocket_client_destroy(client_);
        client_ = nullptr;
        set_status(reconnect_attempts_ > 0 ? SdkStatus::Reconnecting : SdkStatus::Error);
        if (reconnect_attempts_ > 0) schedule_reconnect();
    }
    return err;
}

void SentientWsProtocol::disconnect() {
    stopping_ = true;
    cancel_reconnect();
    cancel_ready_timeout();
    wait_for_timer_callbacks();
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        streaming_ = false;
        ending_ = false;
        uplink_failed_ = true;
    }
    // A synchronous uplink sender must finish before socket destruction.
    TickType_t deadline = xTaskGetTickCount() + pdMS_TO_TICKS(kUplinkWaitMs);
    while (pumping_.test_and_set()) {
        if (static_cast<int32_t>(deadline - xTaskGetTickCount()) <= 0) abort();
        vTaskDelay(1);
    }
    pumping_.clear();
    if (worker_) {
        xTaskNotify(worker_, kStopSignal, eSetBits);
        // Pinned client stop/destroy may wait indefinitely internally; fail closed
        // rather than release callback target or hang teardown forever.
        if (xSemaphoreTake(worker_done_, pdMS_TO_TICKS(15000)) != pdTRUE) abort();
        worker_ = nullptr;
        vSemaphoreDelete(worker_done_);
        worker_done_ = nullptr;
    } else if (client_) {
        // Defensive fallback; normal connections create worker first.
        esp_websocket_client_stop(client_);
        esp_websocket_client_destroy(client_);
        client_ = nullptr;
    }
    handle_disconnect();
    inbound_.reset(); // websocket task has exited
    demuxer_.reset();
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
        if (status_ == next || (next == SdkStatus::Reconnecting && wire_.terminal_auth)) return;
        prev = status_;
        status_ = next;
    }
    ESP_LOGI(TAG, "status: %s -> %s", status_name(prev), status_name(next));
    if (cfg_.on_status_change) cfg_.on_status_change(next);
}
bool SentientWsProtocol::send_text(const std::string& text) {
    bool connected = client_ && esp_websocket_client_is_connected(client_);
    int result = connected ? esp_websocket_client_send_text(client_, text.c_str(), text.size(), pdMS_TO_TICKS(2000)) : -1;
    if (result != static_cast<int>(text.size()))
        ESP_LOGW(TAG, "ws text send failed: expected=%u result=%d connected=%d status=%s",
                 static_cast<unsigned>(text.size()), result, connected, status_name(status()));
    return result == static_cast<int>(text.size());
}
bool SentientWsProtocol::send_binary(const uint8_t* data, size_t len) {
    bool connected = client_ && esp_websocket_client_is_connected(client_);
    int result = connected ? esp_websocket_client_send_bin(client_, reinterpret_cast<const char*>(data), len, pdMS_TO_TICKS(2000)) : -1;
    if (result != static_cast<int>(len))
        ESP_LOGW(TAG, "ws binary send failed: expected=%u result=%d connected=%d status=%s",
                 static_cast<unsigned>(len), result, connected, status_name(status()));
    return result == static_cast<int>(len);
}
bool SentientWsProtocol::send_control(const char* type, const std::string& id,
                                      const std::string& session, int generation) {
    cJSON* obj = cJSON_CreateObject();
    if (!obj) return false;
    cJSON_AddStringToObject(obj, "type", type);
    if (!id.empty()) cJSON_AddStringToObject(obj, "captureId", id.c_str());
    if (strcmp(type, "audio.start") == 0) cJSON_AddStringToObject(obj, "turnMode", "manual");
    binding(obj, session, generation);
    char* encoded = cJSON_PrintUnformatted(obj);
    bool sent = encoded && send_text(encoded);
    if (encoded) cJSON_free(encoded);
    cJSON_Delete(obj);
    return sent;
}

bool SentientWsProtocol::start_streaming() {
    // Only accept once audio.start is serialized before any binary packet.
    if (pumping_.test_and_set()) return false;
    bool accepted = false;
    std::string id, session;
    int gen = 0;
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        if (!stopping_ && status_ == SdkStatus::Ready && !streaming_ && !ending_ && !wire_.terminal_auth) {
            char uuid[33];
            snprintf(uuid, sizeof(uuid), "%08lx%08lx%08lx%08lx",
                     static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()),
                     static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()));
            id = uuid;
            accepted = wire_.start_capture(id);
            if (accepted) {
                streaming_ = true;
                discard_uplink_ = false;
                uplink_failed_ = false;
                session = wire_.capture_session_id;
                gen = wire_.capture_generation;
            }
        }
    }
    if (accepted) {
        accepted = send_control("audio.start", id, session, gen);
        if (!accepted) fail_uplink();
    }
    pumping_.clear();
    return accepted;
}
void SentientWsProtocol::stop_streaming() { finish_uplink("audio.end"); }
void SentientWsProtocol::cancel_streaming() { finish_uplink("audio.cancel"); }
void SentientWsProtocol::finish_uplink(const char* type) {
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        if (!streaming_) return;
        streaming_ = false;
        ending_ = true;
        discard_uplink_ = strcmp(type, "audio.cancel") == 0;
        pending_end_id_ = wire_.finish_capture();
        pending_end_session_ = wire_.capture_session_id;
        pending_end_generation_ = wire_.capture_generation;
        pending_end_type_ = type;
        end_deadline_ = xTaskGetTickCount() + pdMS_TO_TICKS(kUplinkWaitMs);
    }
    pump_again_.store(true);
    pump_uplink();
    // Owner may be in send_bin. Stay in Listening until it drains and sends end.
    // Timeout aborts capture; owner checks failure before any later end.
    while (true) {
        bool pending;
        TickType_t deadline;
        { std::lock_guard<std::mutex> lock(state_mutex_);
          pending = ending_; deadline = end_deadline_; }
        if (!pending) break;
        if (static_cast<int32_t>(deadline - xTaskGetTickCount()) <= 0) {
            fail_uplink();
            break;
        }
        vTaskDelay(1);
    }
}
void SentientWsProtocol::fail_uplink() {
    if (stopping_ || status() == SdkStatus::Reconnecting || status() == SdkStatus::Error) return;
    uplink_failed_ = true;
    handle_disconnect();
    // Gateway capture is connection-scoped: close socket to cancel partial
    // capture before retrying on a fresh attachment. Auth rejection stays terminal.
    bool retry;
    { std::lock_guard<std::mutex> lock(state_mutex_);
      retry = !wire_.terminal_auth && !stopping_ && worker_ && client_; }
    if (retry) {
        set_status(SdkStatus::Reconnecting);
        xTaskNotify(worker_, kFailSignal, eSetBits);
    } else if (!stopping_) set_status(SdkStatus::Error);
}
void SentientWsProtocol::interrupt() {
    std::string session;
    int generation;
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        if (status_ != SdkStatus::Ready) return;
        session = wire_.session_id;
        generation = wire_.generation;
    }
    if (!send_control("interrupt", "", session, generation)) fail_uplink();
}
void SentientWsProtocol::notify_uplink_available() {
    // Task notification bits coalesce bursts. Never enter TLS from codec callback.
    std::lock_guard<std::mutex> lock(state_mutex_);
    // Serialize notification with disconnect's state fence before worker deletion.
    if (!stopping_ && status_ == SdkStatus::Ready && worker_)
        xTaskNotify(worker_, kPumpSignal, eSetBits);
}
void SentientWsProtocol::pump_uplink() {
    if (pumping_.test_and_set()) { pump_again_.store(true); return; }
    do {
        pump_again_.store(false);
        while (cfg_.on_pop_uplink_frame) {
            bool streaming, discard, ending;
            TickType_t deadline;
            {
                std::lock_guard<std::mutex> lock(state_mutex_);
                streaming = streaming_;
                discard = discard_uplink_;
                ending = ending_;
                deadline = end_deadline_;
            }
            if (!streaming && !ending) break;
            if (ending && static_cast<int32_t>(deadline - xTaskGetTickCount()) <= 0) {
                fail_uplink();
                break;
            }
            if (!streaming && discard) break;
            std::vector<uint8_t> payload;
            if (!cfg_.on_pop_uplink_frame(payload)) break;
            // stop may run during pop; drain queued frames before audio.end.
            bool sent = payload.empty() || discard || send_binary(payload.data(), payload.size());
            if (!sent) { fail_uplink(); break; }
        }
        std::string id, session;
        int gen = 0;
        const char* type = nullptr;
        {
            std::lock_guard<std::mutex> lock(state_mutex_);
            if (ending_ && !uplink_failed_) {
                id = std::move(pending_end_id_);
                session = std::move(pending_end_session_);
                gen = pending_end_generation_;
                type = pending_end_type_;
            }
        }
        if (type) {
            if (!id.empty() && !uplink_failed_ &&
                !send_control(type, id, session, gen)) fail_uplink();
            std::lock_guard<std::mutex> lock(state_mutex_);
            ending_ = false;
        }
    } while (pump_again_.exchange(false));
    pumping_.clear();
    if (pump_again_.exchange(false)) pump_uplink();
}

void SentientWsProtocol::handle_disconnect() {
    bool playback;
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        playback = !wire_.audio_turn.empty() || !wire_.done_turn.empty();
        wire_.disconnect();
        uplink_failed_ = true;
        streaming_ = false;
        ending_ = false;
        discard_uplink_ = true;
        pending_end_id_.clear();
    }
    if (playback && cfg_.on_playback_end) cfg_.on_playback_end(true);
}
void SentientWsProtocol::force_reconnect() {
    reconnect_attempts_.store(0);
    disconnect();
    { std::lock_guard<std::mutex> lock(state_mutex_); wire_.terminal_auth = false; }
    stopping_ = false;
    connect();
}

void SentientWsProtocol::handle_data(const esp_websocket_event_data_t* ed) {
    if (!ed) return;
    const uint8_t* binary = nullptr;
    size_t binary_len = 0;
    bool complete = inbound_.append(ed->op_code, ed->fin, ed->payload_offset,
                                    ed->payload_len, ed->data_ptr, ed->data_len,
                                    binary, binary_len);
    if (inbound_.opcode == 2 && !inbound_.dropped && binary_len) {
        if (!inbound_.binary_accepted) {
            std::lock_guard<std::mutex> lock(state_mutex_);
            inbound_.binary_accepted = inbound_.header_size == 9 &&
                wire_.audio_sequence(inbound_.binary_header.data());
            if (!inbound_.binary_accepted) inbound_.dropped = true;
        }
        // Playback may block on the decode queue: never hold state_mutex_ here.
        if (inbound_.binary_accepted && demuxer_) demuxer_->Process(binary, binary_len);
    }
    if (!complete) return;
    if (!inbound_.dropped && inbound_.opcode == 1) handle_text(inbound_.bytes.data(), inbound_.size);
    else if (inbound_.dropped) ESP_LOGW(TAG, "ws: invalid or oversized message dropped");
    inbound_.reset();
}

void SentientWsProtocol::handle_text(const char* data, size_t len) {
    cJSON* root = cJSON_ParseWithLength(data, len);
    if (!root) { ESP_LOGW(TAG, "ws: invalid json len=%u", static_cast<unsigned>(len)); return; }
    const std::string type = value(field(root, "type"));
    if (type == "auth.error") {
        { std::lock_guard<std::mutex> lock(state_mutex_); wire_.terminal_auth = true; }
        cancel_ready_timeout(); cancel_reconnect();
        handle_disconnect();
        if (demuxer_) demuxer_->Reset();
        set_status(SdkStatus::Error);
    } else if (type == "auth.ok" && status() == SdkStatus::Authenticating) {
        cJSON* obj = cJSON_CreateObject();
        if (obj) {
            cJSON_AddStringToObject(obj, "type", "session.configure");
            cJSON_AddStringToObject(obj, "clientType", "cube");
            cJSON_AddStringToObject(obj, "deviceId", cfg_.device_id.c_str());
            cJSON_AddStringToObject(obj, "language", "en");
            cJSON* caps = cJSON_AddObjectToObject(obj, "capabilities");
            cJSON* supports = caps ? cJSON_AddArrayToObject(caps, "supports") : nullptr;
            if (supports) {
                cJSON_AddItemToArray(supports, cJSON_CreateString("audio.input"));
                cJSON_AddItemToArray(supports, cJSON_CreateString("audio.output"));
            }
            // ponytail: fresh snapshot, no journal replay; add resume cursor if offline history matters.
            { std::lock_guard<std::mutex> lock(state_mutex_);
              if (!wire_.anchor.empty()) cJSON_AddStringToObject(obj, "conversationId", wire_.anchor.c_str()); }
            char* encoded = cJSON_PrintUnformatted(obj);
            bool sent = encoded && send_text(encoded);
            if (encoded) cJSON_free(encoded);
            cJSON_Delete(obj);
            if (!sent) { fail_uplink(); cJSON_Delete(root); return; }
        } else { fail_uplink(); cJSON_Delete(root); return; }
        arm_ready_timeout();
    } else if (type == "session.attached") {
        const cJSON* gen = cJSON_GetObjectItemCaseSensitive(root, "generation");
        const char* id = field(root, "sessionId");
        if (id && cJSON_IsNumber(gen)) {
            std::lock_guard<std::mutex> lock(state_mutex_);
            wire_.attached(id, gen->valueint);
        }
    } else if (type == "session.draft") {
        std::lock_guard<std::mutex> lock(state_mutex_);
        wire_.draft(value(field(root, "draftKey")));
    } else if (type == "session.ready" && status() == SdkStatus::Authenticating) {
        // session.ready advertises input format; downlink encoding is turn.audio.start.
        cancel_ready_timeout(); reconnect_attempts_.store(0);
        set_status(SdkStatus::Ready);
    } else if (type == "conversation.entry" || type == "conversation.snapshot") {
        const char* content = nullptr;
        bool valid_snapshot = false;
        if (type == "conversation.entry") {
            const cJSON* item = cJSON_GetObjectItemCaseSensitive(root, "item");
            if (value(field(item, "kind")) == "user") content = field(item, "content");
        } else {
            const cJSON* items = cJSON_GetObjectItemCaseSensitive(root, "items");
            if (cJSON_IsArray(items)) {
                valid_snapshot = true;
                const cJSON* item;
                cJSON_ArrayForEach(item, items) {
                    const std::string kind = value(field(item, "kind"));
                    if (kind == "user" || kind == "assistant") {
                        const char* candidate = field(item, "content");
                        if (!candidate) valid_snapshot = false;
                        else if (kind == "user") content = candidate;
                    } else if (kind == "trigger") {
                        if (!field(item, "source") || !field(item, "summary")) valid_snapshot = false;
                    } else valid_snapshot = false;
                }
            }
        }
        if (content || valid_snapshot) {
            std::string text = content ? content : "";
            { std::lock_guard<std::mutex> lock(state_mutex_); last_transcript_ = text; }
            if (cfg_.on_transcript) cfg_.on_transcript(text);
        }
    } else if (type == "turn.started") {
        if (cfg_.on_cognition_status) cfg_.on_cognition_status(CognitionState::Thinking);
    } else if (type == "turn.completed" || type == "turn.aborted") {
        if (cfg_.on_cognition_status) cfg_.on_cognition_status(CognitionState::Idle);
    } else if (type == "turn.audio.start") {
        const cJSON* rate = cJSON_GetObjectItemCaseSensitive(root, "sampleRate");
        bool accepted = false;
        if (cJSON_IsNumber(rate) && rate->valueint > 0) {
            std::lock_guard<std::mutex> lock(state_mutex_);
            accepted = wire_.audio_start(value(field(root, "turnId")), value(field(root, "encoding")));
            if (accepted) output_sample_rate_ = rate->valueint;
        }
        if (accepted) {
            if (!demuxer_) demuxer_ = std::make_unique<OggDemuxer>();
            else demuxer_->Reset();
            // OpusHead input rate is informational; decode at negotiated wire rate.
            demuxer_->OnDemuxerFinished([this](const uint8_t* packet, int, size_t len) {
                if (cfg_.on_playback_frame) cfg_.on_playback_frame(packet, len, output_sample_rate_);
            });
            if (cfg_.on_playback_begin) cfg_.on_playback_begin(rate->valueint);
        } else ESP_LOGW(TAG, "turn.audio.start: unsupported or overlapping audio");
    } else if (type == "turn.audio.done" || type == "playback.stop") {
        bool ended;
        { std::lock_guard<std::mutex> lock(state_mutex_);
          ended = type == "playback.stop"
              ? wire_.audio_stop(value(field(root, "turnId")))
              : wire_.audio_end(value(field(root, "turnId"))); }
        if (ended) {
            if (demuxer_) demuxer_->Reset();
            if (cfg_.on_playback_end) cfg_.on_playback_end(type == "playback.stop");
        }
    }
    cJSON_Delete(root);
}
void SentientWsProtocol::ws_event_handler(void* arg, esp_event_base_t, int32_t event_id, void* event_data) {
    auto* self = static_cast<SentientWsProtocol*>(arg);
    switch (event_id) {
        case WEBSOCKET_EVENT_CONNECTED: {
            if (self->stopping_ || self->status() != SdkStatus::Connecting) break;
            self->set_status(SdkStatus::Authenticating);
            cJSON* obj = cJSON_CreateObject();
            if (!obj) { self->fail_uplink(); break; }
            cJSON_AddStringToObject(obj, "type", "auth");
            cJSON_AddStringToObject(obj, "token", self->cfg_.token.c_str());
            char* encoded = cJSON_PrintUnformatted(obj);
            bool sent = encoded && self->send_text(encoded);
            if (encoded) cJSON_free(encoded);
            cJSON_Delete(obj);
            if (!sent) self->fail_uplink();
            break;
        }
        case WEBSOCKET_EVENT_DATA:
            if (!self->stopping_ && self->status() != SdkStatus::Error)
                self->handle_data(static_cast<esp_websocket_event_data_t*>(event_data));
            break;
        case WEBSOCKET_EVENT_DISCONNECTED:
        case WEBSOCKET_EVENT_CLOSED:
            self->cancel_ready_timeout();
            self->inbound_.reset(); // only websocket event task owns assembler
            if (self->demuxer_) self->demuxer_->Reset();
            self->handle_disconnect();
            if (!self->stopping_ && self->status() != SdkStatus::Error) {
                self->set_status(SdkStatus::Reconnecting);
                self->schedule_reconnect();
            }
            break;
        default: break;
    }
}
void SentientWsProtocol::schedule_reconnect() {
    { std::lock_guard<std::mutex> lock(state_mutex_);
      if (wire_.terminal_auth || stopping_) return; }
    int attempt;
    esp_err_t err = ESP_OK;
    {
        std::lock_guard<std::mutex> lock(timer_mutex_);
        if (stopping_ || reconnect_timer_) return;
        attempt = ++reconnect_attempts_;
        if (attempt <= kReconnectMaxAttempts) {
            esp_timer_create_args_t args = {};
            args.callback = [](void* ptr) {
                auto* self = static_cast<SentientWsProtocol*>(ptr);
                if (!self->stopping_ && self->worker_)
                    xTaskNotify(self->worker_, kReconnectSignal, eSetBits);
            };
            args.arg = this;
            err = esp_timer_create(&args, &reconnect_timer_);
            if (err == ESP_OK) {
                err = esp_timer_start_once(reconnect_timer_, (std::min(1000 * (1 << (attempt - 1)), 30000) + esp_random() % 500) * 1000ULL);
                if (err != ESP_OK) { esp_timer_delete(reconnect_timer_); reconnect_timer_ = nullptr; }
            }
        }
    }
    if (attempt > kReconnectMaxAttempts || err != ESP_OK) set_status(SdkStatus::Error);
}
void SentientWsProtocol::cancel_reconnect() {
    std::lock_guard<std::mutex> lock(timer_mutex_);
    if (!reconnect_timer_) return;
    esp_timer_stop(reconnect_timer_);
    esp_timer_delete(reconnect_timer_);
    reconnect_timer_ = nullptr;
}
void SentientWsProtocol::arm_ready_timeout() {
    cancel_ready_timeout();
    std::lock_guard<std::mutex> lock(timer_mutex_);
    if (stopping_) return;
    esp_timer_create_args_t args = {};
    args.callback = [](void* ptr) {
        auto* self = static_cast<SentientWsProtocol*>(ptr);
        if (!self->stopping_ && self->worker_)
            xTaskNotify(self->worker_, kReadySignal, eSetBits);
    };
    args.arg = this;
    if (esp_timer_create(&args, &ready_timeout_timer_) == ESP_OK)
        esp_timer_start_once(ready_timeout_timer_, kReadyTimeoutMs * 1000ULL);
}
void SentientWsProtocol::cancel_ready_timeout() {
    std::lock_guard<std::mutex> lock(timer_mutex_);
    if (!ready_timeout_timer_) return;
    esp_timer_stop(ready_timeout_timer_);
    esp_timer_delete(ready_timeout_timer_);
    ready_timeout_timer_ = nullptr;
}
void SentientWsProtocol::worker_entry(void* arg) {
    static_cast<SentientWsProtocol*>(arg)->run_worker();
}
void SentientWsProtocol::run_worker() {
    while (true) {
        uint32_t events = 0;
        xTaskNotifyWait(0, UINT32_MAX, &events, portMAX_DELAY);
        if (events & kStopSignal || stopping_) break;
        if ((events & kFailSignal) && client_) {
            TickType_t deadline = xTaskGetTickCount() + pdMS_TO_TICKS(kUplinkWaitMs);
            while (pumping_.test_and_set()) {
                if (static_cast<int32_t>(deadline - xTaskGetTickCount()) <= 0) abort();
                vTaskDelay(1);
            }
            pumping_.clear();
            esp_websocket_client_stop(client_);
            if (!stopping_ && status() == SdkStatus::Reconnecting) schedule_reconnect();
        }
        if ((events & kReadySignal) && status() == SdkStatus::Authenticating && client_) {
            // stop (not close): pinned close falls back to portMAX_DELAY on timeout.
            esp_websocket_client_stop(client_);
            if (!stopping_ && status() == SdkStatus::Authenticating) {
                handle_disconnect();
                set_status(SdkStatus::Reconnecting);
                schedule_reconnect();
            }
        }
        if ((events & kReconnectSignal) && !stopping_ &&
            status() == SdkStatus::Reconnecting) {
            TickType_t deadline = xTaskGetTickCount() + pdMS_TO_TICKS(kUplinkWaitMs);
            while (pumping_.test_and_set()) {
                if (static_cast<int32_t>(deadline - xTaskGetTickCount()) <= 0) {
                    set_status(SdkStatus::Error);
                    // Keep client alive while sender may still be inside it.
                    // Error is terminal until explicit force_reconnect.
                    goto next_event;
                }
                vTaskDelay(1);
            }
            if (!stopping_) {
                esp_websocket_client_destroy(client_);
                client_ = nullptr;
            }
            pumping_.clear();
            if (!stopping_) {
                cancel_reconnect();
                connect();
            }
        }
        // Stop/failure/reconnect takes priority over stale pump notifications.
        if ((events & kPumpSignal) && !stopping_ && status() == SdkStatus::Ready)
            pump_uplink();
next_event:;
    }
    if (client_) {
        esp_websocket_client_stop(client_);
        esp_websocket_client_destroy(client_);
        client_ = nullptr;
    }
    xSemaphoreGive(worker_done_);
    vTaskDelete(nullptr);
}
void SentientWsProtocol::wait_for_timer_callbacks() {
    // ESP_TIMER_TASK serializes callbacks. Barrier after cancellation ensures no
    // callback still holds `this` before client teardown/destruction.
    SemaphoreHandle_t done = xSemaphoreCreateBinary();
    if (!done) abort();
    esp_timer_handle_t barrier = nullptr;
    esp_timer_create_args_t args = {};
    args.callback = [](void* ptr) { xSemaphoreGive(static_cast<SemaphoreHandle_t>(ptr)); };
    args.arg = done;
    ESP_ERROR_CHECK(esp_timer_create(&args, &barrier));
    ESP_ERROR_CHECK(esp_timer_start_once(barrier, 1));
    // If timer task cannot run, cannot safely free its callback target.
    if (xSemaphoreTake(done, pdMS_TO_TICKS(5000)) != pdTRUE) abort();
    esp_timer_delete(barrier);
    vSemaphoreDelete(done);
}
}  // namespace sentient::cube
