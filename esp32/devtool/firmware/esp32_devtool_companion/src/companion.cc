#include "esp32_devtool/companion.h"

#include <cstdio>
#include <cstring>

#include <esp_log.h>
#include <esp_timer.h>

#include "verb_dispatcher.h"
#include "usb_cdc_reader.h"
#include "http_server.h"
#include "log_relay.h"

static const char* TAG = "sentient.cube.devtool";

// Format an int64 microsecond timestamp to a decimal string. Avoids printf's
// %lld / PRId64 path entirely: ESP-IDF's default newlib-nano printf does NOT
// understand %ll, and the resulting garbage corrupts the HIL marker line
// ("ld" in place of the timestamp). HIL tests parse the timestamp as an
// integer; the marker is unusable without it.
static int format_int64(int64_t value, char* buf, size_t cap) {
    if (cap == 0) return 0;
    if (value < 0) {
        if (cap < 2) return 0;
        buf[0] = '-';
        return 1 + format_int64(-value, buf + 1, cap - 1);
    }
    char tmp[24];
    int n = 0;
    do {
        tmp[n++] = '0' + (int)(value % 10);
        value /= 10;
    } while (value > 0 && n < (int)sizeof(tmp));
    if ((size_t)n >= cap) n = (int)cap - 1;
    for (int i = 0; i < n; ++i) {
        buf[i] = tmp[n - 1 - i];
    }
    buf[n] = '\0';
    return n;
}

static bool s_post_net_started = false;
static esp32_devtool_companion_config_t s_cfg = {};

extern "C" {

int esp32_devtool_companion_start(const esp32_devtool_companion_config_t* cfg) {
    if (cfg == nullptr) return -1;
    s_cfg = *cfg;
    ESP_LOGI(TAG, "start cdc=%d http=%d(port=%d, deferred) relay=%d (deferred)",
             cfg->enable_usb_cdc, cfg->enable_http, cfg->http_port,
             cfg->udp_relay.enabled);
    devtool_verb_dispatcher_init();
    if (cfg->enable_usb_cdc) {
        devtool_usb_cdc_reader_start();
    }
    // Pre-WiFi work ends here. HTTP server + UDP log relay deferred to
    // esp32_devtool_companion_post_network_ready(), which the application
    // calls from its network-up handler. See companion.h for the rationale.
    std::printf(">>> READY\n");
    std::fflush(stdout);
    return 0;
}

void esp32_devtool_companion_post_network_ready(void) {
    if (s_post_net_started) return;
    s_post_net_started = true;
    ESP_LOGI(TAG, "post_network_ready: starting http=%d relay=%d",
             s_cfg.enable_http, s_cfg.udp_relay.enabled);
    if (s_cfg.enable_http) {
        devtool_http_server_start(s_cfg.http_port);
    }
    if (s_cfg.udp_relay.enabled) {
        devtool_log_relay_start(s_cfg.udp_relay.host, s_cfg.udp_relay.port);
    }
}

void esp32_devtool_companion_stop(void) {
    // v1 leaves resources up for app lifetime.
}

void esp32_devtool_companion_checkpoint(const char* label) {
    if (label == nullptr) return;
    int64_t ts_us = esp_timer_get_time();
    char ts_buf[24];
    format_int64(ts_us, ts_buf, sizeof(ts_buf));
    std::printf(">>> CHECKPOINT %s %s\n", label, ts_buf);
    std::fflush(stdout);
}

void esp32_devtool_companion_event(const char* json) {
    if (json == nullptr) return;
    std::printf("<<< EVT %s\n", json);
    std::fflush(stdout);
}

}  // extern "C"

namespace { esp32_devtool_info_provider_t s_info_fn = nullptr; }

extern "C" void esp32_devtool_set_info_provider(esp32_devtool_info_provider_t fn) {
    s_info_fn = fn;
}

extern "C" int esp32_devtool_get_info(esp32_devtool_info_t* out) {
    if (s_info_fn == nullptr || out == nullptr) return -1;
    return s_info_fn(out);
}

namespace { esp32_devtool_snapshot_provider_t s_snap_fn = nullptr; }

extern "C" void esp32_devtool_set_snapshot_provider(esp32_devtool_snapshot_provider_t fn) {
    s_snap_fn = fn;
}

extern "C" int esp32_devtool_get_snapshot(esp32_devtool_snapshot_t* out) {
    if (s_snap_fn == nullptr || out == nullptr) return -1;
    return s_snap_fn(out);
}

namespace { esp32_devtool_touch_provider_t s_touch_fn = nullptr; }

extern "C" void esp32_devtool_set_touch_provider(esp32_devtool_touch_provider_t fn) {
    s_touch_fn = fn;
}

extern "C" int esp32_devtool_invoke_touch(int x, int y, int hold_ms) {
    if (s_touch_fn == nullptr) return -1;
    return s_touch_fn(x, y, hold_ms);
}

namespace { esp32_devtool_audio_record_provider_t s_audio_record_fn = nullptr; }

extern "C" void esp32_devtool_set_audio_record_provider(
        esp32_devtool_audio_record_provider_t fn) {
    s_audio_record_fn = fn;
}

extern "C" int esp32_devtool_invoke_audio_record(int16_t* dst, size_t samples,
                                                  int sample_rate) {
    if (s_audio_record_fn == nullptr) return -1;
    return s_audio_record_fn(dst, samples, sample_rate);
}

namespace { esp32_devtool_audio_inject_provider_t s_audio_inject_fn = nullptr; }

extern "C" void esp32_devtool_set_audio_inject_provider(
        esp32_devtool_audio_inject_provider_t fn) {
    s_audio_inject_fn = fn;
}

extern "C" int esp32_devtool_invoke_audio_inject(const int16_t* src, size_t samples,
                                                  int sample_rate) {
    if (s_audio_inject_fn == nullptr) return -1;
    return s_audio_inject_fn(src, samples, sample_rate);
}
