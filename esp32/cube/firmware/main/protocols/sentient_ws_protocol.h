// SPDX-License-Identifier: MIT
#pragma once

#include "sentient_wire_state.h"

#include <cJSON.h>
#include <esp_err.h>
#include <esp_event.h>
#include <esp_timer.h>
#include <esp_websocket_client.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>

#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

namespace sentient::cube {

inline constexpr int kSentientUplinkSampleRateHz = 16000;
inline constexpr int kSentientDownlinkSampleRateHz = 24000;

enum class SdkStatus { Disconnected, Connecting, Authenticating, Ready, Reconnecting, Error };
enum class CognitionState { Idle, Thinking, Acting };

struct SentientWsProtocolConfig {
    std::string gateway_url;
    std::string token;
    std::string device_id;
    std::function<void(SdkStatus)> on_status_change;
    std::function<void(CognitionState)> on_cognition_status;
    std::function<void(const std::string&)> on_transcript;
    // Move encoded payload into caller; no second allocation/copy on constrained heap.
    std::function<bool(std::vector<uint8_t>& payload)> on_pop_uplink_frame;
    std::function<void(const uint8_t* data, size_t len, int sample_rate)> on_playback_frame;
    std::function<void(int sample_rate)> on_playback_begin;
    std::function<void(bool aborted)> on_playback_end;
    const char* cert_pem = nullptr;
};

class SentientWsProtocol {
public:
    explicit SentientWsProtocol(SentientWsProtocolConfig cfg);
    ~SentientWsProtocol();
    SentientWsProtocol(const SentientWsProtocol&) = delete;
    SentientWsProtocol& operator=(const SentientWsProtocol&) = delete;

    esp_err_t connect();
    void disconnect();
    SdkStatus status() const;
    bool start_streaming();
    void stop_streaming();
    void cancel_streaming();
    void interrupt();
    void notify_uplink_available();
    void force_reconnect();
    std::string last_transcript() const;

private:
    void set_status(SdkStatus next);
    bool send_text(const std::string& text);
    bool send_binary(const uint8_t* data, size_t len);
    void handle_text(const char* data, size_t len);
    void handle_binary(const uint8_t* data, size_t len);
    void handle_data(const esp_websocket_event_data_t* data);
    void handle_disconnect();
    void pump_uplink();
    void finish_uplink(const char* type);
    void fail_uplink();
    void schedule_reconnect();
    void cancel_reconnect();
    void arm_ready_timeout();
    void cancel_ready_timeout();
    void wait_for_timer_callbacks();
    static void worker_entry(void* arg);
    void run_worker();
    bool send_control(const char* type, const std::string& id,
                      const std::string& session, int generation);
    static void ws_event_handler(void* arg, esp_event_base_t base,
                                 int32_t event_id, void* event_data);

    SentientWsProtocolConfig cfg_;
    esp_websocket_client_handle_t client_ = nullptr;
    mutable std::mutex state_mutex_;
    SdkStatus status_ = SdkStatus::Disconnected;
    SentientWireState wire_;
    std::string last_transcript_;
    int output_sample_rate_ = kSentientDownlinkSampleRateHz;
    bool streaming_ = false;
    bool ending_ = false;
    bool discard_uplink_ = false;
    std::string pending_end_id_;
    std::string pending_end_session_;
    int pending_end_generation_ = 0;
    TickType_t end_deadline_ = 0;
    const char* pending_end_type_ = "audio.end";
    std::atomic_flag pumping_ = ATOMIC_FLAG_INIT;
    std::atomic<bool> pump_again_{false};
    std::atomic<bool> uplink_failed_{false};
    std::atomic<int> reconnect_attempts_{0};
    esp_timer_handle_t reconnect_timer_ = nullptr;
    esp_timer_handle_t ready_timeout_timer_ = nullptr;
    // ESP client reports payload_offset/data_len portions of each WS frame;
    // continuation frames finish a fragmented WS message. Drop oversize whole message.
    BoundedWsMessage inbound_;
    std::atomic<bool> stopping_{false};
    std::mutex timer_mutex_;
    TaskHandle_t worker_ = nullptr;
    SemaphoreHandle_t worker_done_ = nullptr;
};

}  // namespace sentient::cube
