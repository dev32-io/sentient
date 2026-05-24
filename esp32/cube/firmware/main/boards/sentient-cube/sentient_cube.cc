// SPDX-License-Identifier: MIT
// sentient_cube.cc
//
// SentientCubeBoard — merged single-class board for the Sentient Cube device.
//
// History: in v1 this was a derived class on top of upstream xiaozhi's
// WaveshareEsp32s3TouchAMOLED2inch16, with a DeferLateInit tag-struct ctor
// variant and a LateInit() method to defer base-class init until the derived
// vtable was set up. In v2 the derivation goes away — there is no separate
// xiaozhi base board class. Patches 0001 (board registration) and 0002
// (vtable defer / DeferLateInit) are obsoleted by this merge.
//
// What this file does:
//   1. Initializes the hardware stack on the Waveshare ESP32-S3-Touch-AMOLED-2.16
//      panel: AXP2101 PMIC, QSPI bus, CO5300 LCD driver, CST9217 touch, ES8311+
//      ES7210 audio codec, boot button.
//   2. Constructs a CustomLcdDisplay subclass whose SetupUI() override replaces
//      xiaozhi's chat/status screen with our toggle-button screen.
//   3. Seeds WiFi creds into SsidManager NVS + WS URL + PASETO token into
//      Settings("websocket") NVS so the device boots straight into the gateway
//      session without an OTA-config round-trip.
//   4. Exposes extern "C" `cube_*` shims so the esp32-devtool verb files
//      under main/devtool_verbs/ can reach Application/SentientWsProtocol
//      state without pulling main into the devtool component's REQUIRES.
//   5. Starts the esp32_devtool companion (USB-CDC verb reader + HTTP server
//      + UDP log relay). The legacy agent_console + net_logger components
//      were deleted in Task 27.

#include "wifi_board.h"
#include "display/lcd_display.h"
#include "esp_lcd_co5300.h"

#include "codecs/box_audio_codec.h"
#include "application.h"
#include "button.h"
#include "led/single_led.h"
#include "config.h"
#include "power_save_timer.h"
#include "axp2101.h"
#include "i2c_device.h"
#include "settings.h"
#include <ssid_manager.h>

#include <esp_heap_caps.h>
#include <esp_log.h>
#include <esp_lcd_panel_vendor.h>
#include <esp_timer.h>
#include <esp_wifi.h>
#include <driver/i2c_master.h>
#include <driver/spi_master.h>
#include <driver/usb_serial_jtag.h>
#include "esp_io_expander_tca9554.h"

#include <esp_lcd_touch_cst9217.h>
#include <esp_lvgl_port.h>
#include <lvgl.h>

#include <cstdio>
#include <cstring>
#include <string>

#include "sentient_creds.h"
#include "esp/esp_ssl.h"

#if SENTIENT_DEV_TLS_PIN
// Symbols exposed by EMBED_TXTFILES on sentient_dev_gateway.crt
// (esp32/cube/firmware/main/CMakeLists.txt). EMBED_TXTFILES null-terminates
// the blob, so (_end - _start) includes the terminator byte; subtract 1 to
// give esp_tls the cert length without the null. (esp_tls works either way,
// but the bytecount-without-null matches the docs and stays compatible if
// the upstream behavior changes.)
extern const char _binary_sentient_dev_gateway_crt_start[] asm("_binary_sentient_dev_gateway_crt_start");
extern const char _binary_sentient_dev_gateway_crt_end[]   asm("_binary_sentient_dev_gateway_crt_end");
#endif

#include "sentient_ui_controller.h"
#include "test_screen.h"
#include "esp32_devtool/companion.h"

static const char* TAG = "sentient.cube.board";

// ---------------------------------------------------------------------------
// Per-board provider functions. Defined as extern "C" so the cube_* shims
// further down (consumed by main/devtool_verbs/*.cc) can wrap them with C
// linkage.
// ---------------------------------------------------------------------------

