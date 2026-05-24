#include "device_state_machine.h"

#include <algorithm>
#include <cstdio>
#include <esp_log.h>

#include "system_info.h"

static const char* TAG = "sentient.cube.state_machine";

// State name strings for logging. Indexed by DeviceState enum. Legacy values
// (Unknown/Starting/WifiConfiguring/Upgrading/Activating/AudioTesting) remain
// in the enum for source-level compatibility with board/led/display code that
// still has dead `case kDeviceState*` branches; they are unreachable via the
// state machine after the Phase 6a cube-sdk pivot.
static const char* const STATE_STRINGS[] = {
    "unknown",
    "starting",          // legacy, unreachable
    "wifi_configuring",  // legacy, unreachable
    "idle",
    "connecting",
    "listening",
    "speaking",
    "upgrading",         // legacy, unreachable
    "activating",        // legacy, unreachable
    "audio_testing",     // legacy, unreachable
    "fatal_error",
    "invalid_state"
};

DeviceStateMachine::DeviceStateMachine() {
}

const char* DeviceStateMachine::GetStateName(DeviceState state) {
    if (state >= 0 && state <= kDeviceStateFatalError) {
        return STATE_STRINGS[state];
    }
    return STATE_STRINGS[kDeviceStateFatalError + 1];
}

bool DeviceStateMachine::IsValidTransition(DeviceState from, DeviceState to) const {
    // Allow transition to the same state (no-op).
    if (from == to) {
        return true;
    }

    // FatalError is terminal.
    if (from == kDeviceStateFatalError) {
        return false;
    }

    // Any state may transition to FatalError.
    if (to == kDeviceStateFatalError) {
        return true;
    }

    // Bootstrap edge: initial Unknown state may enter the active graph via
    // Connecting (SDK first emits SdkStatus::Connecting on connect()).
    if (from == kDeviceStateUnknown) {
        return to == kDeviceStateConnecting || to == kDeviceStateIdle;
    }

    // Phase 6a active graph: Idle / Connecting / Listening / Speaking only.
    switch (from) {
        case kDeviceStateIdle:
            // SDK reconnect drops us back to Connecting; user start_streaming
            // transitions to Listening; server starts TTS directly → Speaking.
            return to == kDeviceStateConnecting ||
                   to == kDeviceStateListening ||
                   to == kDeviceStateSpeaking;

        case kDeviceStateConnecting:
            // Successful auth + session.ready → Idle. Failure → FatalError
            // (handled above).
            return to == kDeviceStateIdle;

        case kDeviceStateListening:
            // Toggle release / server moves to Acting → Speaking or Idle.
            return to == kDeviceStateSpeaking ||
                   to == kDeviceStateIdle ||
                   to == kDeviceStateConnecting;

        case kDeviceStateSpeaking:
            // Playback end → Idle. Barge-in → Listening. Drop → Connecting.
            return to == kDeviceStateIdle ||
                   to == kDeviceStateListening ||
                   to == kDeviceStateConnecting;

        default:
            // Legacy states are unreachable in the new state machine. Reject
            // any inbound transition from them.
            return false;
    }
}

bool DeviceStateMachine::CanTransitionTo(DeviceState target) const {
    return IsValidTransition(current_state_.load(), target);
}

bool DeviceStateMachine::TransitionTo(DeviceState new_state) {
    DeviceState old_state = current_state_.load();

    // No-op if already in the target state.
    if (old_state == new_state) {
        return true;
    }

    // Validate transition.
    if (!IsValidTransition(old_state, new_state)) {
        ESP_LOGW(TAG, "Invalid state transition: %s -> %s",
                 GetStateName(old_state), GetStateName(new_state));
        return false;
    }

    // Perform transition.
    current_state_.store(new_state);
    ESP_LOGI(TAG, "State: %s -> %s",
             GetStateName(old_state), GetStateName(new_state));

    // SRAM audit tap: log heap before listener fan-out so we see the cost of
    // listener side effects (audio EnableInput, WiFi PS toggle, etc.) by
    // diffing this against the next post-transition or post-listener tap.
    char tag[48];
    std::snprintf(tag, sizeof(tag), "state.pre:%s->%s",
                  GetStateName(old_state), GetStateName(new_state));
    SystemInfo::LogHeap(tag);

    // Notify callback.
    NotifyStateChange(old_state, new_state);

    std::snprintf(tag, sizeof(tag), "state.post:%s->%s",
                  GetStateName(old_state), GetStateName(new_state));
    SystemInfo::LogHeap(tag);
    return true;
}

int DeviceStateMachine::AddStateChangeListener(StateCallback callback) {
    std::lock_guard<std::mutex> lock(mutex_);
    int id = next_listener_id_++;
    listeners_.emplace_back(id, std::move(callback));
    return id;
}

void DeviceStateMachine::RemoveStateChangeListener(int listener_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    listeners_.erase(
        std::remove_if(listeners_.begin(), listeners_.end(),
            [listener_id](const auto& p) { return p.first == listener_id; }),
        listeners_.end());
}

void DeviceStateMachine::NotifyStateChange(DeviceState old_state, DeviceState new_state) {
    std::vector<StateCallback> callbacks_copy;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        callbacks_copy.reserve(listeners_.size());
        for (const auto& [id, cb] : listeners_) {
            callbacks_copy.push_back(cb);
        }
    }

    for (const auto& cb : callbacks_copy) {
        cb(old_state, new_state);
    }
}
