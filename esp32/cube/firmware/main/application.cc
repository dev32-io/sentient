#include "application.h"
#include "board.h"
#include "display.h"
#include "system_info.h"
#include "audio_codec.h"
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE
#include "assets.h"
#endif
#include "assets/lang_config.h"
#include "settings.h"
#include "sentient_creds.h"
#include "boards/sentient-cube/sentient_ui_controller.h"

#include "esp32_devtool/companion.h"

#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <esp_log.h>
#include <font_awesome.h>

#define TAG "sentient.cube.application"

using sentient::cube::CognitionState;
using sentient::cube::SdkStatus;
using sentient::cube::SentientWsProtocol;
using sentient::cube::SentientWsProtocolConfig;

namespace {

// One-second status-bar tick period in microseconds.
constexpr uint64_t kStatusBarTickPeriodUs = 1000000ULL;
// Print heap stats every N clock ticks.
constexpr int kHeapStatsTickInterval = 10;
// Settle delay before WiFi RF turn-on. See comment block at call site.
constexpr int kPreNetworkSettleMs = 800;
// Server downlink frame duration. The sentient gateway emits 20 ms opus frames
// (Phase 6a pivot — locked in Task 1).
constexpr int kServerFrameDurationMs = 20;

// Build the sentient gateway WS URI from the baked creds. TLS is required.
std::string build_gateway_uri() {
    char uri[160];
    std::snprintf(uri, sizeof(uri), "wss://%s:%d%s",
                  SENTIENT_GATEWAY_HOST,
                  SENTIENT_GATEWAY_WS_PORT,
                  SENTIENT_GATEWAY_WS_PATH);
    return std::string(uri);
}

}  // namespace


Application::Application() {
    event_group_ = xEventGroupCreate();

#if CONFIG_USE_DEVICE_AEC && CONFIG_USE_SERVER_AEC
#error "CONFIG_USE_DEVICE_AEC and CONFIG_USE_SERVER_AEC cannot be enabled at the same time"
#elif CONFIG_USE_DEVICE_AEC
    aec_mode_ = kAecOnDeviceSide;
#elif CONFIG_USE_SERVER_AEC
    aec_mode_ = kAecOnServerSide;
#else
    aec_mode_ = kAecOff;
#endif

    esp_timer_create_args_t clock_timer_args = {
        .callback = [](void* arg) {
            Application* app = (Application*)arg;
            xEventGroupSetBits(app->event_group_, MAIN_EVENT_CLOCK_TICK);
        },
        .arg = this,
        .dispatch_method = ESP_TIMER_TASK,
        .name = "clock_timer",
        .skip_unhandled_events = true
    };
    esp_timer_create(&clock_timer_args, &clock_timer_handle_);
}

Application::~Application() {
    if (clock_timer_handle_ != nullptr) {
        esp_timer_stop(clock_timer_handle_);
        esp_timer_delete(clock_timer_handle_);
    }
    vEventGroupDelete(event_group_);
}

bool Application::SetDeviceState(DeviceState state) {
    return state_machine_.TransitionTo(state);
}

bool Application::IsAudioChannelOpened() const {
    return sentient_ws_ != nullptr && sentient_ws_->status() == SdkStatus::Ready;
}

