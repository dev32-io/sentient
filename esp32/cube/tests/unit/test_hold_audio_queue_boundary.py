"""Compile Cube queue and end-of-capture methods against host boundary stubs (no IDF)."""
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

MAIN = Path(__file__).resolve().parents[2] / 'firmware/main'


def method(path, owner, name):
    source = path.read_text()
    match = re.search(rf'^(?:bool|void) {owner}::{name}\([^\n]*\) \{{.*?^\}}',
                      source, re.MULTILINE | re.DOTALL)
    if not match:
        raise AssertionError(f'missing {owner}::{name}')
    return match.group()


class HoldAudioQueueBoundaryTest(unittest.TestCase):
    def test_blocked_producer_and_tail_failure(self):
        audio = MAIN / 'audio/audio_service.cc'
        app = MAIN / 'application.cc'
        cpp = r'''
#include <algorithm>
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>
#define MAX_ENCODE_TASKS_IN_QUEUE 2
#define MAX_TIMESTAMPS_IN_QUEUE 3
#define ESP_LOGW(...) ((void)0)
#define TAG "test"
enum AudioTaskType { kAudioTaskTypeEncodeToSendQueue, kAudioTaskTypeEncodeToTestingQueue };
struct AudioTask {
    AudioTaskType type;
    std::vector<int16_t> pcm;
    uint32_t timestamp = 0, send_generation = 0;
};
struct AudioService {
    std::mutex audio_queue_mutex_;
    std::condition_variable audio_queue_cv_;
    std::deque<int> audio_decode_queue_, audio_playback_queue_, audio_send_queue_;
    std::deque<std::unique_ptr<AudioTask>> audio_encode_queue_;
    std::deque<uint32_t> timestamp_queue_;
    bool decoding_ = false, output_in_flight_ = false, service_stopped_ = false;
    bool accepting_send_ = true, encoding_to_send_ = false, send_failed_ = false;
    size_t send_producers_ = 0;
    uint32_t send_generation_ = 0;
    void HandleProcessorOutput(std::vector<int16_t>&&, uint32_t);
    void PushTaskToEncodeQueue(AudioTaskType, std::vector<int16_t>&&, uint32_t = 0);
    void ClearSendQueue();
    bool WaitForSendEncoding();
    bool IsPlaybackDrained();
    void EnableVoiceProcessing(bool) {}
};
''' + '\n'.join(method(audio, 'AudioService', name) for name in (
            'HandleProcessorOutput', 'PushTaskToEncodeQueue', 'ClearSendQueue', 'WaitForSendEncoding', 'IsPlaybackDrained')) + r'''
struct Protocol {
    int stopped = 0, cancelled = 0;
    void stop_streaming() { ++stopped; }
    void cancel_streaming() { ++cancelled; }
};
constexpr int kDeviceStateIdle = 1;
struct Application {
    AudioService audio_service_;
    std::unique_ptr<Protocol> sentient_ws_ = std::make_unique<Protocol>();
    bool processing_ = false;
    int state = 0;
    const char* hint = nullptr;
    void SetDeviceState(int s) { state = s; }
    void EndUplink();
};
Application* current_app;
void sentient_cube_set_status_hint(const char* hint) { current_app->hint = hint; }
struct Display { void ShowNotification(const char*, int) {} };
struct Board {
    static Board& GetInstance() { static Board board; return board; }
    Display* GetDisplay() { return &display; }
    Display display;
};
''' + method(app, 'Application', 'EndUplink') + r'''
int main() {
    Application app;
    current_app = &app;
    auto& audio = app.audio_service_;
    assert(audio.IsPlaybackDrained());
    audio.decoding_ = true;
    assert(!audio.IsPlaybackDrained());
    audio.decoding_ = false;
    audio.output_in_flight_ = true;
    assert(!audio.IsPlaybackDrained());
    audio.output_in_flight_ = false;

    // Producer enters old capture while encode queue is full.
    for (int i = 0; i < MAX_ENCODE_TASKS_IN_QUEUE; ++i) {
        auto task = std::make_unique<AudioTask>();
        task->type = kAudioTaskTypeEncodeToTestingQueue;
        audio.audio_encode_queue_.push_back(std::move(task));
    }
    auto old_capture = audio.send_generation_;
    std::thread late([&] { audio.HandleProcessorOutput({42}, old_capture); });
    {
        std::unique_lock<std::mutex> lock(audio.audio_queue_mutex_);
        audio.audio_queue_cv_.wait(lock, [&] { return audio.send_producers_ == 1; });
    }
    audio.ClearSendQueue();
    audio.accepting_send_ = true; // new capture, before blocked old producer wakes
    late.join();
    assert(audio.audio_encode_queue_.size() == MAX_ENCODE_TASKS_IN_QUEUE);
    assert(audio.send_producers_ == 0);
    audio.audio_encode_queue_.clear();
    // AFE fetched old result before stop; callback arrives after new start.
    audio.HandleProcessorOutput({99}, old_capture);
    assert(audio.audio_encode_queue_.empty());
    audio.HandleProcessorOutput({43}, audio.send_generation_);
    assert(audio.audio_encode_queue_.size() == 1);
    assert(audio.audio_encode_queue_.front()->pcm == std::vector<int16_t>{43});
    assert(audio.audio_encode_queue_.front()->send_generation == audio.send_generation_);

    // Tail still pending: timed-out release must cancel, never commit audio.end.
    // Force predicate failure immediately via explicit encoder failure (bounded failure).
    audio.send_failed_ = true;
    app.EndUplink();
    assert(app.sentient_ws_->cancelled == 1 && app.sentient_ws_->stopped == 0);
    assert(app.state == kDeviceStateIdle && !app.processing_);
    assert(audio.audio_encode_queue_.empty() && audio.audio_send_queue_.empty());
    assert(audio.send_generation_ == 2);

    // Real bounded timeout: no producer or transport progress, no audio.end.
    audio.audio_send_queue_.push_back(1);
    app.EndUplink();
    assert(app.sentient_ws_->cancelled == 2 && app.sentient_ws_->stopped == 0);
    assert(audio.audio_send_queue_.empty());

    // Successful drain commits only after queued final packet has been popped.
    audio.accepting_send_ = true;
    audio.HandleProcessorOutput({44}, audio.send_generation_);
    std::thread drain([&] {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        std::lock_guard<std::mutex> lock(audio.audio_queue_mutex_);
        audio.audio_encode_queue_.clear();
        audio.audio_send_queue_.push_back(1);
        audio.audio_queue_cv_.notify_all();
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        audio.audio_send_queue_.clear();
        audio.audio_queue_cv_.notify_all();
    });
    app.EndUplink();
    drain.join();
    assert(app.sentient_ws_->stopped == 1 && app.sentient_ws_->cancelled == 2);
}
'''
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'queue.cc'
            path.write_text(cpp)
            binary = Path(directory) / 'queue'
            subprocess.run(['c++', '-std=c++17', '-pthread', str(path), '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True, timeout=10)


if __name__ == '__main__':
    unittest.main()