extern "C" {

static const char* sentient_state_str_provider(void) {
    DeviceState s = Application::GetInstance().GetDeviceState();
    switch (s) {
        case kDeviceStateUnknown:        return "UNKNOWN";
        case kDeviceStateStarting:       return "STARTING";
        case kDeviceStateWifiConfiguring:return "WIFI_CONFIGURING";
        case kDeviceStateIdle:           return "IDLE";
        case kDeviceStateConnecting:     return "CONNECTING";
        case kDeviceStateListening:      return "LISTENING";
        case kDeviceStateSpeaking:       return "SPEAKING";
        case kDeviceStateUpgrading:      return "UPGRADING";
        case kDeviceStateActivating:     return "ACTIVATING";
        case kDeviceStateAudioTesting:   return "AUDIO_TESTING";
        case kDeviceStateFatalError:     return "FATAL_ERROR";
        default:                         return "UNKNOWN";
    }
}

static bool sentient_ws_connected_provider(void) {
    // Truthful: only true while an active WS audio channel is open.
    // xiaozhi opens WS lazily on OpenAudioChannel() and closes it at the
    // end of each cycle. At IDLE we have no WS — return false even though
    // WiFi is up. Tests that need a boot-time "gateway reachable" signal
    // should rely on the wifi.connected event + a button.toggle smoke
    // rather than expecting ws_connected=true at IDLE.
    return Application::GetInstance().IsAudioChannelOpened();
}

static void sentient_button_toggle_provider(void) {
    Application::GetInstance().ToggleChatState();
}

// Note: the legacy sentient_ws_disconnect_provider was removed with Task 27.
// The devtool `wifi.disconnect` verb (main/devtool_verbs/wifi.cc) calls
// esp_wifi_disconnect() directly, so no provider indirection is needed.

static void sentient_tts_cancel_provider(void) {
    // Sentient SDK barge-in path: stops the active uplink, resets the local
    // decoder, and clears in-flight playback.
    Application::GetInstance().AbortSpeaking();
}

static bool sentient_play_pcm_provider(const int16_t* samples, size_t count, int sample_rate) {
    return Application::GetInstance().GetAudioService().PlayPcm(samples, count, sample_rate);
}

static bool sentient_record_pcm_provider(int16_t* dst, size_t count, int sample_rate) {
    return Application::GetInstance().GetAudioService().RecordPcm(dst, count, sample_rate);
}

// SentientWsProtocol provider triple for the sentient.* HIL verbs. Each
// guards against the pre-WiFi window where Application::sentient_ws() is
// still nullptr (the protocol is constructed on first network-up event).
static const char* sentient_sdk_status_provider(void) {
    auto* ws = Application::GetInstance().sentient_ws();
    if (ws == nullptr) return "uninit";
    using sentient::cube::SdkStatus;
    switch (ws->status()) {
        case SdkStatus::Disconnected:   return "Disconnected";
        case SdkStatus::Connecting:     return "Connecting";
        case SdkStatus::Authenticating: return "Authenticating";
        case SdkStatus::Ready:          return "Ready";
        case SdkStatus::Reconnecting:   return "Reconnecting";
        case SdkStatus::Error:          return "Error";
    }
    return "?";
}

static void sentient_sdk_force_reconnect_provider(void) {
    auto* ws = Application::GetInstance().sentient_ws();
    if (ws != nullptr) ws->force_reconnect();
}

static size_t sentient_sdk_last_transcript_provider(char* dst, size_t dst_cap) {
    if (dst == nullptr || dst_cap == 0) return 0;
    auto* ws = Application::GetInstance().sentient_ws();
    if (ws == nullptr) {
        dst[0] = '\0';
        return 0;
    }
    const std::string s = ws->last_transcript();
    const size_t n = (s.size() < dst_cap - 1) ? s.size() : dst_cap - 1;
    std::memcpy(dst, s.data(), n);
    dst[n] = '\0';
    return n;
}

// Forward declaration — defined further down in the extern "C" block.
extern "C" int cube_capture_ui_snapshot(uint16_t* dst, size_t dst_cap,
                                         int* out_w, int* out_h);

// ---------------------------------------------------------------------------
// esp32_devtool snapshot provider — lazily allocates a PSRAM buffer sized for
// the panel's native resolution and delegates to cube_capture_ui_snapshot().
// Returns the ACTUAL captured dimensions from LVGL (display registered as
// 466×466, but panel native is 480×480 — we size the buffer for the worst
// case and let LVGL fill what it manages).
// ---------------------------------------------------------------------------

static constexpr int kMaxPanelDim = 480;
static constexpr size_t kSnapBufBytes = (size_t)kMaxPanelDim * kMaxPanelDim * 2;
static uint16_t* s_snap_buf = nullptr;

// ---------------------------------------------------------------------------
// esp32_devtool touch-injection state. cube_touch_inject() (httpd task) writes
// this under the LVGL port lock; SentientTouchReadCb (LVGL task) reads it
// every tick. The lock around the write side is what makes the read side
// coherent — no other producer touches these fields.
// ---------------------------------------------------------------------------
struct SynthTap {
    bool active;
    int x;
    int y;
    int64_t release_at_us;  // absolute esp_timer microsecond deadline
};
static SynthTap s_synth_tap = {};

static int cube_snapshot_provider(esp32_devtool_snapshot_t* out) {
    if (s_snap_buf == nullptr) {
        s_snap_buf = static_cast<uint16_t*>(
            heap_caps_malloc(kSnapBufBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
        if (s_snap_buf == nullptr) {
            ESP_LOGE(TAG, "cube_snapshot_provider: PSRAM alloc failed");
            return -1;
        }
        ESP_LOGI(TAG, "cube_snapshot_provider: PSRAM buf=%p size=%u",
                 (void*)s_snap_buf, (unsigned)kSnapBufBytes);
    }
    int w = 0, h = 0;
    if (cube_capture_ui_snapshot(s_snap_buf, kSnapBufBytes, &w, &h) != 0) return -1;
    out->pixels = s_snap_buf;
    out->width  = w;
    out->height = h;
    return 0;
}

// ---------------------------------------------------------------------------
// esp32_devtool info provider — populates /info JSON from live system state.
// Static buffers are sized for their maximum content; no heap allocation.
// ---------------------------------------------------------------------------

static int cube_info_provider(esp32_devtool_info_t* out) {
    static char ssid_buf[33] = {};
    static char ip_buf[16]   = {};
    static char mac_buf[18]  = {};

    wifi_ap_record_t ap;
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
        std::snprintf(ssid_buf, sizeof(ssid_buf), "%s",
                      reinterpret_cast<const char*>(ap.ssid));
        out->wifi_rssi = ap.rssi;
    } else {
        ssid_buf[0]    = '\0';
        out->wifi_rssi = 0;
    }

    esp_netif_ip_info_t ipi = {};
    esp_netif_t* nif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (nif && esp_netif_get_ip_info(nif, &ipi) == ESP_OK) {
        std::snprintf(ip_buf, sizeof(ip_buf), IPSTR, IP2STR(&ipi.ip));
    } else {
        ip_buf[0] = '\0';
    }

    uint8_t mac[6] = {};
    if (esp_wifi_get_mac(WIFI_IF_STA, mac) == ESP_OK) {
        std::snprintf(mac_buf, sizeof(mac_buf),
                      "%02x:%02x:%02x:%02x:%02x:%02x",
                      mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    } else {
        mac_buf[0] = '\0';
    }

    out->device_id     = SENTIENT_DEVICE_ID;
    out->board         = "cube";
    out->chip          = "esp32-s3";
    out->ip            = ip_buf;
    out->mac           = mac_buf;
    out->wifi_ssid     = ssid_buf;
    out->firmware      = "phase6-cube-sdk-devtool";
    out->build_profile =
#ifdef CONFIG_SENTIENT_PROD_BUILD
        "prod";
#else
        "debug";
#endif
    out->uptime_s = (int)(esp_timer_get_time() / 1000000);
    return 0;
}

// ---------------------------------------------------------------------------
// esp32_devtool shims — extern "C" wrappers that let the devtool verb files
// under main/devtool_verbs/ call into Application state without pulling main
// into the devtool component's REQUIRES.
//
// They are defined here (not in the verb files) because sentient_cube.cc
// already has access to Application, SdkStatus, esp_netif, etc. The verb
// files only need the extern "C" declarations, which they carry locally.
// ---------------------------------------------------------------------------

extern "C" const char* cube_device_state_str(void) {
    return sentient_state_str_provider();
}

extern "C" bool cube_ws_connected(void) {
    return sentient_ws_connected_provider();
}

extern "C" void cube_button_toggle(void) {
    sentient_button_toggle_provider();
}

extern "C" const char* cube_sentient_status_str(void) {
    return sentient_sdk_status_provider();
}

extern "C" const char* cube_ip_str(void) {
    static char buf[16];
    esp_netif_ip_info_t ipi = {};
    esp_netif_t* nif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (nif && esp_netif_get_ip_info(nif, &ipi) == ESP_OK) {
        std::snprintf(buf, sizeof(buf), IPSTR, IP2STR(&ipi.ip));
    } else {
        buf[0] = '\0';
    }
    return buf;
}

// Task 24 shims — extern "C" wrappers for the remaining verbs. Each
// delegates to the existing sentient_*_provider above so the verb files
// don't need to know about Application or SentientWsProtocol.

extern "C" void cube_tts_cancel(void) {
    sentient_tts_cancel_provider();
}

extern "C" bool cube_play_pcm(const int16_t* samples, size_t count,
                              int sample_rate) {
    return sentient_play_pcm_provider(samples, count, sample_rate);
}

extern "C" bool cube_record_pcm(int16_t* dst, size_t count, int sample_rate) {
    return sentient_record_pcm_provider(dst, count, sample_rate);
}

extern "C" void cube_sentient_force_reconnect(void) {
    sentient_sdk_force_reconnect_provider();
}

extern "C" size_t cube_sentient_last_transcript(char* dst, size_t dst_cap) {
    return sentient_sdk_last_transcript_provider(dst, dst_cap);
}

// ---------------------------------------------------------------------------
// UI snapshot capture — fills dst with the current display contents as
// RGB565 LE. Uses lv_snapshot_take (same as ui_snapshot.cc) then memcpy
// the pixel data into the caller-provided buffer. Holds the LVGL mutex
// for the duration of the snapshot + copy.
//
// Returns 0 on success, -1 on LVGL lock timeout or snapshot failure.
// dst must point to at least w * h * 2 bytes of writable storage.
// ---------------------------------------------------------------------------

static const int kSnapLvglLockMs = 2000;

// Capture the active LVGL screen into `dst` as packed RGB565 LE (no stride
// padding). Returns 0 on success and writes the actual captured dimensions
// into *out_w / *out_h. `dst_cap` is the dst buffer's byte capacity.
//
// The draw_buf returned by lv_snapshot_take carries its own w/h/stride —
// blindly memcpy'ing raw bytes produces a diagonally-sheared image when the
// internal stride is wider than w*2 (cube panel native is 480px but the visible
// LVGL display is 466px, so LVGL pads each row). Copy row-by-row using the
// draw_buf's stride to get a packed output.
extern "C" int cube_capture_ui_snapshot(uint16_t* dst, size_t dst_cap,
                                         int* out_w, int* out_h) {
    if (dst == nullptr || out_w == nullptr || out_h == nullptr) return -1;
    if (!lvgl_port_lock(kSnapLvglLockMs)) {
        ESP_LOGW(TAG, "cube_capture_ui_snapshot: lvgl lock timeout");
        return -1;
    }
    lv_obj_t* screen = lv_screen_active();
    lv_draw_buf_t* draw_buf = lv_snapshot_take(screen, LV_COLOR_FORMAT_RGB565);
    lvgl_port_unlock();

    if (draw_buf == nullptr) {
        ESP_LOGE(TAG, "cube_capture_ui_snapshot: lv_snapshot_take returned null");
        return -1;
    }

    const int w = draw_buf->header.w;
    const int h = draw_buf->header.h;
    const uint32_t stride = draw_buf->header.stride;  // bytes per row in src
    const size_t packed_row = (size_t)w * 2;
    const size_t needed = packed_row * (size_t)h;
    if (needed > dst_cap) {
        ESP_LOGE(TAG, "cube_capture_ui_snapshot: dst too small need=%u cap=%u (%dx%d)",
                 (unsigned)needed, (unsigned)dst_cap, w, h);
        lv_draw_buf_destroy(draw_buf);
        return -1;
    }

    const uint8_t* src = static_cast<const uint8_t*>(draw_buf->data);
    uint8_t* out = reinterpret_cast<uint8_t*>(dst);
    for (int y = 0; y < h; ++y) {
        std::memcpy(out + (size_t)y * packed_row, src + (size_t)y * stride, packed_row);
    }
    lv_draw_buf_destroy(draw_buf);

    *out_w = w;
    *out_h = h;
    ESP_LOGI(TAG, "cube_capture_ui_snapshot: ok w=%d h=%d stride=%u bytes=%u",
             w, h, (unsigned)stride, (unsigned)needed);
    return 0;
}

// ---------------------------------------------------------------------------
// Synthetic touch injection — writes into s_synth_tap from the httpd task so
// that SentientTouchReadCb (LVGL task) emits a synthetic PRESSED for the
// requested hold window, then a real RELEASED. The existing press→release
// detector inside SentientTouchReadCb fires the same `touch.tap` EVT it would
// for a physical tap.
//
// The LVGL port lock serializes against SentientTouchReadCb on the LVGL task;
// 50 ms is generous for our typical tick budget and matches the snapshot
// path's lock pattern. Coordinate space is touch-controller space (0..479 on
// each axis, see config.h DISPLAY_WIDTH/HEIGHT).
// ---------------------------------------------------------------------------
int cube_touch_inject(int x, int y, int hold_ms) {
    static const char* INJ_TAG = "sentient.cube.touch.synth";
    if (hold_ms <= 0) {
        ESP_LOGW(INJ_TAG, "reject hold_ms=%d (must be > 0)", hold_ms);
        return -1;
    }
    if (!lvgl_port_lock(50)) {
        ESP_LOGW(INJ_TAG, "lvgl_port_lock timeout");
        return -1;
    }
    s_synth_tap.x = x;
    s_synth_tap.y = y;
    s_synth_tap.release_at_us = esp_timer_get_time() + (int64_t)hold_ms * 1000;
    s_synth_tap.active = true;
    lvgl_port_unlock();
    ESP_LOGD(INJ_TAG, "inject x=%d y=%d hold_ms=%d", x, y, hold_ms);
    return 0;
}

// ---------------------------------------------------------------------------
// esp32_devtool audio providers — thin adapters around the existing
// AudioService::RecordPcm boundary and the shared inject ring buffer
// (main/audio/audio_inject_ring.{h,cc}). Both register at boot via
// esp32_devtool_set_audio_*_provider() so the /audio/record + /audio/inject
// HTTP handlers in the companion can dispatch into them.
// ---------------------------------------------------------------------------

// Forward decl of the shared inject ring push (defined in
// main/audio/audio_inject_ring.cc). Kept local rather than via header to keep
// this file's include surface small.
size_t audio_inject_ring_push(const int16_t* src, size_t n);

int cube_audio_record_provider(int16_t* dst, size_t samples, int sample_rate) {
    // Reuse the Phase 4 boundary. bool → int adapter: 0 on success, -1 on
    // failure (matches the rest of the devtool provider contract).
    return sentient_record_pcm_provider(dst, samples, sample_rate) ? 0 : -1;
}

int cube_audio_inject_provider(const int16_t* src, size_t samples,
                                int /*sample_rate*/) {
    // sample_rate is ignored at push time. The pop side
    // (agent_audio_inject_pop_samples) gates on rate==16000 — anything else
    // degrades to "no injection at this rate" and the real codec path runs.
    // Returning 0 unconditionally means "provider accepted the dispatch"; the
    // HTTP handler's response body reports the sample count from the request.
    audio_inject_ring_push(src, samples);
    return 0;
}

}  // extern "C"

// ---------------------------------------------------------------------------
// Pmic — AXP2101 register bring-up for the Waveshare panel.
// ---------------------------------------------------------------------------

class Pmic : public Axp2101 {
public:
    Pmic(i2c_master_bus_handle_t i2c_bus, uint8_t addr) : Axp2101(i2c_bus, addr) {
        static const char* PMIC_TAG = "sentient.cube.board.pmic";
        ESP_LOGI(PMIC_TAG, "ctor.begin addr=0x%02x", addr);
        // Configure-then-enable order. Old v1 sequence was "disable-all-LDOs
        // (0x90=0x00) then re-enable ALDO1" — that fails on a first-clean-boot
        // from a fully discharged AXP2101 because ALDO1 was sourcing the I2C
        // bus IO power, and disabling it mid-transaction left the next write
        // with ESP_ERR_INVALID_STATE. v1 worked only because AXP2101 retained
        // its prior-session register state across boots.
        //
        // New sequence: set voltages first, enable ALDO1 once, never disable
        // it. Leave other LDOs at whatever their power-on default is — the
        // chip's defaults are safe.
        WriteRegLogged(PMIC_TAG, 0x22, 0b110, "pwron_offlevel_poweroff");
        WriteRegLogged(PMIC_TAG, 0x27, 0x10, "hold_4s_poweroff");
        WriteRegLogged(PMIC_TAG, 0x82, (3300 - 1500) / 100, "dc1_3v3");
        WriteRegLogged(PMIC_TAG, 0x92, (3300 - 500) / 100, "aldo1_3v3");
        WriteRegLogged(PMIC_TAG, 0x80, 0x01, "disable_all_dc_except_dc1");
        WriteRegLogged(PMIC_TAG, 0x90, 0x01, "enable_aldo1_mic_only");
        WriteRegLogged(PMIC_TAG, 0x64, 0x02, "cv_charge_4v1");
        WriteRegLogged(PMIC_TAG, 0x61, 0x02, "main_bat_precharge_50ma");
        WriteRegLogged(PMIC_TAG, 0x62, 0x08, "main_bat_charge_400ma");
        WriteRegLogged(PMIC_TAG, 0x63, 0x01, "main_bat_term_25ma");
        ESP_LOGI(PMIC_TAG, "ctor.done");
    }
private:
    void WriteRegLogged(const char* tag, uint8_t reg, uint8_t value, const char* note) {
        ESP_LOGI(tag, "write reg=0x%02x val=0x%02x note=%s", reg, value, note);
        WriteReg(reg, value);
        ESP_LOGI(tag, "write.ok reg=0x%02x", reg);
    }
};

// ---------------------------------------------------------------------------
// CO5300 panel: QSPI vendor init sequence + opcode constants.
// ---------------------------------------------------------------------------

#define LCD_OPCODE_WRITE_CMD (0x02ULL)
#define LCD_OPCODE_READ_CMD (0x03ULL)
#define LCD_OPCODE_WRITE_COLOR (0x32ULL)

static const co5300_lcd_init_cmd_t vendor_specific_init[] = {
    {0x11, (uint8_t[]){0x00}, 0, 600}, // Sleep out

    {0xFE, (uint8_t[]){0x20}, 1, 0},
    {0x19, (uint8_t[]){0x10}, 1, 0},
    {0x1C, (uint8_t[]){0xA0}, 1, 0},

    {0xFE, (uint8_t[]){0x00}, 1, 0},
    {0xC4, (uint8_t[]){0x80}, 1, 0},
    {0x3A, (uint8_t[]){0x55}, 1, 0},
    {0x35, (uint8_t[]){0x00}, 1, 0},
    {0x53, (uint8_t[]){0x20}, 1, 0},
    {0x51, (uint8_t[]){0xFF}, 1, 0},
    {0x63, (uint8_t[]){0xFF}, 1, 0},
    {0x2A, (uint8_t[]){0x00, 0x00, 0x01, 0xDF}, 4, 0},
    {0x2B, (uint8_t[]){0x00, 0x00, 0x01, 0xDF}, 4, 0},
    {0x36, (uint8_t[]){0xA0}, 1, 0},
    {0x29, (uint8_t[]){0x00}, 0, 600},
};

// ---------------------------------------------------------------------------
// CustomLcdDisplay — SpiLcdDisplay subclass that:
//   1. Rounds invalidation areas to even pixel boundaries (CO5300 alignment).
//   2. Pads the status bar by 10% on each side.
//   3. Swaps in our toggle-button screen after parent SetupUI() completes.
//
// The 3rd item is the v1 SentientCubeDisplay behavior, folded into this class
// since the merged board has no separate display subclass. DisplayLockGuard
// re-acquisition is essential — the parent's lock is RAII-scoped to its own
// SetupUI() and released on return. Calling LVGL APIs without the lock races
// the LVGL task and hangs in lv_inv_area / lv_screen_load.
// ---------------------------------------------------------------------------

class CustomLcdDisplay : public SpiLcdDisplay {
public:
    static void rounder_event_cb(lv_event_t* e) {
        lv_area_t* area = (lv_area_t*)lv_event_get_param(e);
        uint16_t x1 = area->x1;
        uint16_t x2 = area->x2;

        uint16_t y1 = area->y1;
        uint16_t y2 = area->y2;

        // round the start of coordinate down to the nearest 2M number
        area->x1 = (x1 >> 1) << 1;
        area->y1 = (y1 >> 1) << 1;
        // round the end of coordinate up to the nearest 2N+1 number
        area->x2 = ((x2 >> 1) << 1) + 1;
        area->y2 = ((y2 >> 1) << 1) + 1;
    }

    CustomLcdDisplay(esp_lcd_panel_io_handle_t io_handle,
                     esp_lcd_panel_handle_t panel_handle,
                     int width,
                     int height,
                     int offset_x,
                     int offset_y,
                     bool mirror_x,
                     bool mirror_y,
                     bool swap_xy)
        : SpiLcdDisplay(io_handle, panel_handle,
                        width, height, offset_x, offset_y,
                        mirror_x, mirror_y, swap_xy) {
        // UI customization happens in SetupUI() (after lvgl objects exist).
    }

    virtual void SetupUI() override {
        ESP_LOGI(TAG, "setup_ui device_id=" SENTIENT_DEVICE_ID);

        // Parent creates LVGL display + status bar; we then customize.
        SpiLcdDisplay::SetupUI();

        // Re-acquire the LVGL mutex: parent's DisplayLockGuard was scoped to
        // its own SetupUI() and released on return.
        DisplayLockGuard lock(this);
        lv_obj_set_style_pad_left(status_bar_, LV_HOR_RES * 0.1, 0);
        lv_obj_set_style_pad_right(status_bar_, LV_HOR_RES * 0.1, 0);
        lv_display_add_event_cb(display_, rounder_event_cb,
                                LV_EVENT_INVALIDATE_AREA, NULL);

        // Phase 5: restore the toggle-button screen as the boot UI. This
        // spawns the device-state polling task in sentient_ui_controller.cc,
        // which is the sole emitter of:
        //   >>> READY
        //   >>> CHECKPOINT {listen,ws,wifi}.{start,stop,connected,disconnected}
        // The Phase 2 test-screen path is retained as a callable function
        // (sentient_cube_show_test_screen()) so HIL UI-snapshot smoke can
        // still exercise it via a verb if a future need arises.
        sentient_cube_create_toggle_button_screen();
    }
};

// ---------------------------------------------------------------------------
// CustomBacklight — drives backlight brightness via CO5300 panel-IO command.
// ---------------------------------------------------------------------------

class CustomBacklight : public Backlight {
public:
    CustomBacklight(esp_lcd_panel_io_handle_t panel_io)
        : Backlight(), panel_io_(panel_io) {}

protected:
    esp_lcd_panel_io_handle_t panel_io_;

    virtual void SetBrightnessImpl(uint8_t brightness) override {
        auto display = Board::GetInstance().GetDisplay();
        DisplayLockGuard lock(display);
        uint8_t data[1] = {((uint8_t)((255 * brightness) / 100))};
        int lcd_cmd = 0x51;
        lcd_cmd &= 0xff;
        lcd_cmd <<= 8;
        lcd_cmd |= LCD_OPCODE_WRITE_CMD << 24;
        esp_lcd_panel_io_tx_param(panel_io_, lcd_cmd, &data, sizeof(data));
    }
};

// ---------------------------------------------------------------------------
// Helper: build WebSocket URL string from baked-in creds.
// SENTIENT_GATEWAY_WS_PORT is an integer literal, so std::to_string is needed.
// ---------------------------------------------------------------------------

static std::string build_ws_url() {
    return std::string("wss://")
        + SENTIENT_GATEWAY_HOST
        + ":"
        + std::to_string(SENTIENT_GATEWAY_WS_PORT)
        + SENTIENT_GATEWAY_WS_PATH;
}

// ---------------------------------------------------------------------------
// SentientCubeBoard — single-class merged board.
// ---------------------------------------------------------------------------

class SentientCubeBoard : public WifiBoard {
private:
    i2c_master_bus_handle_t i2c_bus_;
    Pmic* pmic_ = nullptr;
    Button boot_button_;
    CustomLcdDisplay* display_;
    CustomBacklight* backlight_;
    esp_io_expander_handle_t io_expander = NULL;
    PowerSaveTimer* power_save_timer_;

    void InitializePowerSaveTimer() {
        ESP_LOGI(TAG, "init.power_save_timer.begin");
        // Shutdown timer disabled (third arg -1). v1 used 300s with
        // OnShutdownRequest -> pmic_->PowerOff(); but PMIC shutdown latches
        // AXP2101 in a state that survives MCU reset + USB unplug — only
        // physical battery disconnect clears it. Skipping shutdown keeps
        // the cube wake-recoverable from any state.
        power_save_timer_ = new PowerSaveTimer(-1, 60, -1);
        power_save_timer_->OnEnterSleepMode([this]() {
            GetDisplay()->SetPowerSaveMode(true);
            GetBacklight()->SetBrightness(20);
        });
        power_save_timer_->OnExitSleepMode([this]() {
            GetDisplay()->SetPowerSaveMode(false);
            GetBacklight()->RestoreBrightness();
        });
        power_save_timer_->SetEnabled(true);
        ESP_LOGI(TAG, "init.power_save_timer.done timer=%p", power_save_timer_);
    }

    // USB-aware power-save override (v1 patch 0003 inlined for v2 rescope).
    //
    // When the USB-Serial-JTAG host is attached (agent dev session), keep the
    // cube awake indefinitely so the command channel stays usable. When
    // unplugged, restore the default 60s-to-sleep timer for battery use.
    // Polled at 0.2 Hz from a low-priority task; toggle is edge-triggered.
    // Shutdown timer is disabled at PowerSaveTimer ctor time; this monitor
    // only toggles the sleep timer, never invokes PMIC PowerOff.
    //
    // Bypassed entirely when CUBE_DEV_AGGRESSIVE_POWER_SAVE is on so the
    // standard 60s dim-to-20% still fires during hour-long dev iterations.
    void InitializePowerSaveMonitor() {
#if CONFIG_CUBE_DEV_AGGRESSIVE_POWER_SAVE
        ESP_LOGI(TAG, "init.power_save_monitor.skipped (CUBE_DEV_AGGRESSIVE_POWER_SAVE=y)");
        // PowerSaveTimer constructor leaves the timer enabled; the 60s sleep
        // path (dim to 20%) fires normally without the USB-aware override.
        return;
#else
        ESP_LOGI(TAG, "init.power_save_monitor.begin timer=%p", power_save_timer_);
        BaseType_t rc = xTaskCreate(
            [](void* arg) {
                auto* timer = static_cast<PowerSaveTimer*>(arg);
                bool last_tethered = true;
                ESP_LOGI("PowerSaveUSB", "task.start initial_tethered=1");
                timer->SetEnabled(false);
                bool first_iter = true;
                for (;;) {
                    bool tethered = usb_serial_jtag_is_connected();
                    if (first_iter) {
                        ESP_LOGI("PowerSaveUSB", "first_probe tethered=%d", (int)tethered);
                        first_iter = false;
                    }
                    if (tethered != last_tethered) {
                        ESP_LOGI("PowerSaveUSB", "usb_state=%s",
                                 tethered ? "tethered" : "untethered");
                        timer->SetEnabled(!tethered);
                        last_tethered = tethered;
                    }
                    vTaskDelay(pdMS_TO_TICKS(5000));
                }
            }, "psave-usb", 2560, power_save_timer_, tskIDLE_PRIORITY + 1, nullptr);
        ESP_LOGI(TAG, "init.power_save_monitor.task_create rc=%d", (int)rc);
#endif
    }

    // Bus health probe + bitbang recovery. Runs BEFORE the I2C peripheral
    // grabs SDA/SCL. Diagnoses:
    //   sda=1 scl=1 → bus idle, pullups working → devices may be present
    //   sda=0 scl=1 → SDA stuck by a clock-stretching slave → 9-pulse SCL
    //                 recovery may release the slave
    //   sda=0 scl=0 → both lines low → pullup voltage missing (AXP2101 DC1
    //                 latched off, or external pullups dead). Bitbang cannot
    //                 fix this — needs physical battery+USB power cycle.
    //   sda=1 scl=0 → SCL stuck by slave → unrecoverable from master side
    void ProbeAndRecoverI2cBus() {
        ESP_LOGI(TAG, "i2c.bus_probe.begin sda_pin=%d scl_pin=%d",
                 AUDIO_CODEC_I2C_SDA_PIN, AUDIO_CODEC_I2C_SCL_PIN);
        gpio_config_t io = {};
        io.pin_bit_mask = (1ULL << AUDIO_CODEC_I2C_SDA_PIN) |
                          (1ULL << AUDIO_CODEC_I2C_SCL_PIN);
        io.mode = GPIO_MODE_INPUT_OUTPUT_OD;
        io.pull_up_en = GPIO_PULLUP_ENABLE;
        io.pull_down_en = GPIO_PULLDOWN_DISABLE;
        io.intr_type = GPIO_INTR_DISABLE;
        gpio_config(&io);
        gpio_set_level((gpio_num_t)AUDIO_CODEC_I2C_SDA_PIN, 1);
        gpio_set_level((gpio_num_t)AUDIO_CODEC_I2C_SCL_PIN, 1);
        esp_rom_delay_us(50);
        int sda = gpio_get_level((gpio_num_t)AUDIO_CODEC_I2C_SDA_PIN);
        int scl = gpio_get_level((gpio_num_t)AUDIO_CODEC_I2C_SCL_PIN);
        ESP_LOGI(TAG, "i2c.bus_probe.idle_levels sda=%d scl=%d", sda, scl);

        if (sda == 0 && scl == 0) {
            ESP_LOGE(TAG, "i2c.bus_dead both_low — AXP2101 DC1 likely off, "
                          "physical power cycle (battery+USB) required");
        } else if (sda == 1 && scl == 0) {
            ESP_LOGE(TAG, "i2c.bus_dead scl_stuck_low — slave clock-stretch "
                          "deadlock, unrecoverable from master side");
        } else if (sda == 0 && scl == 1) {
            ESP_LOGW(TAG, "i2c.sda_stuck.recovery_begin");
            for (int i = 0; i < 9; ++i) {
                gpio_set_level((gpio_num_t)AUDIO_CODEC_I2C_SCL_PIN, 0);
                esp_rom_delay_us(5);
                gpio_set_level((gpio_num_t)AUDIO_CODEC_I2C_SCL_PIN, 1);
                esp_rom_delay_us(5);
                if (gpio_get_level((gpio_num_t)AUDIO_CODEC_I2C_SDA_PIN) == 1) {
                    ESP_LOGI(TAG, "i2c.sda_released after_pulses=%d", i + 1);
                    break;
                }
            }
            // STOP condition: SDA low→high while SCL high
            gpio_set_level((gpio_num_t)AUDIO_CODEC_I2C_SDA_PIN, 0);
            esp_rom_delay_us(5);
            gpio_set_level((gpio_num_t)AUDIO_CODEC_I2C_SCL_PIN, 1);
            esp_rom_delay_us(5);
            gpio_set_level((gpio_num_t)AUDIO_CODEC_I2C_SDA_PIN, 1);
            esp_rom_delay_us(5);
            sda = gpio_get_level((gpio_num_t)AUDIO_CODEC_I2C_SDA_PIN);
            scl = gpio_get_level((gpio_num_t)AUDIO_CODEC_I2C_SCL_PIN);
            ESP_LOGI(TAG, "i2c.bus_probe.after_recovery sda=%d scl=%d", sda, scl);
        } else {
            ESP_LOGI(TAG, "i2c.bus_probe.idle_ok");
        }
        // Release pins so i2c_new_master_bus can claim them.
        gpio_reset_pin((gpio_num_t)AUDIO_CODEC_I2C_SDA_PIN);
        gpio_reset_pin((gpio_num_t)AUDIO_CODEC_I2C_SCL_PIN);
        ESP_LOGI(TAG, "i2c.bus_probe.done released_pins");
    }

    void InitializeCodecI2c() {
        ESP_LOGI(TAG, "init.codec_i2c.begin sda=%d scl=%d port=%d",
                 AUDIO_CODEC_I2C_SDA_PIN, AUDIO_CODEC_I2C_SCL_PIN, I2C_NUM_0);
        ProbeAndRecoverI2cBus();
        i2c_master_bus_config_t i2c_bus_cfg = {
            .i2c_port = I2C_NUM_0,
            .sda_io_num = AUDIO_CODEC_I2C_SDA_PIN,
            .scl_io_num = AUDIO_CODEC_I2C_SCL_PIN,
            .clk_source = I2C_CLK_SRC_DEFAULT,
            .flags = {
                .enable_internal_pullup = 1,
            },
        };
        ESP_ERROR_CHECK(i2c_new_master_bus(&i2c_bus_cfg, &i2c_bus_));
        ESP_LOGI(TAG, "init.codec_i2c.done bus=%p", (void*)i2c_bus_);
    }

    // Scan the I2C bus and log every address that ACKs. Diagnostic only —
    // helps distinguish "AXP2101 missing from bus" from "AXP2101 present but
    // write rejects". Skips reserved addresses (0x00-0x07, 0x78-0x7F).
    void ScanI2cBus() {
        ESP_LOGI(TAG, "i2c.scan.begin bus=%p", (void*)i2c_bus_);
        int found = 0;
        for (uint8_t addr = 0x08; addr < 0x78; ++addr) {
            esp_err_t err = i2c_master_probe(i2c_bus_, addr, 50);
            if (err == ESP_OK) {
                ESP_LOGI(TAG, "i2c.scan.found addr=0x%02x", addr);
                ++found;
            }
        }
        ESP_LOGI(TAG, "i2c.scan.done found_count=%d", found);
    }

    // Probe AXP2101 read-only BEFORE Pmic ctor's write storm. Reads chip ID
    // register 0x03 (AXP2101 datasheet says chip ID = 0x47, mask 0xCF). If
    // this fails or returns wrong ID, Pmic ctor will fail too — but we'll
    // have a precise signal whether bus/device is the problem.
    void ProbeAxp2101() {
        ESP_LOGI(TAG, "axp2101.probe.begin bus=%p addr=0x%02x", (void*)i2c_bus_, 0x34);
        i2c_device_config_t cfg = {
            .dev_addr_length = I2C_ADDR_BIT_LEN_7,
            .device_address = 0x34,
            .scl_speed_hz = 400 * 1000,
            .scl_wait_us = 0,
            .flags = { .disable_ack_check = 0 },
        };
        i2c_master_dev_handle_t probe_dev = nullptr;
        esp_err_t add_err = i2c_master_bus_add_device(i2c_bus_, &cfg, &probe_dev);
        if (add_err != ESP_OK) {
            ESP_LOGE(TAG, "axp2101.probe.add_device.fail err=%s (0x%x)",
                     esp_err_to_name(add_err), add_err);
            return;
        }
        uint8_t reg = 0x03;
        uint8_t chip_id = 0xFF;
        esp_err_t xfer_err = i2c_master_transmit_receive(probe_dev, &reg, 1, &chip_id, 1, 100);
        if (xfer_err != ESP_OK) {
            ESP_LOGE(TAG, "axp2101.probe.read.fail err=%s (0x%x)",
                     esp_err_to_name(xfer_err), xfer_err);
        } else {
            ESP_LOGI(TAG, "axp2101.probe.chip_id=0x%02x (expected 0x47 mask 0xCF)", chip_id);
        }
        i2c_master_bus_rm_device(probe_dev);
        ESP_LOGI(TAG, "axp2101.probe.done");
    }

    void InitializeAxp2101() {
        ESP_LOGI(TAG, "init.axp2101.begin bus=%p addr=0x%02x", (void*)i2c_bus_, 0x34);
        ScanI2cBus();
        ProbeAxp2101();
        pmic_ = new Pmic(i2c_bus_, 0x34);
        ESP_LOGI(TAG, "init.axp2101.done pmic=%p", (void*)pmic_);
    }

    void InitializeSpi() {
        ESP_LOGI(TAG, "init.spi.begin host=SPI2_HOST");
        spi_bus_config_t buscfg = {};
        buscfg.sclk_io_num = EXAMPLE_PIN_NUM_LCD_PCLK;
        buscfg.data0_io_num = EXAMPLE_PIN_NUM_LCD_DATA0;
        buscfg.data1_io_num = EXAMPLE_PIN_NUM_LCD_DATA1;
        buscfg.data2_io_num = EXAMPLE_PIN_NUM_LCD_DATA2;
        buscfg.data3_io_num = EXAMPLE_PIN_NUM_LCD_DATA3;
        buscfg.max_transfer_sz = DISPLAY_WIDTH * DISPLAY_HEIGHT * sizeof(uint16_t);
        buscfg.flags = SPICOMMON_BUSFLAG_QUAD;
        ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &buscfg, SPI_DMA_CH_AUTO));
        ESP_LOGI(TAG, "init.spi.done");
    }

    void InitializeButtons() {
        ESP_LOGI(TAG, "init.buttons.begin gpio=%d", BOOT_BUTTON_GPIO);
        boot_button_.OnClick([this]() {
            auto& app = Application::GetInstance();
            if (app.GetDeviceState() == kDeviceStateStarting) {
                EnterWifiConfigMode();
                return;
            }
            app.ToggleChatState();
        });

#if CONFIG_USE_DEVICE_AEC
        boot_button_.OnDoubleClick([this]() {
            auto& app = Application::GetInstance();
            if (app.GetDeviceState() == kDeviceStateIdle) {
                app.SetAecMode(app.GetAecMode() == kAecOff
                                   ? kAecOnDeviceSide
                                   : kAecOff);
            }
        });
#endif
        ESP_LOGI(TAG, "init.buttons.done");
    }

    void InitializeDisplay() {
        ESP_LOGI(TAG, "init_display device_id=" SENTIENT_DEVICE_ID);

        esp_lcd_panel_io_handle_t panel_io = nullptr;
        esp_lcd_panel_handle_t panel = nullptr;

        ESP_LOGD(TAG, "Install panel IO");
        esp_lcd_panel_io_spi_config_t io_config = CO5300_PANEL_IO_QSPI_CONFIG(
            EXAMPLE_PIN_NUM_LCD_CS,
            nullptr,
            nullptr);
        ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi(SPI2_HOST, &io_config, &panel_io));
        ESP_LOGI(TAG, "init.display.panel_io");

        ESP_LOGD(TAG, "Install LCD driver");
        const co5300_vendor_config_t vendor_config = {
            .init_cmds = &vendor_specific_init[0],
            .init_cmds_size = sizeof(vendor_specific_init) / sizeof(co5300_lcd_init_cmd_t),
            .flags = {
                .use_qspi_interface = 1,
            }};

        esp_lcd_panel_dev_config_t panel_config = {};
        panel_config.reset_gpio_num = EXAMPLE_PIN_NUM_LCD_RST;
        panel_config.rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB;
        panel_config.bits_per_pixel = 16;
        panel_config.vendor_config = (void*)&vendor_config;
        ESP_ERROR_CHECK(esp_lcd_new_panel_co5300(panel_io, &panel_config, &panel));
        ESP_LOGI(TAG, "init.display.panel_driver");
        esp_lcd_panel_reset(panel);
        esp_lcd_panel_init(panel);
        ESP_LOGI(TAG, "init.display.panel_inited");
        esp_lcd_panel_invert_color(panel, false);
        esp_lcd_panel_mirror(panel, DISPLAY_MIRROR_X, DISPLAY_MIRROR_Y);
        esp_lcd_panel_disp_on_off(panel, true);
        ESP_LOGI(TAG, "init.display.disp_on");
        display_ = new CustomLcdDisplay(
            panel_io, panel,
            DISPLAY_WIDTH, DISPLAY_HEIGHT,
            DISPLAY_OFFSET_X, DISPLAY_OFFSET_Y,
            DISPLAY_MIRROR_X, DISPLAY_MIRROR_Y, DISPLAY_SWAP_XY);
        ESP_LOGI(TAG, "init.display.lvgl display=%p", (void*)display_);
        backlight_ = new CustomBacklight(panel_io);
#if CONFIG_CUBE_DEV_AGGRESSIVE_POWER_SAVE
        // Boot-time low-brightness for thermal headroom during long
        // dev sessions. permanent=false so we don't churn NVS each
        // boot; unsetting the Kconfig restores NVS-saved value.
        backlight_->SetBrightness(CONFIG_CUBE_DEV_LOW_BRIGHTNESS_PERCENT, /*permanent=*/false);
        ESP_LOGI(TAG, "init.display.backlight brightness_pct=%d (dev aggressive power-save)",
                 CONFIG_CUBE_DEV_LOW_BRIGHTNESS_PERCENT);
#else
        backlight_->RestoreBrightness();
        ESP_LOGI(TAG, "init.display.backlight");
#endif
    }

    // LVGL input-device read callback. Replaces vendor lvgl_port_touchpad_read
    // which uses ESP_ERROR_CHECK on esp_lcd_touch_read_data — that aborts the
    // firmware on any transient I2C error. Transient errors are EXPECTED on a
    // shared I2C bus during WiFi RF turn-on, audio codec mode changes, charger
    // state transitions, etc. This callback treats any read failure as
    // "no touch this tick" and continues; LVGL retries next tick.
    static void SafeTouchReadCb(lv_indev_t* indev, lv_indev_data_t* data) {
        auto* tp = static_cast<esp_lcd_touch_handle_t>(lv_indev_get_driver_data(indev));
        if (tp == nullptr || esp_lcd_touch_read_data(tp) != ESP_OK) {
            data->state = LV_INDEV_STATE_RELEASED;
            return;
        }
        uint16_t x = 0, y = 0, strength = 0;
        uint8_t cnt = 0;
        bool pressed = esp_lcd_touch_get_coordinates(tp, &x, &y, &strength, &cnt, 1);
        if (pressed && cnt > 0) {
            data->point.x = x;
            data->point.y = y;
            data->state = LV_INDEV_STATE_PRESSED;
        } else {
            data->state = LV_INDEV_STATE_RELEASED;
        }
    }

    // Tap-detector wrapper around SafeTouchReadCb. Runs the safe read first,
    // then layers press→release transition detection on top to emit a single
    // JSON event per tap via the esp32_devtool companion. Also drives the
    // test-screen heatmap dot for visual cross-check.
    //
    // Registered as the LVGL indev read callback instead of SafeTouchReadCb
    // directly. SafeTouchReadCb stays bit-identical for transient-fault
    // tolerance.
    //
    // Synthetic-tap overlay: if s_synth_tap.active and we're still inside the
    // hold window, synthesize PRESSED with the synthetic coords and skip the
    // hardware read this tick. Once the deadline passes, clear `active` and
    // fall through to the real read — the next tick will emit RELEASED and
    // the press→release detector below fires the touch.tap EVT with the
    // synthetic coordinates (identical wire shape to a physical tap).
    static void SentientTouchReadCb(lv_indev_t* indev, lv_indev_data_t* data) {
        if (s_synth_tap.active) {
            if (esp_timer_get_time() < s_synth_tap.release_at_us) {
                data->point.x = s_synth_tap.x;
                data->point.y = s_synth_tap.y;
                data->state   = LV_INDEV_STATE_PRESSED;
            } else {
                s_synth_tap.active = false;
                SafeTouchReadCb(indev, data);
            }
        } else {
            SafeTouchReadCb(indev, data);
        }

        static bool s_was_pressed_last_tick = false;
        static lv_point_t s_last_pressed_point = { 0, 0 };

        const bool is_pressed = (data->state == LV_INDEV_STATE_PRESSED);

        if (is_pressed) {
            s_last_pressed_point = data->point;
            sentient_test_screen_set_touch_xy(data->point.x, data->point.y, true);
        } else if (s_was_pressed_last_tick) {
            // Press → release transition. Emit one tap event with the LAST
            // pressed-tick coordinates; release-tick coords are undefined.
            //
            // ts_us uses %lu not %lld — CONFIG_NEWLIB_NANO_FORMAT=y disables
            // long-long format specifiers in newlib's printf family, which
            // would otherwise emit literal "ld" instead of the number. The
            // (unsigned long) cast drops the upper 32 bits of the microsecond
            // timer (rollover ~71 min — acceptable for tap timestamps which
            // are used for ordering, not wall-clock).
            char json[96];
            snprintf(json, sizeof(json),
                     "{\"event\":\"touch.tap\",\"x\":%ld,\"y\":%ld,\"ts_us\":%lu}",
                     (long)s_last_pressed_point.x,
                     (long)s_last_pressed_point.y,
                     (unsigned long)esp_timer_get_time());
            esp32_devtool_companion_event(json);
            sentient_test_screen_set_touch_xy(0, 0, false);
        }

        s_was_pressed_last_tick = is_pressed;
    }

    void InitializeTouch() {
        ESP_LOGI(TAG, "init.touch.begin bus=%p rst=%d int=%d", (void*)i2c_bus_,
                 PIN_NUM_TOUCH_RST, PIN_NUM_TOUCH_INT);
        esp_lcd_touch_handle_t tp;
        esp_lcd_touch_config_t tp_cfg = {
            .x_max = DISPLAY_WIDTH - 1,
            .y_max = DISPLAY_HEIGHT - 1,
            .rst_gpio_num = PIN_NUM_TOUCH_RST,
            .int_gpio_num = PIN_NUM_TOUCH_INT,
            .levels = {
                .reset = 0,
                .interrupt = 0,
            },
            // CST9217 axis mapping. xiaozhi upstream waveshare AMOLED 2.16
            // shipped {swap_xy=0, mirror_x=1, mirror_y=1} but xiaozhi's UI is
            // button-based — never exercised absolute touch coords. Our
            // SentientTouchReadCb + heatmap dot revealed that the touch chip
            // is rotated 90° counter-clockwise relative to the panel
            // orientation we ship. Empirically calibrated (Phase 2 Task 25
            // — two iterations: first try {swap=1,mx=1,my=0} kept axes
            // inverted; final {swap=1,mx=0,my=1} tracks finger correctly).
            .flags = {
                .swap_xy = 1,
                .mirror_x = 0,
                .mirror_y = 1,
            },
        };
        esp_lcd_panel_io_handle_t tp_io_handle = NULL;
        esp_lcd_panel_io_i2c_config_t tp_io_config = ESP_LCD_TOUCH_IO_I2C_CST9217_CONFIG();
        tp_io_config.scl_speed_hz = 400 * 1000;
        ESP_ERROR_CHECK(esp_lcd_new_panel_io_i2c(i2c_bus_, &tp_io_config, &tp_io_handle));
        ESP_LOGI(TAG, "Initialize touch controller");
        ESP_ERROR_CHECK(esp_lcd_touch_new_i2c_cst9217(tp_io_handle, &tp_cfg, &tp));

        // Register our own LVGL input device with a safe read callback.
        // Bypasses lvgl_port_add_touch (which uses ESP_ERROR_CHECK and aborts
        // on any transient touch-read failure — fatal in a polling loop).
        DisplayLockGuard lock(display_);
        lv_indev_t* indev = lv_indev_create();
        lv_indev_set_type(indev, LV_INDEV_TYPE_POINTER);
        lv_indev_set_read_cb(indev, SentientTouchReadCb);
        lv_indev_set_driver_data(indev, tp);
        lv_indev_set_display(indev, lv_display_get_default());
        ESP_LOGI(TAG, "Touch panel initialized successfully indev=%p", (void*)indev);
    }

    // Seed WiFi credentials so TryWifiConnect() finds an SSID without the
    // user going through the BLE/hotspot config flow.
    // AddSsid is idempotent for the same SSID — safe to call every boot.
    void InjectWifiCredentials() {
        ESP_LOGI(TAG, "inject_wifi ssid=%.32s device_id=" SENTIENT_DEVICE_ID,
                 SENTIENT_WIFI_SSID);
        SsidManager::GetInstance().AddSsid(SENTIENT_WIFI_SSID, SENTIENT_WIFI_PSK);
        ESP_LOGI(TAG, "inject_wifi.done");
    }

    // Seed WS URL + PASETO token so WebsocketProtocol::OpenAudioChannel()
    // picks them up without an OTA-config round-trip.
    // Token is stored raw; WebsocketProtocol prepends "Bearer " automatically
    // when no space is present in the token string.
    void InjectWebsocketConfig() {
        std::string url = build_ws_url();
        ESP_LOGI(TAG, "inject_ws url=%.80s device_id=" SENTIENT_DEVICE_ID,
                 url.c_str());
        Settings ws("websocket", /*read_write=*/true);
        ws.SetString("url", url);
        ws.SetString("token", SENTIENT_PASETO_TOKEN);
        ESP_LOGI(TAG, "inject_ws.done");
    }

