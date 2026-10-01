"""Execute production AFE worker allocation/deletion boundary without hardware."""
from pathlib import Path
import subprocess

SOURCE = Path(__file__).resolve().parents[2] / 'firmware/main/audio/processors/afe_audio_processor.cc'


def test_full_stack_caps_pair_and_allocation_failure(tmp_path):
    source = SOURCE.read_text()
    start = source.index('    // Fetch/reset + queue callbacks')
    end = source.index('\n}', start)
    # Intercept fail-closed abort so allocation rejection is observable on host.
    creation = source[start:end].replace('std::abort()', 'throw AllocationFailure{}')
    cpp = r'''
#include <cassert>
#include <cstring>
#include <cstddef>
#define ESP_LOGE(...) ((void)0)
constexpr int pdPASS = 1, MALLOC_CAP_SPIRAM = 1, MALLOC_CAP_8BIT = 2;
struct AllocationFailure {};
bool fail_task = false;
int created = 0, caps_created = 0, deleted = 0, caps_deleted = 0, ran = 0;
void (*entry)(void*) = nullptr;
void* argument = nullptr;
int xTaskCreate(void (*fn)(void*), const char* name, int bytes, void* arg, int priority, void* handle) {
    assert(std::strcmp(name, "audio_communication") == 0);
    assert(bytes == 4096 && priority == 3 && handle == nullptr);
    ++created;
    if (fail_task) return 0;
    entry = fn; argument = arg;
    return pdPASS;
}
int xTaskCreateWithCaps(void (*fn)(void*), const char* name, int bytes, void* arg, int priority,
                        void* handle, int caps) {
    assert(caps == (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    ++caps_created;
    return xTaskCreate(fn, name, bytes, arg, priority, handle);
}
void vTaskDelete(void* task) { assert(task == nullptr); ++deleted; }
void vTaskDeleteWithCaps(void* task) { assert(task == nullptr); ++caps_deleted; }
struct AfeAudioProcessor {
    void* afe_data_ = this;
    void* event_group_ = this;
    void AudioProcessorTask() { ++ran; }
    void Create() {
''' + creation + r'''
    }
};
int main() {
    AfeAudioProcessor processor;
    for (int failure = 0; failure < 3; ++failure) {
        processor.afe_data_ = failure == 0 ? nullptr : &processor;
        processor.event_group_ = failure == 1 ? nullptr : &processor;
        fail_task = failure == 2;
        bool rejected = false;
        try { processor.Create(); } catch (AllocationFailure&) { rejected = true; }
        assert(rejected && entry == nullptr && ran == 0);
    }
    assert(created == 1); // invalid AFE/sync state never starts worker
    fail_task = false;
    processor.Create();
    assert(entry && created == 2);
    entry(argument); // test matching return/deletion path too
    assert(ran == 1);
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE
    assert(caps_created == 2 && caps_deleted == 1 && deleted == 0);
#else
    assert(caps_created == 0 && caps_deleted == 0 && deleted == 1);
#endif
}
'''
    file = tmp_path / 'worker.cc'
    file.write_text(cpp)
    binary = tmp_path / 'worker'
    for cube in (0, 1):
        subprocess.run(['c++', '-std=c++17', f'-DCONFIG_BOARD_TYPE_SENTIENT_CUBE={cube}',
                        str(file), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True, timeout=5)
