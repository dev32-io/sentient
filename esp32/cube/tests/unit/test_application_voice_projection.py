"""Exercise Cube's production hold/release and turn callbacks with host stubs."""
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

APP = Path(__file__).resolve().parents[2] / 'firmware/main/application.cc'


def method(name):
    match = re.search(rf'^void Application::{name}\([^\n]*\) \{{.*?^\}}',
                      APP.read_text(), re.MULTILINE | re.DOTALL)
    if not match:
        raise AssertionError(f'missing Application::{name}')
    return match.group()


class ApplicationVoiceProjectionTest(unittest.TestCase):
    def test_silent_release_and_turn_callbacks_around_release(self):
        cpp = r'''
#include <atomic>
#include <cassert>
#include <cstring>
#include <memory>
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGW(...) ((void)0)
#define TAG "test"
enum class CognitionState { Idle, Thinking, Acting };
enum DeviceState { kDeviceStateIdle, kDeviceStateListening, kDeviceStateSpeaking };
struct AudioService {
    bool drained = true;
    bool EnableVoiceProcessing(bool) { return true; }
    bool WaitForSendEncoding() { return true; }
    bool IsPlaybackDrained() { return drained; }
    void ClearSendQueue() {}
    void ResetDecoder() {}
};
struct Protocol {
    int starts = 0, ends = 0, cancels = 0, interrupts = 0;
    bool start_streaming() { ++starts; return true; }
    void stop_streaming() { ++ends; }
    void cancel_streaming() { ++cancels; }
    void interrupt() { ++interrupts; }
};
struct Display { void ShowNotification(const char*, int) {} };
struct Board {
    static Board& GetInstance() { static Board board; return board; }
    Display* GetDisplay() { return &display; }
    Display display;
};
struct Application {
    AudioService audio_service_;
    std::unique_ptr<Protocol> sentient_ws_ = std::make_unique<Protocol>();
    DeviceState state = kDeviceStateIdle;
    bool processing_ = false, playback_active_ = false, playback_waiting_for_drain_ = false;
    std::atomic<unsigned> playback_epoch_{0}, suppressed_playback_epoch_{0};
    const char* hint = "Ready";
    DeviceState GetDeviceState() const { return state; }
    void SetDeviceState(DeviceState s) { state = s; }
    bool IsAudioChannelOpened() const { return true; }
    void BeginUplink();
    void EndUplink();
    void AbortSpeaking();
    void OnSdkCognitionStatus(CognitionState);
    void OnSdkPlaybackBegin(int);
    void OnSdkPlaybackEnd(bool);
    void OnPlaybackDrained();
};
Application* current_app;
void sentient_cube_set_status_hint(const char* hint) { current_app->hint = hint; }
''' + '\n'.join(method(name) for name in (
            'BeginUplink', 'EndUplink', 'AbortSpeaking', 'OnSdkCognitionStatus',
            'OnSdkPlaybackBegin', 'OnSdkPlaybackEnd', 'OnPlaybackDrained')) + r'''
void hint_is(Application& app, const char* text) { assert(std::strcmp(app.hint, text) == 0); }
int main() {
    Application app;
    current_app = &app;
    auto* wire = app.sentient_ws_.get();
    app.BeginUplink();
    app.EndUplink(); // No turn.started: silence must not invent cognition.
    assert(app.state == kDeviceStateIdle && !app.processing_);
    hint_is(app, "Ready");
    app.BeginUplink();
    assert(wire->starts == 2 && wire->ends == 1 && wire->interrupts == 0);
    assert(app.state == kDeviceStateListening);
    app.EndUplink();

    // Turn may start before release; completion while held must also clear it.
    app.BeginUplink();
    app.OnSdkCognitionStatus(CognitionState::Thinking);
    assert(app.processing_);
    hint_is(app, "Recording");
    app.EndUplink();
    assert(app.state == kDeviceStateIdle && app.processing_);
    hint_is(app, "Processing");
    app.BeginUplink(); // Real active turn: preserve mobile-like interrupt.
    assert(wire->interrupts == 1 && app.state == kDeviceStateListening);
    app.OnSdkCognitionStatus(CognitionState::Idle);
    assert(!app.processing_);
    hint_is(app, "Recording");
    app.EndUplink();
    hint_is(app, "Ready");

    app.BeginUplink();
    app.EndUplink();
    app.OnSdkCognitionStatus(CognitionState::Thinking); // Event queued after release.
    hint_is(app, "Processing");
    app.OnSdkCognitionStatus(CognitionState::Idle);
    hint_is(app, "Ready");

    app.BeginUplink();
    app.OnSdkCognitionStatus(CognitionState::Thinking);
    app.OnSdkCognitionStatus(CognitionState::Idle);
    app.EndUplink();
    assert(!app.processing_ && wire->interrupts == 1);
    hint_is(app, "Ready");

    // Playback can start during held capture. Release exposes it until physical drain.
    app.BeginUplink();
    app.OnSdkPlaybackBegin(16000);
    assert(app.state == kDeviceStateListening);
    app.audio_service_.drained = false;
    app.OnSdkPlaybackEnd(false);
    app.EndUplink();
    assert(app.state == kDeviceStateSpeaking);
    hint_is(app, "Speaking");
    app.audio_service_.drained = true;
    app.OnPlaybackDrained();
    assert(app.state == kDeviceStateIdle);
    hint_is(app, "Ready");
    app.BeginUplink();
    assert(wire->interrupts == 1);
    app.OnSdkPlaybackBegin(16000);
    app.EndUplink();
    assert(app.state == kDeviceStateSpeaking);
    app.BeginUplink(); // Actual playback: interrupt before next capture.
    assert(wire->interrupts == 2 && app.state == kDeviceStateListening);
    app.EndUplink();
    hint_is(app, "Ready");

    app.OnSdkPlaybackBegin(16000); // Playback arriving after release.
    assert(app.state == kDeviceStateSpeaking);
    app.OnSdkPlaybackEnd(true);
    assert(app.state == kDeviceStateIdle);
    hint_is(app, "Ready");

    app.OnSdkPlaybackBegin(16000);
    app.OnSdkCognitionStatus(CognitionState::Thinking);
    app.OnSdkPlaybackEnd(false);
    assert(app.state == kDeviceStateIdle && app.processing_);
    hint_is(app, "Processing");
    app.OnSdkCognitionStatus(CognitionState::Idle);
    hint_is(app, "Ready");

    // turn.audio.done and physical drain do not complete cognition.
    app.BeginUplink();
    app.OnSdkCognitionStatus(CognitionState::Thinking);
    app.OnSdkPlaybackBegin(16000);
    app.audio_service_.drained = false;
    app.OnSdkPlaybackEnd(false);
    app.audio_service_.drained = true;
    app.OnPlaybackDrained();
    assert(app.state == kDeviceStateListening && app.processing_);
    app.EndUplink();
    assert(app.state == kDeviceStateIdle && app.processing_);
    hint_is(app, "Processing");
    app.BeginUplink(); // Before turn.completed: real active turn needs one interrupt.
    assert(wire->interrupts == 3 && app.state == kDeviceStateListening && !app.processing_);
}
'''
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'projection.cc'
            source.write_text(cpp)
            binary = Path(directory) / 'projection'
            subprocess.run(['c++', '-std=c++17', str(source), '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True)


if __name__ == '__main__':
    unittest.main()
