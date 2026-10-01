#include "../../firmware/main/boards/sentient-cube/cube_presentation.h"
#include <cassert>

int main() {
    CubeSignals s;
    assert(cube_scene(s) == CubeScene::NoWifi);
    s.wifi = true;
    assert(cube_scene(s) == CubeScene::Service);
    s.connected = true;
    assert(cube_scene(s) == CubeScene::Ready);
    s.low_battery = true;
    assert(cube_scene(s) == CubeScene::Low);
    s.charging = true;
    assert(cube_scene(s) == CubeScene::Charging);
    s.processing = true;
    assert(cube_scene(s) == CubeScene::Thinking); // idle != ready
    s.playback = true;
    assert(cube_scene(s) == CubeScene::Speaking); // includes decoder drain
    s.capturing = true;
    assert(cube_scene(s) == CubeScene::Listening); // interrupt owns sprite
    s.account_attention = true;
    assert(cube_scene(s) == CubeScene::Account);
    s.setup = true;
    assert(cube_scene(s) == CubeScene::Setup);
    s.asleep = true;
    assert(cube_scene(s) == CubeScene::Sleep);

    CubeWakeGesture touch;
    assert(!touch.accept(true, true)); // wake starts while finger down
    assert(!touch.accept(true, false)); // holding never starts capture
    assert(!touch.accept(false, false, false)); // transient I2C error isn't release
    assert(!touch.accept(true, false)); // same hold still consumed
    assert(!touch.accept(false, false)); // release/press-lost consumes edge
    assert(touch.accept(true, false)); // next press can capture
    assert(!touch.accept(false, false)); // release ends capture
    assert(!touch.accept(true, true)); // later sleep re-arms gate
    assert(!touch.accept(false, false));
    assert(touch.accept(true, false));
}
