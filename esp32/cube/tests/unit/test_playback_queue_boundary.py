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
#include <algorithm>
#include <set>
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
void agent_audio_inject_begin_capture() {}
void agent_audio_inject_end_capture() {}
#define pdMS_TO_TICKS(ms) (ms)
bool input_open = false, processor_ready = false;
void vTaskDelay(int) { assert(input_open); } // Settle wait must follow real codec enable.
void esp_timer_stop(int) {}
void esp_timer_start_periodic(int, int) {}
void xEventGroupSetBits(int, int) {}
void esp_opus_dec_reset(void*) {}
void esp_ae_rate_cvt_reset(void*) {}
void xEventGroupClearBits(int, int) {}
enum class DecodeQueueResult { Queued, Stale, Timeout, Full, Stopped, Failed };
struct AudioStreamPacket {
    bool pcm = false;
    uint32_t playback_epoch = 0;
    int sample_rate = 0, frame_duration = 0;
    std::vector<uint8_t> payload;
};
using esp_err_t = int;
enum class SdkStatus { Ready = 1, Reconnecting = 2 };
using CognitionState = int;
namespace sentient::cube {
struct CubeHardware {
    static CubeHardware& Get() { static CubeHardware h; return h; }
    void WsStartResult(const char*, int) {}
};
}
namespace sentient::cube { enum class SdkFailure { CaptureBusy, CommandRejected }; }
struct SentientWsProtocolConfig {
    std::function<void(sentient::cube::SdkFailure, const std::string&)> on_failure;
    std::function<void(SdkStatus)> on_status_change;
    std::function<void(int)> on_cognition_status, on_playback_begin;
    std::function<void(const char*, int)> on_start_result;
    std::function<void(bool)> on_playback_end;
    std::function<void(const uint8_t*, size_t, int, bool)> on_playback_frame;
    std::function<bool(std::vector<uint8_t>&)> on_pop_uplink_frame;
};
struct Codec {
    std::mutex mutex;
    std::condition_variable cv;
    bool entered = false, release = false, write_ok = true;
    std::atomic<int> writes = 0;
    bool input_enabled() { return input_open; }
    void EnableInput(bool enable) { input_open = enable; }
    bool output_enabled() { return false; }
    void EnableOutput(bool) {
        std::unique_lock<std::mutex> lock(mutex);
        entered = true;
        cv.notify_all();
        cv.wait(lock, [this] { return release; });
    }
    std::vector<int16_t> played;
    bool OutputData(const std::vector<int16_t>& pcm) {
        std::lock_guard<std::mutex> lock(mutex);
        if (write_ok) played.insert(played.end(), pcm.begin(), pcm.end());
        ++writes;
        return write_ok;
    }
};
struct AudioTask { std::vector<int16_t> pcm; uint32_t timestamp = 0, playback_epoch = 0; };
struct AudioServiceCallbacks {
    std::function<void()> on_playback_drained, on_send_queue_available;
    std::function<void(uint32_t, uint32_t)> on_playback_failed;
};
struct Processor {
    int starts = 0;
    bool start_ok = true, stop_ok = true;
    void Initialize(Codec*, int, void*) {}
    bool Start(uint32_t) { ++starts; processor_ready = start_ok; return start_ok; }
    bool Stop(bool = false) { processor_ready = false; return stop_ok; }
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
    std::timed_mutex input_capture_mutex_;
    void* models_list_ = nullptr;
    AudioServiceCallbacks callbacks_;
    void SetCallbacks(AudioServiceCallbacks cb) { callbacks_ = cb; }
    struct { int playback_count = 0; } debug_statistics_;
    std::chrono::steady_clock::time_point last_output_time_, last_input_time_;
    std::set<uint32_t> failed_playback_epochs_;
    uint32_t latest_playback_epoch_ = 0, decoding_playback_epoch_ = 0, output_playback_epoch_ = 0;
    void PrunePlaybackFailures();
    void FailPlaybackOwner(uint32_t);
    uint32_t decode_generation_ = 0;
    bool playback_deferred_ = false;
    bool output_in_flight_ = false, decoding_ = false;
    std::atomic<bool> service_stopped_ = false;
    void* opus_decoder_ = nullptr;
    int audio_power_timer_ = 0, event_group_ = 0;
    int clears = 0, resets = 0;
    std::function<void()> before_generation, before_decode_wait;
    uint32_t ReadDecodeGeneration();
    uint32_t DecodeGeneration() {
        if (before_generation) before_generation();
        return ReadDecodeGeneration();
    }
    DecodeQueueResult PushPacketToDecodeQueue(std::unique_ptr<AudioStreamPacket>, uint32_t, bool = false);
    bool ResetDecoder();
    void PublishDecoded(uint32_t generation, uint32_t epoch, int16_t sample);
    bool IsPlaybackDrained(uint32_t epoch = 0);
    void AudioOutputTask();
    void Stop();
    void ClearSendQueue() { ++clears; ++send_generation_; }
    void DiscardPlayback(uint32_t, uint32_t);
    void DeferPlayback(bool);
    bool EnableVoiceProcessing(bool, bool = false);
};
''' + '\n'.join(method(audio, 'AudioService', name).replace(
            'AudioService::DecodeGeneration(', 'AudioService::ReadDecodeGeneration(').replace(
            'if (!audio_queue_cv_.wait_for(lock, std::chrono::seconds(5),',
            'if (before_decode_wait) before_decode_wait();\n        if (!audio_queue_cv_.wait_for(lock, std::chrono::seconds(5),') for name in (
            'DecodeGeneration', 'PushPacketToDecodeQueue', 'IsPlaybackDrained', 'AudioOutputTask', 'Stop', 'EnableVoiceProcessing', 'DeferPlayback', 'DiscardPlayback', 'PrunePlaybackFailures', 'FailPlaybackOwner')) + r'''
