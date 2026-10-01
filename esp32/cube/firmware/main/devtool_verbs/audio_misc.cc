// SPDX-License-Identifier: MIT
// devtool_verbs/audio_misc.cc — audio.dump_state + audio.test_tone verbs.
//
// audio.dump_state: live processor/drain flags and bounded heap diagnostics.
//   Software drain is not proof of physical codec DMA drain.
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

#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
#include "esp32_devtool/verbs.h"
#include "audio/audio_inject_ring.h"
#include "application.h"

#include <cmath>
#include <cstdint>
#include <vector>

#include <esp_log.h>
#include <esp_heap_caps.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

extern "C" bool cube_voice_processing(void);
extern "C" bool cube_mic1_gain_register(int* value);
extern "C" bool cube_playback_drained(void);
extern "C" bool cube_play_pcm(const int16_t* samples, size_t count, int sample_rate);

namespace {

constexpr const char* TAG = "sentient.cube.devtool.audio";

int handle_audio_dump_state(const cJSON* /*params*/, cJSON* out_result,
                            int* /*ec*/, const char** /*em*/) {
    // Do not report invented frame counters: use observable live boundaries.
    cJSON_AddBoolToObject(out_result, "voice_processing", cube_voice_processing());
    cJSON_AddNumberToObject(out_result, "mic1_gain_requested_db", CONFIG_CUBE_MIC1_GAIN_DB);
    int mic1_reg = 0;
    if (cube_mic1_gain_register(&mic1_reg)) {
        cJSON_AddNumberToObject(out_result, "mic1_gain_reg43", mic1_reg);
        cJSON_AddNumberToObject(out_result, "mic1_gain_code", mic1_reg & 0x0f);
    } else {
        cJSON_AddNullToObject(out_result, "mic1_gain_reg43");
        cJSON_AddNullToObject(out_result, "mic1_gain_code");
    }
    cJSON_AddBoolToObject(out_result, "playback_drained", cube_playback_drained());
    const size_t pending = audio_inject_ring_available();
    const size_t consumed = audio_inject_ring_consumed();
    if (pending == SIZE_MAX) cJSON_AddNullToObject(out_result, "injection_pending_samples");
    else cJSON_AddNumberToObject(out_result, "injection_pending_samples", pending);
    if (consumed == SIZE_MAX) cJSON_AddNullToObject(out_result, "injection_consumed_samples");
    else cJSON_AddNumberToObject(out_result, "injection_consumed_samples", consumed);
    CaptureEnergySnapshot snapshot;
    if (!Application::GetInstance().GetAudioService().GetCaptureEnergy(snapshot)) {
        cJSON_AddNullToObject(out_result, "capture_energy");
    } else {
        auto* capture = cJSON_AddObjectToObject(out_result, "capture_energy");
        cJSON_AddNumberToObject(capture, "epoch", snapshot.epoch);
        const char* states[] = {"idle", "capturing", "draining", "complete", "retired", "failed"};
        cJSON_AddStringToObject(capture, "state", states[static_cast<unsigned>(snapshot.state)]);
        cJSON_AddNumberToObject(capture, "native_rate_hz", snapshot.native_rate_hz);
        cJSON_AddNumberToObject(capture, "encoder_rate_hz", snapshot.encoder_rate_hz);
        cJSON_AddNumberToObject(capture, "injected_samples", snapshot.injected_samples);
        if (snapshot.afe_counts_available) {
            cJSON_AddNumberToObject(capture, "afe_fed_samples", snapshot.afe_fed_samples);
            cJSON_AddNumberToObject(capture, "afe_fetched_samples", snapshot.afe_fetched_samples);
        } else {
            cJSON_AddNullToObject(capture, "afe_fed_samples");
            cJSON_AddNullToObject(capture, "afe_fetched_samples");
        }
        auto add_energy = [capture](const char* name, const CaptureEnergy& energy) {
            if (!energy.valid) {
                cJSON_AddNullToObject(capture, name);
                return;
            }
            auto* stage = cJSON_AddObjectToObject(capture, name);
            cJSON_AddNumberToObject(stage, "samples", energy.samples);
            // PCM16 full scale = 32768; zero samples is unavailable, not silence.
            if (energy.samples) {
                cJSON_AddNumberToObject(stage, "rms_normalized",
                    std::sqrt(static_cast<double>(energy.squares) / energy.samples) / 32768.0);
                cJSON_AddNumberToObject(stage, "peak_pcm16", energy.peak);
            } else {
                cJSON_AddNullToObject(stage, "rms_normalized");
                cJSON_AddNullToObject(stage, "peak_pcm16");
            }
            cJSON_AddNumberToObject(stage, "clipped_samples", energy.clipped);
        };
        add_energy("native_mic_physical", snapshot.native_mic);
        add_energy("encoder_queue_accepted", snapshot.encoder_input);
    }
    constexpr uint32_t internal = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
    cJSON_AddNumberToObject(out_result, "internal_free_bytes", heap_caps_get_free_size(internal));
    cJSON_AddNumberToObject(out_result, "internal_min_free_bytes", heap_caps_get_minimum_free_size(internal));
    cJSON_AddNumberToObject(out_result, "internal_largest_block_bytes", heap_caps_get_largest_free_block(internal));
    cJSON_AddNumberToObject(out_result, "psram_free_bytes", heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    if (auto task = xTaskGetHandle("opus_codec")) {
        cJSON_AddNumberToObject(out_result, "opus_stack_unused_bytes", uxTaskGetStackHighWaterMark(task));
    }
    if (auto task = xTaskGetHandle("sentient_ws")) {
        cJSON_AddNumberToObject(out_result, "ws_worker_stack_unused_bytes", uxTaskGetStackHighWaterMark(task));
    }
    if (auto task = xTaskGetHandle("websocket_task")) {
        cJSON_AddNumberToObject(out_result, "ws_transport_stack_unused_bytes", uxTaskGetStackHighWaterMark(task));
    }
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

    // PlayPcm waits for codec writes, not independently verified DAC drain.
    // Under CONFIG_AGENT_CONSOLE_DESTRUCTIVE the devtool USB-CDC reader
    // task is intentionally blocked for the tone's software output.
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
#endif  // CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
