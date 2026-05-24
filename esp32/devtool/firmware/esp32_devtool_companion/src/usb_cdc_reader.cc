#include "usb_cdc_reader.h"
#include "verb_dispatcher.h"

#include <cstdio>
#include <cstring>
#include <cstdint>
#include <cstdlib>

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <esp_log.h>
#include <esp_heap_caps.h>

static const char* TAG = "sentient.cube.devtool.cdc";

namespace {
constexpr size_t kBufferSize = 65536;       // longest verb is audio.inject_pcm — 0.5s @ 16kHz mono PCM16 = ~21KB base64; 1s = ~42KB
constexpr const char* kCmdPrefix = ">>> CMD ";

void usb_cdc_reader_task(void* /*arg*/) {
    // Buffer in PSRAM — 64KB in internal SRAM would starve WiFi init
    // (which needs ~40KB contiguous from the same pool).
    char* buf = (char*)heap_caps_malloc(kBufferSize, MALLOC_CAP_SPIRAM);
    if (buf == nullptr) {
        ESP_LOGE(TAG, "PSRAM alloc failed; falling back to internal");
        buf = (char*)std::malloc(kBufferSize);
        if (buf == nullptr) {
            ESP_LOGE(TAG, "buf alloc failed; cdc reader disabled");
            return;
        }
    }
    for (;;) {
        // USB-CDC may deliver a single host write() as multiple USB packets.
        // fgets returns after the first packet, yielding a partial line.
        // Accumulate until we see a newline to get the full command.
        size_t pos = 0;
        bool found_newline = false;
        int null_retries = 0;
        while (!found_newline && pos < kBufferSize - 1) {
            if (std::fgets(buf + pos, static_cast<int>(kBufferSize - pos), stdin) == nullptr) {
                if (pos == 0) {
                    // stdin closed/error — back off to avoid spinning.
                    vTaskDelay(pdMS_TO_TICKS(100));
                    break;
                }
                // USB-CDC VFS returns null on read timeout between packets,
                // even though the connection is still live and more data is
                // coming.  Retry a few times before treating as a host-sent
                // partial line without trailing newline.
                if (++null_retries > 20) {  // ~200 ms of retries
                    found_newline = true;
                    break;
                }
                vTaskDelay(pdMS_TO_TICKS(10));
                continue;
            }
            null_retries = 0;
            pos += std::strlen(buf + pos);
            if (pos > 0 && (buf[pos - 1] == '\n' || buf[pos - 1] == '\r')) {
                found_newline = true;
            }
        }
        if (pos == 0) continue;
        // Strip trailing newline(s).
        size_t len = pos;
        while (len > 0 && (buf[len - 1] == '\n' || buf[len - 1] == '\r')) {
            buf[--len] = '\0';
        }
        if (std::strncmp(buf, kCmdPrefix, std::strlen(kCmdPrefix)) != 0) {
            // Discard non-CMD lines silently. Avoid logging here — would cause
            // recursion via the same stdout xiaozhi log goes through.
            continue;
        }
        const char* json = buf + std::strlen(kCmdPrefix);
        size_t jlen = std::strlen(json);
        ESP_LOGI(TAG, "rx-cmd len=%u head=%.60s tail=%.30s",
                 (unsigned)jlen, json,
                 jlen > 30 ? json + jlen - 30 : "");
        devtool_dispatcher_dispatch_line(json);
    }
}

}  // namespace

extern "C" void devtool_usb_cdc_reader_start(void) {
    ESP_LOGI(TAG, "start");
    BaseType_t ok = xTaskCreate(usb_cdc_reader_task, "devtool-cdc", 6 * 1024,
                                nullptr, tskIDLE_PRIORITY + 2, nullptr);
    if (ok != pdPASS) {
        ESP_LOGE(TAG, "task-create-failed");
    }
}
