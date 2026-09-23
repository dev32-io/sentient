"""Compile production queue, reset, ingress and start methods against host boundary stubs."""
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

MAIN = Path(__file__).resolve().parents[2] / 'firmware/main'


def method(path, owner, name):
    match = re.search(rf'^(?:bool|void|uint32_t|DecodeQueueResult) {owner}::{name}\([\s\S]*?\) \{{.*?^\}}',
                      path.read_text(), re.MULTILINE | re.DOTALL)
    if not match:
        raise AssertionError(f'missing {owner}::{name}')
    return match.group()


class PlaybackQueueBoundaryTest(unittest.TestCase):
    def test_backpressure_reset_stop_timeout_and_app_failures(self):
        audio = MAIN / 'audio/audio_service.cc'
        app = MAIN / 'application.cc'
        cpp = r'''
#include <atomic>
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>
#define MAX_DECODE_PACKETS_IN_QUEUE 2
#define AUDIO_POWER_CHECK_INTERVAL_MS 1000
#define OPUS_FRAME_DURATION_MS 20
#define AS_EVENT_AUDIO_TESTING_RUNNING 1
#define AS_EVENT_WAKE_WORD_RUNNING 2
#define AS_EVENT_AUDIO_PROCESSOR_RUNNING 4
#define ESP_LOGW(...) ((void)0)
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGD(...) ((void)0)
#define ESP_LOGE(...) ((void)0)
#define TAG "test"
void esp_timer_stop(int) {}
void esp_timer_start_periodic(int, int) {}
void xEventGroupSetBits(int, int) {}
void esp_opus_dec_reset(void*) {}
void esp_ae_rate_cvt_reset(void*) {}
void xEventGroupClearBits(int, int) {}
enum class DecodeQueueResult { Queued, Stale, Timeout, Full, Stopped };
struct AudioStreamPacket {
    int sample_rate = 0, frame_duration = 0;
    std::vector<uint8_t> payload;
};
struct Codec {
    std::mutex mutex;
    std::condition_variable cv;
    bool entered = false, release = false;
    std::atomic<int> writes = 0;
    bool output_enabled() { return false; }
    void EnableOutput(bool) {
        std::unique_lock<std::mutex> lock(mutex);
        entered = true;
        cv.notify_all();
        cv.wait(lock, [this] { return release; });
    }
    void OutputData(const std::vector<int16_t>&) { ++writes; }
};
struct AudioTask { std::vector<int16_t> pcm; uint32_t timestamp = 0; };
struct Processor {
    int starts = 0;
    bool start_ok = true;
    void Initialize(Codec*, int, void*) {}
    bool Start(uint32_t) { ++starts; return start_ok; }
    bool Stop() { return true; }
};
struct AudioService {
    std::mutex audio_queue_mutex_, decoder_mutex_;
    std::condition_variable audio_queue_cv_;
    std::deque<std::unique_ptr<AudioStreamPacket>> audio_decode_queue_, audio_send_queue_, audio_testing_queue_;
    std::deque<int> audio_encode_queue_, timestamp_queue_;
    std::deque<std::unique_ptr<AudioTask>> audio_playback_queue_;
    Codec* codec_ = nullptr;
    std::unique_ptr<Processor> audio_processor_ = std::make_unique<Processor>();
    bool audio_processor_initialized_ = false, audio_input_need_warmup_ = false;
    bool accepting_send_ = false, send_failed_ = false;
    uint32_t send_generation_ = 0;
    void* input_resampler_ = nullptr;
    std::mutex input_resampler_mutex_;
    void* models_list_ = nullptr;
    struct { std::function<void()> on_playback_drained; } callbacks_;
    struct { int playback_count = 0; } debug_statistics_;
    std::chrono::steady_clock::time_point last_output_time_;
    uint32_t decode_generation_ = 0;
    bool output_in_flight_ = false, decoding_ = false;
    std::atomic<bool> service_stopped_ = false;
    void* opus_decoder_ = nullptr;
    int audio_power_timer_ = 0, event_group_ = 0;
    int clears = 0, resets = 0;
    std::function<void()> before_generation;
    uint32_t ReadDecodeGeneration();
    uint32_t DecodeGeneration() {
        if (before_generation) before_generation();
        return ReadDecodeGeneration();
    }
    DecodeQueueResult PushPacketToDecodeQueue(std::unique_ptr<AudioStreamPacket>, uint32_t, bool = false);
    bool ResetDecoder();
    void AudioOutputTask();
    void Stop();
    void ClearSendQueue() { ++clears; ++send_generation_; }
    bool EnableVoiceProcessing(bool);
};
''' + '\n'.join(method(audio, 'AudioService', name).replace(
            'AudioService::DecodeGeneration(', 'AudioService::ReadDecodeGeneration(') for name in (
            'DecodeGeneration', 'PushPacketToDecodeQueue', 'AudioOutputTask', 'Stop', 'EnableVoiceProcessing')) + r'''
// Production ResetDecoder with host decoder stub, including queue notification.
''' + method(audio, 'AudioService', 'ResetDecoder') + r'''
struct Protocol {
    int started = 0, cancelled = 0, interrupted = 0;
    bool start_streaming() { ++started; return true; }
    void cancel_streaming() { ++cancelled; }
    void interrupt() { ++interrupted; }
};
constexpr int kDeviceStateIdle = 1, kDeviceStateListening = 2, kDeviceStateSpeaking = 3;
constexpr int kServerFrameDurationMs = 20;
struct Display { int notices = 0; void ShowNotification(const char*, int) { ++notices; } };
struct Board {
    static Board& GetInstance() { static Board board; return board; }
    Display* GetDisplay() { return &display; }
    Display display;
};
struct Application {
    AudioService audio_service_;
    std::unique_ptr<Protocol> sentient_ws_ = std::make_unique<Protocol>();
    int state = kDeviceStateIdle, aborts = 0;
    bool processing_ = false, playback_active_ = false, playback_waiting_for_drain_ = false;
    std::atomic<uint32_t> playback_epoch_{1}, suppressed_playback_epoch_{0};
    std::deque<std::function<void()>> tasks;
    const char* hint = nullptr;
    bool IsAudioChannelOpened() { return true; }
    int GetDeviceState() { return state; }
    void SetDeviceState(int next) { state = next; }
    void AbortSpeaking();
    void Schedule(std::function<void()> cb) { tasks.push_back(std::move(cb)); }
    void BeginUplink();
    void OnSdkPlaybackFrame(const uint8_t*, size_t, int);
    void OnPlaybackQueueFailure(uint32_t, uint32_t);
};
Application* current_app;
void sentient_cube_set_status_hint(const char* hint) { current_app->hint = hint; }
''' + '\n'.join(method(app, 'Application', name) for name in (
            'AbortSpeaking', 'BeginUplink', 'OnSdkPlaybackFrame', 'OnPlaybackQueueFailure')) + r'''
std::unique_ptr<AudioStreamPacket> packet() { return std::make_unique<AudioStreamPacket>(); }
void fill(AudioService& audio) {
    while (audio.audio_decode_queue_.size() < MAX_DECODE_PACKETS_IN_QUEUE)
        audio.audio_decode_queue_.push_back(packet());
}
int main() {
    Application app;
    current_app = &app;
    auto& audio = app.audio_service_;

    // Wire start succeeded but processor could not start: cancel, never listen.
    audio.audio_processor_->start_ok = false;
    app.BeginUplink();
    assert(app.sentient_ws_->started == 1 && app.sentient_ws_->cancelled == 1);
    assert(audio.clears == 3 && app.state == kDeviceStateIdle && app.hint);
    assert(Board::GetInstance().display.notices == 1);
    audio.audio_processor_->start_ok = true;
    app.BeginUplink();
    assert(app.state == kDeviceStateListening);
    app.state = kDeviceStateSpeaking;

    // Local abort precedes server playback.stop: old frames cannot refill reset decoder.
    fill(audio);
    app.AbortSpeaking();
    assert(app.sentient_ws_->interrupted == 1 && audio.audio_decode_queue_.empty());
    uint8_t old_bytes[] = {1, 2};
    app.OnSdkPlaybackFrame(old_bytes, sizeof(old_bytes), 16000);
    assert(audio.audio_decode_queue_.empty() && app.tasks.empty());
    app.playback_epoch_ = 2;
    app.OnSdkPlaybackFrame(old_bytes, sizeof(old_bytes), 16000);
    assert(audio.audio_decode_queue_.size() == 1);
    audio.ResetDecoder();
    app.state = kDeviceStateSpeaking;

    // Callback passed initial epoch check, then main-task abort wins before
    // generation snapshot. Wrap the production getter to force this overlap.
    {
        Application overlap;
        current_app = &overlap;
        overlap.audio_service_.before_generation = [&] { overlap.AbortSpeaking(); };
        overlap.OnSdkPlaybackFrame(old_bytes, sizeof(old_bytes), 16000);
        assert(overlap.sentient_ws_->interrupted == 1);
        assert(overlap.audio_service_.audio_decode_queue_.empty());
        assert(overlap.tasks.empty());
        current_app = &app;
    }

    // Full decode queue: producer waits for real consumer capacity.
    fill(audio);
    auto generation = audio.DecodeGeneration();
    std::atomic<bool> entered = false;
    DecodeQueueResult result = DecodeQueueResult::Timeout;
    std::thread waiting([&] {
        entered = true;
        result = audio.PushPacketToDecodeQueue(packet(), generation, true);
    });
    while (!entered) std::this_thread::yield();
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    {
        std::lock_guard<std::mutex> lock(audio.audio_queue_mutex_);
        assert(audio.audio_decode_queue_.size() == MAX_DECODE_PACKETS_IN_QUEUE);
        audio.audio_decode_queue_.pop_front();
        audio.audio_queue_cv_.notify_all();
    }
    waiting.join();
    assert(result == DecodeQueueResult::Queued);
    assert(audio.audio_decode_queue_.size() == MAX_DECODE_PACKETS_IN_QUEUE);

    // Reset wakes blocked producer; stale result must not reset/interrupt new turn.
    generation = audio.DecodeGeneration();
    entered = false;
    std::thread stale([&] {
        entered = true;
        result = audio.PushPacketToDecodeQueue(packet(), generation, true);
    });
    while (!entered) std::this_thread::yield();
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    audio.ResetDecoder();
    stale.join();
    assert(result == DecodeQueueResult::Stale && audio.audio_decode_queue_.empty());
    fill(audio);
    uint8_t bytes[] = {1, 2};
    entered = false;
    std::thread cancelled([&] {
        entered = true;
        app.OnSdkPlaybackFrame(bytes, sizeof(bytes), 16000);
    });
    while (!entered) std::this_thread::yield();
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    audio.ResetDecoder();
    cancelled.join();
    assert(app.suppressed_playback_epoch_ == 2 && app.tasks.empty());
    app.playback_epoch_ = 3; // New turn is not suppressed by old reset.
    fill(audio);

    // Timeout is not silently dropped: frame callback suppresses this epoch
    // and schedules a local abort; wire interrupt never targets a later turn.
    app.OnSdkPlaybackFrame(bytes, sizeof(bytes), 16000);
    assert(app.suppressed_playback_epoch_ == 3 && app.tasks.size() == 1);
    app.playback_epoch_ = 4; // New turn begins before old failure handler runs.
    app.tasks.front()();
    app.tasks.clear();
    assert(app.state == kDeviceStateSpeaking && app.sentient_ws_->interrupted == 1);
    assert(audio.audio_decode_queue_.size() == MAX_DECODE_PACKETS_IN_QUEUE);

    app.OnSdkPlaybackFrame(bytes, sizeof(bytes), 16000); // New turn also times out.
    assert(app.suppressed_playback_epoch_ == 4 && app.tasks.size() == 1);
    app.tasks.front()();
    app.tasks.clear();
    assert(app.state == kDeviceStateIdle && app.hint && Board::GetInstance().display.notices == 2);
    assert(audio.audio_decode_queue_.empty() && app.sentient_ws_->interrupted == 1);
    app.OnSdkPlaybackFrame(bytes, sizeof(bytes), 16000); // Failed turn remains suppressed.
    assert(audio.audio_decode_queue_.empty());

    // Popped PCM blocked before OutputData: reset cannot return success
    // until software-owned handoff finishes. Queue lock stays available.
    Codec codec;
    audio.codec_ = &codec;
    auto pcm = std::make_unique<AudioTask>();
    pcm->pcm = {7};
    {
        std::lock_guard<std::mutex> lock(audio.audio_queue_mutex_);
        audio.audio_playback_queue_.push_back(std::move(pcm));
        audio.audio_queue_cv_.notify_all();
    }
    std::thread output([&] { audio.AudioOutputTask(); });
    {
        std::unique_lock<std::mutex> lock(codec.mutex);
        codec.cv.wait(lock, [&] { return codec.entered; });
    }
    std::atomic<bool> reset_done = false;
    bool reset_ok = false;
    std::thread resetting([&] { reset_ok = audio.ResetDecoder(); reset_done = true; });
    {
        std::lock_guard<std::mutex> lock(audio.audio_queue_mutex_);
        assert(audio.output_in_flight_ && codec.writes == 0);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    assert(!reset_done && codec.writes == 0);
    {
        std::lock_guard<std::mutex> lock(codec.mutex);
        codec.release = true;
        codec.cv.notify_all();
    }
    resetting.join();
    assert(reset_ok && codec.writes == 1 && !audio.output_in_flight_);

    // Hung codec handoff: bounded reset fails; capture cannot start.
    Codec hung;
    audio.codec_ = &hung;
    auto next = std::make_unique<AudioTask>();
    next->pcm = {8};
    {
        std::lock_guard<std::mutex> lock(audio.audio_queue_mutex_);
        audio.audio_playback_queue_.push_back(std::move(next));
        audio.audio_queue_cv_.notify_all();
    }
    {
        std::unique_lock<std::mutex> lock(hung.mutex);
        hung.cv.wait(lock, [&] { return hung.entered; });
    }
    int starts = audio.audio_processor_->starts;
    assert(!audio.EnableVoiceProcessing(true));
    assert(audio.audio_processor_->starts == starts && hung.writes == 0);
    {
        std::lock_guard<std::mutex> lock(hung.mutex);
        hung.release = true;
        hung.cv.notify_all();
    }
    assert(audio.ResetDecoder());

    // Stopped service wakes a blocked producer; no deadlock or enqueue.
    fill(audio);
    generation = audio.DecodeGeneration();
    entered = false;
    std::thread stopping([&] {
        entered = true;
        result = audio.PushPacketToDecodeQueue(packet(), generation, true);
    });
    while (!entered) std::this_thread::yield();
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    audio.Stop();
    stopping.join();
    output.join();
    assert(result == DecodeQueueResult::Stopped);
}
'''
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'playback.cc'
            source.write_text(cpp)
            binary = Path(directory) / 'playback'
            subprocess.run(['c++', '-std=c++17', '-pthread', str(source), '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True, timeout=25)


if __name__ == '__main__':
    unittest.main()
