// Shipping shared views, source-pack aliases and deterministic snapshot clock.
#include "cube_views.h"
#include "source_resources.h"
#include "sdl2_driver.h"
#include <SDL.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <new>

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"
using namespace sentient::cube;
// Host-only fault injection: production uses ordinary owned nothrow allocation.
static constexpr size_t kQrAllocationBytes = 8 + kPairingQrSize * kPairingQrSize / 8;
static unsigned qr_allocations = 0;
static bool fail_qr_allocation = false;
void* operator new[](size_t size, const std::nothrow_t&) noexcept {
    if (size == kQrAllocationBytes) {
        ++qr_allocations;
        if (fail_qr_allocation) return nullptr;
    }
    try { return ::operator new[](size); }
    catch (const std::bad_alloc&) { return nullptr; }
}
static_assert(sizeof(SetupView) < 512, "SetupView must not reserve inline QR pixels");
static uint32_t clock_ms = 1;
static bool deterministic = false;
static uint32_t tick_ms() { return deterministic ? clock_ms : SDL_GetTicks(); }
static void advance(uint32_t delta) {
    while (delta) {
        const auto step = std::min(delta, uint32_t(5));
        clock_ms += step; delta -= step; lv_timer_handler();
    }
    lv_refr_now(nullptr);
}
#define CHECK(condition) do { if (!(condition)) { \
    std::fprintf(stderr, "check failed at line %d: %s\n", __LINE__, #condition); return 1; \
} } while (0)
struct VoiceProbe {
    unsigned starts = 0, stops = 0;
    static void input(void* context, bool pressed) {
        auto& probe = *static_cast<VoiceProbe*>(context);
        if (pressed) ++probe.starts; else ++probe.stops;
    }
};
static const uint8_t* frame_pixels(ViewHost& host) {
    auto* frame = static_cast<const lv_image_dsc_t*>(host.main().frame_source());
    return frame ? frame->data : nullptr;
}
static lv_obj_t* label_named(lv_obj_t* screen, const char* text) {
    for (uint32_t i = 0; i < lv_obj_get_child_count(screen); ++i) {
        auto* child = lv_obj_get_child(screen, i);
        if (lv_obj_check_type(child, &lv_label_class) && !strcmp(lv_label_get_text(child), text)) return child;
    }
    return nullptr;
}
static int exercise_views() {
    const unsigned allocations_before = qr_allocations;
    SourceResources resources; VoiceProbe voice;
    const lv_font_t loaded_font = lv_font_montserrat_28; // Distinct platform-owned font handle.
    ViewHost host(resources.reader(), VoiceProbe::input, &voice);
    host.create();
    CHECK(host.in_boot() && resources.reads == 0 && !host.main().screen());
    auto* boot_label = label_named(lv_screen_active(), "Starting...");
    CHECK(boot_label && lv_obj_get_style_text_font(boot_label, LV_PART_MAIN) == LV_FONT_DEFAULT);
    lv_obj_send_event(lv_screen_active(), LV_EVENT_PRESSED, nullptr);
    CHECK(voice.starts == 0);
    lv_obj_send_event(lv_screen_active(), LV_EVENT_RELEASED, nullptr);
    // QR is disposable test data. Never exported via snapshot.
    host.pairing("SIM-ONLY-DISPOSABLE-SETUP", "SIM", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq");
    host.project(CubeScene::Ready);
    CHECK(resources.reads == 0 && !host.main().animating());
    // Model ApplyTextFont's post-boot root style and adapter's resolved-font handoff.
    lv_obj_set_style_text_font(lv_screen_active(), &loaded_font, 0);
    host.finish_boot(true, lv_obj_get_style_text_font(lv_screen_active(), LV_PART_MAIN)); advance(40);
    CHECK(host.boot_ready() && !host.in_setup() && qr_allocations == allocations_before);
    host.project(CubeScene::Setup); advance(40);
    CHECK(host.in_setup() && host.protected_visible() && qr_allocations == allocations_before + 1);
    auto* qr_widget = lv_obj_get_child(lv_obj_get_child(lv_screen_active(), 0), 0);
    const auto* qr_image = static_cast<const lv_image_dsc_t*>(lv_image_get_src(qr_widget));
    CHECK(qr_image && qr_image->data && qr_image->data_size == kQrAllocationBytes);
    const auto* qr_backing = qr_image->data;
    CHECK(lv_obj_get_style_text_font(lv_screen_active(), LV_PART_MAIN) == &loaded_font);
    auto* pairing_title = label_named(lv_screen_active(), "Pairing code");
    CHECK(pairing_title && lv_obj_get_style_text_font(pairing_title, LV_PART_MAIN) == &lv_font_montserrat_14);
    lv_obj_send_event(lv_screen_active(), LV_EVENT_PRESSED, nullptr);
    CHECK(voice.starts == 0);
    lv_obj_send_event(lv_screen_active(), LV_EVENT_RELEASED, nullptr);
    host.project(CubeScene::Ready);
    CHECK(!host.protected_visible() && host.main().animating());
    const auto* ready = frame_pixels(host);
    CHECK(ready == resources.buffers.at("/companions/cat/ready.rgb565").data());
    advance(3300);
    CHECK(frame_pixels(host) == resources.buffers.at("/companions/cat/blink.rgb565").data());
    host.project(CubeScene::Ready); // Unchanged projection cannot restart clip.
    CHECK(frame_pixels(host) != ready);
    advance(120); CHECK(frame_pixels(host) == ready);
    lv_obj_send_event(lv_screen_active(), LV_EVENT_PRESSED, nullptr);
    CHECK(voice.starts == 1 && host.pressed());
    host.project(CubeScene::Setup);
    CHECK(voice.stops == 1 && !host.pressed() && !host.main().animating());
    CHECK(qr_image->data == qr_backing && qr_allocations == allocations_before + 1);
    advance(40); // Re-render same stable canvas backing after exit/re-entry.
    const auto* hidden = frame_pixels(host);
    advance(10000); CHECK(frame_pixels(host) == hidden);
    host.project(CubeScene::Ready);
    lv_obj_send_event(lv_screen_active(), LV_EVENT_PRESSED, nullptr);
    CHECK(voice.starts == 1); // Exit cancelled held input; release required.
    lv_obj_send_event(lv_screen_active(), LV_EVENT_RELEASED, nullptr);
    lv_obj_send_event(lv_screen_active(), LV_EVENT_PRESSED, nullptr);
    CHECK(voice.starts == 2);
    lv_obj_send_event(lv_screen_active(), LV_EVENT_PRESS_LOST, nullptr);
    CHECK(voice.stops == 2);
    lv_obj_send_event(lv_screen_active(), LV_EVENT_PRESSED, nullptr);
    CHECK(voice.starts == 2);
    lv_obj_send_event(lv_screen_active(), LV_EVENT_RELEASED, nullptr);
    host.project(CubeScene::Listening);
    CHECK(frame_pixels(host) == resources.buffers.at("/companions/cat/listening.rgb565").data());
    advance(900);
    CHECK(frame_pixels(host) == resources.buffers.at("/companions/cat/listening-blink.rgb565").data());
    host.project(CubeScene::Thinking); CHECK(frame_pixels(host) == ready);
    advance(180);
    CHECK(frame_pixels(host) == resources.buffers.at("/companions/cat/thinking.rgb565").data());
    host.project(CubeScene::Speaking);
    CHECK(frame_pixels(host) == resources.buffers.at("/companions/cat/speaking.rgb565").data());
    host.project(CubeScene::NoWifi); // Offline does not return to BootView.
    CHECK(!host.in_boot());
    auto* main_caption = label_named(host.main().screen(), "No Wi-Fi");
    CHECK(main_caption && lv_obj_get_style_text_font(main_caption, LV_PART_MAIN) == &loaded_font);
    advance(40); // Render inherited post-boot font through real LVGL.
    CHECK(frame_pixels(host) == resources.buffers.at("/companions/cat/offline.rgb565").data());
    lv_obj_send_event(lv_screen_active(), LV_EVENT_PRESSED, nullptr);
    CHECK(voice.starts == 2);
    lv_obj_send_event(lv_screen_active(), LV_EVENT_RELEASED, nullptr);
    host.project(CubeScene::Ready);
    lv_obj_send_event(lv_screen_active(), LV_EVENT_PRESSED, nullptr);
    host.project(CubeScene::Sleep);
    CHECK(voice.stops == 3 && !host.main().animating());
    host.project(CubeScene::Ready);
    lv_obj_send_event(lv_screen_active(), LV_EVENT_RELEASED, nullptr);
    lv_obj_send_event(lv_screen_active(), LV_EVENT_PRESSED, nullptr);
    auto* external = lv_obj_create(nullptr); lv_screen_load(external);
    CHECK(voice.stops == 4 && !host.main().animating());
    host.project(CubeScene::Ready); lv_obj_delete(external);
    CHECK(host.main().animating());
    {
        SourceResources bad; ViewHost error(bad.reader(), VoiceProbe::input, &voice);
        error.create(); error.finish_boot(false, &loaded_font); error.project(CubeScene::Ready);
        CHECK(error.in_boot() && !error.boot_ready() && bad.reads == 0);
        CHECK(lv_obj_get_style_text_font(lv_screen_active(), LV_PART_MAIN) == LV_FONT_DEFAULT);
        error.finish_boot(true); CHECK(bad.reads == 0); // Terminal failure, no retry loop.
        lv_obj_send_event(lv_screen_active(), LV_EVENT_PRESSED, nullptr);
        CHECK(voice.starts == 4);
    }
    {
        SourceResources bad; bad.missing = "/ui/bubble-active.rgb565";
        ViewHost error(bad.reader()); error.create(); error.finish_boot(true);
        CHECK(error.in_boot() && !error.boot_ready() && !error.main().animating());
    }
    {
        SourceResources source; VoiceProbe held;
        ViewHost error(source.reader(), VoiceProbe::input, &held);
        error.create(); error.project(CubeScene::Ready); error.finish_boot(true, &loaded_font);
        CHECK(error.boot_ready());
        lv_obj_send_event(lv_screen_active(), LV_EVENT_PRESSED, nullptr);
        CHECK(held.starts == 1 && error.pressed());
        const unsigned before_failure = qr_allocations;
        fail_qr_allocation = true;
        error.project(CubeScene::Setup);
        CHECK(error.in_boot() && !error.boot_ready() && !error.main().animating());
        CHECK(held.stops == 1 && !error.pressed() && !error.protected_visible());
        CHECK(label_named(lv_screen_active(), "Resources unavailable\nRestart or reflash by USB"));
        error.project(CubeScene::Setup); error.finish_boot(true, &loaded_font);
        CHECK(qr_allocations == before_failure + 1); // Failed allocation never retried by poll.
        lv_obj_send_event(lv_screen_active(), LV_EVENT_PRESSED, nullptr);
        CHECK(held.starts == 1); // Controlled error cannot capture.
        fail_qr_allocation = false;
    }
    {
        SourceResources source;
        ViewHost setup(source.reader()); setup.create();
        setup.pairing("SIM-ONLY-DISPOSABLE-SETUP", "SIM", "test-proof");
        setup.project(CubeScene::Setup); setup.finish_boot(true, &loaded_font); advance(40);
        CHECK(setup.protected_visible());
    } // Destroy active canvas while backing bytes still live; sanitizers cover teardown.
    std::printf("shared view/input/lifecycle checks passed (ViewHost=%zu SetupView=%zu QR heap=%zu)\n",
                sizeof(ViewHost), sizeof(SetupView), kQrAllocationBytes);
    return 0;
}
static int snapshot(const char* path, ViewHost& host) {
    // Same protection as firmware. No flag or diagnostic path bypasses setup QR.
    if (host.protected_visible() || host.in_setup()) {
        std::fputs("setup snapshot denied\n", stderr); return 2;
    }
    int width, height;
    const uint8_t* fb = sentient_sim_sdl2_framebuffer(&width, &height);
    if (!fb) return 3;
    std::vector<uint8_t> rgb(size_t(width) * height * 3);
    for (size_t i = 0; i < size_t(width) * height; ++i) {
        const uint16_t v = uint16_t(fb[2 * i]) | (uint16_t(fb[2 * i + 1]) << 8);
        const uint8_t r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
        rgb[3 * i] = (r << 3) | (r >> 2);
        rgb[3 * i + 1] = (g << 2) | (g >> 4);
        rgb[3 * i + 2] = (b << 3) | (b >> 2);
    }
    return stbi_write_png(path, width, height, 3, rgb.data(), width * 3) ? 0 : 4;
}
static bool scene_named(const char* name, CubeScene& scene) {
    const std::pair<const char*, CubeScene> scenes[] = {
        {"ready", CubeScene::Ready}, {"setup", CubeScene::Setup}, {"sleep", CubeScene::Sleep},
        {"pairing", CubeScene::Pairing}, {"listening", CubeScene::Listening},
        {"thinking", CubeScene::Thinking}, {"speaking", CubeScene::Speaking},
        {"offline", CubeScene::NoWifi}, {"service", CubeScene::Service},
        {"account", CubeScene::Account}, {"volume", CubeScene::Volume},
        {"low", CubeScene::Low}, {"charging", CubeScene::Charging}};
    for (const auto& item : scenes) if (!strcmp(name, item.first)) { scene = item.second; return true; }
    return false;
}
int main(int argc, char** argv) {
    const char* out = nullptr; CubeScene scene = CubeScene::Ready;
    uint32_t at_ms = 0; bool self_test = false, boot_error = false, pending = false;
    for (int i = 1; i < argc; ++i) {
        if (!strcmp(argv[i], "--snapshot") && i + 1 < argc) out = argv[++i];
        else if (!strcmp(argv[i], "--scene") && i + 1 < argc) {
            if (!scene_named(argv[++i], scene)) return 1;
        } else if (!strcmp(argv[i], "--at-ms") && i + 1 < argc) {
            char* end; const unsigned long value = strtoul(argv[++i], &end, 10);
            if (*end || value > 60000) return 1;
            at_ms = value;
        } else if (!strcmp(argv[i], "--self-test")) self_test = true;
        else if (!strcmp(argv[i], "--boot-error")) boot_error = true;
        else if (!strcmp(argv[i], "--not-ready")) pending = true;
        else { std::fputs("unknown/missing simulator argument\n", stderr); return 1; }
    }
    deterministic = out || self_test;
    if (deterministic) SDL_setenv("SDL_VIDEODRIVER", "dummy", 1);
    lv_init(); lv_tick_set_cb(tick_ms);
    if (sentient_sim_sdl2_init(480, 480)) return 1;
    int result = 0;
    if (self_test) result = exercise_views();
    else {
        SourceResources resources; VoiceProbe voice;
        ViewHost host(resources.reader(), VoiceProbe::input, &voice);
        host.create(); host.volume(65); host.battery(42, scene == CubeScene::Charging, scene == CubeScene::Low);
        host.pairing("SIM-ONLY-DISPOSABLE-SETUP", "SIM", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq");
        host.project(scene);
        if (!pending) host.finish_boot(!boot_error, &lv_font_montserrat_28);
        if (out) { advance(at_ms); result = snapshot(out, host); }
        else while (sentient_sim_sdl2_pump_events()) { lv_timer_handler(); SDL_Delay(5); }
    }
    sentient_sim_sdl2_shutdown(); lv_deinit();
    return result;
}