void Application::Initialize() {
    ESP_LOGI(TAG, "init.begin");
    auto& board = Board::GetInstance();

    auto display = board.GetDisplay();
    display->SetupUI();
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE
    // Only load the text font. Assets::Apply also installs SR models.
    if (!Assets::GetInstance().ApplyTextFont()) {
        ESP_LOGW(TAG, "CJK transcript font unavailable; using built-in font");
    }
#endif
    display->SetChatMessage("system", SystemInfo::GetUserAgent().c_str());

    auto codec = board.GetAudioCodec();
    audio_service_.Initialize(codec);
    audio_service_.Start();
    WireAudioServiceCallbacks();

    state_machine_.AddStateChangeListener([this](DeviceState, DeviceState) {
        xEventGroupSetBits(event_group_, MAIN_EVENT_STATE_CHANGED);
    });

    esp_timer_start_periodic(clock_timer_handle_, kStatusBarTickPeriodUs);
    WireNetworkEventCallback();

    // Settle delay before WiFi RF turn-on. AXP2101 voltage rails are still
    // stabilizing after cold boot; turning on WiFi RF too early causes a
    // current spike on the shared 3.3V/I2C rails that corrupts transient
    // I2C reads (touch chip especially).
    ESP_LOGI(TAG, "init.pre_network_settle_delay ms=%d", kPreNetworkSettleMs);
    vTaskDelay(pdMS_TO_TICKS(kPreNetworkSettleMs));

    board.StartNetwork();
    display->UpdateStatusBar(true);
    ESP_LOGI(TAG, "init.done");
}

void Application::WireNetworkEventCallback() {
    Board::GetInstance().SetNetworkEventCallback(
        [this](NetworkEvent event, const std::string& data) {
            auto display = Board::GetInstance().GetDisplay();
            switch (event) {
                case NetworkEvent::Scanning:
                    display->ShowNotification(Lang::Strings::SCANNING_WIFI, 30000);
                    xEventGroupSetBits(event_group_, MAIN_EVENT_NETWORK_DISCONNECTED);
                    break;
                case NetworkEvent::Connecting:
                    if (!data.empty()) {
                        std::string msg = Lang::Strings::CONNECT_TO;
                        msg += data;
                        msg += "...";
                        display->ShowNotification(msg.c_str(), 30000);
                    }
                    break;
                case NetworkEvent::Connected: {
                    std::string msg = Lang::Strings::CONNECTED_TO;
                    msg += data;
                    display->ShowNotification(msg.c_str(), 30000);
                    xEventGroupSetBits(event_group_, MAIN_EVENT_NETWORK_CONNECTED);
                    break;
                }
                case NetworkEvent::Disconnected:
                    xEventGroupSetBits(event_group_, MAIN_EVENT_NETWORK_DISCONNECTED);
                    break;
                default:
                    // WifiConfig* and Modem* events are legacy paths; the
                    // sentient cube boots straight into station mode.
                    break;
            }
        });
}

void Application::WireAudioServiceCallbacks() {
    AudioServiceCallbacks callbacks;
    callbacks.on_send_queue_available = [this]() {
        // Notify the main loop to drain the send queue.
        xEventGroupSetBits(event_group_, MAIN_EVENT_SEND_AUDIO);
        // Also poke the SDK directly — its pump_uplink can pull frames from
        // any task context (esp_websocket_client serializes the send).
        if (sentient_ws_) {
            sentient_ws_->notify_uplink_available();
        }
    };
    callbacks.on_playback_drained = [this]() {
        Schedule([this]() { OnPlaybackDrained(); });
    };
    audio_service_.SetCallbacks(callbacks);
}

