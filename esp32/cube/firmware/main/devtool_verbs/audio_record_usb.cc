// SPDX-License-Identifier: MIT
// devtool_verbs/audio_record_usb.cc — audio.record_rms + audio.record_pcm.
//
// USB-CDC variants of the audio record verbs. The HTTP /audio/record endpoint
// (devtool companion) is the modern path; these JSON-RPC verbs remain for
// HIL tests that already speak JSON-RPC end-to-end.
//
// record_rms: capture `ms` of mic, return mean RMS amplitude as a number.
// record_pcm: capture `ms` of mic, return base64-encoded PCM16 mono.
//
// Migrated from components/agent_console/verbs/audio_record.cc in Task 24.
// Both gated by CONFIG_AGENT_CONSOLE_DESTRUCTIVE.
//
// Registered via __attribute__((constructor)) static-init.

#include "sdkconfig.h"

#include "esp32_devtool/verbs.h"

#include <cmath>
#include <cstdint>
#include <vector>

#include <esp_log.h>
#include <mbedtls/base64.h>

extern "C" bool cube_record_pcm(int16_t* dst, size_t count, int sample_rate);

namespace {

constexpr const char* TAG = "sentient.cube.devtool.audio";

// audio.record_rms / audio.record_pcm constants.
constexpr int kRecordSampleRate = 16000;
constexpr int kRecordMinMs = 10;
constexpr int kRecordMaxMs = 1000;
// 1 s @ 16 kHz mono = 16000 samples = 32000 bytes raw = ~42667 base64 chars.
constexpr size_t kMaxRecordB64Bytes = 64 * 1024;

#ifdef CONFIG_AGENT_CONSOLE_DESTRUCTIVE

int handle_audio_record_rms(const cJSON* params, cJSON* out_result,
                            int* ec, const char** em) {
    const cJSON* ms_node = cJSON_GetObjectItem(params, "ms");
    if (!cJSON_IsNumber(ms_node)) {
        *ec = -32602;
        *em = "Invalid params: expect ms (number)";
        return 1;
    }
    const int ms = ms_node->valueint;
    if (ms < kRecordMinMs || ms > kRecordMaxMs) {
        *ec = -32602;
        *em = "Invalid params: ms must be 10-1000";
        return 1;
    }

    const size_t sample_count =
        static_cast<size_t>(kRecordSampleRate) * static_cast<size_t>(ms) / 1000U;
    std::vector<int16_t> samples(sample_count);
    ESP_LOGI(TAG, "record_rms ms=%d samples=%u", ms, (unsigned)sample_count);
    const bool ok = cube_record_pcm(samples.data(), sample_count, kRecordSampleRate);
    if (!ok) {
        *ec = -32603;
        *em = "RecordPcm failed (codec disabled or read aborted)";
        return 1;
    }

    // Mean of squares in double space, then sqrt → RMS in PCM16 units.
    double sum_sq = 0.0;
    for (size_t i = 0; i < sample_count; ++i) {
        const double v = static_cast<double>(samples[i]);
        sum_sq += v * v;
    }
    const double mean_sq = sum_sq / static_cast<double>(sample_count);
    const double rms = std::sqrt(mean_sq);

    cJSON_AddBoolToObject(out_result, "ok", true);
    cJSON_AddNumberToObject(out_result, "ms", static_cast<double>(ms));
    cJSON_AddNumberToObject(out_result, "samples", static_cast<double>(sample_count));
    cJSON_AddNumberToObject(out_result, "rms", rms);
    return 0;
}

int handle_audio_record_pcm(const cJSON* params, cJSON* out_result,
                            int* ec, const char** em) {
    const cJSON* ms_node = cJSON_GetObjectItem(params, "ms");
    if (!cJSON_IsNumber(ms_node)) {
        *ec = -32602;
        *em = "Invalid params: expect ms (number)";
        return 1;
    }
    const int ms = ms_node->valueint;
    if (ms < kRecordMinMs || ms > kRecordMaxMs) {
        *ec = -32602;
        *em = "Invalid params: ms must be 10-1000";
        return 1;
    }

    const size_t sample_count =
        static_cast<size_t>(kRecordSampleRate) * static_cast<size_t>(ms) / 1000U;
    std::vector<int16_t> samples(sample_count);
    ESP_LOGI(TAG, "record_pcm ms=%d samples=%u", ms, (unsigned)sample_count);
    const bool ok = cube_record_pcm(samples.data(), sample_count, kRecordSampleRate);
    if (!ok) {
        *ec = -32603;
        *em = "RecordPcm failed";
        return 1;
    }

    // base64-encode the raw PCM16 byte buffer.
    const size_t raw_bytes = sample_count * sizeof(int16_t);
    const size_t b64_capacity = ((raw_bytes + 2) / 3) * 4 + 1;
    if (b64_capacity > kMaxRecordB64Bytes) {
        *ec = -32603;
        *em = "Server error: encoded payload exceeds 64 KB cap";
        return 1;
    }
    std::vector<unsigned char> b64(b64_capacity);
    size_t b64_len = 0;
    const int rc = mbedtls_base64_encode(
        b64.data(), b64.size(), &b64_len,
        reinterpret_cast<const unsigned char*>(samples.data()), raw_bytes);
    if (rc != 0) {
        *ec = -32603;
        *em = "Server error: base64 encode failed";
        return 1;
    }
    // mbedtls returns b64_len excluding the null terminator. Ensure terminator.
    if (b64_len < b64.size()) b64[b64_len] = '\0';

    cJSON_AddBoolToObject(out_result, "ok", true);
    cJSON_AddNumberToObject(out_result, "ms", static_cast<double>(ms));
    cJSON_AddNumberToObject(out_result, "samples", static_cast<double>(sample_count));
    cJSON_AddNumberToObject(out_result, "rate",
                            static_cast<double>(kRecordSampleRate));
    cJSON_AddStringToObject(out_result, "b64",
                            reinterpret_cast<const char*>(b64.data()));
    return 0;
}

#endif  // CONFIG_AGENT_CONSOLE_DESTRUCTIVE

__attribute__((constructor))
static void register_audio_record_usb_verbs(void) {
#ifdef CONFIG_AGENT_CONSOLE_DESTRUCTIVE
    devtool_register_verb("audio.record_rms", handle_audio_record_rms);
    devtool_register_verb("audio.record_pcm", handle_audio_record_pcm);
#endif
}

}  // namespace
