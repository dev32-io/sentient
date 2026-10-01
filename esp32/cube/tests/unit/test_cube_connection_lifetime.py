"""Old WSS callbacks cannot publish readiness after credential replacement."""
from pathlib import Path
import re
import subprocess


def test_retired_connection_callbacks_are_fenced(tmp_path):
    source = (Path(__file__).resolve().parents[2] / 'firmware/main/application.cc').read_text()
    method = re.search(r'^void Application::WireSentientWsCallbacks\([^\n]*\) \{.*?^\}',
                       source, re.MULTILINE | re.DOTALL).group()
    program = r'''
#include <atomic>
#include <cassert>
#include <cstdint>
#include <functional>
#include <vector>
#include <mutex>
#include <thread>
#include <string>
using esp_err_t=int;
namespace sentient::cube {
struct CubeHardware {
    int start_reports=0;
    static CubeHardware& Get() { static CubeHardware value; return value; }
    void WsStartResult(const char*,int) { ++start_reports; }
};
}
enum class SdkStatus { Ready = 1, Reconnecting = 2 };
using CognitionState=int;
namespace sentient::cube { enum class SdkFailure { CaptureBusy, CommandRejected }; }
struct SentientWsProtocolConfig {
    std::function<void(sentient::cube::SdkFailure, const std::string&)> on_failure;
    std::function<void(SdkStatus)> on_status_change;
    std::function<void(int)> on_cognition_status, on_playback_begin;
    std::function<void(const char*,int)> on_start_result;
    std::function<void(bool)> on_playback_end;
    std::function<void(const uint8_t*,size_t,int,bool)> on_playback_frame;
    std::function<bool(std::vector<uint8_t>&)> on_pop_uplink_frame;
};
constexpr int kDeviceStateListening = 1, kDeviceStateSpeaking = 2, kDeviceStateIdle = 3;
void sentient_cube_set_playback(bool) {}
struct Display { void ShowNotification(const char*, int) {} };
struct Board { static Board& GetInstance() { static Board b; return b; } Display* GetDisplay() { static Display d; return &d; } };
struct Application {
    struct { int resets = 0; void ResetDecoder() { ++resets; } void EnableVoiceProcessing(bool) {} void ClearSendQueue() {} void DeferPlayback(bool) {} } audio_service_;
    std::atomic<uint32_t> sdk_status_epoch_{0};
    std::atomic<int> sdk_status_{-1};
    std::mutex mutex_;
    std::atomic<uint32_t> protocol_epoch_{0}, playback_epoch_{0}, suppressed_playback_epoch_{0};
    std::vector<std::function<void()>> pending;
    int published=0;
    void Schedule(std::function<void()> task) { pending.push_back(task); }
    void OnSdkStatusChange(SdkStatus) { ++published; }
    void OnSdkCognitionStatus(int) { ++published; }
    void OnSdkPlaybackBegin(int) { ++published; }
    void OnSdkPlaybackEnd(bool) { ++published; }
    void OnSdkPlaybackFrame(const uint8_t*,size_t,int,bool = false) { ++published; }
    bool OnSdkPopUplinkFrame(std::vector<uint8_t>&) { ++published; return true; }
    struct Ws { bool busy_refusal_pending() const { return true; } void settle_busy_refusal() {} }; Ws* sentient_ws_ = nullptr;
    int GetDeviceState() { return 0; } void SetDeviceState(int) {}
    bool playback_active_ = false, playback_waiting_for_drain_ = false;
    void RetireConnectionAudio() { ++playback_epoch_; audio_service_.ResetDecoder(); }
    void WireSentientWsCallbacks(SentientWsProtocolConfig&);
    void flush() { for(auto& task:pending) task(); pending.clear(); }
};
''' + method + r'''
int main() {
    Application app;
    SentientWsProtocolConfig old, current;
    app.WireSentientWsCallbacks(old);
    old.on_start_result("worker-task",257);
    old.on_status_change(SdkStatus::Ready); old.on_cognition_status(1);
    old.on_playback_begin(16000); old.on_playback_end(false);
    ++app.protocol_epoch_; // Main loop retires revoked/pending credentials before disconnect.
    app.WireSentientWsCallbacks(current);
    app.flush(); assert(app.published==0);
    assert(sentient::cube::CubeHardware::Get().start_reports==0);
    std::vector<uint8_t> frame;
    old.on_playback_frame(nullptr,0,16000,false);
    assert(!old.on_pop_uplink_frame(frame));
    old.on_playback_begin(16000); old.on_playback_end(true);
    app.flush(); assert(app.published==0 && app.audio_service_.resets==0);
    current.on_start_result("started",0);
    current.on_status_change(SdkStatus::Ready); current.on_cognition_status(1);
    current.on_playback_begin(16000); current.on_playback_end(false);
    app.flush(); assert(app.published==4);
    assert(sentient::cube::CubeHardware::Get().start_reports==1);
    assert(current.on_pop_uplink_frame(frame));
    current.on_playback_frame(nullptr,0,16000,false); assert(app.published==6);
}
'''
    (tmp_path / 'main.cc').write_text(program)
    binary = tmp_path / 'check'
    subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                    str(tmp_path / 'main.cc'), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)