void Application::Run() {
    // Set the priority of the main task to 10
    vTaskPrioritySet(nullptr, 10);

    const EventBits_t ALL_EVENTS =
        MAIN_EVENT_SCHEDULE |
        MAIN_EVENT_SEND_AUDIO |
        MAIN_EVENT_CLOCK_TICK |
        MAIN_EVENT_ERROR |
        MAIN_EVENT_NETWORK_CONNECTED |
        MAIN_EVENT_NETWORK_DISCONNECTED |
        MAIN_EVENT_TOGGLE_CHAT |
        MAIN_EVENT_START_LISTENING |
        MAIN_EVENT_STOP_LISTENING |
        MAIN_EVENT_STATE_CHANGED;

    while (true) {
        auto bits = xEventGroupWaitBits(event_group_, ALL_EVENTS, pdTRUE, pdFALSE, portMAX_DELAY);

        if (bits & MAIN_EVENT_ERROR) {
            SetDeviceState(kDeviceStateIdle);
            Alert(Lang::Strings::ERROR, "Sentient WS error",
                  "circle_xmark", Lang::Sounds::OGG_EXCLAMATION);
        }

        if (bits & MAIN_EVENT_NETWORK_CONNECTED) {
            HandleNetworkConnectedEvent();
        }

        if (bits & MAIN_EVENT_NETWORK_DISCONNECTED) {
            HandleNetworkDisconnectedEvent();
        }

        if (bits & MAIN_EVENT_STATE_CHANGED) {
            HandleStateChangedEvent();
        }

        if (bits & MAIN_EVENT_TOGGLE_CHAT) {
            HandleToggleChatEvent();
        }

        // Event bits coalesce edges; release previous capture, then honor
        // latest physical state (including release followed by another press).
        if (bits & MAIN_EVENT_STOP_LISTENING) {
            HandleStopListeningEvent();
        }
        if ((bits & (MAIN_EVENT_START_LISTENING | MAIN_EVENT_STOP_LISTENING)) &&
            listening_button_held_.load()) {
            HandleStartListeningEvent();
        }

        if (bits & MAIN_EVENT_SEND_AUDIO) {
            // Uplink draining is owned by the SDK via on_pop_uplink_frame.
            // We poke it here in case the SDK's notify_uplink_available was
            // missed for any reason.
            if (sentient_ws_) {
                sentient_ws_->notify_uplink_available();
            }
        }

        if (bits & MAIN_EVENT_SCHEDULE) {
            std::unique_lock<std::mutex> lock(mutex_);
            auto tasks = std::move(main_tasks_);
            lock.unlock();
            for (auto& task : tasks) {
                task();
            }
        }

        if (bits & MAIN_EVENT_CLOCK_TICK) {
            clock_ticks_++;
            auto display = Board::GetInstance().GetDisplay();
            display->UpdateStatusBar();

            if (clock_ticks_ % kHeapStatsTickInterval == 0) {
                SystemInfo::PrintHeapStats();
            }
        }
    }
}

void Application::HandleNetworkConnectedEvent() {
    ESP_LOGI(TAG, "net.connected: bringing up sentient WS");

    SystemInfo::LogHeap("net.connected.start");

    // Late-bind devtool companion's network-dependent surface (HTTP /info,
    // /screenshot, /touch, /audio/*, UDP log relay). Idempotent. Runs here
    // — in the main_task with priority 10 + ample stack — rather than in the
    // IP_EVENT callback context, where the small sys_evt task stack (~4 KB)
    // is shared with every other event consumer in the firmware.
    esp32_devtool_companion_post_network_ready();
    SystemInfo::LogHeap("net.connected.companion_up");

    if (!sentient_ws_) {
        InitializeSentientWs();
    } else if (sentient_ws_->status() == SdkStatus::Disconnected ||
               sentient_ws_->status() == SdkStatus::Error) {
        sentient_ws_->force_reconnect();
    }
    SystemInfo::LogHeap("net.connected.ws_init");

    auto display = Board::GetInstance().GetDisplay();
    display->UpdateStatusBar(true);
}

void Application::HandleNetworkDisconnectedEvent() {
    // Sentient SDK owns its own reconnect ladder. Just bring the UI back to
    // a neutral state; the SDK will report SdkStatus::Reconnecting and
    // eventually Ready again.
    audio_service_.EnableVoiceProcessing(false);
    audio_service_.ClearSendQueue();
    audio_service_.ResetDecoder();
    playback_active_ = false;
    playback_waiting_for_drain_ = false;
    processing_ = false;
    if (GetDeviceState() != kDeviceStateFatalError) {
        SetDeviceState(kDeviceStateConnecting);
    }

    auto display = Board::GetInstance().GetDisplay();
    display->UpdateStatusBar(true);
}

