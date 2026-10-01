// SPDX-License-Identifier: MIT
// sentient_ui_controller.cc
//
// Project board, SDK and audio events into shared ViewHost. Platform adapters
// stay here/in toggle_button_screen.cc; rendering/player live in ui-shared.
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
#include "cube_hardware.h"

// VERIFY UPSTREAM: confirm application.h is on the include path as "application.h"
// (it lives in upstream/main/ which is listed in INCLUDE_DIRS).
#include "application.h"
#include "assets.h"
#include "device_state.h"  // VERIFY UPSTREAM: DeviceState enum + kDeviceState* values
#include "esp32_devtool/companion.h" // esp32_devtool_companion_checkpoint — HIL marker emitter
#include "test_screen.h"   // sentient_test_screen_build (Phase 2 shared UI)

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <esp_event.h>
#include <esp_wifi.h>
#include <esp_netif.h>
#include <esp_log.h>
#include <esp_lvgl_port.h>
#include <esp_timer.h>
#include <string.h>
#include <cstdio>     // std::printf / std::fflush for `>>> READY` boot marker

static_assert(sizeof(kCubeUiTaskName) <= configMAX_TASK_NAME_LEN,
              "UI task name must fit without FreeRTOS truncation");
static const char* TAG = "sentient.cube.ui";
static const char* CHECKPOINT_TAG = "sentient.cube.checkpoints";

// Small latest-state mailbox: producers never wait for LVGL (including audio
// callbacks). Poll retries projection after snapshot/render lock contention.
static portMUX_TYPE g_signal_mux = portMUX_INITIALIZER_UNLOCKED;
static CubeSignals g_signals;
static int g_volume_percent = 0;
static int g_battery_percent = 0; // Unknown until board reports; empty silhouette.
static int64_t g_volume_until_us = 0;
static bool g_poll_started = false;
static int g_boot_result = 0; // 0 pending, 1 ready, -1 failed. Retried by projector.
extern "C" void toggle_button_screen_finish_boot(bool ready);
extern "C" void toggle_button_screen_suspend(void);

bool sentient_cube_read_asset(void*, const char* name, const uint8_t*& data, size_t& size) {
    void* ptr = nullptr;
    if (!Assets::GetInstance().GetAssetData(name, ptr, size)) return false;
    data = static_cast<const uint8_t*>(ptr);
    return true;
}
extern "C" void toggle_button_screen_create(void);
extern "C" void toggle_button_screen_apply_scene(CubeScene scene);
extern "C" void toggle_button_screen_volume(int percent);
extern "C" void toggle_button_screen_battery(int percent, bool charging, bool low);
extern "C" void toggle_button_screen_pairing(const char* qr, const char* locator, const char* proof);

static void project_latest(const sentient::cube::CubePresentation& presentation = {}) {
    if (!lvgl_port_lock(50)) return;
    portENTER_CRITICAL(&g_signal_mux);
    if (g_signals.volume && esp_timer_get_time() >= g_volume_until_us)
        g_signals.volume = false;
    CubeSignals signals = g_signals;
    int volume = g_volume_percent;
    int battery = g_battery_percent;
    int boot_result = g_boot_result;
    portEXIT_CRITICAL(&g_signal_mux);
    if (boot_result) toggle_button_screen_finish_boot(boot_result > 0);
    toggle_button_screen_volume(volume);
    toggle_button_screen_battery(battery, signals.charging, signals.low_battery);
    toggle_button_screen_pairing(presentation.qr.c_str(), presentation.locator.c_str(), presentation.proof.c_str());
    toggle_button_screen_apply_scene(cube_scene(signals));
    lvgl_port_unlock();
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
        sentient_cube_set_wifi(false);
        esp32_devtool_companion_checkpoint("ws.disconnected");
    }
}

