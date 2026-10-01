#include "cube_views.h"
#include "qrcodegen.h" // Existing firmware encoder; host compiles same source.
#include <src/misc/cache/instance/lv_image_cache.h>
#include <cstring>
#include <algorithm>
#include <new>

namespace sentient::cube {
namespace {
constexpr size_t kQrPixelBytes = 8 + kPairingQrSize * kPairingQrSize / 8;
void visible(lv_obj_t* object, bool show) {
    if (show) lv_obj_remove_flag(object, LV_OBJ_FLAG_HIDDEN);
    else lv_obj_add_flag(object, LV_OBJ_FLAG_HIDDEN);
}
const char* caption(CubeScene s) {
    switch (s) {
        case CubeScene::Pairing: return "Finish in app";
        case CubeScene::NoWifi: return "No Wi-Fi";
        case CubeScene::Service: return "Can't connect";
        case CubeScene::Account: return "Open app";
        case CubeScene::Low: return "Charge soon";
        default: return "";
    }
}
}
View::~View() { if (screen_) lv_obj_delete(screen_); }
void View::create_screen(uint32_t background) {
    screen_ = lv_obj_create(nullptr);
    lv_obj_set_style_bg_color(screen_, lv_color_hex(background), 0);
    lv_obj_set_style_bg_opa(screen_, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(screen_, 0, 0);
    lv_obj_set_style_pad_all(screen_, 0, 0);
    lv_obj_remove_flag(screen_, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_event_cb(screen_, [](lv_event_t* event) {
        static_cast<View*>(lv_event_get_user_data(event))->exit();
    }, LV_EVENT_SCREEN_UNLOAD_START, this);
    // Boot/setup receive release edges but never own capture.
    lv_obj_add_flag(screen_, LV_OBJ_FLAG_CLICKABLE);
    for (auto code : {LV_EVENT_PRESSED, LV_EVENT_RELEASED, LV_EVENT_PRESS_LOST}) {
        lv_obj_add_event_cb(screen_, [](lv_event_t* event) {
            static_cast<ViewHost*>(lv_event_get_user_data(event))->input(lv_event_get_code(event));
        }, code, &host_);
    }
}
void View::enter() { lv_screen_load(screen_); }
void BootView::create() {
    if (screen_) return;
    create_screen(0x2b2621);
    status_ = lv_label_create(screen_);
    lv_label_set_text(status_, "Starting...");
    lv_obj_set_style_text_color(status_, lv_color_hex(0xf2e8d6), 0);
    lv_obj_center(status_);
}
void BootView::fail() {
    lv_label_set_text(status_, "Resources unavailable\nRestart or reflash by USB");
    lv_obj_set_style_text_align(status_, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_center(status_);
}
SetupView::~SetupView() {
    // Delete canvas before releasing its backing bytes; drop cached descriptors too.
    if (screen_) { lv_obj_delete(screen_); screen_ = nullptr; }
    if (pixels_) lv_image_cache_drop(&image_);
}
bool SetupView::create() {
    if (screen_) return true;
    // One bounded ordinary allocation: firmware's large-allocation policy uses PSRAM.
    pixels_.reset(new (std::nothrow) uint8_t[kQrPixelBytes]{});
    if (!pixels_) return false; // No setup widgets or partial canvas published.
    create_screen(0x2b2621);
    lv_obj_set_style_text_font(screen_, host_.text_font(), 0);
    plate_ = lv_obj_create(screen_);
    lv_obj_set_size(plate_, kPairingQrSize, kPairingQrSize);
    lv_obj_align(plate_, LV_ALIGN_CENTER, 0, kPairingQrCenterY);
    lv_obj_set_style_bg_color(plate_, lv_color_white(), 0);
    lv_obj_set_style_border_width(plate_, 0, 0);
    lv_obj_set_style_radius(plate_, 0, 0);
    lv_obj_set_style_pad_all(plate_, 0, 0);
    lv_obj_remove_flag(plate_, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_remove_flag(plate_, LV_OBJ_FLAG_SCROLLABLE);
    code_ = lv_image_create(plate_);
    lv_obj_center(code_);
    locator_ = lv_label_create(screen_);
    lv_obj_align(locator_, LV_ALIGN_TOP_MID, 0, kPairingLocatorY);
    title_ = lv_label_create(screen_);
    lv_label_set_text(title_, "Pairing code");
    lv_obj_align(title_, LV_ALIGN_TOP_MID, 0, kPairingTitleY);
    proof_ = lv_label_create(screen_);
    lv_obj_set_width(proof_, 300);
    lv_label_set_long_mode(proof_, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(proof_, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_line_space(proof_, 5, 0);
    lv_obj_align(proof_, LV_ALIGN_TOP_MID, 0, kPairingProofY);
    for (auto* label : {locator_, title_, proof_}) {
        lv_obj_set_style_text_font(label, &lv_font_montserrat_14, 0);
        lv_obj_set_style_text_color(label, lv_color_hex(0xf2e8d6), 0);
    }
    image_.header.magic = LV_IMAGE_HEADER_MAGIC;
    image_.header.cf = LV_COLOR_FORMAT_I1;
    image_.header.w = image_.header.h = kPairingQrSize;
    image_.header.stride = kPairingQrSize / 8;
    image_.data_size = kQrPixelBytes; image_.data = pixels_.get();
    pairing("", "", "");
    return true;
}
void SetupView::pairing(const char* payload, const char* locator, const char* proof) {
    if (!code_) return;
    if (strcmp(lv_label_get_text(locator_), locator)) lv_label_set_text(locator_, locator);
    const auto grouped = cube_group_pairing_proof(proof);
    if (strcmp(lv_label_get_text(proof_), grouped.c_str())) lv_label_set_text(proof_, grouped.c_str());
    if (payload_ != payload) {
        payload_ = payload;
        lv_image_cache_drop(&image_);
        memset(pixels_.get(), 0, kQrPixelBytes);
        const uint32_t palette[] = {0xffffffff, 0xff000000};
        memcpy(pixels_.get(), palette, sizeof(palette));
        if (!payload_.empty()) {
            uint8_t temporary[qrcodegen_BUFFER_LEN_FOR_VERSION(12)];
            uint8_t code[qrcodegen_BUFFER_LEN_FOR_VERSION(12)];
            if (!qrcodegen_encodeText(payload, temporary, code, qrcodegen_Ecc_MEDIUM,
                                     1, 12, qrcodegen_Mask_AUTO, true)) {
                payload_.clear();
            } else {
                const int modules = qrcodegen_getSize(code);
                const int scale = kPairingQrSize / (modules + 8);
                const int inset = (kPairingQrSize - modules * scale) / 2;
                for (int y = 0; y < modules; ++y) for (int x = 0; x < modules; ++x) {
                    if (!qrcodegen_getModule(code, x, y)) continue;
                    for (int dy = 0; dy < scale; ++dy) for (int dx = 0; dx < scale; ++dx) {
                        const int px = inset + x * scale + dx, py = inset + y * scale + dy;
                        pixels_[8 + py * (kPairingQrSize / 8) + px / 8] |= 0x80 >> (px % 8);
                    }
                }
            }
        }
        lv_image_set_src(code_, &image_);
        lv_obj_invalidate(code_);
    }
    visible(plate_, !payload_.empty());
    visible(title_, !payload_.empty());
    visible(proof_, !payload_.empty());
    if (payload_.empty()) lv_label_set_text(locator_, "Finish setup in app");
}
bool SetupView::protected_visible() const {
    return screen_ && lv_screen_active() == screen_ && plate_ && !lv_obj_has_flag(plate_, LV_OBJ_FLAG_HIDDEN);
}
void SetupView::exit() {
    pairing("", "", "");
    lv_image_cache_drop(&image_);
}
MainView::~MainView() { if (timer_) lv_timer_delete(timer_); }
bool MainView::prepare(ResourceReader reader) {
    return character_.load(reader) && assets_.load(reader);
}
void MainView::create() {
    if (screen_) return;
    create_screen(character_.document().background);
    lv_obj_set_style_text_font(screen_, host_.text_font(), 0);
    // 480px panel: 64px inset, 44px meta, 352x272 scene at (64,108).
    // Character (112,116)..(368,372); 32px RGB565 source scaled 8x by
    // LVGL nearest-neighbor. Extended draw bounds include full transformed
    // image; only sprite_ changes on frame ticks, not the bubble or header.
    ground_ = lv_obj_create(screen_);
    lv_obj_set_size(ground_, 216, 8);
    lv_obj_align(ground_, LV_ALIGN_CENTER, 0, 122);
    lv_obj_set_style_bg_color(ground_, lv_color_hex(0x241f1b), 0);
    lv_obj_set_style_border_width(ground_, 0, 0);
    lv_obj_set_style_radius(ground_, 0, 0);
    lv_obj_set_style_pad_all(ground_, 0, 0);
    lv_obj_remove_flag(ground_, LV_OBJ_FLAG_CLICKABLE);

    sprite_ = lv_image_create(screen_);
    lv_image_set_pivot(sprite_, character_.document().width / 2, character_.document().height / 2);
    lv_image_set_scale(sprite_, LV_SCALE_NONE * 256 / std::max(character_.document().width, character_.document().height));
    lv_image_set_antialias(sprite_, false);
    lv_obj_align(sprite_, LV_ALIGN_CENTER, 0, 4);
    lv_obj_remove_flag(sprite_, LV_OBJ_FLAG_CLICKABLE);
    // Opaque RGB565 matte would cover ground_ otherwise; ground_ starts below
    // the art baseline (y358), so this cannot cover cat pixels.
    lv_obj_move_to_index(ground_, -1);

    voice_cue_ = lv_image_create(screen_);
    lv_image_set_src(voice_cue_, assets_.bubble(false));
    lv_obj_align(voice_cue_, LV_ALIGN_CENTER, 140, -94); // (344,110), 72x72
    lv_obj_remove_flag(voice_cue_, LV_OBJ_FLAG_CLICKABLE);
    bubble_glyph_ = lv_image_create(screen_);
    lv_obj_align(bubble_glyph_, LV_ALIGN_CENTER, 140, -98); // (362,124), 8px bottom padding
    lv_obj_remove_flag(bubble_glyph_, LV_OBJ_FLAG_CLICKABLE);

    top_glyph_ = lv_image_create(screen_);
    lv_obj_align(top_glyph_, LV_ALIGN_TOP_LEFT, 64, 68); // 36x36
    lv_obj_remove_flag(top_glyph_, LV_OBJ_FLAG_CLICKABLE);
    record_dot_ = lv_obj_create(screen_);
    lv_obj_set_size(record_dot_, 12, 12);
    lv_obj_align(record_dot_, LV_ALIGN_TOP_LEFT, 110, 80);
    lv_obj_set_style_bg_color(record_dot_, lv_color_hex(0xf2a06a), 0);
    lv_obj_set_style_radius(record_dot_, 0, 0);
    lv_obj_set_style_border_width(record_dot_, 0, 0);
    lv_obj_set_style_pad_all(record_dot_, 0, 0);
    lv_obj_remove_flag(record_dot_, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_flag(record_dot_, LV_OBJ_FLAG_HIDDEN);
    battery_glyph_ = lv_image_create(screen_);
    lv_image_set_src(battery_glyph_, assets_.battery(0, false, false));
    lv_obj_align(battery_glyph_, LV_ALIGN_TOP_RIGHT, -64, 69); // 54x34
    lv_obj_remove_flag(battery_glyph_, LV_OBJ_FLAG_CLICKABLE);
    for (int i = 0; i < 5; ++i) {
        volume_level_[i] = lv_obj_create(screen_);
        lv_obj_set_size(volume_level_[i], 28, 12);
        lv_obj_align(volume_level_[i], LV_ALIGN_CENTER, (i - 2) * 36, 152);
        lv_obj_set_style_border_width(volume_level_[i], 0, 0);
        lv_obj_set_style_radius(volume_level_[i], 0, 0);
        lv_obj_set_style_bg_color(volume_level_[i], lv_color_hex(0x4a4138), 0);
        lv_obj_remove_flag(volume_level_[i], LV_OBJ_FLAG_CLICKABLE);
        lv_obj_add_flag(volume_level_[i], LV_OBJ_FLAG_HIDDEN);
    }
    // Entire visible scene is one touch target; children never own capture.
    status_ = lv_label_create(screen_);
    lv_obj_align(status_, LV_ALIGN_TOP_MID, 0, 380);
    lv_obj_set_style_text_color(status_, lv_color_hex(0xf2e8d6), 0);
    timer_ = lv_timer_create([](lv_timer_t* timer) {
        static_cast<MainView*>(lv_timer_get_user_data(timer))->paint();
    }, 900, this);
    lv_timer_pause(timer_);
}
void MainView::volume(int percent) {
    percent = percent < 0 ? 0 : percent > 100 ? 100 : percent;
    if (!screen_ || volume_percent_ == percent) return;
    volume_percent_ = percent;
    for (int i = 0; i < 5; ++i)
        lv_obj_set_style_bg_color(volume_level_[i],
            lv_color_hex(i < (percent + 19) / 20 ? 0xf2a06a : 0x4a4138), 0);
}
void MainView::battery(int percent, bool charging, bool low) {
    if (!screen_ || (battery_percent_ == percent && charging_ == charging && low_ == low)) return;
    battery_percent_ = percent; charging_ = charging; low_ = low;
    lv_image_set_src(battery_glyph_, assets_.battery(percent, charging, low));
}
bool MainView::accepts_input() const {
    return projected_ && (scene_ == CubeScene::Ready || scene_ == CubeScene::Charging ||
        scene_ == CubeScene::Low || scene_ == CubeScene::Volume || scene_ == CubeScene::Listening ||
        scene_ == CubeScene::Thinking || scene_ == CubeScene::Speaking);
}
bool MainView::animating() const { return animating_; }
void MainView::exit() {
    host_.cancel_input();
    if (timer_) lv_timer_pause(timer_);
    character_.stop(); animating_ = false; projected_ = false;
}
void MainView::paint() {
    if (lv_screen_active() != screen_ || scene_ == CubeScene::Sleep) {
        lv_timer_pause(timer_); character_.stop(); animating_ = false; return;
    }
    const auto frame = character_.sample(lv_tick_get());
    if (frame.image && lv_image_get_src(sprite_) != frame.image) lv_image_set_src(sprite_, frame.image);
    visible(sprite_, frame.image != nullptr);
    animating_ = frame.next_ms != 0;
    if (frame.next_ms) {
        lv_timer_set_period(timer_, frame.next_ms);
        lv_timer_reset(timer_); lv_timer_resume(timer_);
    } else lv_timer_pause(timer_);
}
void MainView::project(CubeScene next) {
    if (!screen_ || (projected_ && scene_ == next)) return;
    scene_ = next; projected_ = true;
    lv_timer_pause(timer_); // Cancel old clip's wakeup before selecting new clip.
    character_.select(next, lv_tick_get());
    if (!accepts_input()) host_.cancel_input();
    lv_label_set_text(status_, caption(next));
    visible(status_, *caption(next));
    const auto visual = cube_visual(next); // Recording truth is never document-owned.
    const bool awake = next != CubeScene::Sleep;
    visible(top_glyph_, awake); visible(battery_glyph_, awake);
    if (awake) lv_image_set_src(top_glyph_, assets_.icon(visual.status,
        visual.recording || next == CubeScene::Speaking));
    visible(record_dot_, visual.recording);
    for (auto* item : {ground_, voice_cue_, bubble_glyph_}) visible(item, awake);
    if (awake) {
        lv_image_set_src(voice_cue_, assets_.bubble(visual.capturing_bubble));
        lv_image_set_src(bubble_glyph_, assets_.icon(visual.bubble, false, visual.capturing_bubble));
    }
    for (auto* item : volume_level_) visible(item, next == CubeScene::Volume);
    if (!awake) { visible(sprite_, false); animating_ = false; }
    else paint();
}
ViewHost::ViewHost(ResourceReader reader, VoiceInput voice, void* context, const lv_font_t* text_font)
    : reader_(reader), voice_(voice), context_(context), text_font_(text_font),
      boot_(*this), setup_(*this), main_(*this) {}
void ViewHost::create() {
    if (active_) return;
    boot_.create(); show(boot_);
}
void ViewHost::show(View& next) {
    if (active_ == &next && lv_screen_active() == next.screen()) return;
    cancel_input();
    if (active_) active_->exit();
    active_ = &next; next.enter();
}
void ViewHost::finish_boot(bool assets_ready, const lv_font_t* text_font) {
    create();
    if (finished_) return;
    finished_ = true;
    if (!assets_ready || !main_.prepare(reader_)) { boot_.fail(); return; }
    if (text_font) text_font_ = text_font;
    main_.create(); ready_ = true;
    project(scene_);
}
void ViewHost::project(CubeScene scene) {
    scene_ = scene;
    if (!ready_) return;
    if (scene == CubeScene::Setup) {
        cancel_input(); // Release owned capture before allocating setup widgets.
        if (!setup_.create()) {
            ready_ = false; // Terminal error, no allocation retry on every poll.
            show(boot_); boot_.fail(); return;
        }
        show(setup_);
        setup_.pairing(qr_.c_str(), locator_.c_str(), proof_.c_str());
    } else {
        show(main_); main_.project(scene);
        main_.volume(volume_); main_.battery(battery_, charging_, low_);
    }
}
void ViewHost::pairing(const char* payload, const char* locator, const char* proof) {
    qr_ = payload; locator_ = locator; proof_ = proof;
    if (active_ == &setup_) setup_.pairing(payload, locator, proof);
}
void ViewHost::volume(int percent) { volume_ = percent; if (ready_) main_.volume(percent); }
void ViewHost::battery(int percent, bool charging, bool low) {
    battery_ = percent; charging_ = charging; low_ = low;
    if (ready_) main_.battery(percent, charging, low);
}
void ViewHost::input(lv_event_code_t event) {
    if (event == LV_EVENT_PRESSED) {
        if (blocked_ || pressed_) return;
        if (active_ != &main_ || lv_screen_active() != main_.screen() || !main_.accepts_input()) {
            blocked_ = true; return;
        }
        pressed_ = true; if (voice_) voice_(context_, true);
    } else {
        if (pressed_ && voice_) voice_(context_, false);
        pressed_ = false;
        // PRESS_LOST does not prove physical release (e.g. transient I2C error).
        blocked_ = event != LV_EVENT_RELEASED;
    }
}
void ViewHost::cancel_input() {
    if (!pressed_) return;
    if (voice_) voice_(context_, false);
    pressed_ = false; blocked_ = true;
}
void ViewHost::suspend() {
    cancel_input(); if (active_) active_->exit(); active_ = nullptr;
}
bool ViewHost::protected_visible() const { return setup_.protected_visible(); }
} // namespace sentient::cube
