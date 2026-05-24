// SPDX-License-Identifier: MIT
// sentient_ui_controller.cc
//
// State-machine + setter implementation. Real LVGL widget creation lives in
// toggle_button_screen.cc (Task 3.2). This translation unit holds the
// state-update fanout and bridges the C-API to LVGL via forward declarations.
//
// Device-state polling: Application::state_machine_ is private so
// AddStateChangeListener is not directly callable from board code. We use
// Path B — a 4 Hz FreeRTOS polling task — and leave a TODO for a future
// upstream patch that exposes a public observer hook.
//
// HIL checkpoints (Task 4.6): the same poll loop emits stdout markers
// `>>> CHECKPOINT <label> <ts_us>` on each device-state transition the HIL
// test matrix asserts on (listen.start, listen.stop, ws.connected,
// ws.disconnected). WiFi-level markers (wifi.connected, wifi.disconnected)
// are wired via esp_event handlers, registered lazily from this same task
// because the default event loop is created by xiaozhi's WifiManager AFTER
// SentientCubeBoard ctor returns.

#include "sentient_ui_controller.h"
#include "sentient_creds.h"  // SENTIENT_DEVICE_ID, baked at build time

// VERIFY UPSTREAM: confirm application.h is on the include path as "application.h"
// (it lives in upstream/main/ which is listed in INCLUDE_DIRS).
#include "application.h"
#include "device_state.h"  // VERIFY UPSTREAM: DeviceState enum + kDeviceState* values
#include "esp32_devtool/companion.h" // esp32_devtool_companion_checkpoint — HIL marker emitter
#include "test_screen.h"   // sentient_test_screen_build (Phase 2 shared UI)

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <esp_event.h>
#include <esp_wifi.h>
#include <esp_netif.h>
#include <esp_log.h>
#include <string.h>
#include <cstdio>     // std::printf / std::fflush for `>>> READY` boot marker

static const char* TAG = "sentient.cube.ui";
static const char* CHECKPOINT_TAG = "sentient.cube.checkpoints";

// Current locally-tracked UI state.
static sentient_ui_state_t g_state = SENTIENT_UI_DISABLED;

// Guards one-time poll task creation.
static bool g_poll_started = false;

// ---------------------------------------------------------------------------
// Forward declarations — implemented in toggle_button_screen.cc (Task 3.2).
// ---------------------------------------------------------------------------
extern "C" {
void toggle_button_screen_create(void);
void toggle_button_screen_apply_state(sentient_ui_state_t state);
void toggle_button_screen_set_status_hint(const char* text);
void toggle_button_screen_set_transcript(const char* text);
}

// ---------------------------------------------------------------------------
// Device-state → UI-state mapping
// VERIFY UPSTREAM: confirm kDeviceState* enum names match device_state.h.
// Current upstream enum (SHA b72945a):
//   kDeviceStateUnknown, kDeviceStateStarting, kDeviceStateWifiConfiguring,
//   kDeviceStateIdle, kDeviceStateConnecting, kDeviceStateListening,
//   kDeviceStateSpeaking, kDeviceStateUpgrading, kDeviceStateActivating,
//   kDeviceStateAudioTesting, kDeviceStateFatalError
// ---------------------------------------------------------------------------

struct UiMapping {
    sentient_ui_state_t ui_state;
    const char* hint;
};

static UiMapping map_device_state(DeviceState ds) {
    switch (ds) {
        case kDeviceStateIdle:
            return {SENTIENT_UI_READY, ""};
        case kDeviceStateListening:
            return {SENTIENT_UI_LISTENING, ""};
        case kDeviceStateSpeaking:
            return {SENTIENT_UI_DISABLED, ""};
        case kDeviceStateAudioTesting:
            return {SENTIENT_UI_DISABLED, "Audio test"};
        case kDeviceStateWifiConfiguring:
        case kDeviceStateConnecting:
        case kDeviceStateStarting:
        case kDeviceStateActivating:
        case kDeviceStateUpgrading:
            return {SENTIENT_UI_DISABLED, "Reaching home\xe2\x80\xa6"};  // UTF-8 ellipsis
        case kDeviceStateFatalError:
        case kDeviceStateUnknown:
        default:
            return {SENTIENT_UI_DISABLED, "Can't reach home"};
    }
}