void Application::InitializeSentientWs() {
    if (sentient_ws_) {
        ESP_LOGW(TAG, "sentient_ws_init: already initialized");
        return;
    }

    auto display = Board::GetInstance().GetDisplay();
    display->SetStatus(Lang::Strings::CONNECTING);

    SentientWsProtocolConfig cfg;
    cfg.gateway_url = build_gateway_uri();
    cfg.token = SENTIENT_PASETO_TOKEN;
    cfg.device_id = SENTIENT_DEVICE_ID;
#if SENTIENT_DEV_TLS_PIN
    extern const char dev_cert_pem_start[] asm("_binary_sentient_dev_gateway_crt_start");
    cfg.cert_pem = dev_cert_pem_start;
#endif
    WireSentientWsCallbacks(cfg);

    ESP_LOGI(TAG, "sentient_ws_init: connecting uri=%s", cfg.gateway_url.c_str());
    sentient_ws_ = std::make_unique<SentientWsProtocol>(std::move(cfg));

    // Initial bootstrap edge: Unknown → Connecting before connect() so the
    // status callback's Connecting → Connecting is a no-op.
    SetDeviceState(kDeviceStateConnecting);

    esp_err_t err = sentient_ws_->connect();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "sentient_ws_init: connect failed err=%d", err);
        SetDeviceState(kDeviceStateFatalError);
    }
}

void Application::WireSentientWsCallbacks(SentientWsProtocolConfig& cfg) {
    cfg.on_status_change = [this](SdkStatus s) {
        Schedule([this, s]() { OnSdkStatusChange(s); });
    };
    cfg.on_cognition_status = [this](CognitionState s) {
        Schedule([this, s]() { OnSdkCognitionStatus(s); });
    };
    cfg.on_playback_begin = [this](int sample_rate) {
        auto epoch = ++playback_epoch_;
        Schedule([this, sample_rate, epoch]() {
            if (epoch == playback_epoch_ && epoch != suppressed_playback_epoch_) OnSdkPlaybackBegin(sample_rate);
        });
    };
    cfg.on_playback_end = [this](bool aborted) {
        auto epoch = playback_epoch_.load();
        Schedule([this, aborted, epoch]() {
            if (epoch == playback_epoch_ && epoch != suppressed_playback_epoch_) OnSdkPlaybackEnd(aborted);
        });
    };
    cfg.on_playback_frame = [this](const uint8_t* data, size_t len, int sample_rate) {
        OnSdkPlaybackFrame(data, len, sample_rate);
    };
    cfg.on_pop_uplink_frame = [this](std::vector<uint8_t>& payload) {
        return OnSdkPopUplinkFrame(payload);
    };
    cfg.on_transcript = [this](const std::string& text) {
        // Copy out of std::string before scheduling — the SDK doesn't retain
        // ownership across the callback boundary.
        std::string copy = text;
        Schedule([copy = std::move(copy)]() {
            sentient_cube_set_transcript(copy.c_str());
        });
    };
}

void Application::OnSdkStatusChange(SdkStatus s) {
    switch (s) {
        case SdkStatus::Disconnected:
        case SdkStatus::Connecting:
        case SdkStatus::Authenticating:
        case SdkStatus::Reconnecting:
        case SdkStatus::Error:
            audio_service_.EnableVoiceProcessing(false);
            audio_service_.ClearSendQueue();
            audio_service_.ResetDecoder();
            playback_active_ = false;
            playback_waiting_for_drain_ = false;
            processing_ = false;
            sentient_cube_set_status_hint(s == SdkStatus::Error ? "Not ready" : "Connecting");
            SetDeviceState(s == SdkStatus::Error ? kDeviceStateFatalError : kDeviceStateConnecting);
            break;
        case SdkStatus::Ready:
            if (GetDeviceState() == kDeviceStateConnecting) {
                SetDeviceState(kDeviceStateIdle);
            }
            sentient_cube_set_status_hint("Ready");
            DismissAlert();
            break;
    }
}

