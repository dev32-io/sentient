#include <cstdio>
#include <cstring>
#include <esp_http_server.h>
#include <esp_log.h>

#include "esp32_devtool/companion.h"
#include "esp32_devtool/endpoints.h"
#include "companion_internal.h"

static const char* TAG = "sentient.cube.devtool.screenshot";

// v1 returns raw RGB565 LE; the host CLI converts to PNG/JPEG if asked.
// On-device PNG/JPEG would need lvgl_imageenc or libpng/zlib + several KB of
// extra PSRAM — not worth it when WiFi bandwidth is plentiful and the host
// does the conversion in milliseconds.
static esp_err_t screenshot_handler(httpd_req_t* req) {
    ESP_LOGD(TAG, "GET /screenshot");
    esp32_devtool_snapshot_t snap = {};
    if (esp32_devtool_get_snapshot(&snap) != 0 || snap.pixels == nullptr) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        httpd_resp_sendstr(req, "{\"error\":\"snapshot_provider_unset\"}");
        return ESP_OK;
    }

    char w[16], h[16];
    snprintf(w, sizeof(w), "%d", snap.width);
    snprintf(h, sizeof(h), "%d", snap.height);
    httpd_resp_set_hdr(req, "X-Screenshot-Width", w);
    httpd_resp_set_hdr(req, "X-Screenshot-Height", h);
    httpd_resp_set_hdr(req, "X-Screenshot-Format", "rgb565");

    size_t bytes = (size_t)snap.width * snap.height * 2;
    httpd_resp_set_type(req, "application/octet-stream");

    // Stream the body in chunks. A single 434 KB send via httpd_resp_send
    // serializes against lwIP's TCP_SND_BUF (default 5760 bytes) and is
    // observed to stall to <10 KB/s under any background WiFi pressure on the
    // cube (clock-tick log spam, WS heartbeats, etc.). 16 KB chunks let the
    // httpd loop yield naturally between writes and TCP keeps the window open.
    constexpr size_t kChunk = 16 * 1024;
    const char* p = reinterpret_cast<const char*>(snap.pixels);
    size_t remaining = bytes;
    while (remaining > 0) {
        size_t n = remaining < kChunk ? remaining : kChunk;
        esp_err_t e = httpd_resp_send_chunk(req, p, n);
        if (e != ESP_OK) {
            ESP_LOGE(TAG, "send_chunk failed at offset=%u: %d",
                     (unsigned)(bytes - remaining), (int)e);
            return e;
        }
        p += n;
        remaining -= n;
    }
    // Empty chunk closes the response.
    return httpd_resp_send_chunk(req, nullptr, 0);
}

__attribute__((constructor))
static void register_screenshot_route() {
    devtool_register_http("GET", "/screenshot", screenshot_handler);
}