// ---------------------------------------------------------------------------
// HIL checkpoint emission — drive `>>> CHECKPOINT <label> <ts_us>` markers
// from observed device-state transitions. Labels MUST match
// docs/superpowers/plans/2026-05-09-esp32-cube-v1.md Phase 4 verification gate
// exactly; misspelled labels silently break the test matrix.
//
// Heuristic mapping (xiaozhi has no public WS-channel observer; we infer):
//   listen.start       Idle → Listening
//   listen.stop        Listening → {Idle, Speaking}
//   ws.connected       Connecting → !Connecting   (audio channel opened)
//                      OR first Activating → Idle (boot — control plane up)
//   ws.disconnected    !Connecting → Connecting   (reconnect attempt)
//                      OR {Listening,Speaking} → Idle (audio channel closed)
//
// One-shot guard for boot-time ws.connected so it fires exactly once at the
// initial Activating→Idle handshake.
// ---------------------------------------------------------------------------

static bool g_ws_connected_emitted_once = false;

static void emit_state_transition_checkpoints(DeviceState last, DeviceState now) {
    // listen.start — xiaozhi routes button.toggle through
    // Idle → Connecting → Listening. Match the real arrival edge.
    if (now == kDeviceStateListening &&
        (last == kDeviceStateConnecting || last == kDeviceStateIdle)) {
        esp32_devtool_companion_checkpoint("listen.start");
    }
    // listen.stop — toggle off or end-of-utterance.
    else if (last == kDeviceStateListening &&
             (now == kDeviceStateIdle || now == kDeviceStateSpeaking)) {
        esp32_devtool_companion_checkpoint("listen.stop");
    }

    // ws.connected — first transition past Connecting/Activating into a
    // usable state. Emit once at boot; subsequent re-Connecting → Idle hops
    // (e.g. after wifi.disconnect/connect) re-emit ws.connected too.
    // First emission also fires `>>> READY` so HIL fixtures see a single
    // boot-complete marker once stdout is established + WS is alive.
    bool is_ws_connected_edge =
        (last == kDeviceStateConnecting && now == kDeviceStateIdle) ||
        (last == kDeviceStateActivating && now == kDeviceStateIdle);
    if (is_ws_connected_edge) {
        esp32_devtool_companion_checkpoint("ws.connected");
        if (!g_ws_connected_emitted_once) {
            std::printf(">>> READY\n");
            std::fflush(stdout);
            g_ws_connected_emitted_once = true;
        }
    }

    // ws.disconnected is emitted from wifi_event_handler (paired with
    // wifi.disconnected) — see Phase 4.6 details. State-machine heuristic
    // can't distinguish a normal Idle→Connecting→Listening listen-start hop
    // from a true disconnect, so we rely on WIFI_EVENT_STA_DISCONNECTED as
    // the authoritative signal.
}

// ---------------------------------------------------------------------------
// WiFi/IP esp_event handlers — emit wifi.connected / wifi.disconnected.
// Registered lazily from poll_state_task because the default event loop is
// created inside xiaozhi's WifiManager::Initialize(), which runs AFTER
// SentientCubeBoard ctor (Application::Initialize → board.StartNetwork →
// WifiManager.Initialize). Registration in the ctor would fail with
// ESP_ERR_INVALID_STATE.
// ---------------------------------------------------------------------------

static bool g_wifi_handlers_registered = false;

static void wifi_event_handler(void* /*arg*/, esp_event_base_t event_base,
                               int32_t event_id, void* /*event_data*/) {
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        // Pair: wifi.disconnected implies the audio WS will be torn down too.
        // Emit both so HIL tests can assert ws.disconnected without touching
        // xiaozhi protocol internals.
        esp32_devtool_companion_checkpoint("wifi.disconnected");
        esp32_devtool_companion_checkpoint("ws.disconnected");
    }
}

static void ip_event_handler(void* /*arg*/, esp_event_base_t event_base,
                             int32_t event_id, void* /*event_data*/) {
    if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        esp32_devtool_companion_checkpoint("wifi.connected");
    }
}

static void try_register_wifi_handlers() {
    if (g_wifi_handlers_registered) return;
    // Probe — esp_event_handler_register fails fast with ESP_ERR_INVALID_STATE
    // if the default loop hasn't been created yet. No side effects on failure.
    esp_err_t er = esp_event_handler_register(
        WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, wifi_event_handler, nullptr);
    if (er != ESP_OK) {
        ESP_LOGD(CHECKPOINT_TAG, "wifi_handler_register_pending err=%s",
                 esp_err_to_name(er));
        return;
    }
    er = esp_event_handler_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, ip_event_handler, nullptr);
    if (er != ESP_OK) {
        ESP_LOGW(CHECKPOINT_TAG, "ip_handler_register_failed err=%s",
                 esp_err_to_name(er));
        // Roll back the WIFI_EVENT registration so we don't double-register
        // on the next attempt.
        esp_event_handler_unregister(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED,
                                     wifi_event_handler);
        return;
    }
    g_wifi_handlers_registered = true;
    ESP_LOGI(CHECKPOINT_TAG, "wifi_handlers_registered device_id="
             SENTIENT_DEVICE_ID);
}

