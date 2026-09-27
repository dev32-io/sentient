"""Host check of production injection ring's PSRAM-only lazy storage and FIFO contract."""
from pathlib import Path
import subprocess
import tempfile
import unittest

AUDIO = Path(__file__).resolve().parents[2] / 'firmware/main/audio'


class AudioInjectRingBoundaryTest(unittest.TestCase):
    def test_idle_failure_retry_and_wrap(self):
        headers = {
            'esp_log.h': '#pragma once\n#define ESP_LOGE(...) ((void)0)\n#define ESP_LOGW(...) ((void)0)\n#define ESP_LOGD(...) ((void)0)\n',
            'esp_heap_caps.h': '''#pragma once
#include <cstddef>
constexpr int MALLOC_CAP_SPIRAM = 1;
constexpr int MALLOC_CAP_8BIT = 2;
extern int allocation_calls, last_caps;
extern size_t last_size;
extern bool fail_allocation;
void* heap_caps_malloc(size_t size, int caps);
''',
            'freertos/FreeRTOS.h': '#pragma once\n#define pdTRUE 1\n#define pdMS_TO_TICKS(ms) (ms)\n',
            'freertos/semphr.h': '''#pragma once
#include <mutex>
using SemaphoreHandle_t = std::mutex*;
inline SemaphoreHandle_t xSemaphoreCreateMutex() { return new std::mutex; }
inline int xSemaphoreTake(SemaphoreHandle_t mutex, int) { return mutex->try_lock() ? pdTRUE : 0; }
inline void xSemaphoreGive(SemaphoreHandle_t mutex) { mutex->unlock(); }
''',
        }
        cpp = r'''
#include "audio_inject_ring.h"
#include "esp_heap_caps.h"
#include <cassert>
#include <cstdlib>
#include <vector>
int allocation_calls = 0, last_caps = 0;
size_t last_size = 0;
bool fail_allocation = true;
void* heap_caps_malloc(size_t size, int caps) {
    ++allocation_calls;
    last_size = size;
    last_caps = caps;
    return fail_allocation ? nullptr : std::malloc(size);
}
int main() {
    int16_t dst[32000] = {};
    assert(audio_inject_ring_pop(dst, 32000, 16000) == 0);
    assert(audio_inject_ring_available() == 0);
    assert(allocation_calls == 0); // Normal mic path never allocates ring.
    int16_t sample = 17;
    assert(audio_inject_ring_push(&sample, 1) == 0);
    assert(audio_inject_ring_available() == 0);
    assert(audio_inject_ring_pop(dst, 1, 16000) == 0);
    assert(allocation_calls == 1 && last_size == 64000);
    assert(last_caps == (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    fail_allocation = false;
    std::vector<int16_t> src(32010);
    for (size_t i = 0; i < src.size(); ++i) src[i] = static_cast<int16_t>(i);
    assert(audio_inject_ring_push(src.data(), src.size()) == 32000);
    assert(allocation_calls == 2 && audio_inject_ring_available() == 32000);
    assert(audio_inject_ring_push(&sample, 1) == 0); // Bounded: drop overflow.
    assert(audio_inject_ring_pop(dst, 31990, 16000) == 31990);
    for (int i = 0; i < 31990; ++i) assert(dst[i] == src[i]);
    assert(audio_inject_ring_push(src.data() + 32000, 10) == 10); // Wrap.
    assert(audio_inject_ring_pop(dst, 20, 16000) == 20);
    for (int i = 0; i < 20; ++i) assert(dst[i] == src[31990 + i]);
    assert(audio_inject_ring_available() == 0 && allocation_calls == 2);
}
'''
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, content in headers.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            source = root / 'test.cc'
            source.write_text(cpp)
            binary = root / 'ring'
            subprocess.run(['c++', '-std=c++17', '-pthread', '-I', str(root), '-I', str(AUDIO),
                            str(source), str(AUDIO / 'audio_inject_ring.cc'), '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True, timeout=5)


if __name__ == '__main__':
    unittest.main()
