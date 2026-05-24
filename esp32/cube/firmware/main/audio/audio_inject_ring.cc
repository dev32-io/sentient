// audio_inject_ring.cc — see audio_inject_ring.h.
//
// Storage + mutex + push/pop_locked + strong override of
// agent_audio_inject_pop_samples. Ported verbatim from the v1 inject path —
// same buffer geometry, same drop-on-overflow semantics.

#include "audio_inject_ring.h"

#include <mutex>

#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

namespace {

constexpr const char* TAG = "sentient.cube.audio.inject_ring";

// Ring-buffer capacity. Two seconds at 16 kHz mono — preserved verbatim from
// the v1 inject_ring (kInjectRingSamples). Tuned for HIL: long enough
// for chained injections, small enough to leave PSRAM headroom for the rest
// of the audio pipeline.
constexpr size_t kInjectRingSamples = 32000;

// Rate gate for the pop path. Wake-word + audio_processor always request
// 16 kHz; any other rate degrades to "no injection at this rate" and the
// real codec path runs as normal.
constexpr int kSupportedSampleRate = 16000;

int16_t g_ring[kInjectRingSamples];
size_t  g_head  = 0;   // next write index
size_t  g_tail  = 0;   // next read index
size_t  g_count = 0;   // samples currently buffered

SemaphoreHandle_t g_mutex = nullptr;
std::once_flag    g_mutex_once;

void ensure_mutex_once() {
    std::call_once(g_mutex_once, []() {
        g_mutex = xSemaphoreCreateMutex();
        if (g_mutex == nullptr) {
            ESP_LOGE(TAG, "xSemaphoreCreateMutex returned null");
        }
    });
}

size_t push_locked(const int16_t* src, size_t n) {
    size_t pushed = 0;
    while (pushed < n && g_count < kInjectRingSamples) {
        g_ring[g_head] = src[pushed++];
        g_head = (g_head + 1) % kInjectRingSamples;
        g_count++;
    }
    return pushed;
}

size_t pop_locked(int16_t* dst, size_t n) {
    size_t popped = 0;
    while (popped < n && g_count > 0) {
        dst[popped++] = g_ring[g_tail];
        g_tail = (g_tail + 1) % kInjectRingSamples;
        g_count--;
    }
    return popped;
}

}  // namespace

extern "C" size_t audio_inject_ring_push(const int16_t* src, size_t n) {
    if (src == nullptr || n == 0) return 0;
    ensure_mutex_once();
    if (g_mutex == nullptr) return 0;
    size_t pushed = 0;
    if (xSemaphoreTake(g_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        pushed = push_locked(src, n);
        xSemaphoreGive(g_mutex);
    } else {
        ESP_LOGW(TAG, "push mutex timeout n=%u", (unsigned)n);
    }
    ESP_LOGD(TAG, "push n=%u pushed=%u count=%u",
             (unsigned)n, (unsigned)pushed, (unsigned)g_count);
    return pushed;
}

extern "C" int audio_inject_ring_pop(int16_t* dst, int target_samples,
                                      int sample_rate) {
    if (dst == nullptr || target_samples <= 0) return 0;
    if (sample_rate != kSupportedSampleRate) return 0;
    ensure_mutex_once();
    if (g_mutex == nullptr) return 0;
    int got = 0;
    // Non-blocking take: the codec read path runs every ~10 ms; if the push
    // side is holding the mutex briefly, return 0 and the real codec path
    // takes over for this read. Keeps the audio loop deterministic.
    if (xSemaphoreTake(g_mutex, 0) == pdTRUE) {
        got = static_cast<int>(pop_locked(dst, static_cast<size_t>(target_samples)));
        xSemaphoreGive(g_mutex);
    }
    return got;
}

extern "C" size_t audio_inject_ring_available(void) {
    ensure_mutex_once();
    if (g_mutex == nullptr) return 0;
    size_t count = 0;
    if (xSemaphoreTake(g_mutex, 0) == pdTRUE) {
        count = g_count;
        xSemaphoreGive(g_mutex);
    }
    return count;
}

// ---------------------------------------------------------------------------
// Strong override of the weak hook declared in audio_service.cc. Called from
// AudioService::ReadAudioData() on every codec read. Returns the number of
// mono samples written; 0 means "ring empty / unsupported rate, fall back to
// the real codec path".
// ---------------------------------------------------------------------------
extern "C" int agent_audio_inject_pop_samples(int16_t* buf,
                                              int target_samples,
                                              int sample_rate) {
    return audio_inject_ring_pop(buf, target_samples, sample_rate);
}
