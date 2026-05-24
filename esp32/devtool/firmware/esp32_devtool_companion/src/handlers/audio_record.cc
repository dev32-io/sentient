// handlers/audio_record.cc — GET /audio/record?duration_ms=N&sample_rate=R.
// Returns raw PCM16LE mono in the body; X-Audio-Samples header reports the
// sample count so the host can sanity-check without re-deriving from
// content-length. The provider (registered by the board adapter) wraps
// AudioService::RecordPcm — synchronous capture, blocks the httpd task.

#include <esp_http_server.h>
#include <esp_log.h>
#include <esp_heap_caps.h>
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "esp32_devtool/companion.h"
#include "esp32_devtool/endpoints.h"
#include "companion_internal.h"

static const char* TAG = "sentient.cube.devtool.audio.record";

// Defaults match the HIL parity test (1s @ 16 kHz mono = 32 KB body).
static constexpr int kDefaultDurationMs = 1000;
static constexpr int kDefaultSampleRate = 16000;

// Capture cap. AudioService::RecordPcm itself caps at 1 s on the codec side;
// the HTTP wrapper still trims the user's request to a sane upper bound so
// we don't allocate megabytes of PSRAM for a typo'd query string.
static constexpr int kMaxDurationMs = 10000;

static esp_err_t audio_record_handler(httpd_req_t* req) {
    char query[64] = {};
    int duration_ms = kDefaultDurationMs;
    int sample_rate = kDefaultSampleRate;
    if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK) {
        char v[16];
        if (httpd_query_key_value(query, "duration_ms", v, sizeof(v)) == ESP_OK) {
            duration_ms = atoi(v);
        }
        if (httpd_query_key_value(query, "sample_rate", v, sizeof(v)) == ESP_OK) {
            sample_rate = atoi(v);
        }
    }
    if (duration_ms <= 0) duration_ms = kDefaultDurationMs;
    if (duration_ms > kMaxDurationMs) duration_ms = kMaxDurationMs;
    if (sample_rate <= 0) sample_rate = kDefaultSampleRate;

    size_t samples = (size_t)duration_ms * (size_t)sample_rate / 1000U;
    size_t bytes = samples * sizeof(int16_t);
    ESP_LOGI(TAG, "record duration_ms=%d sample_rate=%d samples=%u bytes=%u "
                  "heap.sram free=%u min=%u largest=%u",
             duration_ms, sample_rate, (unsigned)samples, (unsigned)bytes,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));

    int16_t* buf = static_cast<int16_t*>(
        heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (buf == nullptr) {
        ESP_LOGE(TAG, "PSRAM alloc failed bytes=%u", (unsigned)bytes);
        httpd_resp_set_status(req, "503 Service Unavailable");
        httpd_resp_sendstr(req, "{\"error\":\"alloc_failed\"}");
        return ESP_OK;
    }

    int rc = esp32_devtool_invoke_audio_record(buf, samples, sample_rate);
    if (rc != 0) {
        ESP_LOGW(TAG, "invoke_audio_record failed rc=%d (provider unset or busy)", rc);
        free(buf);
        httpd_resp_set_status(req, "503 Service Unavailable");
        httpd_resp_sendstr(req, "{\"error\":\"audio_record_provider_unset\"}");
        return ESP_OK;
    }

    char ctype[64];
    std::snprintf(ctype, sizeof(ctype),
                  "audio/L16; rate=%d; channels=1", sample_rate);
    httpd_resp_set_type(req, ctype);

    char samp_s[16];
    std::snprintf(samp_s, sizeof(samp_s), "%u", (unsigned)samples);
    httpd_resp_set_hdr(req, "X-Audio-Samples", samp_s);

    // Chunked send — same rationale as screenshot.cc. A single httpd_resp_send
    // call serializes against lwIP's TCP_SND_BUF; under WiFi pressure (clock-
    // tick log spam, WS heartbeats) it stalls indefinitely even for sub-32 KB
    // payloads. 4 KB chunks let the httpd loop yield naturally between writes
    // and TCP keeps the window open.
    //
    // 1024-byte chunks. lwIP TCP_SND_BUF defaults to 5760 (~4 MSS). A 4 KB
    // chunk overshoots one round-trip's worth of unacked window, so the
    // second chunk's send() hits EAGAIN; httpd_resp_send_chunk does not
    // retry and bails with `httpd_sock_err: error in send : 11`. 1 KB
    // chunks always fit one TCP segment, get ACKed before the next send,
    // and unblock the 1s record body without WiFi-PS toggling or TCP
    // tuning.
    constexpr size_t kChunk = 1024;
    const char* p = reinterpret_cast<const char*>(buf);
    size_t remaining = bytes;
    esp_err_t send_err = ESP_OK;
    while (remaining > 0) {
        size_t n = remaining < kChunk ? remaining : kChunk;
        send_err = httpd_resp_send_chunk(req, p, n);
        if (send_err != ESP_OK) {
            ESP_LOGE(TAG, "send_chunk failed at offset=%u: %d "
                          "heap.sram free=%u largest=%u",
                     (unsigned)(bytes - remaining), (int)send_err,
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                     (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
            break;
        }
        p += n;
        remaining -= n;
    }
    free(buf);
    if (send_err != ESP_OK) return send_err;
    return httpd_resp_send_chunk(req, nullptr, 0);
}

__attribute__((constructor))
static void register_audio_record_route() {
    devtool_register_http("GET", "/audio/record", audio_record_handler);
}
