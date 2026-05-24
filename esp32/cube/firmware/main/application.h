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
     * Routed through the sentient WS protocol's stop_streaming + local
     * decoder reset.
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

    /**
     * Non-owning accessor for the sentient WS protocol. Returns nullptr
     * before WiFi-up (protocol is constructed on first network-connected
     * event). Callers MUST treat the pointer as transient — `ResetProtocol`
     * may null it out at any time. Used by HIL provider callbacks in
     * `boards/sentient-cube/sentient_cube.cc` to expose status / reconnect /
     * last_transcript to devtool verbs without pulling main into the
     * devtool component's REQUIRES.
     */
    sentient::cube::SentientWsProtocol* sentient_ws() { return sentient_ws_.get(); }

private:
    Application();
    ~Application();

    std::mutex mutex_;
    std::deque<std::function<void()>> main_tasks_;
    std::unique_ptr<sentient::cube::SentientWsProtocol> sentient_ws_;
    EventGroupHandle_t event_group_ = nullptr;
    esp_timer_handle_t clock_timer_handle_ = nullptr;
    DeviceStateMachine state_machine_;
    AecMode aec_mode_ = kAecOff;
    AudioService audio_service_;

    int clock_ticks_ = 0;
    bool playback_active_ = false;  // true between on_playback_begin and on_playback_end

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
    void WireAudioServiceCallbacks();
    void WireNetworkEventCallback();
    void WireSentientWsCallbacks(sentient::cube::SentientWsProtocolConfig& cfg);
    void OnSdkStatusChange(sentient::cube::SdkStatus status);
    void OnSdkCognitionStatus(sentient::cube::CognitionState state);
    void OnSdkPlaybackBegin(int sample_rate);
    void OnSdkPlaybackEnd(bool aborted);
    void OnSdkPlaybackFrame(const uint8_t* data, size_t len, int sample_rate);
    bool OnSdkPopUplinkFrame(uint8_t** out_data, size_t* out_len);
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