static void ip_event_handler(void* /*arg*/, esp_event_base_t event_base,
                             int32_t event_id, void* /*event_data*/) {
    if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        esp32_devtool_companion_checkpoint("wifi.connected");
        sentient_cube_set_wifi(true);
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
    ESP_LOGI(CHECKPOINT_TAG, "wifi_handlers_registered");
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
            ESP_LOGD(TAG, "device_state prev=%d next=%d", (int)last, (int)now);
            emit_state_transition_checkpoints(last, now);
            last = now;
        }
        // Event registration can follow first GOT_IP; association probe
        // recovers that missed edge and keeps offline distinct from WS failure.
        wifi_ap_record_t ap;
        bool wifi = sentient::cube::CubeHardware::Get().WifiConnected() &&
                    esp_wifi_sta_get_ap_info(&ap) == ESP_OK;
        bool connected = Application::GetInstance().IsAudioChannelOpened();
        bool capturing = now == kDeviceStateListening;
        auto hardware = sentient::cube::CubeHardware::Get().Presentation();
        bool setup = hardware.setup;
        portENTER_CRITICAL(&g_signal_mux);
        g_signals.wifi = wifi;
        g_signals.connected = connected;
        g_signals.capturing = capturing;
        g_signals.setup = setup;
        g_signals.pairing = hardware.pairing;
        g_signals.account_attention = hardware.account_attention;
        // SDK cognition/playback callbacks own those flags; idle is not
        // proof that processing or decoded playback has ended.
        portEXIT_CRITICAL(&g_signal_mux);
        project_latest(hardware);

        vTaskDelay(pdMS_TO_TICKS(250));
    }
}

// ---------------------------------------------------------------------------
// Public C API
// ---------------------------------------------------------------------------

extern "C" {

void sentient_cube_create_toggle_button_screen(void) {
    ESP_LOGI(TAG, "create_screen");
    // SetupUI already holds this recursive port mutex; do not look up Board
    // here (its display is still being constructed).
    if (!lvgl_port_lock(0)) return;
    toggle_button_screen_create();
    lvgl_port_unlock();
    project_latest();

    if (!g_poll_started) {
        g_poll_started = true;
        // Keep the measured 6144-byte poll stack and low priority so
        // LVGL updates do not starve audio tasks.
        BaseType_t ret = xTaskCreate(
            poll_state_task,
            kCubeUiTaskName,
            6144,
            nullptr,
            tskIDLE_PRIORITY + 1,
            nullptr);
        if (ret != pdPASS) {
            ESP_LOGE(TAG, "poll_task_create_failed");
        } else {
            ESP_LOGI(TAG, "poll_task_started");
        }
    }
}

void sentient_cube_finish_boot(bool assets_ready) {
    portENTER_CRITICAL(&g_signal_mux);
    if (!g_boot_result) g_boot_result = assets_ready ? 1 : -1;
    portEXIT_CRITICAL(&g_signal_mux);
    project_latest();
}

void sentient_cube_set_wifi(bool value) {
    portENTER_CRITICAL(&g_signal_mux);
    g_signals.wifi = value;
    portEXIT_CRITICAL(&g_signal_mux);
}

void sentient_cube_set_processing(bool value) {
    portENTER_CRITICAL(&g_signal_mux);
    g_signals.processing = value;
    portEXIT_CRITICAL(&g_signal_mux);
}

void sentient_cube_set_playback(bool value) {
    portENTER_CRITICAL(&g_signal_mux);
    g_signals.playback = value;
    portEXIT_CRITICAL(&g_signal_mux);
}

void sentient_cube_set_sleep(bool value) {
    portENTER_CRITICAL(&g_signal_mux);
    g_signals.asleep = value;
    portEXIT_CRITICAL(&g_signal_mux);
}

void sentient_cube_set_battery(bool charging, bool low) {
    portENTER_CRITICAL(&g_signal_mux);
    g_signals.charging = charging;
    g_signals.low_battery = low;
    portEXIT_CRITICAL(&g_signal_mux);
}

void sentient_cube_set_battery_level(int percent) {
    portENTER_CRITICAL(&g_signal_mux);
    g_battery_percent = percent;
    portEXIT_CRITICAL(&g_signal_mux);
}

void sentient_cube_show_volume(int percent) {
    int64_t until = esp_timer_get_time() + 1500000;
    portENTER_CRITICAL(&g_signal_mux);
    g_volume_percent = percent;
    g_volume_until_us = until;
    g_signals.volume = true;
    portEXIT_CRITICAL(&g_signal_mux);
}

void sentient_cube_show_test_screen(void) {
    if (!lvgl_port_lock(0)) return;
    ESP_LOGI(TAG, "show_test_screen");
    toggle_button_screen_suspend();
    sentient_test_screen_build();
    lvgl_port_unlock();
}

}  // extern "C"
