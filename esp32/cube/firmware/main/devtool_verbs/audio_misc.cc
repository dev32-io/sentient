// SPDX-License-Identifier: MIT
// devtool_verbs/audio_misc.cc — audio.dump_state + audio.test_tone verbs.
//
// audio.dump_state: read-only counters snapshot (stub for v1; will source
//   from AudioService stats once those counters land).
// audio.test_tone: generate a sine wave on-device and push to speaker.
//   Gated by CONFIG_AGENT_CONSOLE_DESTRUCTIVE (blocks the verb-dispatch
//   task while I2S DMA drains).
//
// Migrated in Task 24. audio.dump_state was in components/agent_console/verbs/
// audio_misc.cc; audio.test_tone was in audio_play.cc. The plan groups both
// under audio_misc.cc to keep audio_play.cc focused on the chunked-stream
// PCM-injection path. tts.cancel moved to its own tts.cc file.
//
// Registered via __attribute__((constructor)) static-init.

#include "sdkconfig.h"

#include "esp32_devtool/verbs.h"

#include <cmath>
#include <cstdint>
#include <vector>

#include <esp_log.h>

extern "C" bool cube_play_pcm(const int16_t* samples, size_t count, int sample_rate);

namespace {

constexpr const char* TAG = "sentient.cube.devtool.audio";

int handle_audio_dump_state(const cJSON* /*params*/, cJSON* out_result,
                            int* /*ec*/, const char** /*em*/) {
    // TODO: source from xiaozhi's AudioService stats once those counters land.
    // For v1 return zeros so the verb is callable and the shape is stable.
    cJSON_AddNumberToObject(out_result, "q_depth",            0);
    cJSON_AddNumberToObject(out_result, "frames_sent",        0);
    cJSON_AddNumberToObject(out_result, "frames_recv",        0);
    cJSON_AddNumberToObject(out_result, "opus_decode_ms_avg", 0);
    return 0;
}

#if CONFIG_AGENT_CONSOLE_DESTRUCTIVE

int handle_audio_test_tone(const cJSON* params, cJSON* out_result,
                           int* ec, const char** em) {
    const cJSON* freq_node = cJSON_GetObjectItem(params, "freq");
    const cJSON* ms_node = cJSON_GetObjectItem(params, "ms");
    if (!cJSON_IsNumber(freq_node) || !cJSON_IsNumber(ms_node)) {
        *ec = -32602;
        *em = "Invalid params: expect freq + ms (numbers)";
        return 1;
    }
    const int freq = freq_node->valueint;
    const int ms = ms_node->valueint;
    if (freq < 20 || freq > 20000) {
        *ec = -32602;
        *em = "Invalid params: freq must be 20-20000 Hz";
        return 1;
    }
    if (ms < 10 || ms > 1000) {
        *ec = -32602;
        *em = "Invalid params: ms must be 10-1000 (1s PlayPcm cap)";
        return 1;
    }

    constexpr int kSampleRate = 16000;
    const size_t sample_count = (size_t)kSampleRate * (size_t)ms / 1000U;
    ESP_LOGI(TAG, "test_tone freq=%d ms=%d samples=%u", freq, ms,
             (unsigned)sample_count);
    std::vector<int16_t> samples(sample_count);
    const float omega = 2.0f * 3.14159265358979323846f
                        * (float)freq / (float)kSampleRate;
    for (size_t i = 0; i < sample_count; ++i) {
        const float v = sinf(omega * (float)i);
        samples[i] = (int16_t)(v * 16384.0f);  // 50% amplitude to avoid clipping
    }

    // PlayPcm is synchronous (blocks until I2S DMA completes). Acceptable
    // under CONFIG_AGENT_CONSOLE_DESTRUCTIVE for HIL; the devtool USB-CDC
    // reader task is intentionally blocked for the tone duration.
    const bool ok = cube_play_pcm(samples.data(), samples.size(), kSampleRate);
    if (!ok) {
        *ec = -32603;
        *em = "PlayPcm failed (codec disabled or rate rejected)";
        return 1;
    }
    cJSON_AddBoolToObject(out_result, "ok", true);
    cJSON_AddNumberToObject(out_result, "samples_generated", (double)sample_count);
    return 0;
}

#endif  // CONFIG_AGENT_CONSOLE_DESTRUCTIVE

__attribute__((constructor))
static void register_audio_misc_verbs(void) {
    devtool_register_verb("audio.dump_state", handle_audio_dump_state);
#if CONFIG_AGENT_CONSOLE_DESTRUCTIVE
    devtool_register_verb("audio.test_tone",  handle_audio_test_tone);
#endif
}

}  // namespace
