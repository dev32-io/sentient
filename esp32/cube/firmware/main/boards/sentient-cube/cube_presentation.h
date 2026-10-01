#pragma once

// Voice and warning projection. No display, audio or touch authority here.
enum class CubeScene { Ready, Sleep, Setup, Pairing, Listening, Thinking, Speaking,
                       NoWifi, Service, Account, Volume, Low, Charging };

struct CubeSignals {
    bool connected = false;
    bool wifi = false;
    bool setup = false;
    bool pairing = false;
    bool account_attention = false;
    bool capturing = false;
    bool processing = false;
    bool playback = false; // Remains true until decoded audio drains.
    bool charging = false;
    bool low_battery = false;
    bool volume = false;
    bool asleep = false;
};

inline CubeScene cube_scene(const CubeSignals& s) {
    if (s.asleep) return CubeScene::Sleep;
    if (s.setup) return CubeScene::Setup;
    if (s.pairing) return CubeScene::Pairing;
    if (s.account_attention) return CubeScene::Account;
    if (s.capturing) return CubeScene::Listening;
    if (s.playback) return CubeScene::Speaking;
    if (s.processing) return CubeScene::Thinking;
    if (!s.wifi) return CubeScene::NoWifi;
    if (!s.connected) return CubeScene::Service;
    if (s.volume) return CubeScene::Volume;
    if (s.low_battery && !s.charging) return CubeScene::Low;
    return s.charging ? CubeScene::Charging : CubeScene::Ready;
}

// Called for every sampled touch, before LVGL receives it. Wake press stays
// consumed until physical release, including a transient read/press-lost.
class CubeWakeGesture {
public:
    bool accept(bool pressed, bool asleep, bool valid = true) {
        // I2C read failure is a press-lost edge for LVGL, not proof finger lifted.
        if (!valid) return false;
        if (!pressed) { consumed_ = false; return false; }
        if (asleep) consumed_ = true;
        return !consumed_;
    }
private:
    bool consumed_ = false;
};