void Application::OnSdkCognitionStatus(CognitionState s) {
    processing_ = s == CognitionState::Thinking || s == CognitionState::Acting;
    if (GetDeviceState() == kDeviceStateIdle && !playback_active_ && !playback_waiting_for_drain_) {
        sentient_cube_set_status_hint(processing_ ? "Processing" : "Ready");
    }
}

void Application::OnSdkPlaybackBegin(int sample_rate) {
    ESP_LOGI(TAG, "playback.begin sample_rate=%d", sample_rate);
    if (!IsAudioChannelOpened()) {
        return;
    }
    playback_active_ = true;
    playback_waiting_for_drain_ = false;
    if (GetDeviceState() != kDeviceStateListening) {
        sentient_cube_set_status_hint("Speaking");
        SetDeviceState(kDeviceStateSpeaking);
    }
}

void Application::OnSdkPlaybackEnd(bool aborted) {
    ESP_LOGI(TAG, "playback.end aborted=%d", aborted ? 1 : 0);
    playback_active_ = false;
    if (aborted) {
        playback_waiting_for_drain_ = false;
        audio_service_.ResetDecoder();
        if (GetDeviceState() == kDeviceStateSpeaking) {
            SetDeviceState(kDeviceStateIdle);
            sentient_cube_set_status_hint(processing_ ? "Processing" : "Ready");
        }
    } else {
        playback_waiting_for_drain_ = true;
        OnPlaybackDrained();
    }
}

void Application::OnPlaybackDrained() {
    if (!playback_waiting_for_drain_ || !audio_service_.IsPlaybackDrained()) {
        return;
    }
    playback_waiting_for_drain_ = false;
    if (GetDeviceState() == kDeviceStateSpeaking) {
        SetDeviceState(kDeviceStateIdle);
        sentient_cube_set_status_hint(processing_ ? "Processing" : "Ready");
    }
}

void Application::OnSdkPlaybackFrame(const uint8_t* data, size_t len, int sample_rate) {
    auto epoch = playback_epoch_.load();
    if (!IsAudioChannelOpened() || data == nullptr || len == 0 ||
        epoch == suppressed_playback_epoch_) return;
    // Snapshot before copying the payload; reset while waiting invalidates it.
    auto generation = audio_service_.DecodeGeneration();
    // Abort can run between initial epoch check and generation snapshot.
    // After this check, a later reset invalidates generation at enqueue.
    if (epoch != playback_epoch_ || epoch == suppressed_playback_epoch_) return;
    auto packet = std::make_unique<AudioStreamPacket>();
    packet->sample_rate = sample_rate;
    packet->frame_duration = kServerFrameDurationMs;
    packet->payload.assign(data, data + len);
    auto result = audio_service_.PushPacketToDecodeQueue(std::move(packet), generation, true);
    if (result == DecodeQueueResult::Queued) return;
    // Reset cancelled this epoch intentionally. Drop remaining frames without
    // reporting a failure or interrupting any subsequent turn.
    suppressed_playback_epoch_ = epoch;
    if (result == DecodeQueueResult::Stale) return;
    // Mark before returning to SDK dispatch: subsequent frames must not
    // refill the queue while the main task handles this failure.
    ESP_LOGW(TAG, "playback.queue_failed: reason=%d", static_cast<int>(result));
    Schedule([this, epoch, generation]() { OnPlaybackQueueFailure(epoch, generation); });
}

void Application::OnPlaybackQueueFailure(uint32_t epoch, uint32_t generation) {
    if (epoch != playback_epoch_ || epoch != suppressed_playback_epoch_ ||
        generation != audio_service_.DecodeGeneration()) return;
    // Abort local playback, not wire turn: interrupt could cancel a newer turn.
    audio_service_.ResetDecoder();
    playback_active_ = false;
    playback_waiting_for_drain_ = false;
    processing_ = false;
    if (GetDeviceState() == kDeviceStateSpeaking) SetDeviceState(kDeviceStateIdle);
    sentient_cube_set_status_hint("Audio incomplete - retry");
    Board::GetInstance().GetDisplay()->ShowNotification("Audio playback incomplete - retry", 5000);
}

