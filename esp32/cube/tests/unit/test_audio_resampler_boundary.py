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
        enqueue = block(source, 'if (generation == decode_generation_ &&')
        cpp = r'''
#include <cassert>
#include <chrono>
#include <cstdint>
#include <memory>
#include <functional>
#include <algorithm>
#include <set>
#include <mutex>
#include <vector>
#ifndef CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
#define CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE 0
#endif
#include "capture_energy.h"
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
[[maybe_unused]] constexpr int AS_EVENT_AUDIO_TESTING_RUNNING = 1, AS_EVENT_WAKE_WORD_RUNNING = 2,
              AS_EVENT_AUDIO_PROCESSOR_RUNNING = 4;
int modes = AS_EVENT_AUDIO_PROCESSOR_RUNNING, inject_remaining = 0;
int64_t now_us = 0;
std::function<void()> on_delay;
int xEventGroupGetBits(int) { return modes; }
using TickType_t = uint32_t;
#define configTICK_RATE_HZ 100
TickType_t xTaskGetTickCount() { return now_us / 10000; }
void vTaskDelay(int ticks) {
    assert(ticks == 1);
    now_us += 10000; // production tick duration, including partial frame rounding
    if (on_delay) on_delay();
}
int agent_audio_inject_pop_samples(int16_t* dst, int samples, int) {
    int got = std::min(inject_remaining, samples);
    inject_remaining -= got;
    std::fill(dst, dst + got, 123);
    return got;
}
struct Processor { bool running = true; bool IsRunning() { return running; } };
void esp_timer_stop(int) {}
void esp_timer_start_periodic(int, int) {}
std::function<void()> on_read;
struct Codec {
    int input_channels() { return 2; }
    int input_sample_rate() { return 24000; }
    int output_sample_rate() { return 24000; }
    bool input_enabled() { return true; }
    void EnableInput(bool) {}
    bool InputData(std::vector<int16_t>& data) {
        assert(data.size() == 1440 || data.size() == 480);
        for (size_t i = 0; i < data.size(); i += 2) {
            data[i] = i % 4 ? -4096 : 4096;
            data[i + 1] = 32767; // reference must not affect mic energy
        }
        if (on_read) on_read();
        return true;
    }
};
struct Task { std::vector<int16_t> pcm; uint32_t playback_epoch = 0; };
struct AudioService {
    Codec* codec_;
    std::mutex audio_queue_mutex_;
    uint32_t send_generation_ = 1;
    int event_group_ = 0;
    bool service_stopped_ = false;
    std::unique_ptr<Processor> audio_processor_ = std::make_unique<Processor>();
    Handle* input_resampler_ = &handle;
    Handle* output_resampler_ = &handle;
    std::mutex input_resampler_mutex_;
    int audio_power_timer_ = 0;
    std::chrono::steady_clock::time_point last_input_time_;
    struct { int input_count = 0; } debug_statistics_;
    bool ReadAudioData(std::vector<int16_t>&, int, int, uint32_t = 0);
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
    CaptureEnergySnapshot capture_energy_;
    bool accepting_send_ = true;
#endif
};
''' + read + r'''
bool decode(AudioService& service, std::vector<int16_t> pcm, bool playback_failed_ = false,
            uint32_t failed_playback_epoch_ = 0, uint32_t epoch = 0) {
    auto* codec_ = service.codec_;
    auto* output_resampler_ = service.output_resampler_;
    int decoder_sample_rate_ = 16000;
    int decode_generation_ = 1, generation = 1;
    std::mutex mutex;
    std::unique_lock<std::mutex> lock(mutex);
    lock.unlock();
    bool decode_failed = false;
    std::set<uint32_t> failed_playback_epochs_;
    if (playback_failed_) failed_playback_epochs_.insert(failed_playback_epoch_);
    auto task = std::make_unique<Task>();
    task->pcm = std::move(pcm);
    task->playback_epoch = epoch;
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
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
    service.capture_energy_.epoch = 1;
    service.capture_energy_.generation = service.send_generation_;
    service.capture_energy_.state = CaptureEnergySnapshot::State::Capturing;
    max_count = actual_count = 160;
    assert(service.ReadAudioData(data, 16000, 160, service.send_generation_));
    const auto& energy = service.capture_energy_.native_mic;
    assert(energy.samples == 240 && energy.peak == 4096 && energy.clipped == 0);
    assert(energy.squares == uint64_t{240} * 4096 * 4096); // RMS = 0.125
    // Retirement/reset while codec read is in flight cannot merge old samples.
    on_read = [&] {
        ++service.send_generation_;
        service.capture_energy_ = {};
        service.capture_energy_.generation = service.send_generation_;
        service.capture_energy_.state = CaptureEnergySnapshot::State::Capturing;
    };
    assert(service.ReadAudioData(data, 16000, 160, service.send_generation_));
    assert(service.capture_energy_.native_mic.samples == 0);
    on_read = {};
    inject_remaining = 17;
    assert(service.ReadAudioData(data, 16000, 160, service.send_generation_));
    assert(service.capture_energy_.injected_samples == 17);
    assert(service.capture_energy_.native_mic.samples == 0);
    // Full accepted 2-second injection must take >=2 seconds at actual read
    // boundary, including short last frame. No codec or resampler calls.
    int before_inject = process_calls;
    inject_remaining = 32000;
    for (int total = 0; total < 32000;) {
        int64_t start = now_us;
        assert(service.ReadAudioData(data, 16000, 160));
        total += data.size() / 2;
        assert(now_us - start >= 10000);
        assert(data[0] == 123 && data[1] == 123);
    }
    assert(now_us >= 2000000 && process_calls == before_inject);
    inject_remaining = 17;
    int64_t start = now_us;
    assert(service.ReadAudioData(data, 16000, 160));
    assert(data.size() == 34 && now_us - start >= 1063);
    // Stop, rapid restart (same running state, different epoch), testing stop,
    // and service shutdown all cancel a waiting read within a single tick.
    for (int reason = 0; reason < 4; ++reason) {
        modes = reason == 2 ? AS_EVENT_AUDIO_TESTING_RUNNING : AS_EVENT_AUDIO_PROCESSOR_RUNNING;
        inject_remaining = 480;
        start = now_us;
        on_delay = [&] {
            // Must not hold queue mutex over delay.
            assert(service.audio_queue_mutex_.try_lock());
            service.audio_queue_mutex_.unlock();
            if (reason == 0) { service.audio_processor_->running = false; ++service.send_generation_; }
            if (reason == 1) ++service.send_generation_;
            if (reason == 2) modes = 0;
            if (reason == 3) service.service_stopped_ = true;
        };
        assert(!service.ReadAudioData(data, 16000, 480));
        assert(now_us - start == 10000);
        service.audio_processor_->running = true;
        service.service_stopped_ = false;
        on_delay = {};
    }
    // Graceful release closes new reads, but preserves already accepted samples.
    modes = AS_EVENT_AUDIO_PROCESSOR_RUNNING;
    inject_remaining = 480;
    on_delay = [&] { modes = 0; };
    assert(service.ReadAudioData(data, 16000, 480));
    assert(data.size() == 960);
    on_delay = {};
    // Scheduling stall never creates catch-up credit for subsequent frames.
    inject_remaining = 320;
    on_delay = [&] { now_us += 100000; };
    assert(service.ReadAudioData(data, 16000, 160));
    on_delay = {};
    start = now_us;
    assert(service.ReadAudioData(data, 16000, 160));
    assert(now_us - start >= 10000);
    // No active capture: bounded diagnostic RecordPcm reads still pace.
    modes = 0;
    inject_remaining = 160;
    start = now_us;
    assert(service.ReadAudioData(data, 16000, 160));
    assert(now_us - start >= 10000);
#endif
    max_count = actual_count = 480;
    assert(decode(service, std::vector<int16_t>(320)));
    // Decode finishing after A output failure must drop A but publish B.
    assert(!decode(service, std::vector<int16_t>(320), true, 7, 7));
    assert(decode(service, std::vector<int16_t>(320), true, 7, 8));
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
            (Path(directory) / 'sdkconfig.h').write_text('')
            binary = Path(directory) / 'resampler'
            for debug in (0, 1):
                subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra',
                                f'-DCONFIG_ESP32_DEVTOOL_COMPANION_ENABLE={debug}',
                                '-I', directory, '-I', str(SOURCE.parent), str(file), '-o', str(binary)], check=True)
                subprocess.run([str(binary)], check=True)


if __name__ == '__main__':
    unittest.main()
