"""Production lifecycle/queue diagnostic boundaries; no IDF, audio files or hardware."""
from pathlib import Path
import subprocess
import tempfile

from test_audio_resampler_boundary import block

AUDIO = Path(__file__).resolve().parents[2] / 'firmware/main/audio'


def test_capture_energy_lifecycle():
    source = (AUDIO / 'audio_service.cc').read_text()
    methods = '\n'.join(block(source, marker) for marker in (
        'bool AudioService::EnableVoiceProcessing(',
        'void AudioService::ClearSendQueue(',
        'void AudioService::PushTaskToEncodeQueue(',
        'bool AudioService::GetCaptureEnergy(',
    ))
    cpp = r'''
#include "capture_energy.h"
#include <algorithm>
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>
#define ESP_LOGD(...) ((void)0)
#define ESP_LOGE(...) ((void)0)
#define OPUS_FRAME_DURATION_MS 20
#define AUDIO_POWER_CHECK_INTERVAL_MS 1000
#define AS_EVENT_AUDIO_PROCESSOR_RUNNING 4
#define MAX_TIMESTAMPS_IN_QUEUE 3
#define MAX_ENCODE_TASKS_IN_QUEUE 2
#define ESP_LOGW(...) ((void)0)
void esp_timer_stop(int) {}
void esp_timer_start_periodic(int, int) {}
void vTaskDelay(int) {}
int pdMS_TO_TICKS(int n) { return n; }
void esp_ae_rate_cvt_reset(int) {}
void xEventGroupSetBits(int, int) {}
void xEventGroupClearBits(int, int) {}
void agent_audio_inject_begin_capture() {}
void agent_audio_inject_end_capture() {}
struct Codec {
    bool input_enabled() { return true; }
    void EnableInput(bool) {}
    int input_sample_rate() { return 24000; }
};
struct Processor {
    bool start_ok = true, stop_ok = true;
    std::function<void()> tail;
    void Initialize(Codec*, int, int) {}
    bool Start(uint32_t) { return start_ok; }
    bool GetCaptureSampleCounts(uint32_t, size_t& fed, size_t& fetched) {
        fed = 512; fetched = 480; return true;
    }
    bool Stop(bool drain) { if (drain && tail) tail(); return stop_ok; }
};
enum AudioTaskType { kAudioTaskTypeEncodeToSendQueue, kAudioTaskTypeEncodeToTestingQueue };
struct AudioTask {
    AudioTaskType type;
    std::vector<int16_t> pcm;
    uint32_t send_generation = 0, timestamp = 0;
};
struct AudioService {
    CaptureEnergySnapshot capture_energy_;
    Codec codec;
    Codec* codec_ = &codec;
    Processor processor;
    Processor* audio_processor_ = &processor;
    bool audio_processor_initialized_ = false, accepting_send_ = false;
    bool send_failed_ = false, service_stopped_ = false;
    uint32_t send_generation_ = 0;
    size_t send_producers_ = 0;
    int models_list_ = 0, audio_power_timer_ = 0, event_group_ = 0;
    decltype(nullptr) input_resampler_ = nullptr;
    std::chrono::steady_clock::time_point last_input_time_;
    std::mutex audio_queue_mutex_, input_resampler_mutex_;
    std::timed_mutex input_capture_mutex_;
    std::condition_variable audio_queue_cv_;
    std::deque<std::unique_ptr<AudioTask>> audio_encode_queue_;
    std::deque<int> audio_send_queue_;
    std::deque<uint32_t> timestamp_queue_;
    bool ResetDecoder() { return true; }
    bool EnableVoiceProcessing(bool, bool = false);
    void ClearSendQueue();
    void PushTaskToEncodeQueue(AudioTaskType, std::vector<int16_t>&&, uint32_t);
    bool GetCaptureEnergy(CaptureEnergySnapshot&);
};
void esp_ae_rate_cvt_reset(decltype(nullptr)) {}
''' + methods + r'''
int main() {
    AudioService service;
    CaptureEnergySnapshot snap;
    assert(!service.GetCaptureEnergy(snap));
    assert(service.EnableVoiceProcessing(true));
    auto first = service.send_generation_;
    assert(service.GetCaptureEnergy(snap));
    assert(snap.epoch == 1 && snap.state == CaptureEnergySnapshot::State::Capturing);
    assert(snap.native_rate_hz == 24000 && snap.encoder_rate_hz == 16000);
    service.PushTaskToEncodeQueue(kAudioTaskTypeEncodeToSendQueue,
                                 {-32768, 32767, 0, 16384}, first);
    assert(service.GetCaptureEnergy(snap));
    assert(snap.encoder_input.samples == 4 && snap.encoder_input.clipped == 2);
    assert(snap.encoder_input.peak == 32768);
    assert(snap.encoder_input.squares == uint64_t{32768}*32768 + uint64_t{32767}*32767 + uint64_t{16384}*16384);
    service.processor.tail = [&] {
        assert(service.GetCaptureEnergy(snap));
        assert(snap.state == CaptureEnergySnapshot::State::Draining);
        service.PushTaskToEncodeQueue(kAudioTaskTypeEncodeToSendQueue, {0, 0}, first);
    };
    assert(service.EnableVoiceProcessing(false, true));
    assert(service.GetCaptureEnergy(snap));
    assert(snap.state == CaptureEnergySnapshot::State::Complete && snap.encoder_input.samples == 6);
    assert(snap.afe_counts_available && snap.afe_fed_samples == 512 && snap.afe_fetched_samples == 480);
    service.ClearSendQueue(); // preserve finalized snapshot through idle
    assert(service.GetCaptureEnergy(snap) && snap.encoder_input.samples == 6);
    assert(service.EnableVoiceProcessing(true));
    assert(service.GetCaptureEnergy(snap) && snap.epoch == 2 && snap.encoder_input.samples == 0);
    service.PushTaskToEncodeQueue(kAudioTaskTypeEncodeToSendQueue, {32767}, first);
    assert(service.GetCaptureEnergy(snap) && snap.encoder_input.samples == 0);
    // Busy snapshot must say unavailable, never expose partial/false-zero data.
    std::unique_lock<std::mutex> held(service.audio_queue_mutex_);
    bool available = true;
    std::thread reader([&] { available = service.GetCaptureEnergy(snap); });
    reader.join();
    assert(!available);
    held.unlock();
    assert(service.EnableVoiceProcessing(false));
    assert(service.GetCaptureEnergy(snap) && snap.state == CaptureEnergySnapshot::State::Retired);
    service.processor.start_ok = false;
    assert(!service.EnableVoiceProcessing(true));
    assert(service.GetCaptureEnergy(snap) && snap.epoch == 3 && snap.state == CaptureEnergySnapshot::State::Failed);
    CaptureEnergy bounded;
    bounded.samples = UINT64_MAX / (uint64_t{1} << 30);
    int16_t sample = -32768;
    bounded.Merge(CaptureEnergy::Measure(&sample, 1));
    assert(!bounded.valid);
}
'''
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory)
        (path / 'sdkconfig.h').write_text('')
        (path / 'test.cc').write_text(cpp)
        subprocess.run(['c++', '-std=c++17', '-pthread', '-Wall', '-Wextra',
                        '-DCONFIG_ESP32_DEVTOOL_COMPANION_ENABLE=1',
                        '-I', directory, '-I', str(AUDIO), str(path / 'test.cc'),
                        '-o', str(path / 'test')], check=True)
        subprocess.run([str(path / 'test')], check=True, timeout=5)
        # Disabled production header has no diagnostic type/surface.
        (path / 'prod.cc').write_text('#include "capture_energy.h"\nstruct CaptureEnergy {};\nstruct CaptureEnergySnapshot {};\nint main() {}\n')
        subprocess.run(['c++', '-std=c++17', '-DCONFIG_ESP32_DEVTOOL_COMPANION_ENABLE=0',
                        '-I', directory, '-I', str(AUDIO), str(path / 'prod.cc'),
                        '-o', str(path / 'prod')], check=True)
        subprocess.run(['c++', '-std=c++17', '-DCONFIG_ESP32_DEVTOOL_COMPANION_ENABLE=0',
                        '-I', directory, '-c', str(AUDIO.parent / 'devtool_verbs/audio_misc.cc'),
                        '-o', str(path / 'audio_misc.o')], check=True)
        symbols = subprocess.check_output(['nm', str(path / 'audio_misc.o')], text=True)
        assert 'audio_dump_state' not in symbols and 'register_audio_misc_verbs' not in symbols
