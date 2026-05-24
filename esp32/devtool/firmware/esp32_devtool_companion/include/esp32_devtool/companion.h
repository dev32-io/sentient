#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool enable_usb_cdc;
    bool enable_http;
    int  http_port;
    struct {
        bool enabled;
        const char* host;
        int port;
    } udp_relay;
} esp32_devtool_companion_config_t;

// Boot companion. Called once at app startup. Registers the USB-CDC reader +
// verb dispatcher (pre-WiFi surface) and stashes the http/relay config. The
// HTTP server + UDP log relay are NOT started here — the application must call
// esp32_devtool_companion_post_network_ready() from its network-up handler.
// That late-bound start runs in the application's main task (priority 10,
// generous stack) instead of the IP_EVENT callback context, which avoids the
// sys_evt task stack overflow + the UI-task contention seen when the companion
// hooked IP_EVENT directly. No-op when CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE=n.
int esp32_devtool_companion_start(const esp32_devtool_companion_config_t* cfg);

// Late-bound: called by the application once the network is up and an IP is
// assigned. Idempotent — subsequent calls are no-ops. Starts the HTTP server
// (if enable_http) and the UDP log relay (if udp_relay.enabled). Safe to call
// from any task with at least 4 KB of free stack; intended for the
// application's network-connected handler running in its main task.
void esp32_devtool_companion_post_network_ready(void);

void esp32_devtool_companion_stop(void);

// Boundary stdout markers used by the host-side daemon's serial reader.
void esp32_devtool_companion_checkpoint(const char* label);
void esp32_devtool_companion_event(const char* json);

typedef struct {
    const char* device_id;
    const char* board;
    const char* chip;
    const char* firmware;
    const char* build_profile;
    const char* ip;
    const char* mac;
    int wifi_rssi;
    int uptime_s;
    const char* wifi_ssid;
} esp32_devtool_info_t;

// Caller fills `out` from app state. Return 0 on success.
typedef int (*esp32_devtool_info_provider_t)(esp32_devtool_info_t* out);

void esp32_devtool_set_info_provider(esp32_devtool_info_provider_t fn);

typedef struct {
    uint16_t* pixels;  // RGB565 LE; caller does not free — provider owns
    int width;
    int height;
} esp32_devtool_snapshot_t;

typedef int (*esp32_devtool_snapshot_provider_t)(esp32_devtool_snapshot_t* out);

void esp32_devtool_set_snapshot_provider(esp32_devtool_snapshot_provider_t fn);

// Touch-injection provider. The application registers a callback that synthesizes
// a pointer-down at (x, y) held for `hold_ms` milliseconds, then released.
// Coordinate space is the application's native screen coords (board-specific —
// see board manifest / docs). Returns 0 on success, non-zero on failure (e.g.
// LVGL lock timeout or invalid params).
typedef int (*esp32_devtool_touch_provider_t)(int x, int y, int hold_ms);

void esp32_devtool_set_touch_provider(esp32_devtool_touch_provider_t fn);

// Audio capture provider. Fills `dst` with `samples` mono int16 samples at
// `sample_rate`. Returns 0 on success, non-zero on failure (provider unset,
// codec not ready, etc.). Synchronous: blocks the HTTP task until the capture
// completes. The board adapter typically delegates to AudioService::RecordPcm.
typedef int (*esp32_devtool_audio_record_provider_t)(int16_t* dst,
                                                      size_t samples,
                                                      int sample_rate);

// Audio injection provider. Queues `samples` mono int16 samples at
// `sample_rate` into the cube's injection ring; subsequent codec reads drain
// the ring before falling back to the real mic path. Returns 0 on success.
typedef int (*esp32_devtool_audio_inject_provider_t)(const int16_t* src,
                                                      size_t samples,
                                                      int sample_rate);

void esp32_devtool_set_audio_record_provider(esp32_devtool_audio_record_provider_t fn);
void esp32_devtool_set_audio_inject_provider(esp32_devtool_audio_inject_provider_t fn);

#ifdef __cplusplus
}
#endif
