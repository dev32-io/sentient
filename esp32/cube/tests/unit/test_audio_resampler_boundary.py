"""Host check of production input/output rate-converter rejection boundaries."""
from pathlib import Path
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / 'firmware/main/audio/audio_service.cc'


def block(text, marker):
    start = text.index(marker)
    opening = text.index('{', start)
    depth = 0
    for pos in range(opening, len(text)):
        depth += (text[pos] == '{') - (text[pos] == '}')
        if depth == 0:
            return text[start:pos + 1]
    raise AssertionError(marker)


class AudioResamplerBoundaryTest(unittest.TestCase):
    def test_error_and_oversized_counts_never_reach_resize_or_playback(self):
        source = SOURCE.read_text()
        read = block(source, 'bool AudioService::ReadAudioData(')
        output = block(source, 'if (decoder_sample_rate_ != codec_->output_sample_rate() && output_resampler_ != nullptr)')
        enqueue = block(source, 'if (generation == decode_generation_ && !task->pcm.empty())')
        cpp = r'''
#include <cassert>
#include <chrono>
#include <cstdint>
#include <memory>
#include <mutex>
#include <vector>
#ifndef CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
#define CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE 0
#endif
#define CONFIG_USE_AUDIO_DEBUGGER 0
#define ESP_AE_ERR_OK 0
#define ESP_LOGE(...) ((void)0)
#define ESP_LOGI(...) ((void)0)
#define TAG "test"
#define AUDIO_POWER_CHECK_INTERVAL_MS 1000
using esp_ae_sample_t = void*;
struct Handle {};
Handle handle;
int max_ret = 0, process_ret = 0;
uint32_t max_count = 480, actual_count = 480;
int process_calls = 0;
int esp_ae_rate_cvt_get_max_out_sample_num(Handle*, uint32_t, uint32_t* count) {
    *count = max_count;
    return max_ret;
}
int esp_ae_rate_cvt_process(Handle*, esp_ae_sample_t, uint32_t, esp_ae_sample_t, uint32_t* count) {
    ++process_calls;
    *count = actual_count;
    return process_ret;
}
int agent_audio_inject_pop_samples(int16_t*, int, int) { return 0; }
void esp_timer_stop(int) {}
void esp_timer_start_periodic(int, int) {}
struct Codec {
    int input_channels() { return 2; }
    int input_sample_rate() { return 24000; }
    int output_sample_rate() { return 24000; }
    bool input_enabled() { return true; }
    void EnableInput(bool) {}
    bool InputData(std::vector<int16_t>& data) {
        assert(data.size() == 1440 || data.size() == 480);
        return true;
    }
};
struct Task { std::vector<int16_t> pcm; };
struct AudioService {
    Codec* codec_;
    Handle* input_resampler_ = &handle;
    Handle* output_resampler_ = &handle;
    std::mutex input_resampler_mutex_;
    int audio_power_timer_ = 0;
    std::chrono::steady_clock::time_point last_input_time_;
    struct { int input_count = 0; } debug_statistics_;
    bool ReadAudioData(std::vector<int16_t>&, int, int);
};
''' + read + r'''
bool decode(AudioService& service, std::vector<int16_t> pcm) {
    auto* codec_ = service.codec_;
    auto* output_resampler_ = service.output_resampler_;
    int decoder_sample_rate_ = 16000;
    int decode_generation_ = 1, generation = 1;
    std::mutex mutex;
    std::unique_lock<std::mutex> lock(mutex);
    lock.unlock();
    auto task = std::make_unique<Task>();
    task->pcm = std::move(pcm);
    std::vector<std::unique_ptr<Task>> audio_playback_queue_;
''' + output + r'''
    lock.lock();
''' + enqueue + r'''
    return !audio_playback_queue_.empty();
}
int main() {
    Codec codec;
    AudioService service{};
    service.codec_ = &codec;
    std::vector<int16_t> data;
    // 30ms stereo 720 points and 10ms stereo 240-point tail, repeated.
    for (int round = 0; round < 2; ++round) {
        for (int request : {480, 160}) {
            max_count = request;
            actual_count = request;
            max_ret = process_ret = 0;
            assert(service.ReadAudioData(data, 16000, request));
            assert(data.size() == static_cast<size_t>(request * 2));
            max_ret = -1;
            int before = process_calls;
            assert(!service.ReadAudioData(data, 16000, request));
            assert(process_calls == before);
            max_ret = 0;
            process_ret = -1;
            assert(!service.ReadAudioData(data, 16000, request));
            process_ret = 0;
            actual_count = 0;
            assert(!service.ReadAudioData(data, 16000, request));
            actual_count = request + 1;
            assert(!service.ReadAudioData(data, 16000, request));
        }
    }
    max_count = actual_count = 480;
    assert(decode(service, std::vector<int16_t>(320)));
    max_ret = -1;
    int before = process_calls;
    assert(!decode(service, std::vector<int16_t>(320)) && process_calls == before);
    max_ret = 0;
    process_ret = -1;
    assert(!decode(service, std::vector<int16_t>(320)));
    process_ret = 0;
    actual_count = 481;
    assert(!decode(service, std::vector<int16_t>(320)));
}
'''
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'resampler.cc'
            file.write_text(cpp)
            binary = Path(directory) / 'resampler'
            for debug in (0, 1):
                subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra',
                                f'-DCONFIG_ESP32_DEVTOOL_COMPANION_ENABLE={debug}',
                                str(file), '-o', str(binary)], check=True)
                subprocess.run([str(binary)], check=True)


if __name__ == '__main__':
    unittest.main()
