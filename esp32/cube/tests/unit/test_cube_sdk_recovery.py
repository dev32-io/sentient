"""Production SDK + Application methods + actual state graph; hardware adapters only mocked."""
from pathlib import Path
import os
import re
import subprocess
from cube_envelope_host import envelope_link_args

UNIT = Path(__file__).resolve().parent
MAIN = UNIT.parents[1] / 'firmware/main'


def method(path, owner, name):
    return re.search(rf'^(?:void|bool) {owner}::{name}\([^\n]*\)[^\n]*\{{.*?^\}}',
                     path.read_text(), re.MULTILINE | re.DOTALL).group()


def test_protocol_and_recovered_application_capture(tmp_path):
    cjson = Path(os.environ.get('IDF_PATH', Path.home() / 'esp/esp-idf')) / 'components/json/cJSON'
    program = r'''
#define main protocol_regressions
#include "sentient_ws_protocol_host_test.cc"
#undef main
#include "device_state.h"
#include <deque>
class DeviceStateMachine { public: bool IsValidTransition(DeviceState, DeviceState) const; };
namespace sentient::cube {
struct CubeHardware {
    bool ready = false;
    static CubeHardware& Get() { static CubeHardware h; return h; }
    void GatewayReady(bool value) { ready = value; }
    void WsStartResult(const char*, int) {}
};
}
struct Display { int notices = 0; void ShowNotification(const char*, int) { ++notices; } };
struct Board { static Board& GetInstance() { static Board b; return b; }
    Display* GetDisplay() { return &display; } Display display; };
void sentient_cube_set_processing(bool) {}
void sentient_cube_set_playback(bool) {}
struct AudioService {
    bool prepared = false, deferred = false, finished = false;
    int queued = 0, resets = 0;
    bool EnableVoiceProcessing(bool enable, bool drain = false) {
        prepared = enable; if (!enable) finished = drain; return true;
    }
    bool IsAudioProcessorRunning() { return prepared; }
    void ClearSendQueue() {}
    bool WaitForSendEncoding() { return finished; }
    void ResetDecoder() { queued = 0; ++resets; }
    void DeferPlayback(bool value) { deferred = value; }
};
struct Application {
    std::unique_ptr<SentientWsProtocol> sentient_ws_;
    AudioService audio_service_;
    DeviceState state = kDeviceStateIdle;
    DeviceStateMachine graph;
    bool cube_auth_refresh_attempted_ = false, processing_ = false;
    bool playback_active_ = false, playback_waiting_for_drain_ = false;
    std::atomic<uint32_t> sdk_status_epoch_{0};
    std::atomic<int> sdk_status_{-1};
    int GetSdkStatus() const { return sdk_status_.load(); }
    std::atomic<uint32_t> protocol_epoch_{0}, playback_epoch_{0}, suppressed_playback_epoch_{0};
    std::deque<std::function<void()>> tasks;
    std::mutex mutex_;
    void Schedule(std::function<void()> fn) { std::lock_guard<std::mutex> lock(mutex_); tasks.push_back(std::move(fn)); }
    void flush() { for (;;) { std::unique_lock<std::mutex> lock(mutex_); if (tasks.empty()) break;
        auto fn = std::move(tasks.front()); tasks.pop_front(); lock.unlock(); fn(); } }
    DeviceState GetDeviceState() const { return state; }
    bool SetDeviceState(DeviceState next) { if (!graph.IsValidTransition(state, next)) return false; state = next; return true; }
    bool IsAudioChannelOpened() const;
    void DismissAlert() {}
    void RetireConnectionAudio();
    void OnSdkStatusChange(SdkStatus);
    void OnSdkCognitionStatus(CognitionState);
    void OnSdkPlaybackBegin(int) {}
    void OnSdkPlaybackEnd(bool) {}
    void OnSdkPlaybackFrame(const uint8_t*, size_t, int, bool) { ++audio_service_.queued; }
    bool OnSdkPopUplinkFrame(std::vector<uint8_t>&) { return false; }
    void WireSentientWsCallbacks(SentientWsProtocolConfig&);
    void BeginUplink(); void EndUplink(); void AbortSpeaking();
};
'''
    program += method(MAIN / 'device_state_machine.cc', 'DeviceStateMachine', 'IsValidTransition')
    for name in ('IsAudioChannelOpened', 'RetireConnectionAudio', 'OnSdkStatusChange', 'WireSentientWsCallbacks',
                 'BeginUplink', 'EndUplink', 'AbortSpeaking', 'OnSdkCognitionStatus'):
        program += '\n' + method(MAIN / 'application.cc', 'Application', name)
    program += r'''
int main() {
    protocol_regressions();
    Application app;
    SentientWsProtocolConfig cfg;
    cfg.gateway_url = "wss://localhost/test"; cfg.device_id = "test-device";
    app.WireSentientWsCallbacks(cfg);
    app.sentient_ws_ = std::make_unique<SentientWsProtocol>(std::move(cfg));
    auto& sdk = *app.sentient_ws_;
    auto begin = [&] {
        // SDK intentionally refuses while sender owns serialization; bound retries
        // so this recovery regression does not depend on host task scheduling.
        for (int i = 0; i < 100; ++i) {
            mock_text.clear();
            app.BeginUplink();
            if (app.audio_service_.prepared) {
                auto interrupt = mock_text.find("\"type\":\"interrupt\"");
                auto start = mock_text.find("audio.start");
                assert(interrupt != std::string::npos && interrupt < start);
                assert(interrupt == mock_text.rfind("\"type\":\"interrupt\""));
                return;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        assert(false && "capture did not become available");
    };
    auto text = [&](const char* json) { sdk.handle_text(json, strlen(json)); app.flush(); };
    assert(sdk.connect() == ESP_OK);
    SentientWsProtocol::ws_event_handler(&sdk, nullptr, WEBSOCKET_EVENT_CONNECTED, nullptr);
    assert(sdk.ready_timeout_timer_); // Auth wait, not only configure wait, is bounded.
    text(R"({"type":"auth.error","code":"expired"})");
    assert(sdk.status() == SdkStatus::Error && app.state == kDeviceStateConnecting);
    app.BeginUplink(); assert(!app.audio_service_.prepared);
    sdk.update_token("synthetic-test-token");
    sdk.force_reconnect(); app.flush();
    assert(sdk.status() == SdkStatus::Connecting);
    SentientWsProtocol::ws_event_handler(&sdk, nullptr, WEBSOCKET_EVENT_CONNECTED, nullptr);
    text(R"({"type":"auth.ok"})");
    text(R"({"type":"session.attached","sessionId":"daily","generation":7})");
    text(R"({"type":"session.ready"})");
    assert(app.IsAudioChannelOpened() && app.state == kDeviceStateIdle);
    // Whole reconnect/attach/audio sequence can arrive before main work runs.
    sdk.force_reconnect();
    SentientWsProtocol::ws_event_handler(&sdk, nullptr, WEBSOCKET_EVENT_CONNECTED, nullptr);
    for (const char* json : {R"({"type":"auth.ok"})", R"({"type":"session.ready"})",
                           R"({"type":"turn.audio.start","turnId":"fresh","encoding":"pcm","sampleRate":24000})"})
        sdk.handle_text(json, strlen(json));
    std::string pcm(969, '\0'); pcm[8] = 1;
    esp_websocket_event_data_t e{};
    e.op_code = 2; e.fin = true; e.data_ptr = pcm.data(); e.data_len = e.payload_len = pcm.size();
    sdk.handle_data(&e);
    assert(app.audio_service_.queued == 1);
    const auto resets = app.audio_service_.resets;
    app.flush();
    assert(app.audio_service_.queued == 1 && app.audio_service_.resets == resets);
    text(R"({"type":"turn.audio.done","turnId":"fresh"})");
    text(R"({"type":"session.attached","sessionId":"daily","generation":7})");
    text(R"({"type":"turn.audio.start","turnId":"old-reply","encoding":"pcm","sampleRate":24000})");
    text(R"({"type":"turn.audio.done","turnId":"old-reply"})");
    mock_text.clear();
    begin();
    assert(app.state == kDeviceStateListening && app.audio_service_.prepared && app.audio_service_.deferred);
    assert(sdk.streaming_ && !sdk.wire_.capture_id.empty());
    const auto hold_resets = app.audio_service_.resets;
    text(R"({"type":"playback.stop","turnId":"old-reply","reason":"interrupt"})");
    assert(app.audio_service_.resets == hold_resets + 1); // Actual late wire callback retires old decode only.
    assert(app.state == kDeviceStateListening && app.audio_service_.prepared && sdk.streaming_);
    assert(mock_text.find("audio.start") != std::string::npos);
    assert(mock_text.find("attachmentGeneration\":7") != std::string::npos);
    app.EndUplink();
    assert(app.audio_service_.finished && !app.audio_service_.deferred);
    assert(app.state == kDeviceStateIdle && sdk.wire_.capture_id.empty());
    assert(mock_text.find("audio.end") != std::string::npos);
    begin();
    const auto refused_capture = sdk.wire_.capture_id;
    assert(app.state == kDeviceStateListening && app.audio_service_.prepared);
    mock_text.clear();
    text(R"({"type":"command.rejected","command":"audio.start","reason":"session_busy"})");
    assert(!app.audio_service_.prepared && sdk.wire_.capture_id.empty());
    assert(mock_text.find("audio.cancel") != std::string::npos && mock_text.find(refused_capture) != std::string::npos);
    assert(mock_text.find("audio.end") == std::string::npos);
    assert(sdk.status() == SdkStatus::Ready && app.state == kDeviceStateIdle);
    assert(!sdk.busy_refusal_);
    assert(Board::GetInstance().display.notices == 2); // Auth failure and typed busy refusal.
    begin();
    const char* refusal = R"({"type":"command.rejected","command":"audio.start","reason":"session_busy"})";
    const char* thinking = R"({"type":"turn.started","turnId":"answer-A"})";
    sdk.handle_text(thinking, strlen(thinking));
    sdk.handle_text(refusal, strlen(refusal));
    sdk.handle_text(refusal, strlen(refusal));
    auto delayed_callback = std::move(app.tasks.back()); app.tasks.pop_back();
    // A's delayed speech may already be queued before B refusal cleanup.
    app.audio_service_.queued = 3;
    app.flush();
    assert(app.audio_service_.queued == 3 && app.processing_);
    text(R"({"type":"turn.completed","turnId":"answer-A"})");
    begin();
    assert(app.state == kDeviceStateListening && app.audio_service_.prepared);
    const auto new_capture = sdk.wire_.capture_id;
    const auto before_stale = app.audio_service_.resets;
    assert(app.audio_service_.queued == 0); // New explicit hold intentionally retired prior speech.
    delayed_callback(); // Already-settled callback must not kill newer capture.
    assert(sdk.wire_.capture_id == new_capture && sdk.streaming_);
    assert(app.audio_service_.prepared && app.state == kDeviceStateListening);
    assert(app.audio_service_.resets == before_stale && app.audio_service_.queued == 0);
    app.EndUplink();
    sdk.disconnect(); app.flush();
    // Configure errors take same truthful bounded failure path, not Ready.
    sdk.stopping_ = false;
    assert(sdk.connect() == ESP_OK);
    SentientWsProtocol::ws_event_handler(&sdk, nullptr, WEBSOCKET_EVENT_CONNECTED, nullptr);
    text(R"({"type":"auth.ok"})");
    text(R"({"type":"error","code":"invalid_config","message":"synthetic"})");
    assert(sdk.status() != SdkStatus::Ready && !app.IsAudioChannelOpened());
    sdk.disconnect(); app.flush();
}
'''
    source = tmp_path / 'recovery.cc'
    source.write_text(program)
    subprocess.run(['cc', '-c', str(cjson / 'cJSON.c'), '-I', str(cjson), '-o', str(tmp_path / 'json.o')], check=True)
    binary = tmp_path / 'recovery'
    subprocess.run(['c++', '-std=c++17', '-pthread', '-I', str(UNIT), '-I', str(UNIT / 'ws_stubs'),
                    '-I', str(MAIN), '-I', str(cjson), str(source),
                    str(MAIN / 'protocols/sentient_ws_protocol.cc'), str(MAIN / 'audio/demuxer/ogg_demuxer.cc'),
                    str(tmp_path / 'json.o'), *envelope_link_args(tmp_path, cjson), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True, timeout=20)