// ---------------------------------------------------------------------------
// Background polling task — 4 Hz.
// TODO: replace with a public observer hook when upstream exposes one, so we
// can react synchronously instead of polling.
// ---------------------------------------------------------------------------

static void poll_state_task(void* /*arg*/) {
    DeviceState last = kDeviceStateUnknown;

    for (;;) {
        // Lazily register WiFi/IP event handlers once the default event loop
        // exists (created by xiaozhi's WifiManager.Initialize after our ctor).
        try_register_wifi_handlers();

        // VERIFY UPSTREAM: Application::GetInstance().GetDeviceState() must be
        // thread-safe (it is: uses std::atomic<DeviceState>).
        DeviceState now = Application::GetInstance().GetDeviceState();

        if (now != last) {
            UiMapping m = map_device_state(now);
            ESP_LOGI(TAG, "device_state device_id=" SENTIENT_DEVICE_ID
                     " prev=%d next=%d ui=%d hint='%s'",
                     (int)last, (int)now, (int)m.ui_state, m.hint);

            emit_state_transition_checkpoints(last, now);

            sentient_cube_set_state(m.ui_state);
            // The Phase-6 status_hint is now driven directly by the cube-sdk
            // callbacks in application.cc (sdk:/cognition:/playback: prefixes)
            // so the operator can read live event flow. The device-state poll
            // keeps owning the button color/animation but does not overwrite
            // the hint here — otherwise the 250ms tick races the SDK events.
            last = now;
        }

        vTaskDelay(pdMS_TO_TICKS(250));
    }
}

// ---------------------------------------------------------------------------
// Public C API
// ---------------------------------------------------------------------------

extern "C" {

void sentient_cube_create_toggle_button_screen(void) {
    ESP_LOGI(TAG, "create_screen device_id=" SENTIENT_DEVICE_ID);
    toggle_button_screen_create();
    toggle_button_screen_apply_state(g_state);

    if (!g_poll_started) {
        g_poll_started = true;
        // Stack 6144 bytes: 3 KB was sized for the original simple poll loop
        // BEFORE Phase 6a added the 28 pt Montserrat transcript label +
        // multi-line wrap on toggle_button_screen. First-render glyph paths
        // through LVGL on a state transition push stack past 3 KB and trip
        // the FreeRTOS overflow guard ("sentient-ui-pol" overflow seen on
        // 2026-05-15 once the devtool companion added more concurrent boot
        // pressure). Priority 1 (just above idle) keeps UI updates
        // responsive without starving audio tasks.
        BaseType_t ret = xTaskCreate(
            poll_state_task,
            "sentient-ui-poll",
            6144,
            nullptr,
            tskIDLE_PRIORITY + 1,
            nullptr);
        if (ret != pdPASS) {
            ESP_LOGE(TAG, "poll_task_create_failed device_id=" SENTIENT_DEVICE_ID);
        } else {
            ESP_LOGI(TAG, "poll_task_started device_id=" SENTIENT_DEVICE_ID);
        }
    }
}

void sentient_cube_set_state(sentient_ui_state_t state) {
    if (state == g_state) {
        return;
    }
    ESP_LOGI(TAG, "set_state device_id=" SENTIENT_DEVICE_ID
             " prev=%d next=%d", (int)g_state, (int)state);
    g_state = state;
    toggle_button_screen_apply_state(state);
}

void sentient_cube_set_status_hint(const char* text) {
    ESP_LOGD(TAG, "set_status_hint device_id=" SENTIENT_DEVICE_ID
             " text='%.80s'", text ? text : "");
    toggle_button_screen_set_status_hint(text ? text : "");
}

void sentient_cube_set_transcript(const char* text) {
    ESP_LOGD(TAG, "set_transcript device_id=" SENTIENT_DEVICE_ID
             " text='%.80s'", text ? text : "");
    toggle_button_screen_set_transcript(text ? text : "");
}

void sentient_cube_show_test_screen(void) {
    ESP_LOGI(TAG, "show_test_screen device_id=" SENTIENT_DEVICE_ID);
    sentient_test_screen_build();
}

}  // extern "C"