public:
    SentientCubeBoard() : boot_button_(BOOT_BUTTON_GPIO) {
        ESP_LOGI(TAG, "ctor begin device_id=" SENTIENT_DEVICE_ID);

#if SENTIENT_DEV_TLS_PIN
        {
            // mbedtls_x509_crt_parse requires PEM length INCLUDING the null
            // terminator (mbedtls docs). EMBED_TXTFILES exposes the null at
            // position end-1, so (end - start) is the full count including
            // null — pass it as-is.
            const size_t cert_len =
                _binary_sentient_dev_gateway_crt_end - _binary_sentient_dev_gateway_crt_start;
            if (cert_len > 0) {
                ESP_LOGI(TAG, "Pinning dev gateway TLS cert (%u bytes, incl null)", (unsigned)cert_len);
                EspSsl::SetCacert(_binary_sentient_dev_gateway_crt_start, cert_len);
            }
        }
#endif

        // Hardware bring-up (verbatim from waveshare init order).
        InitializePowerSaveTimer();
        InitializePowerSaveMonitor();
        InitializeCodecI2c();
        InitializeAxp2101();
        InitializeSpi();
        InitializeDisplay();
        InitializeTouch();
        InitializeButtons();

        // NVS bootstrap (sentient overlay — was inject_*_credentials() in v1).
        InjectWifiCredentials();
        InjectWebsocketConfig();

        // esp32_devtool companion: USB-CDC verb reader + HTTP server on :8081
        // + UDP log relay. Registers info / snapshot / touch / audio providers
        // BEFORE companion_start so they are ready when the HTTP server starts
        // serving on IP_EVENT_STA_GOT_IP.
        //
        // The legacy agent_console + net_logger components were deleted in
        // Task 27. With net_logger gone, the UDP log relay is the only
        // vprintf hook in the chain — flipping CONFIG_ESP32_DEVTOOL_LOG_RELAY_ENABLE
        // back to y (its new default) is safe.
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
        esp32_devtool_set_info_provider(cube_info_provider);
        esp32_devtool_set_snapshot_provider(cube_snapshot_provider);
        esp32_devtool_set_touch_provider(cube_touch_inject);
        esp32_devtool_set_audio_record_provider(cube_audio_record_provider);
        esp32_devtool_set_audio_inject_provider(cube_audio_inject_provider);
        {
            esp32_devtool_companion_config_t devtool_cfg = {};
            devtool_cfg.enable_usb_cdc      = true;
            devtool_cfg.enable_http         = true;
            devtool_cfg.http_port           = CONFIG_ESP32_DEVTOOL_HTTP_PORT;
#if CONFIG_ESP32_DEVTOOL_LOG_RELAY_ENABLE
            devtool_cfg.udp_relay.enabled   = true;
            devtool_cfg.udp_relay.host      = CONFIG_ESP32_DEVTOOL_LOG_RELAY_HOST;
            devtool_cfg.udp_relay.port      = CONFIG_ESP32_DEVTOOL_LOG_RELAY_PORT;
#else
            devtool_cfg.udp_relay.enabled   = false;
#endif
            esp32_devtool_companion_start(&devtool_cfg);
        }
        ESP_LOGI(TAG, "devtool_companion.started");
#endif

        ESP_LOGI(TAG, "ctor end device_id=" SENTIENT_DEVICE_ID);
    }

    virtual AudioCodec* GetAudioCodec() override {
        static BoxAudioCodec audio_codec(
            i2c_bus_,
            AUDIO_INPUT_SAMPLE_RATE,
            AUDIO_OUTPUT_SAMPLE_RATE,
            AUDIO_I2S_GPIO_MCLK,
            AUDIO_I2S_GPIO_BCLK,
            AUDIO_I2S_GPIO_WS,
            AUDIO_I2S_GPIO_DOUT,
            AUDIO_I2S_GPIO_DIN,
            AUDIO_CODEC_PA_PIN,
            AUDIO_CODEC_ES8311_ADDR,
            AUDIO_CODEC_ES7210_ADDR,
            AUDIO_INPUT_REFERENCE);
        return &audio_codec;
    }

    virtual Display* GetDisplay() override {
        return display_;
    }

    virtual Backlight* GetBacklight() override {
        return backlight_;
    }

    virtual bool GetBatteryLevel(int& level, bool& charging,
                                 bool& discharging) override {
        static bool last_discharging = false;
        charging = pmic_->IsCharging();
        discharging = pmic_->IsDischarging();
        if (discharging != last_discharging) {
            power_save_timer_->SetEnabled(discharging);
            last_discharging = discharging;
        }

        level = pmic_->GetBatteryLevel();
        return true;
    }

    virtual void SetPowerSaveLevel(PowerSaveLevel level) override {
        if (level != PowerSaveLevel::LOW_POWER) {
            power_save_timer_->WakeUp();
        }
        WifiBoard::SetPowerSaveLevel(level);
    }
};

DECLARE_BOARD(SentientCubeBoard);
