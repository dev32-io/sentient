#pragma once
#include "character_data.h"
#include "cube_visual_assets.h"
#include "cube_pairing_display.h"
#include <lvgl.h>
#include <string>
#include <memory>

namespace sentient::cube {
using VoiceInput = void (*)(void*, bool);
class ViewHost;
class View {
public:
    explicit View(ViewHost& host) : host_(host) {}
    virtual ~View();
    virtual void enter();
    virtual void exit() {}
    lv_obj_t* screen() const { return screen_; }
protected:
    void create_screen(uint32_t background);
    ViewHost& host_;
    lv_obj_t* screen_ = nullptr;
};
class BootView final : public View {
public:
    using View::View;
    void create();
    void fail();
private:
    lv_obj_t* status_ = nullptr;
};
class SetupView final : public View {
public:
    using View::View;
    ~SetupView() override;
    bool create();
    void pairing(const char* payload, const char* locator, const char* proof);
    bool protected_visible() const;
    void exit() override;
private:
    lv_obj_t *plate_ = nullptr, *code_ = nullptr, *locator_ = nullptr, *title_ = nullptr, *proof_ = nullptr;
    std::string payload_;
    std::unique_ptr<uint8_t[]> pixels_;
    lv_image_dsc_t image_{};
};
class MainView final : public View {
public:
    using View::View;
    ~MainView() override;
    bool prepare(ResourceReader reader);
    void create();
    void exit() override;
    void project(CubeScene scene);
    void volume(int percent);
    void battery(int percent, bool charging, bool low);
    void paint();
    bool accepts_input() const;
    CubeScene scene() const { return scene_; }
    lv_obj_t* sprite() const { return sprite_; }
    lv_obj_t* voice_cue() const { return voice_cue_; }
    const void* frame_source() const { return sprite_ ? lv_image_get_src(sprite_) : nullptr; }
    bool animating() const;
private:
    CharacterData character_;
    CubeVisualAssets assets_;
    lv_obj_t *sprite_ = nullptr, *status_ = nullptr, *top_glyph_ = nullptr, *battery_glyph_ = nullptr;
    lv_obj_t *record_dot_ = nullptr, *ground_ = nullptr, *voice_cue_ = nullptr, *bubble_glyph_ = nullptr;
    lv_obj_t* volume_level_[5]{};
    lv_timer_t* timer_ = nullptr;
    CubeScene scene_ = CubeScene::Sleep;
    bool projected_ = false, animating_ = false;
    int volume_percent_ = -1, battery_percent_ = -1;
    bool charging_ = false, low_ = false;
};
// One active view, no navigation stack. Every method runs on LVGL's owner.
class ViewHost {
public:
    ViewHost(ResourceReader reader, VoiceInput voice = nullptr, void* context = nullptr,
             const lv_font_t* text_font = LV_FONT_DEFAULT);
    void create(); // Asset-independent BootView only.
    // Font storage remains platform-owned for the UI lifetime; BootView is independent.
    void finish_boot(bool assets_ready, const lv_font_t* text_font = nullptr);
    void project(CubeScene scene);
    void pairing(const char* payload, const char* locator, const char* proof);
    void volume(int percent);
    void battery(int percent, bool charging, bool low);
    void input(lv_event_code_t event);
    void cancel_input();
    void suspend(); // Diagnostic screen: cancel input and hidden animation.
    bool protected_visible() const;
    bool boot_ready() const { return ready_; }
    bool in_boot() const { return active_ == &boot_; }
    bool in_setup() const { return active_ == &setup_; }
    bool pressed() const { return pressed_; }
    MainView& main() { return main_; }
    const lv_font_t* text_font() const { return text_font_; }
private:
    void show(View& next);
    ResourceReader reader_;
    VoiceInput voice_;
    void* context_;
    const lv_font_t* text_font_;
    BootView boot_;
    SetupView setup_;
    MainView main_;
    View* active_ = nullptr;
    bool finished_ = false, ready_ = false, pressed_ = false, blocked_ = false;
    CubeScene scene_ = CubeScene::NoWifi;
    int volume_ = 0, battery_ = 0;
    bool charging_ = false, low_ = false;
    std::string qr_, locator_, proof_;
};
} // namespace sentient::cube