// Production ResetDecoder with host decoder stub, including queue notification.
''' + method(audio, 'AudioService', 'ResetDecoder') + r'''
void AudioService::PublishDecoded(uint32_t generation, uint32_t epoch, int16_t sample) {
    auto task = std::make_unique<AudioTask>();
    task->playback_epoch = epoch;
    task->pcm = {sample};
    std::lock_guard<std::mutex> lock(audio_queue_mutex_);
''' + re.search(r'    if \(generation == decode_generation_ &&.*?^                    \}', audio.read_text(), re.MULTILINE | re.DOTALL).group() + r'''
    audio_queue_cv_.notify_all();
}
struct Protocol {
    int started = 0, cancelled = 0, interrupted = 0;
    std::function<void()> on_interrupt;
    bool start_streaming() { assert(processor_ready); ++started; return true; }
    void notify_uplink_available() {}
    bool busy_refusal_pending() const { return true; } void settle_busy_refusal() {}
    void cancel_streaming() { ++cancelled; }
    void interrupt() { ++interrupted; if (on_interrupt) on_interrupt(); }
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
    static Application& GetInstance();
    AudioService audio_service_;
    std::unique_ptr<Protocol> sentient_ws_ = std::make_unique<Protocol>();
    int state = kDeviceStateIdle, aborts = 0, event_group_ = 0;
    void WireAudioServiceCallbacks();
    void RetireConnectionAudio();
    void WireSentientWsCallbacks(SentientWsProtocolConfig&);
    void OnSdkStatusChange(SdkStatus) {}
    void OnSdkCognitionStatus(int) {}
    bool OnSdkPopUplinkFrame(std::vector<uint8_t>&) { return false; }
    void OnSdkPlaybackBegin(int);
    void OnSdkPlaybackEnd(bool);
    void OnPlaybackDrained();
    bool processing_ = false, playback_active_ = false, playback_waiting_for_drain_ = false;
    std::atomic<uint32_t> sdk_status_epoch_{0};
    std::atomic<int> sdk_status_{-1};
    std::mutex mutex_;
    std::atomic<uint32_t> protocol_epoch_{0};
    std::atomic<uint32_t> playback_epoch_{1}, suppressed_playback_epoch_{0};
    std::deque<std::function<void()>> tasks;
    bool ui_playback = true, ui_processing = true;
    bool IsAudioChannelOpened() { return true; }
    int GetDeviceState() { return state; }
    void SetDeviceState(int next) { state = next; }
    void AbortSpeaking();
    void Schedule(std::function<void()> cb) { tasks.push_back(std::move(cb)); }
    void BeginUplink();
    void OnSdkPlaybackFrame(const uint8_t*, size_t, int, bool = false);
    void OnPlaybackQueueFailure(uint32_t, uint32_t);
};
constexpr int MAIN_EVENT_SEND_AUDIO = 1;
Application* current_app;
Application& Application::GetInstance() { return *current_app; }
void sentient_cube_set_playback(bool value) { current_app->ui_playback = value; }
void sentient_cube_set_processing(bool value) { current_app->ui_processing = value; }
''' + re.search(r'extern "C" bool cube_playback_drained\(void\) \{.*?^\}', app.read_text(), re.MULTILINE | re.DOTALL).group() + '\n'.join(method(app, 'Application', name) for name in (
            'AbortSpeaking', 'BeginUplink', 'OnSdkPlaybackFrame', 'OnPlaybackQueueFailure',
            'WireSentientWsCallbacks', 'RetireConnectionAudio', 'WireAudioServiceCallbacks', 'OnSdkPlaybackBegin', 'OnSdkPlaybackEnd', 'OnPlaybackDrained')) + r'''
