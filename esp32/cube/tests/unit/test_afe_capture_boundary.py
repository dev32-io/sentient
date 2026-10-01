"""Host check of production AFE stop acknowledgment with delayed fetched output."""
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / 'firmware/main/audio/processors/afe_audio_processor.cc'


def method(name):
    match = re.search(rf'^(?:bool|void) AfeAudioProcessor::{name}\([^\n]*\) \{{.*?^\}}',
                      SOURCE.read_text(), re.MULTILINE | re.DOTALL)
    if not match:
        raise AssertionError(f'missing AfeAudioProcessor::{name}')
    return match.group()


class AfeCaptureBoundaryTest(unittest.TestCase):
    def test_stop_waits_for_fetched_callback_then_resets_before_start(self):
        cpp = r'''
#include <atomic>
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>
#define PROCESSOR_RUNNING 1
#define pdFALSE 0
#define pdTRUE 1
#define portMAX_DELAY -1
#define pdMS_TO_TICKS(ms) (ms)
#define ESP_FAIL -1
#define VAD_SPEECH 1
#define VAD_SILENCE 0
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGE(...) ((void)0)
#define TAG "test"
struct EventGroup {
    std::mutex mutex;
    std::condition_variable cv;
    int bits = 0;
};
using EventGroupHandle_t = EventGroup*;
void xEventGroupSetBits(EventGroupHandle_t group, int bits) {
    std::lock_guard<std::mutex> lock(group->mutex);
    group->bits |= bits;
    group->cv.notify_all();
}
void xEventGroupClearBits(EventGroupHandle_t group, int bits) {
    std::lock_guard<std::mutex> lock(group->mutex);
    group->bits &= ~bits;
}
void xEventGroupWaitBits(EventGroupHandle_t group, int bits, int, int, int) {
    std::unique_lock<std::mutex> lock(group->mutex);
    group->cv.wait(lock, [&] { return group->bits & bits; });
}
struct Result { int ret_value = 0, vad_state = 0, data_size = 4; int16_t data[2] = {10, 11}; };
struct FakeAfe {
    std::mutex mutex;
    std::condition_variable cv;
    bool ready = false;
    int resets = 0, feeds = 0, feed_result = 4;
    bool reset_success = true, auto_output = false;
    int output_delay_ms = 0;
    Result result;
};
struct Codec { int input_channels() { return 1; } };
struct Interface {
    int feed(FakeAfe* afe, const int16_t* data) {
        std::lock_guard<std::mutex> lock(afe->mutex);
        ++afe->feeds;
        if (afe->auto_output) {
            afe->result.data[0] = data[0]; afe->result.data[1] = data[1];
            if (afe->output_delay_ms) {
                std::thread([afe] {
                    std::this_thread::sleep_for(std::chrono::milliseconds(afe->output_delay_ms));
                    std::lock_guard<std::mutex> lock(afe->mutex);
                    afe->ready = true; afe->cv.notify_all();
                }).detach();
            } else { afe->ready = true; afe->cv.notify_all(); }
        }
        return afe->feed_result;
    }
    int get_fetch_chunksize(FakeAfe*) { return 2; }
    int get_feed_chunksize(FakeAfe*) { return 2; }
    Result* fetch_with_delay(FakeAfe* afe, int ms) {
        std::unique_lock<std::mutex> lock(afe->mutex);
        if (!afe->cv.wait_for(lock, std::chrono::milliseconds(ms), [&] { return afe->ready; })) return nullptr;
        afe->ready = false;
        return &afe->result;
    }
    int reset_buffer(FakeAfe* afe) {
        std::lock_guard<std::mutex> lock(afe->mutex);
        ++afe->resets;
        afe->ready = false;
        return afe->reset_success ? 1 : -1;
    }
};
struct AfeAudioProcessor {
    EventGroupHandle_t event_group_;
    Interface* afe_iface_;
    FakeAfe* afe_data_;
    Codec* codec_;
    int frame_samples_ = 2;
    bool is_speaking_ = false;
    std::vector<int16_t> input_buffer_, output_buffer_;
    std::timed_mutex input_buffer_mutex_;
    std::condition_variable_any stopped_cv_;
    std::atomic<bool> stop_requested_ = true;
    bool running_ = false, stopped_ = true, reset_ok_ = true, feed_failed_ = false;
    bool draining_ = false;
    size_t fed_samples_ = 0, fetched_samples_ = 0;
    std::chrono::steady_clock::time_point drain_deadline_;
    uint32_t capture_generation_ = 0;
    std::function<void(std::vector<int16_t>&&, uint32_t)> output_callback_;
    std::function<void(bool)> vad_state_change_callback_;
    void Feed(std::vector<int16_t>&&, uint32_t);
    bool Start(uint32_t);
    bool Stop(bool drain = false);
    bool GetCaptureSampleCounts(uint32_t, size_t&, size_t&);
    void AudioProcessorTask();
};
''' + '\n'.join(method(name) for name in ('Feed', 'Start', 'Stop', 'AudioProcessorTask', 'GetCaptureSampleCounts')) + r'''
int main() {
    auto* processor = new AfeAudioProcessor;
    auto* event = new EventGroup;
    auto* afe = new FakeAfe;
    auto* iface = new Interface;
    processor->event_group_ = event;
    processor->afe_data_ = afe;
    processor->afe_iface_ = iface;
    Codec codec;
    processor->codec_ = &codec;
    std::mutex mutex;
    std::condition_variable cv;
    bool in_callback = false, release = false;
    uint32_t delivered = 0;
    processor->output_callback_ = [&](std::vector<int16_t>&&, uint32_t token) {
        std::unique_lock<std::mutex> lock(mutex);
        delivered = token;
        in_callback = true;
        cv.notify_all();
        cv.wait(lock, [&] { return release; });
    };
    std::thread worker([&] { processor->AudioProcessorTask(); });
    worker.detach(); // Worker is process-lifetime in firmware too.
    assert(processor->Start(7));
    {
        std::lock_guard<std::mutex> lock(afe->mutex);
        afe->ready = true;
    }
    afe->cv.notify_all();
    {
        std::unique_lock<std::mutex> lock(mutex);
        assert(cv.wait_for(lock, std::chrono::seconds(2), [&] { return in_callback; }));
    }
    std::atomic<bool> stop_done = false;
    std::thread stopper([&] { assert(processor->Stop()); stop_done = true; });
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    assert(!stop_done); // No reset/start while old callback still running.
    {
        std::lock_guard<std::mutex> lock(mutex);
        release = true;
    }
    cv.notify_all();
    stopper.join();
    assert(delivered == 7 && afe->resets == 1);
    assert(processor->Start(8));
    processor->Feed({30, 31}, 7); // Codec read started before stop, finished after start.
    assert(afe->feeds == 0);
    processor->Feed({40, 41}, 8);
    assert(afe->feeds == 1);
    assert(processor->Stop());
    assert(afe->resets == 2);
    // SDK ring-full is ZERO, not ESP_FAIL. Both must cancel this capture,
    // stop feeding, reset on worker, and remain failed through repeated Stop.
    for (int result : {0, -1}) {
        assert(processor->Start(9));
        afe->feed_result = result;
        const int before = afe->feeds;
        processor->Feed({40, 41, 42, 43}, 9);
        processor->Feed({44, 45}, 9);
        assert(afe->feeds == before + 1); // no retries or remaining chunk feeds
        assert(!processor->Stop());
        assert(!processor->Stop()); // worker reset must not erase capture failure
        assert(processor->input_buffer_.empty());
        assert(processor->output_buffer_.empty());
    }
    afe->feed_result = 4;
    assert(processor->Start(10));
    processor->Feed({50, 51}, 10);
    assert(processor->Stop()); // new capture can recover after acknowledged reset
    std::vector<std::vector<int16_t>> tails;
    processor->frame_samples_ = 4;
    processor->output_callback_ = [&](std::vector<int16_t>&& data, uint32_t token) {
        assert(token == 11); tails.push_back(std::move(data));
    };
    afe->auto_output = true;
    afe->output_delay_ms = 180; // First empty 100-ms fetch is not EOS.
    assert(processor->Start(11));
    processor->Feed({60}, 11); // Partial producer feed, partial encoder output.
    size_t fed = 999, fetched = 999;
    assert(!processor->GetCaptureSampleCounts(processor->capture_generation_, fed, fetched));
    assert(processor->Stop(true));
    assert(processor->GetCaptureSampleCounts(processor->capture_generation_, fed, fetched));
    assert(fed == processor->fed_samples_ && fetched == processor->fetched_samples_);
    assert(!processor->GetCaptureSampleCounts(processor->capture_generation_ + 1, fed, fetched));
    assert(tails.size() == 1 && (tails[0] == std::vector<int16_t>{60, 0, 0, 0}));
    assert(processor->Start(12));
    processor->Feed({70}, 12);
    assert(processor->Stop(false));
    assert(tails.size() == 1); // Discard path never flushes partial staged input.
    assert(processor->Start(13));
    afe->reset_success = false;
    assert(!processor->Stop());
    assert(!processor->Start(12)); // Failed hardware reset cannot relabel old ring data.
}
'''
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'afe.cc'
            source.write_text(cpp)
            binary = Path(directory) / 'afe'
            subprocess.run(['c++', '-std=c++17', '-pthread', str(source), '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True, timeout=10)


if __name__ == '__main__':
    unittest.main()