def test_active_token_starts_ws_without_renewal_loop(tmp_path):
    source = (Path(__file__).resolve().parents[2] / 'firmware/main/application.cc').read_text()
    method = re.search(r'^void Application::RefreshCubeConnection\(\) \{.*?^\}',
                       source, re.MULTILINE | re.DOTALL).group()
    program = r'''
#include <cassert>
#include <cstdint>
#include <memory>
#include <string>
enum class SdkStatus { Disconnected, Connecting, Ready, Error };
namespace sentient::cube {
struct CubeHardware {
    struct Credentials { bool blocked=true; uint32_t revision=0; std::string token; } credentials;
    bool online=true;
    int syncs=0;
    static CubeHardware& Get() { static CubeHardware h; return h; }
    Credentials Connection() { return credentials; }
    bool WifiConnected() { return online; }
    void RequestSync() { ++syncs; }
};
}
struct Ws {
    SdkStatus state=SdkStatus::Connecting;
    int reconnects=0;
    std::string token;
    SdkStatus status() { return state; }
    void disconnect() {}
    void update_token(const std::string& value) { token=value; }
    void force_reconnect() { ++reconnects; state=SdkStatus::Connecting; }
};
struct Display { void ShowNotification(const char*, int) {} };
struct Board { static Board& GetInstance() { static Board b; return b; } Display* GetDisplay() { static Display d; return &d; } };
struct Application {
    uint32_t protocol_epoch_=0, playback_epoch_=0, cube_token_revision_=0;
    bool cube_auth_refresh_attempted_=false;
    std::unique_ptr<Ws> sentient_ws_;
    struct Audio { void ResetDecoder() {} } audio_service_;
    int starts=0;
    void InitializeSentientWs() {
        auto credentials=sentient::cube::CubeHardware::Get().Connection();
        assert(!credentials.blocked && !credentials.token.empty());
        ++starts;
        cube_token_revision_=credentials.revision;
        sentient_ws_=std::make_unique<Ws>();
        sentient_ws_->token=credentials.token;
    }
    void OnSdkStatusChange(SdkStatus) {}
    void RetireConnectionAudio() { audio_service_.ResetDecoder(); }
    void RetireProtocolStatus() { ++protocol_epoch_; }
    void RefreshCubeConnection();
};
''' + method + r'''
int main() {
    Application app;
    auto& h=sentient::cube::CubeHardware::Get();
    app.RefreshCubeConnection(); // Active NVS record after boot still needs RAM token.
    assert(!app.sentient_ws_ && !h.syncs);
    h.credentials={false,1,"disposable-token"};
    for(int i=0;i<100;++i) app.RefreshCubeConnection();
    assert(app.starts==1 && app.sentient_ws_ && !h.syncs);
    app.sentient_ws_->state=SdkStatus::Error;
    for(int i=0;i<100;++i) app.RefreshCubeConnection();
    assert(h.syncs==1); // One auth refresh, not a clock-tick renewal loop.
    h.credentials={false,2,"renewed-disposable-token"};
    app.RefreshCubeConnection();
    assert(app.sentient_ws_->token==h.credentials.token && app.sentient_ws_->reconnects==1);
    app.sentient_ws_->state=SdkStatus::Error;
    for(int i=0;i<100;++i) app.RefreshCubeConnection();
    assert(h.syncs==1 && app.starts==1);
}
'''
    (tmp_path / 'startup.cc').write_text(program)
    binary = tmp_path / 'startup'
    subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                    str(tmp_path / 'startup.cc'), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)


