// SPDX-License-Identifier: MIT
// devtool_verbs/audio_play.cc — audio.play_pcm verb.
//
// base64-decode PCM16 mono @ 16 kHz, push to speaker via the cube_play_pcm()
// shim. Both single-payload and chunked-stream variants are supported.
//
// Migrated from components/agent_console/verbs/audio_play.cc in Task 24.
// audio.test_tone moved to audio_misc.cc per the plan's grouping.
// Gated by CONFIG_AGENT_CONSOLE_DESTRUCTIVE — debug keeps it on, prod flips
// it off (and CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE is also off in prod, so
// the verb constructor no-ops via the companion stub anyway).
//
// Registered via __attribute__((constructor)) static-init.

#include "sdkconfig.h"

#include "esp32_devtool/verbs.h"
#include "audio_common.h"

#include <cstdint>
#include <cstring>
#include <vector>

#include <esp_log.h>
#include <mbedtls/base64.h>

extern "C" bool cube_play_pcm(const int16_t* samples, size_t count, int sample_rate);

namespace {

constexpr const char* TAG = "sentient.cube.devtool.audio";

devtool_audio::ChunkedStream g_play_stream;

#if CONFIG_AGENT_CONSOLE_DESTRUCTIVE

int handle_audio_play_pcm(const cJSON* params, cJSON* out_result,
                          int* ec, const char** em) {
    using devtool_audio::ChunkedStream;
    using devtool_audio::kMaxChunkB64Bytes;
    using devtool_audio::kMaxStreamB64Bytes;
    using devtool_audio::parse_chunk_params;
    using devtool_audio::decode_b64_to_vec;

    // --- Chunked-stream path ---
    int chunk = 0, of = 0;
    char stream_id[33] = {0};
    if (parse_chunk_params(params, &chunk, &of, stream_id, ec, em)) {
        if (*ec != 0) return 1;

        const cJSON* b64_node = cJSON_GetObjectItem(params, "b64");
        if (!cJSON_IsString(b64_node)) {
            *ec = -32602;
            *em = "Invalid params: expect b64 (string)";
            return 1;
        }

        const size_t b64_len = strlen(b64_node->valuestring);
        if (b64_len > kMaxChunkB64Bytes) {
            *ec = -32602;
            *em = "Invalid params: chunk b64 exceeds 32 KB cap";
            return 1;
        }

        ChunkedStream& st = g_play_stream;
        if (chunk == 0) {
            if (st.active) {
                *ec = -32000;
                *em = "Server error: stream already in-flight";
                return 1;
            }
            st.active = true;
            strncpy(st.stream_id, stream_id, 32);
            st.stream_id[32] = '\0';
            st.next_chunk = 1;
            st.total_chunks = of;
            st.b64_accum.clear();
        } else {
            if (!st.active) {
                *ec = -32602;
                *em = "Invalid params: no active stream; send chunk 0 first";
                return 1;
            }
            if (strcmp(st.stream_id, stream_id) != 0) {
                st.active = false;
                st.b64_accum.clear();
                *ec = -32000;
                *em = "Server error: stream_id mismatch";
                return 1;
            }
            if (chunk != st.next_chunk) {
                st.active = false;
                st.b64_accum.clear();
                *ec = -32602;
                *em = "Invalid params: expected chunk index out of order";
                return 1;
            }
            st.next_chunk++;
        }

        if (st.b64_accum.size() + b64_len > kMaxStreamB64Bytes) {
            ESP_LOGW(TAG, "play_pcm stream-b64-total %u > cap %u",
                     (unsigned)(st.b64_accum.size() + b64_len),
                     (unsigned)kMaxStreamB64Bytes);
            *ec = -32602;
            *em = "Invalid params: total stream size exceeds 256 KB cap";
            st.active = false;
            st.b64_accum.clear();
            return 1;
        }
        st.b64_accum.append(b64_node->valuestring, b64_len);

        cJSON_AddBoolToObject(out_result, "ok", true);
        cJSON_AddNumberToObject(out_result, "chunk", (double)chunk);
        cJSON_AddNumberToObject(out_result, "of", (double)of);
        cJSON_AddNumberToObject(out_result, "buffered_b64",
                                (double)st.b64_accum.size());

        if (chunk + 1 == of) {
            // Final chunk — decode accumulated base64, validate PCM16
            // alignment, then play.
            std::vector<uint8_t> raw;
            if (decode_b64_to_vec(st.b64_accum.c_str(), st.b64_accum.size(),
                                  raw, ec, em) != 0) {
                st.active = false;
                st.b64_accum.clear();
                return 1;
            }
            if (raw.size() % 2 != 0) {
                *ec = -32602;
                *em = "Invalid params: total decoded length not PCM16-aligned";
                st.active = false;
                st.b64_accum.clear();
                return 1;
            }
            const size_t sample_count = raw.size() / 2;
            ESP_LOGI(TAG, "play_pcm chunked-commit raw=%u samples=%u",
                     (unsigned)raw.size(), (unsigned)sample_count);
            const bool ok = cube_play_pcm(
                reinterpret_cast<const int16_t*>(raw.data()),
                sample_count, 16000);
            st.active = false;
            st.b64_accum.clear();
            if (!ok) {
                *ec = -32603;
                *em = "PlayPcm failed";
                return 1;
            }
            cJSON_AddBoolToObject(out_result, "committed", true);
            cJSON_AddNumberToObject(out_result, "samples", (double)sample_count);
        } else {
            cJSON_AddBoolToObject(out_result, "committed", false);
        }
        return 0;
    }

    // --- Single-payload path ---
    const cJSON* b64_node = cJSON_GetObjectItem(params, "b64");
    if (!cJSON_IsString(b64_node)) {
        *ec = -32602;
        *em = "Invalid params: expect b64 (string)";
        return 1;
    }
    const char* b64 = b64_node->valuestring;
    const size_t b64_len = strlen(b64);
    constexpr size_t kMaxB64Bytes = 64 * 1024;
    if (b64_len > kMaxB64Bytes) {
        *ec = -32602;
        *em = "Invalid params: b64 length exceeds 64 KB cap (use chunked variant)";
        return 1;
    }

    std::vector<uint8_t> raw(b64_len);
    size_t raw_len = 0;
    const int rc = mbedtls_base64_decode(raw.data(), raw.size(), &raw_len,
                                          (const unsigned char*)b64, b64_len);
    if (rc != 0) {
        *ec = -32602;
        *em = "Invalid params: base64 decode failed";
        return 1;
    }
    if (raw_len % 2 != 0) {
        *ec = -32602;
        *em = "Invalid params: decoded length not PCM16-aligned";
        return 1;
    }

    const int16_t* samples = reinterpret_cast<const int16_t*>(raw.data());
    const size_t sample_count = raw_len / 2;
    ESP_LOGI(TAG, "play_pcm b64_len=%u raw_len=%u samples=%u",
             (unsigned)b64_len, (unsigned)raw_len, (unsigned)sample_count);
    const bool ok = cube_play_pcm(samples, sample_count, 16000);
    if (!ok) {
        *ec = -32603;
        *em = "PlayPcm failed";
        return 1;
    }
    cJSON_AddBoolToObject(out_result, "ok", true);
    cJSON_AddNumberToObject(out_result, "samples", (double)sample_count);
    return 0;
}

#endif  // CONFIG_AGENT_CONSOLE_DESTRUCTIVE

__attribute__((constructor))
static void register_audio_play_verb(void) {
#if CONFIG_AGENT_CONSOLE_DESTRUCTIVE
    devtool_register_verb("audio.play_pcm", handle_audio_play_pcm);
#endif
}

}  // namespace
