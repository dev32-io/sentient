#ifndef _APPLICATION_H_
#define _APPLICATION_H_

#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>
#include <freertos/task.h>
#include <esp_timer.h>

#include <string>
#include <mutex>
#include <deque>
#include <memory>
#include <atomic>

#include "audio_service.h"
#include "device_state.h"
#include "device_state_machine.h"
#include "protocols/sentient_ws_protocol.h"

// Main event bits
#define MAIN_EVENT_SCHEDULE             (1 << 0)
#define MAIN_EVENT_SEND_AUDIO           (1 << 1)
#define MAIN_EVENT_ERROR                (1 << 4)
#define MAIN_EVENT_CLOCK_TICK           (1 << 6)
#define MAIN_EVENT_NETWORK_CONNECTED    (1 << 7)
#define MAIN_EVENT_NETWORK_DISCONNECTED (1 << 8)
#define MAIN_EVENT_TOGGLE_CHAT          (1 << 9)
#define MAIN_EVENT_START_LISTENING      (1 << 10)
#define MAIN_EVENT_STOP_LISTENING       (1 << 11)
#define MAIN_EVENT_STATE_CHANGED        (1 << 12)


enum AecMode {
    kAecOff,
    kAecOnDeviceSide,
    kAecOnServerSide,
};

#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
extern "C" bool cube_playback_drained(void);
#endif

class Application {
public:
    static Application& GetInstance() {
        static Application instance;
        return instance;
    }
    // Delete copy constructor and assignment operator
    Application(const Application&) = delete;
    Application& operator=(const Application&) = delete;

    /**
     * Initialize the application
     * This sets up display, audio, network callbacks, etc.
     * Network connection starts asynchronously.
     */
    void Initialize();

    /**
     * Run the main event loop
     * This function runs in the main task and never returns.
     */
    void Run();

    DeviceState GetDeviceState() const { return state_machine_.GetState(); }

    /**
     * True when the sentient WS protocol has completed auth and reached the
     * Ready state. Legacy name preserved for board callbacks that probe
     * gateway reachability.
     */
    bool IsAudioChannelOpened() const;

    bool IsVoiceDetected() const { return audio_service_.IsVoiceDetected(); }

    /**
     * Request state transition.
     * Returns true if transition was successful.
     */
    bool SetDeviceState(DeviceState state);

    /**
     * Schedule a callback to be executed in the main task
     */
    void Schedule(std::function<void()>&& callback);

    /**
     * Alert with status, message, emotion and optional sound
     */
    void Alert(const char* status, const char* message, const char* emotion = "", const std::string_view& sound = "");
    void DismissAlert();

    /**
     * Abort the current speaking cycle (barge-in / cancel TTS).
     * Interrupts gateway playback and flushes queued local audio.
     * Owner task only; cross-task callers must Schedule this operation.
     */
    void AbortSpeaking();

    /**
     * Toggle chat state (event-based, thread-safe)
     */
    void ToggleChatState();

    /**
     * Start listening (event-based, thread-safe)
     */
    void StartListening();

    /**
     * Stop listening (event-based, thread-safe)
     */
    void StopListening();

    void Reboot();
    bool CanEnterSleepMode();
    void SetAecMode(AecMode mode);
    AecMode GetAecMode() const { return aec_mode_; }
    void PlaySound(const std::string_view& sound);
    AudioService& GetAudioService() { return audio_service_; }

    /**
     * Reset the sentient WS protocol (thread-safe).
     * Used when leaving normal operation (e.g., entering WiFi config mode).
     */
    void ResetProtocol();

    // Cross-task readers never borrow the owner-task protocol. -1 means uninitialized.
    int GetSdkStatus() const { return sdk_status_.load(); }
    void ForceProtocolReconnect();

private:
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
    friend bool cube_playback_drained(void);
#endif
    Application();
    ~Application();

    std::mutex mutex_;
    std::deque<std::function<void()>> main_tasks_;
    // Main task owns all protocol access and destruction; callbacks publish snapshots/events.
    std::unique_ptr<sentient::cube::SentientWsProtocol> sentient_ws_;
    EventGroupHandle_t event_group_ = nullptr;
    esp_timer_handle_t clock_timer_handle_ = nullptr;
    DeviceStateMachine state_machine_;
    AecMode aec_mode_ = kAecOff;
    AudioService audio_service_;

    int clock_ticks_ = 0;
    bool playback_active_ = false;  // server audio ingress bracket
    bool playback_waiting_for_drain_ = false;
    std::atomic<uint32_t> playback_epoch_{0};
    std::atomic<uint32_t> suppressed_playback_epoch_{0};
    bool processing_ = false;
    std::atomic<bool> listening_button_held_{false};

    // Event handlers
    void HandleStateChangedEvent();
    void HandleToggleChatEvent();
    void HandleStartListeningEvent();
    void HandleStopListeningEvent();
    void HandleNetworkConnectedEvent();
    void HandleNetworkDisconnectedEvent();
    void BeginUplink();
    void EndUplink();

    // Helper methods
    void InitializeSentientWs();
    void RefreshCubeConnection();
    void RetireProtocolStatus();
    std::atomic<int> sdk_status_{-1};
    uint32_t cube_token_revision_ = 0;
    std::atomic<uint32_t> protocol_epoch_{0};
    std::atomic<uint32_t> sdk_status_epoch_{0};
    bool cube_auth_refresh_attempted_ = false;
    void WireAudioServiceCallbacks();
    void WireNetworkEventCallback();
    void WireSentientWsCallbacks(sentient::cube::SentientWsProtocolConfig& cfg);
    void RetireConnectionAudio();
    void OnSdkStatusChange(sentient::cube::SdkStatus status);
    void OnSdkCognitionStatus(sentient::cube::CognitionState state);
    void OnSdkPlaybackBegin(int sample_rate);
    void OnSdkPlaybackEnd(bool aborted);
    void OnPlaybackDrained();
    void OnSdkPlaybackFrame(const uint8_t* data, size_t len, int sample_rate, bool pcm = false);
    void OnPlaybackQueueFailure(uint32_t epoch, uint32_t generation);
    bool OnSdkPopUplinkFrame(std::vector<uint8_t>& payload);
};


class TaskPriorityReset {
public:
    TaskPriorityReset(BaseType_t priority) {
        original_priority_ = uxTaskPriorityGet(NULL);
        vTaskPrioritySet(NULL, priority);
    }
    ~TaskPriorityReset() {
        vTaskPrioritySet(NULL, original_priority_);
    }

private:
    BaseType_t original_priority_;
};

#endif // _APPLICATION_H_