def test_owner_retirement_with_concurrent_snapshot_readers(tmp_path):
    main = Path(__file__).resolve().parents[2] / 'firmware/main'
    source = (main / 'application.cc').read_text()
    header = (main / 'application.h').read_text()
    methods = '\n'.join(re.search(rf'^(?:void|bool) Application::{name}\([^\n]*\)(?: const)? \{{.*?^\}}',
        source, re.M | re.S).group() for name in (
            'IsAudioChannelOpened', 'RetireProtocolStatus', 'ResetProtocol',
            'ForceProtocolReconnect', 'WireAudioServiceCallbacks', 'Reboot'))
    # Use the actual status callback (including its publication/epoch lock).
    callback = source[source.index('    cfg.on_status_change ='):source.index('    cfg.on_cognition_status =')]
    getter = re.search(r'    int GetSdkStatus\(\) const \{[^\n]*', header).group()
    cpp = r'''
#include <atomic>
#include <cassert>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>
#define ESP_LOGI(...) ((void)0)
#define pdMS_TO_TICKS(x) (x)
void vTaskDelay(int) {}
int reboots = 0;
void esp_restart() { ++reboots; }
enum class SdkStatus { Disconnected, Ready, Reconnecting };
constexpr int MAIN_EVENT_SEND_AUDIO = 1;
std::atomic<int> notifications{0};
void xEventGroupSetBits(int, int) { ++notifications; }
struct AudioServiceCallbacks {
    std::function<void()> on_send_queue_available, on_playback_drained;
    std::function<void(uint32_t,uint32_t)> on_playback_failed;
};
struct Audio {
    AudioServiceCallbacks callbacks;
    void Stop() {}
    void SetCallbacks(AudioServiceCallbacks value) { callbacks = std::move(value); }
};
struct Protocol {
    std::function<void()> joined_callback;
    std::thread::id owner = std::this_thread::get_id();
    void disconnect() { assert(owner == std::this_thread::get_id()); joined_callback(); }
    void force_reconnect() { assert(owner == std::this_thread::get_id()); }
    ~Protocol() { disconnect(); }
};
struct Application {
    std::atomic<int> sdk_status_{-1};
    std::atomic<uint32_t> protocol_epoch_{0}, sdk_status_epoch_{0}, playback_epoch_{0};
    std::mutex mutex_;
    std::deque<std::function<void()>> main_tasks_;
    std::unique_ptr<Protocol> sentient_ws_;
    Audio audio_service_;
    int event_group_ = 0;
    void Schedule(std::function<void()> task) {
        std::lock_guard<std::mutex> lock(mutex_); main_tasks_.push_back(std::move(task));
    }
    void flush() {
        std::deque<std::function<void()>> tasks;
        { std::lock_guard<std::mutex> lock(mutex_); tasks.swap(main_tasks_); }
        for (auto& task : tasks) task();
    }
    void RetireConnectionAudio() {}
    void OnSdkStatusChange(SdkStatus) {}
    void OnPlaybackDrained() {}
    void OnPlaybackQueueFailure(uint32_t,uint32_t) {}
    bool IsAudioChannelOpened() const;
    void RetireProtocolStatus();
    void ResetProtocol();
    void ForceProtocolReconnect();
    void Reboot();
    void WireAudioServiceCallbacks();
''' + getter + r'''
    std::function<void(SdkStatus)> status_callback() {
        const auto protocol_epoch = ++protocol_epoch_;
        struct { std::function<void(SdkStatus)> on_status_change; } cfg;
''' + callback + r'''
        return cfg.on_status_change;
    }
};
''' + methods + r'''
int main() {
    Application app;
    app.WireAudioServiceCallbacks();
    std::atomic<bool> done{false};
    std::atomic<int> reads{0};
    std::thread reader([&] {
        while (!done) {
            (void)app.IsAudioChannelOpened(); (void)app.GetSdkStatus();
            app.audio_service_.callbacks.on_send_queue_available();
            ++reads;
        }
    });
    for (int i = 0; i < 200; ++i) {
        auto status = app.status_callback();
        app.sentient_ws_ = std::make_unique<Protocol>();
        // Teardown joins callback work that takes Application mutex: deadlocks
        // if retirement holds it across disconnect/destruction.
        app.sentient_ws_->joined_callback = [&] {
            std::thread callback([&] { status(SdkStatus::Ready); app.Schedule([] {}); });
            callback.join();
        };
        status(SdkStatus::Ready);
        assert(app.IsAudioChannelOpened());
        std::thread diagnostics([&] { app.ForceProtocolReconnect(); app.ResetProtocol(); });
        diagnostics.join();
        std::thread publisher([&] { for (int n = 0; n < 100; ++n) status(SdkStatus::Ready); });
        app.flush(); // Actual owner-scheduled reset races status publication/readers.
        publisher.join();
        assert(!app.sentient_ws_ && !app.IsAudioChannelOpened() && app.GetSdkStatus() == -1);
        app.flush(); // Deferred old statuses cannot republish readiness.
        assert(!app.IsAudioChannelOpened());
    }
    app.sentient_ws_ = std::make_unique<Protocol>();
    app.sentient_ws_->joined_callback = [] {};
    std::thread reboot_request([&] { app.Reboot(); });
    reboot_request.join();
    assert(reboots == 0 && app.sentient_ws_);
    app.flush();
    assert(reboots == 1 && !app.sentient_ws_);
    done = true; reader.join();
    assert(reads > 0 && notifications > 0);
}
'''
    (tmp_path / 'concurrent.cc').write_text(cpp)
    subprocess.run(['c++', '-std=c++17', '-pthread', '-Wall', '-Wextra', '-Werror',
                    str(tmp_path / 'concurrent.cc'), '-o', str(tmp_path / 'concurrent')], check=True)
    subprocess.run([str(tmp_path / 'concurrent')], check=True, timeout=15)
