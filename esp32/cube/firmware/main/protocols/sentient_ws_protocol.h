// SPDX-License-Identifier: MIT
#pragma once

#include <cJSON.h>
#include <esp_err.h>
#include <esp_event.h>
#include <esp_timer.h>
#include <esp_websocket_client.h>

#include <atomic>
#include <functional>
#include <mutex>
#include <string>

namespace sentient::cube {

inline constexpr int kSentientUplinkSampleRateHz = 16000;
inline constexpr int kSentientDownlinkSampleRateHz = 24000;

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
    // TLS verification strategy. Prod: verify the gateway's (Let's Encrypt)
    // cert against the embedded mbedTLS certificate bundle. Debug: skip
    // verification (local gateway serves a self-signed localhost cert).
    // Exactly one of these is active per build profile.
    bool use_crt_bundle = true;
    bool insecure_skip_verify = false;
};

// Single-class in-firmware sentient WS client. Phase 6b extracts the internals
// into shared/cube-sdk/. This class is intentionally larger than typical Phase 6a
// scope because it consolidates connect/auth/router/reconnect into one unit for
// the vertical-slice smoke. <=600 lines impl per clean-code rule; if it threatens
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

    // Firmware hook: called when the audio service has new opus packets ready.
    void notify_uplink_available();

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
    void arm_ready_timeout();
    void cancel_ready_timeout();

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
    int active_input_sample_rate_ = kSentientUplinkSampleRateHz;
    int active_output_sample_rate_ = kSentientDownlinkSampleRateHz;

    std::atomic<bool> is_streaming_{false};
    std::atomic<int> reconnect_attempts_{0};
    esp_timer_handle_t reconnect_timer_ = nullptr;
    esp_timer_handle_t ready_timeout_timer_ = nullptr;
};

}  // namespace sentient::cube
