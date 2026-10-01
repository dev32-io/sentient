"""Run production decode branch with deterministic codec/converter adapters (no audio/device)."""
from pathlib import Path
import subprocess
from test_audio_resampler_boundary import block

MAIN = Path(__file__).resolve().parents[2] / 'firmware/main'


def test_pcm_opus_decode_failure_and_owner_fence(tmp_path):
    source = (MAIN / 'audio/audio_service.cc').read_text()
    decode = block(source, 'if (!audio_decode_queue_.empty() && audio_playback_queue_.size() < MAX_PLAYBACK_TASKS_IN_QUEUE)')
    cpp = r'''
#include "audio/audio_stream_packet.h"
#include <algorithm>
#include <set>
#include <atomic>
#include <thread>
#include <chrono>
#include <cassert>
#include <condition_variable>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#define MAX_PLAYBACK_TASKS_IN_QUEUE 2
#define MAX_DECODE_PACKETS_IN_QUEUE 4
#define AUDIO_POWER_CHECK_INTERVAL_MS 1000
#define ESP_AUDIO_ERR_OK 0
#define ESP_AUDIO_ERR_FAIL -1
#define ESP_AE_ERR_OK 0
#define ESP_AUDIO_DEC_RECOVERY_NONE 0
#define ESP_LOGE(...) ((void)0)
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGW(...) ((void)0)
#define ESP_AUDIO_MONO 1
struct esp_opus_dec_cfg_t { int rate, duration; };
struct esp_ae_rate_cvt_cfg_t { int src, dst, channels; };
#define OPUS_DEC_CFG(r,d) esp_opus_dec_cfg_t{r,d}
#define RATE_CVT_CFG(s,d,c) esp_ae_rate_cvt_cfg_t{s,d,c}
bool opus_open_ok = true, converter_open_ok = true;
void esp_opus_dec_close(void*) {}
void esp_ae_rate_cvt_close(void*) {}
int esp_opus_dec_open(esp_opus_dec_cfg_t*, size_t, void** ptr) { *ptr = opus_open_ok ? reinterpret_cast<void*>(1) : nullptr; return 0; }
int esp_ae_rate_cvt_open(esp_ae_rate_cvt_cfg_t*, void** ptr) { *ptr = converter_open_ok ? reinterpret_cast<void*>(1) : nullptr; return 0; }
struct esp_audio_dec_in_raw_t { uint8_t* buffer; uint32_t len, consumed; int frame_recover; };
struct esp_audio_dec_out_frame_t { uint8_t* buffer; uint32_t len, decoded_size; };
struct esp_audio_dec_info_t {};
using esp_ae_sample_t = void*;
void esp_opus_dec_reset(void*) {}
void esp_ae_rate_cvt_reset(void*) {}
int decode_result = 0, convert_result = 0, opus_calls = 0;
bool buffered_only = false;
int esp_opus_dec_decode(void*, esp_audio_dec_in_raw_t*, esp_audio_dec_out_frame_t* out, esp_audio_dec_info_t*) {
    ++opus_calls; out->decoded_size = 4; return decode_result;
}
int esp_ae_rate_cvt_get_max_out_sample_num(void*, uint32_t count, uint32_t* out) { *out = buffered_only && count == 1 ? 0 : count; return 0; }
int esp_ae_rate_cvt_process(void*, void*, uint32_t, void*, uint32_t* count) { if (buffered_only) *count = 0; return convert_result; }
void esp_timer_stop(int) {} void esp_timer_start_periodic(int, int) {}
struct Codec {
    std::mutex mutex; std::condition_variable cv;
    bool entered = false, release = true, write_ok = true;
    int output_sample_rate() { return 24000; }
    bool output_enabled() { return true; } void EnableOutput(bool) {}
    bool OutputData(const std::vector<int16_t>&) {
        std::unique_lock<std::mutex> lock(mutex);
        entered = true; cv.notify_all(); cv.wait(lock, [&] { return release; });
        return write_ok;
    }
};
struct Board { static Board& GetInstance() { static Board b; return b; }
    Codec* GetAudioCodec() { static Codec c; return &c; } };
constexpr int kAudioTaskTypeDecodeToPlaybackQueue = 1;
struct AudioTask { int type; uint32_t timestamp, playback_epoch; std::vector<int16_t> pcm; };
enum class DecodeQueueResult { Queued, Stale, Timeout, Full, Stopped, Failed };
struct AudioService {
    std::mutex audio_queue_mutex_, decoder_mutex_;
    std::condition_variable audio_queue_cv_;
    std::deque<std::unique_ptr<AudioStreamPacket>> audio_decode_queue_;
    std::deque<std::unique_ptr<AudioTask>> audio_playback_queue_;
    bool decoding_ = false, output_in_flight_ = false, service_stopped_ = false, playback_deferred_ = false;
    int audio_power_timer_ = 0;
    std::chrono::steady_clock::time_point last_output_time_;
    std::set<uint32_t> failed_playback_epochs_;
    uint32_t latest_playback_epoch_ = 0, decoding_playback_epoch_ = 0, output_playback_epoch_ = 0;
    void PrunePlaybackFailures();
    void FailPlaybackOwner(uint32_t);
    uint32_t decode_generation_ = 1;
    uint32_t decoder_playback_epoch_ = 0, decoder_owner_generation_ = 0;
    bool decoder_pcm_ = false;
    int decoder_duration_ms_ = 20;
    int decoder_frame_size_ = 480, decoder_sample_rate_ = 24000;
    void* opus_decoder_ = this;
    void* output_resampler_ = this;
    Codec codec; Codec* codec_ = &codec;
    struct { int decode_count = 0, playback_count = 0; } debug_statistics_;
    struct { std::function<void()> on_playback_drained; std::function<void(uint32_t,uint32_t)> on_playback_failed; } callbacks_;
    void SetDecodeSampleRate(int rate, int duration, bool pcm);
    void DecodeOnce(); void AudioOutputTask();
    DecodeQueueResult PushPacketToDecodeQueue(std::unique_ptr<AudioStreamPacket>, uint32_t, bool);
    void DiscardPlayback(uint32_t, uint32_t); bool IsPlaybackDrained(uint32_t);
};
''' + block(source, 'void AudioService::PrunePlaybackFailures(') + block(source, 'void AudioService::FailPlaybackOwner(') + block(source, 'void AudioService::SetDecodeSampleRate(') + block(source, 'void AudioService::AudioOutputTask(') + block(source, 'DecodeQueueResult AudioService::PushPacketToDecodeQueue(') + block(source, 'void AudioService::DiscardPlayback(') + block(source, 'bool AudioService::IsPlaybackDrained(') + r'''
void AudioService::DecodeOnce() {
    std::unique_lock<std::mutex> lock(audio_queue_mutex_);
''' + decode + r'''
}
int main() {
    AudioService audio;
    int failures = 0, drains = 0;
    audio.callbacks_.on_playback_failed = [&](uint32_t epoch, uint32_t generation) {
        assert(generation == 1); ++failures;
    };
    audio.callbacks_.on_playback_drained = [&] { ++drains; };
    auto queue = [&](uint32_t epoch, bool pcm, int rate = 24000) {
        auto packet = std::make_unique<AudioStreamPacket>();
        packet->pcm = pcm; packet->frame_duration = 20; packet->playback_epoch = epoch; packet->sample_rate = rate;
        packet->payload = {0x00, 0x80, 0xff, 0x7f, 0xff, 0xff};
        assert(audio.PushPacketToDecodeQueue(std::move(packet), 1, false) == DecodeQueueResult::Queued);
    };
    opus_open_ok = false; // PCM never depends on allocating Opus decoder.
    queue(1, true); audio.DecodeOnce();
    assert(opus_calls == 0);
    assert((audio.audio_playback_queue_.front()->pcm == std::vector<int16_t>{-32768, 32767, -1}));
    audio.audio_playback_queue_.clear();
    opus_open_ok = true;
    queue(1, false); audio.DecodeOnce(); assert(opus_calls == 1);
    audio.audio_playback_queue_.clear();
    decode_result = -1;
    queue(2, false); queue(2, false); queue(3, true);
    audio.DecodeOnce();
    assert(failures == 1 && drains == 0 && audio.audio_playback_queue_.empty());
    assert(audio.audio_decode_queue_.size() == 1 && audio.audio_decode_queue_.front()->playback_epoch == 3);
    audio.DecodeOnce(); // Older failed decoder cannot poison newer PCM owner.
    assert(audio.audio_playback_queue_.front()->playback_epoch == 3);
    audio.audio_playback_queue_.clear();
    convert_result = -1;
    queue(4, true, 48000); audio.DecodeOnce();
    assert(failures == 2 && drains == 0 && audio.audio_playback_queue_.empty());
    audio.output_resampler_ = nullptr;
    converter_open_ok = false;
    queue(5, true, 48000); audio.DecodeOnce();
    assert(failures == 3 && drains == 0); // Never fake playback at incorrect physical rate.
    converter_open_ok = true; convert_result = 0; buffered_only = true;
    queue(6, true, 48000); audio.audio_decode_queue_.back()->payload.resize(2);
    audio.DecodeOnce();
    assert(failures == 3 && audio.audio_playback_queue_.empty()); // Valid 1-sample buffered progress.

    // Crossed failures: B decoder fails, then blocked older A output fails,
    // while ALL main-thread failure callbacks remain pending.
    AudioService crossed;
    std::mutex callback_mutex;
    std::vector<uint32_t> pending_callbacks;
    std::atomic<int> crossed_drains = 0;
    crossed.callbacks_.on_playback_failed = [&](uint32_t epoch, uint32_t generation) {
        assert(generation == 1);
        std::lock_guard<std::mutex> lock(callback_mutex); pending_callbacks.push_back(epoch);
    };
    crossed.callbacks_.on_playback_drained = [&] { ++crossed_drains; };
    auto a = std::make_unique<AudioTask>(); a->playback_epoch = 1; a->pcm = {42};
    crossed.audio_playback_queue_.push_back(std::move(a));
    crossed.codec.release = false; crossed.codec.write_ok = false;
    std::thread output([&] { crossed.AudioOutputTask(); });
    {
        std::unique_lock<std::mutex> lock(crossed.codec.mutex);
        assert(crossed.codec.cv.wait_for(lock, std::chrono::seconds(1), [&] { return crossed.codec.entered; }));
    }
    auto ingress = [&](uint32_t owner, bool pcm) {
        auto packet = std::make_unique<AudioStreamPacket>(); packet->pcm = pcm;
        packet->sample_rate = 24000; packet->frame_duration = 20; packet->playback_epoch = owner; packet->payload = {1, 0};
        return crossed.PushPacketToDecodeQueue(std::move(packet), 1, false);
    };
    assert(ingress(2, false) == DecodeQueueResult::Queued);
    crossed.DecodeOnce(); // Actual failed Opus decode.
    {
        std::lock_guard<std::mutex> lock(crossed.codec.mutex);
        crossed.codec.release = true; crossed.codec.cv.notify_all();
    }
    for (int i = 0; i < 100; ++i) {
        { std::lock_guard<std::mutex> lock(callback_mutex); if (pending_callbacks.size() == 2) break; }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    {
        std::lock_guard<std::mutex> lock(callback_mutex);
        assert((pending_callbacks == std::vector<uint32_t>{2, 1}));
    }
    assert(ingress(2, true) == DecodeQueueResult::Failed);
    assert(!crossed.IsPlaybackDrained(2) && crossed_drains == 0);
    { std::lock_guard<std::mutex> lock(crossed.codec.mutex); crossed.codec.write_ok = true; }
    assert(ingress(3, true) == DecodeQueueResult::Queued);
    crossed.DecodeOnce();
    for (int i = 0; i < 100 && !crossed_drains; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    assert(crossed_drains == 1 && crossed.IsPlaybackDrained(3)); // Healthy C independent.
    assert(ingress(2, true) == DecodeQueueResult::Stale); // Retired B cannot resurrect either.
    for (uint32_t owner = 4; owner < 500; ++owner) {
        assert(ingress(owner, true) == DecodeQueueResult::Queued);
        crossed.DiscardPlayback(owner, 1);
        assert(crossed.failed_playback_epochs_.size() <= 4); // Retained owners, not history.
    }
    { std::lock_guard<std::mutex> lock(crossed.audio_queue_mutex_); crossed.service_stopped_ = true; }
    crossed.audio_queue_cv_.notify_all(); output.join();
}
'''
    path = tmp_path / 'decode.cc'
    path.write_text(cpp)
    binary = tmp_path / 'decode'
    subprocess.run(['c++', '-std=c++17', '-pthread', '-I', str(MAIN), str(path), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
