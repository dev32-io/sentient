#pragma once
#include "cube_enrollment_store.h"
#include "cube_http_diagnostics.h"
#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <esp_event.h>
#include <esp_wifi.h>
#include <protocomm.h>

namespace sentient::cube {
struct CubeConnection {
    std::string device_id, url, token;
    uint32_t revision = 0;
    bool blocked = true;
};
struct CubePresentation {
    bool setup = false, pairing = false, account_attention = false;
    std::string qr, locator, proof; // Setup-only display data; never diagnostics.
};
struct CubeHardwareStatus {
    const char* phase;
    std::string last_error; // Firmware-owned error category, never transport detail.
    bool fatal, account_attention, ble_active, ble_connected, ble_authenticated;
    bool wifi_connected, gateway_ready;
    const char* wifi_state;
    CubeHttpDiagnostics http;
    const char* ws_start_phase;
    esp_err_t ws_start_error;
};

// Board-lifetime service. Only worker performs HTTP/BLE lifecycle operations;
// protected commands atomically persist intent, never wait for gateway requests.
class CubeHardware {
public:
    static CubeHardware& Get() { static CubeHardware instance; return instance; }
    esp_err_t Start(std::function<void(bool)> network_event);
    void RequestSync();
    void WsStartResult(const char* phase, esp_err_t error);
    CubeConnection Connection();
    CubePresentation Presentation();
    CubeHardwareStatus Status();
    bool WifiConnected() const { return wifi_connected_; }
    void GatewayReady(bool value) { gateway_ready_ = value; }
    void Battery(int percent, bool charging) { battery_ = percent; charging_ = charging; }
private:
    CubeHardware() = default;
    void Run();
    esp_err_t StartBle();
    esp_err_t Save(const CubeEnrollment& next);
    void SyncGateway();
    std::string Command(const uint8_t* data, size_t len);
    static esp_err_t Control(uint32_t, const uint8_t*, ssize_t, uint8_t**, ssize_t*, void*);
    static void NetworkEvent(void*, esp_event_base_t, int32_t, void*);
    static void BleEvent(void*, esp_event_base_t, int32_t, void*);

    std::mutex mutex_;
    CubeEnrollmentStore store_;
    CubeEnrollment record_;
    std::function<void(bool)> network_event_;
    nvs_handle_t wifi_nvs_ = 0;
    wifi_config_t wifi_config_{};
    bool have_wifi_ = false;
    bool apply_wifi_ = false;
    bool fatal_ = false, account_attention_ = false, syncing_ = false;
    std::string last_error_, token_, qr_;
    CubeHttpDiagnostics http_;
    const char* ws_start_phase_ = "idle";
    esp_err_t ws_start_error_ = ESP_OK;
    uint32_t revision_ = 0, epoch_ = 0;
    bool sync_requested_ = false;
    unsigned sync_attempts_ = 0;
    int64_t next_sync_ = 0;
    enum class WifiState { Offline, Joining, Connected, Failed };
    std::atomic<WifiState> wifi_state_{WifiState::Offline};
    std::atomic<bool> wifi_connected_{false}, gateway_ready_{false};
    std::atomic<bool> ble_restart_{false}, ble_active_{false}, ble_authenticated_{false};
    std::atomic<int> ble_handle_{-1};
    std::atomic<int64_t> ble_deadline_{0};
    std::atomic<int> battery_{-1};
    std::atomic<bool> charging_{false};
    bool ble_bootstrap_ = true; // Changed only while NimBLE is stopped.
    protocomm_t* pc_ = nullptr;
    uint8_t ble_salt_[32]{}, ble_verifier_[384]{};
};
}