bool Application::OnSdkPopUplinkFrame(std::vector<uint8_t>& payload) {
    if (!IsAudioChannelOpened() || GetDeviceState() != kDeviceStateListening) {
        return false;
    }
    auto packet = audio_service_.PopPacketFromSendQueue();
    if (!packet) return false;
    payload = std::move(packet->payload);
    return true;
}

void Application::Alert(const char* status, const char* message, const char* emotion, const std::string_view& sound) {
    ESP_LOGW(TAG, "Alert displayed");
    auto display = Board::GetInstance().GetDisplay();
    display->SetStatus(status);
    display->SetEmotion(emotion);
    display->SetChatMessage("system", message);
    if (!sound.empty()) {
        audio_service_.PlaySound(sound);
    }
}

void Application::DismissAlert() {
    if (GetDeviceState() == kDeviceStateIdle) {
        auto display = Board::GetInstance().GetDisplay();
        display->SetStatus(Lang::Strings::STANDBY);
        display->SetEmotion("neutral");
        display->SetChatMessage("system", "");
    }
}

void Application::ToggleChatState() {
    xEventGroupSetBits(event_group_, MAIN_EVENT_TOGGLE_CHAT);
}

void Application::StartListening() {
    listening_button_held_.store(true);
    xEventGroupSetBits(event_group_, MAIN_EVENT_START_LISTENING);
}

void Application::StopListening() {
    listening_button_held_.store(false);
    xEventGroupSetBits(event_group_, MAIN_EVENT_STOP_LISTENING);
}

void Application::HandleToggleChatEvent() {
    if (!sentient_ws_) {
        ESP_LOGW(TAG, "toggle: sentient_ws_ not initialized — net not up yet");
        return;
    }

    auto state = GetDeviceState();
    if (state == kDeviceStateIdle) {
        BeginUplink();
    } else if (state == kDeviceStateListening) {
        EndUplink();
    } else if (state == kDeviceStateSpeaking) {
        AbortSpeaking();
    }
}

void Application::HandleStartListeningEvent() {
    if (!sentient_ws_) {
        ESP_LOGW(TAG, "start_listening: sentient_ws_ not initialized");
        return;
    }
    auto state = GetDeviceState();
    if (state == kDeviceStateIdle || state == kDeviceStateSpeaking) {
        BeginUplink();
    }
}

void Application::HandleStopListeningEvent() {
    if (sentient_ws_ && GetDeviceState() == kDeviceStateListening) {
        EndUplink();
    }
}

void Application::BeginUplink() {
    if (!IsAudioChannelOpened()) {
        return;
    }
    if (GetDeviceState() == kDeviceStateSpeaking || processing_) {
        AbortSpeaking();
    }
    audio_service_.ClearSendQueue();
    if (!sentient_ws_->start_streaming()) {
        return;
    }
    processing_ = false;
    if (!audio_service_.EnableVoiceProcessing(true)) {
        ESP_LOGW(TAG, "uplink.processor_start_failed: cancelling capture");
        sentient_ws_->cancel_streaming();
        audio_service_.ClearSendQueue();
        SetDeviceState(kDeviceStateIdle);
        sentient_cube_set_status_hint("Hold to retry");
        Board::GetInstance().GetDisplay()->ShowNotification("Audio unavailable - hold to retry", 5000);
        return;
    }
    sentient_cube_set_status_hint("Recording");
    SetDeviceState(kDeviceStateListening);
}