std::unique_ptr<AudioStreamPacket> packet() { return std::make_unique<AudioStreamPacket>(); }
void fill(AudioService& audio) {
    while (audio.audio_decode_queue_.size() < MAX_DECODE_PACKETS_IN_QUEUE)
        audio.audio_decode_queue_.push_back(packet());
}
int main() {
    Application app;
    current_app = &app;
    auto& audio = app.audio_service_;
    Codec prepared_codec;
    prepared_codec.release = true;
    audio.codec_ = &prepared_codec;

    // Processor preparation precedes audio.start: failed prep sends no capture.
    audio.audio_processor_->start_ok = false;
    app.BeginUplink();
    assert(app.sentient_ws_->started == 0 && app.sentient_ws_->cancelled == 0);
    assert(!audio.accepting_send_ && app.state == kDeviceStateIdle && !app.ui_processing);
    assert(Board::GetInstance().display.notices == 1);
    audio.audio_processor_->start_ok = true;
    app.BeginUplink();
    assert(app.state == kDeviceStateListening);
    // AFE feed failure survives worker reset through Stop: do not permit
    // commit/drain success for a known incomplete capture.
    audio.audio_processor_->stop_ok = false;
    assert(!audio.EnableVoiceProcessing(false));
    assert(audio.send_failed_ && !audio.accepting_send_);
    audio.audio_processor_->stop_ok = true;
    audio.DeferPlayback(false); // Cancelled hold; Application normally releases this gate.
    app.state = kDeviceStateSpeaking;

    // Local abort precedes server playback.stop: old frames cannot refill reset decoder.
    fill(audio);
    app.AbortSpeaking();
    assert(app.sentient_ws_->interrupted == 3 && audio.audio_decode_queue_.empty());
    uint8_t old_bytes[] = {1, 2};
    app.OnSdkPlaybackFrame(old_bytes, sizeof(old_bytes), 16000);
    assert(audio.audio_decode_queue_.empty() && app.tasks.empty());
    app.playback_epoch_ = 2;
    app.OnSdkPlaybackFrame(old_bytes, sizeof(old_bytes), 16000);
    assert(audio.audio_decode_queue_.size() == 1);
    assert(audio.audio_decode_queue_.front()->playback_epoch == 2);
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

    // DATA callback holds transport lock while its decode enqueue is blocked.
    // Abort must invalidate that enqueue before trying the control send.
    {
        Application congested;
        current_app = &congested;
        auto& decode = congested.audio_service_;
        fill(decode);
        congested.state = kDeviceStateSpeaking;
        const auto old_generation = decode.DecodeGeneration();
        std::timed_mutex transport;
        std::atomic<bool> entered = false, completed = false;
        decode.before_decode_wait = [&] { entered = true; };
        congested.sentient_ws_->on_interrupt = [&] {
            assert(congested.suppressed_playback_epoch_ == congested.playback_epoch_);
            assert(decode.DecodeGeneration() != old_generation);
            // Fake control send cannot take transport until DATA callback exits.
            assert(transport.try_lock_for(std::chrono::milliseconds(300)));
            assert(completed && congested.tasks.empty());
            transport.unlock();
        };
        std::thread callback([&] {
            std::lock_guard<std::timed_mutex> lock(transport);
            congested.OnSdkPlaybackFrame(old_bytes, sizeof(old_bytes), 16000);
            completed = true;
        });
        auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
        while (!entered && std::chrono::steady_clock::now() < deadline) std::this_thread::yield();
        assert(entered && !completed);
        congested.AbortSpeaking();
        callback.join();
        assert(congested.sentient_ws_->interrupted == 1);
        assert(decode.audio_decode_queue_.empty() && congested.tasks.empty());
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
    assert(app.state == kDeviceStateSpeaking && app.sentient_ws_->interrupted == 3);
    assert(audio.audio_decode_queue_.size() == MAX_DECODE_PACKETS_IN_QUEUE);

    app.processing_ = app.ui_processing = true; // B cognition, independent of latest A audio.
    app.OnSdkPlaybackFrame(bytes, sizeof(bytes), 16000); // New turn also times out.
    assert(app.suppressed_playback_epoch_ == 4 && app.tasks.size() == 1);
    app.tasks.front()();
    app.tasks.clear();
    assert(app.state == kDeviceStateIdle && !app.ui_playback && app.ui_processing && Board::GetInstance().display.notices == 2);
    // Failed newer turn must not delete older queued owners (fill uses owner 0).
    assert(audio.audio_decode_queue_.size() == MAX_DECODE_PACKETS_IN_QUEUE && app.sentient_ws_->interrupted == 3);
    app.OnSdkPlaybackFrame(bytes, sizeof(bytes), 16000); // Failed turn remains suppressed.
    assert(audio.audio_decode_queue_.size() == MAX_DECODE_PACKETS_IN_QUEUE);
    audio.ResetDecoder(); // Fixture retires older queued audio before next case.

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

    // Zero/short write: no played count or successful-drain notification.
    // Rejected ingress propagates failure until explicit reset starts new generation.
    Codec broken;
    broken.release = false;
    broken.write_ok = false;
    audio.codec_ = &broken;
    app.WireAudioServiceCallbacks();
    auto notify_failure = audio.callbacks_.on_playback_failed;
    std::atomic<int> failures = 0;
    audio.callbacks_.on_playback_failed = [&](uint32_t epoch, uint32_t generation) {
        // Callback can reenter service: no queue lock held and handoff ended.
        assert(audio.DecodeGeneration() == generation);
        assert(!audio.output_in_flight_);
        notify_failure(epoch, generation);
        ++failures;
    };
    app.playback_epoch_ = 5;
    app.OnSdkPlaybackBegin(16000);
    std::atomic<int> drains = 0;
    audio.callbacks_.on_playback_drained = [&] { ++drains; };
    int played_before = audio.debug_statistics_.playback_count;
    {
        std::lock_guard<std::mutex> lock(audio.audio_queue_mutex_);
        auto failed = std::make_unique<AudioTask>();
        failed->pcm = {9};
        failed->playback_epoch = 5;
        audio.audio_playback_queue_.push_back(std::move(failed));
        audio.audio_queue_cv_.notify_all();
    }
    {
        std::unique_lock<std::mutex> lock(broken.mutex);
        assert(broken.cv.wait_for(lock, std::chrono::seconds(1), [&] { return broken.entered; }));
        app.OnSdkPlaybackEnd(false); // All ingress ended BEFORE final output fails.
        assert(app.state == kDeviceStateSpeaking && app.playback_waiting_for_drain_);
        broken.release = true;
        broken.cv.notify_all();
    }
    {
        std::unique_lock<std::mutex> lock(audio.audio_queue_mutex_);
        assert(audio.audio_queue_cv_.wait_for(lock, std::chrono::seconds(1), [&] {
            return !audio.failed_playback_epochs_.empty() && !audio.output_in_flight_;
        }));
    }
    auto failure_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    while (failures == 0 && std::chrono::steady_clock::now() < failure_deadline) std::this_thread::yield();
    assert(failures == 1 && app.tasks.size() == 1);
    assert(app.state == kDeviceStateSpeaking && app.playback_waiting_for_drain_);
    assert(!audio.IsPlaybackDrained(5) && drains == 0);
    assert(!cube_playback_drained()); // Pending failure callback: diagnostic uses nonzero owner.
    assert(audio.debug_statistics_.playback_count == played_before);
    auto rejected = packet();
    rejected->playback_epoch = 5;
    assert(audio.PushPacketToDecodeQueue(std::move(rejected), audio.DecodeGeneration()) == DecodeQueueResult::Failed);
    auto terminal_failure = app.tasks.front();
    app.tasks.clear();
    terminal_failure();
    assert(app.state == kDeviceStateIdle && !app.ui_playback && app.ui_processing);
    assert(!app.playback_active_ && !app.playback_waiting_for_drain_);
    assert(app.sentient_ws_->interrupted == 3 && Board::GetInstance().display.notices == 3);
    app.OnSdkPlaybackFrame(bytes, sizeof(bytes), 16000);
    assert(audio.audio_decode_queue_.empty()); // Failed epoch stays suppressed.
    assert(audio.IsPlaybackDrained() && drains == 0); // Reset is not success notification.

    // A delayed old notification must preserve a new turn, even if decoder
    // generation has not changed (playback.begin does not reset the decoder).
    const auto shared_generation = audio.DecodeGeneration();
    notify_failure(5, shared_generation);
    app.playback_epoch_ = 6;
    app.OnSdkPlaybackBegin(16000);
    app.processing_ = app.ui_processing = true;
    app.OnSdkPlaybackFrame(bytes, sizeof(bytes), 16000);
    app.tasks.front()();
    app.tasks.clear();
    assert(app.state == kDeviceStateSpeaking && app.ui_playback && app.ui_processing);
    assert(audio.DecodeGeneration() == shared_generation && audio.audio_decode_queue_.size() == 1);
    assert(app.suppressed_playback_epoch_ == 5 && Board::GetInstance().display.notices == 3);

    // Same epoch, reset/new decoder: generation fence independently rejects it.
    notify_failure(6, shared_generation);
    audio.ResetDecoder();
    app.OnSdkPlaybackFrame(bytes, sizeof(bytes), 16000);
    app.tasks.front()();
    app.tasks.clear();
    assert(app.state == kDeviceStateSpeaking && app.ui_playback && app.ui_processing);
    assert(audio.audio_decode_queue_.size() == 1 && app.sentient_ws_->interrupted == 3);
    audio.ResetDecoder();

    // R1: actual output worker fails A after wire-done and B begin/queue,
    // with NO decoder reset. Park terminal delivery to inspect both queues.
    Codec late_failure;
    late_failure.write_ok = false;
    audio.codec_ = &late_failure;
    const auto overlap_generation = audio.DecodeGeneration();
    app.playback_epoch_ = 7;
    app.OnSdkPlaybackBegin(16000);
    std::mutex delivery_mutex;
    std::condition_variable delivery_cv;
    bool delivered = false, resume_output = false;
    audio.callbacks_.on_playback_failed = [&](uint32_t epoch, uint32_t gen) {
        assert(epoch == 7 && gen == overlap_generation);
        notify_failure(epoch, gen);
        std::unique_lock<std::mutex> lock(delivery_mutex);
        delivered = true;
        delivery_cv.notify_all();
        delivery_cv.wait(lock, [&] { return resume_output; });
    };
    {
        std::lock_guard<std::mutex> lock(audio.audio_queue_mutex_);
        auto a = std::make_unique<AudioTask>();
        a->pcm = {10}; a->playback_epoch = 7;
        audio.audio_playback_queue_.push_back(std::move(a));
        audio.audio_queue_cv_.notify_all();
    }
    {
        std::unique_lock<std::mutex> lock(late_failure.mutex);
        assert(late_failure.cv.wait_for(lock, std::chrono::seconds(1), [&] { return late_failure.entered; }));
    }
    app.OnSdkPlaybackEnd(false);
    app.playback_epoch_ = 8;
    app.OnSdkPlaybackBegin(16000);
    app.OnSdkPlaybackFrame(bytes, sizeof(bytes), 16000);
    {
        std::lock_guard<std::mutex> lock(audio.audio_queue_mutex_);
        auto old = packet(); old->playback_epoch = 7;
        audio.audio_decode_queue_.push_front(std::move(old));
        for (uint32_t epoch : {7u, 8u}) {
            auto pcm = std::make_unique<AudioTask>();
            pcm->pcm = {11}; pcm->playback_epoch = epoch;
            audio.audio_playback_queue_.push_back(std::move(pcm));
        }
    }
    {
        std::lock_guard<std::mutex> lock(late_failure.mutex);
        late_failure.release = true;
        late_failure.cv.notify_all();
    }
    {
        std::unique_lock<std::mutex> lock(delivery_mutex);
        assert(delivery_cv.wait_for(lock, std::chrono::seconds(1), [&] { return delivered; }));
    }
    assert(audio.DecodeGeneration() == overlap_generation);
    assert(audio.audio_decode_queue_.size() == 1 && audio.audio_decode_queue_.front()->playback_epoch == 8);
    assert(audio.audio_playback_queue_.size() == 1 && audio.audio_playback_queue_.front()->playback_epoch == 8);
    auto old = packet(); old->playback_epoch = 7;
    assert(audio.PushPacketToDecodeQueue(std::move(old), overlap_generation) == DecodeQueueResult::Failed);
    app.tasks.front()(); app.tasks.clear(); // A notification ignored without reset.
    assert(app.state == kDeviceStateSpeaking && app.ui_playback && app.suppressed_playback_epoch_ == 5);
    app.OnSdkPlaybackFrame(bytes, sizeof(bytes), 16000); // B admission still works.
    assert(audio.audio_decode_queue_.size() == 2 && app.tasks.empty());
    app.OnSdkPlaybackEnd(false);
    {
        std::lock_guard<std::mutex> lock(audio.audio_queue_mutex_);
        audio.audio_decode_queue_.clear(); // Decoder boundary consumed B packets.
    }
    auto drain_before = drains.load();
    {
        std::lock_guard<std::mutex> lock(delivery_mutex);
        late_failure.write_ok = true;
        resume_output = true;
        delivery_cv.notify_all();
    }
    auto drain_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    while (drains == drain_before && std::chrono::steady_clock::now() < drain_deadline) std::this_thread::yield();
    assert(drains == drain_before + 1 && late_failure.writes == 2); // A failed, B played.
    assert(audio.DecodeGeneration() == overlap_generation && audio.IsPlaybackDrained(8));
    assert(!audio.IsPlaybackDrained(7)); // A never becomes fake success.
    assert(cube_playback_drained()); // Old A failure does not poison current B diagnostic.
    app.OnPlaybackDrained();
    assert(app.state == kDeviceStateIdle && !app.ui_playback);
    assert(Board::GetInstance().display.notices == 3 && app.sentient_ws_->interrupted == 3);

    // wkO5HV: real callback wiring, delayed main queue, real reset/ingress/
    // decoder-publication fence and output worker. Abort A must finish cleanup
    // before B is admitted, not wait for a stale deferred UI callback.
    {
        Application overlap;
        current_app = &overlap;
        auto& decode = overlap.audio_service_;
        Codec player;
        player.release = true;
        decode.codec_ = &player;
        SentientWsProtocolConfig cfg;
        overlap.WireSentientWsCallbacks(cfg);
        auto flush_main = [&] {
            while (!overlap.tasks.empty()) {
                auto task = std::move(overlap.tasks.front());
                overlap.tasks.pop_front();
                task();
            }
        };
        auto wait_drained = [&] {
            auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
            while (!decode.IsPlaybackDrained() && std::chrono::steady_clock::now() < deadline)
                std::this_thread::yield();
            assert(decode.IsPlaybackDrained());
        };
        // Reconnect status can wait behind main work while new ingress arrives.
        cfg.on_status_change(SdkStatus::Reconnecting);
        cfg.on_status_change(SdkStatus::Ready);
        decode.DeferPlayback(true); // Physical output remains gated for held mic.
        cfg.on_playback_begin(16000); // A
        flush_main();
        assert(overlap.state == kDeviceStateSpeaking);
        cfg.on_playback_frame(bytes, sizeof(bytes), 16000, false);
        cfg.on_playback_frame(bytes, sizeof(bytes), 16000, false);
        const auto a_epoch = overlap.playback_epoch_.load();
        const auto a_generation = decode.DecodeGeneration();
        decode.audio_decode_queue_.pop_front(); // A decode already in flight
        decode.PublishDecoded(a_generation, a_epoch, 1); // A PCM also waiting
        assert(decode.audio_decode_queue_.size() == 1 && decode.audio_playback_queue_.size() == 1);
        cfg.on_playback_end(true); // accepted abortedDone A, no main-task drain
        assert(decode.DecodeGeneration() != a_generation);
        assert(decode.audio_decode_queue_.empty() && decode.audio_playback_queue_.empty());
        cfg.on_playback_begin(16000); // B arrives BEFORE deferred A UI callback
        cfg.on_playback_frame(bytes, sizeof(bytes), 16000, false);
        const auto b_epoch = overlap.playback_epoch_.load();
        const auto b_generation = decode.DecodeGeneration();
        assert(b_epoch != a_epoch && decode.audio_decode_queue_.size() == 1);
        decode.PublishDecoded(a_generation, a_epoch, 1); // late A decoder publication
        assert(decode.audio_playback_queue_.empty());
        decode.audio_decode_queue_.pop_front(); // B decode finishes
        decode.PublishDecoded(b_generation, b_epoch, 2);
        assert(decode.audio_playback_queue_.size() == 1);
        flush_main(); // A presentation skipped, NEVER a late global reset
        assert(decode.DecodeGeneration() == b_generation);
        assert(decode.audio_playback_queue_.size() == 1);
        assert(overlap.state == kDeviceStateSpeaking && overlap.ui_playback);
        cfg.on_playback_end(false);
        flush_main();
        assert(overlap.playback_waiting_for_drain_);
        std::thread player_thread([&] { decode.AudioOutputTask(); });
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        assert(player.writes == 0 && !decode.IsPlaybackDrained());
        decode.DeferPlayback(false); // Release promotes buffered audio, not wire done.
        wait_drained();
        overlap.OnPlaybackDrained();
        assert(overlap.state == kDeviceStateIdle && !overlap.ui_playback);
        cfg.on_playback_begin(16000); // C normal, without user barge-in
        cfg.on_playback_frame(bytes, sizeof(bytes), 16000, false);
        decode.audio_decode_queue_.pop_front();
        decode.PublishDecoded(decode.DecodeGeneration(), overlap.playback_epoch_, 3);
        cfg.on_playback_end(false);
        flush_main();
        wait_drained();
        overlap.OnPlaybackDrained();
        assert(overlap.state == kDeviceStateIdle && !overlap.ui_playback);
        decode.Stop();
        player_thread.join();
        assert((player.played == std::vector<int16_t>{2, 3})); // A NEVER handed to output
        current_app = &app;
    }

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
