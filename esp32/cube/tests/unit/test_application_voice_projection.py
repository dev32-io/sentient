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
#include "cube_presentation.h"
#include <memory>
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGW(...) ((void)0)
#define TAG "test"
enum class CognitionState { Idle, Thinking, Acting };
enum DeviceState { kDeviceStateIdle, kDeviceStateListening, kDeviceStateSpeaking };
struct AudioService {
    bool drained = true;
    bool enabled = false, deferred = false;
    bool EnableVoiceProcessing(bool value, bool = false) { enabled = value; return true; }
    bool WaitForSendEncoding() { return true; }
    bool IsPlaybackDrained(unsigned = 0) { return drained; }
    void DeferPlayback(bool value) { deferred = value; }
    void ClearSendQueue() {}
    int resets = 0;
    void ResetDecoder() { ++resets; drained = true; }
};
struct Protocol {
    void notify_uplink_available() {}
    int starts = 0, ends = 0, cancels = 0, interrupts = 0;
    bool start_ok = true;
    bool start_streaming() { assert(interrupts == starts + 1); ++starts; return start_ok; }
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
    bool ui_processing = false, ui_playback = false;
    DeviceState GetDeviceState() const { return state; }
    void SetDeviceState(DeviceState s) { state = s; }
    bool IsAudioChannelOpened() const { return true; }
    void BeginUplink();
    void HandleStartListeningEvent();
    void EndUplink();
    void AbortSpeaking();
    void OnSdkCognitionStatus(CognitionState);
    void OnSdkPlaybackBegin(int);
    void OnSdkPlaybackEnd(bool);
    void OnPlaybackDrained();
};
Application* current_app;
void sentient_cube_set_processing(bool value) { current_app->ui_processing = value; }
void sentient_cube_set_playback(bool value) { current_app->ui_playback = value; }
''' + '\n'.join(method(name) for name in (
            'BeginUplink', 'HandleStartListeningEvent', 'EndUplink', 'AbortSpeaking', 'OnSdkCognitionStatus',
            'OnSdkPlaybackBegin', 'OnSdkPlaybackEnd', 'OnPlaybackDrained')) + r'''
void scene_is(Application& app, CubeScene scene) {
    CubeSignals s;
    s.wifi = s.connected = true;
    s.capturing = app.state == kDeviceStateListening;
    s.processing = app.ui_processing;
    s.playback = app.ui_playback;
    assert(cube_scene(s) == scene);
}
int main() {
    Application app;
    current_app = &app;
    auto* wire = app.sentient_ws_.get();
    app.HandleStartListeningEvent(); // Actual Ready -> explicit hold path.
    assert(wire->starts == 1 && wire->interrupts == 1);
    app.HandleStartListeningEvent(); // Repeated edge while held is not another start/interrupt.
    assert(wire->starts == 1 && wire->interrupts == 1);
    app.EndUplink(); // No turn.started: silence must not invent cognition.
    assert(app.state == kDeviceStateIdle && !app.processing_);
    scene_is(app, CubeScene::Ready);
    app.BeginUplink();
    assert(wire->starts == 2 && wire->ends == 1 && wire->interrupts == wire->starts);
    assert(app.state == kDeviceStateListening);
    app.EndUplink();

    // Turn may start before release; completion while held must also clear it.
    app.BeginUplink();
    app.OnSdkCognitionStatus(CognitionState::Thinking);
    assert(app.processing_);
    scene_is(app, CubeScene::Listening);
    app.EndUplink();
    assert(app.state == kDeviceStateIdle && app.processing_);
    scene_is(app, CubeScene::Thinking);
    app.BeginUplink(); // Real active turn: preserve mobile-like interrupt.
    assert(wire->interrupts == wire->starts && app.state == kDeviceStateListening);
    app.OnSdkCognitionStatus(CognitionState::Idle);
    assert(!app.processing_);
    scene_is(app, CubeScene::Listening);
    app.EndUplink();
    scene_is(app, CubeScene::Ready);

    app.BeginUplink();
    app.EndUplink();
    app.OnSdkCognitionStatus(CognitionState::Thinking); // Event queued after release.
    scene_is(app, CubeScene::Thinking);
    app.OnSdkCognitionStatus(CognitionState::Idle);
    scene_is(app, CubeScene::Ready);

    app.BeginUplink();
    app.OnSdkCognitionStatus(CognitionState::Thinking);
    app.OnSdkCognitionStatus(CognitionState::Idle);
    app.EndUplink();
    assert(!app.processing_ && wire->interrupts == wire->starts);
    scene_is(app, CubeScene::Ready);

    // Playback can start during held capture. Release exposes it until physical drain.
    app.BeginUplink();
    app.OnSdkPlaybackBegin(16000);
    assert(app.state == kDeviceStateListening);
    app.audio_service_.drained = false;
    app.OnSdkPlaybackEnd(false);
    app.EndUplink();
    assert(app.state == kDeviceStateSpeaking);
    scene_is(app, CubeScene::Speaking);
    app.audio_service_.drained = true;
    app.OnPlaybackDrained();
    assert(app.state == kDeviceStateIdle);
    scene_is(app, CubeScene::Ready);
    app.BeginUplink();
    assert(wire->interrupts == wire->starts);
    app.OnSdkPlaybackBegin(16000);
    app.EndUplink();
    assert(app.state == kDeviceStateSpeaking);
    app.BeginUplink(); // Actual playback: interrupt before next capture.
    assert(wire->interrupts == wire->starts && app.state == kDeviceStateListening);
    app.EndUplink();
    scene_is(app, CubeScene::Ready);

    app.OnSdkPlaybackBegin(16000); // Failed partial speech must not await drain.
    app.audio_service_.drained = false;
    assert(app.state == kDeviceStateSpeaking);
    // Simulate wire-side audio cleanup; this handler is UI-only.
    app.audio_service_.ResetDecoder();
    const int resets_before_terminal_ui = app.audio_service_.resets;
    app.OnSdkPlaybackEnd(true);
    assert(app.audio_service_.resets == resets_before_terminal_ui);
    assert(!app.playback_active_ && !app.playback_waiting_for_drain_);
    assert(app.state == kDeviceStateIdle);
    scene_is(app, CubeScene::Ready);

    app.OnSdkPlaybackBegin(16000);
    app.OnSdkCognitionStatus(CognitionState::Thinking);
    app.OnSdkPlaybackEnd(false);
    assert(app.state == kDeviceStateIdle && app.processing_);
    scene_is(app, CubeScene::Thinking);
    app.OnSdkCognitionStatus(CognitionState::Idle);
    scene_is(app, CubeScene::Ready);

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
    scene_is(app, CubeScene::Thinking);
    app.BeginUplink(); // Before turn.completed: real active turn needs one interrupt.
    assert(wire->interrupts == wire->starts && app.state == kDeviceStateListening && !app.processing_);
    app.EndUplink();
    wire->start_ok = false;
    app.HandleStartListeningEvent();
    assert(app.state == kDeviceStateIdle && !app.audio_service_.enabled && !app.audio_service_.deferred);
    assert(wire->interrupts == wire->starts); // One explicit interrupt, no dangling local capture.
}
'''
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'projection.cc'
            source.write_text(cpp)
            binary = Path(directory) / 'projection'
            subprocess.run(['c++', '-std=c++17', '-I', str(APP.parent / 'boards/sentient-cube'), str(source), '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True)


if __name__ == '__main__':
    unittest.main()