void Application::EndUplink() {
    audio_service_.EnableVoiceProcessing(false);
    if (!audio_service_.WaitForSendEncoding()) {
        ESP_LOGW(TAG, "uplink.tail_incomplete: cancelling capture");
        sentient_ws_->cancel_streaming();
        audio_service_.ClearSendQueue();
        processing_ = false;
        SetDeviceState(kDeviceStateIdle);
        sentient_cube_set_status_hint("Hold to retry");
        Board::GetInstance().GetDisplay()->ShowNotification("Audio incomplete - hold to retry", 5000);
        return;
    }
    sentient_ws_->stop_streaming();
    if (playback_active_ || playback_waiting_for_drain_) {
        sentient_cube_set_status_hint("Speaking");
        SetDeviceState(kDeviceStateSpeaking);
    } else {
        sentient_cube_set_status_hint(processing_ ? "Processing" : "Ready");
        SetDeviceState(kDeviceStateIdle);
    }
}

void Application::HandleStateChangedEvent() {
    DeviceState new_state = state_machine_.GetState();
    clock_ticks_ = 0;

    auto& board = Board::GetInstance();
    auto display = board.GetDisplay();
    auto led = board.GetLed();
    led->OnStateChanged();

    switch (new_state) {
        case kDeviceStateIdle:
            display->SetStatus(Lang::Strings::STANDBY);
            display->ClearChatMessages();
            display->SetEmotion("neutral");
            audio_service_.EnableVoiceProcessing(false);
            board.SetPowerSaveLevel(PowerSaveLevel::LOW_POWER);
            break;
        case kDeviceStateConnecting:
            display->SetStatus(Lang::Strings::CONNECTING);
            display->SetEmotion("neutral");
            display->SetChatMessage("system", "");
            break;
        case kDeviceStateListening:
            display->SetStatus(Lang::Strings::LISTENING);
            display->SetEmotion("neutral");
            board.SetPowerSaveLevel(PowerSaveLevel::PERFORMANCE);
            break;
        case kDeviceStateSpeaking:
            display->SetStatus(Lang::Strings::SPEAKING);
            audio_service_.EnableVoiceProcessing(false);
            board.SetPowerSaveLevel(PowerSaveLevel::PERFORMANCE);
            break;
        default:
            break;
    }
}

void Application::Schedule(std::function<void()>&& callback) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        main_tasks_.push_back(std::move(callback));
    }
    xEventGroupSetBits(event_group_, MAIN_EVENT_SCHEDULE);
}

void Application::AbortSpeaking() {
    ESP_LOGI(TAG, "AbortSpeaking");
    // Reject old downlink before decoder reset; playback.stop can arrive later.
    suppressed_playback_epoch_ = playback_epoch_.load();
    // Wake blocked downlink enqueue before control send waits for transport lock.
    // Reset also waits up to 5s for software-owned output handoff.
    audio_service_.ResetDecoder();
    if (sentient_ws_) {
        sentient_ws_->interrupt();
    }
    playback_active_ = false;
    playback_waiting_for_drain_ = false;
    if (GetDeviceState() == kDeviceStateSpeaking) {
        SetDeviceState(kDeviceStateIdle);
    }
}

void Application::Reboot() {
    ESP_LOGI(TAG, "Rebooting...");
    if (sentient_ws_) {
        sentient_ws_->disconnect();
        sentient_ws_.reset();
    }
    audio_service_.Stop();

    vTaskDelay(pdMS_TO_TICKS(1000));
    esp_restart();
}

bool Application::CanEnterSleepMode() {
    return GetDeviceState() == kDeviceStateIdle && audio_service_.IsIdle();
}

void Application::SetAecMode(AecMode mode) {
    aec_mode_ = mode;
    Schedule([this]() {
        auto display = Board::GetInstance().GetDisplay();
        audio_service_.EnableDeviceAec(aec_mode_ == kAecOnDeviceSide);
        display->ShowNotification(aec_mode_ == kAecOff
                                      ? Lang::Strings::RTC_MODE_OFF
                                      : Lang::Strings::RTC_MODE_ON);
    });
}

void Application::PlaySound(const std::string_view& sound) {
    audio_service_.PlaySound(sound);
}

void Application::ResetProtocol() {
    Schedule([this]() {
        if (sentient_ws_) {
            sentient_ws_->disconnect();
            sentient_ws_.reset();
        }
    });
}
