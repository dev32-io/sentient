#pragma once
#include "cube_presentation.h"

enum class CubeGlyph { None, Wifi, Offline, Mic, Speaker, Phone, Dots, Retry, Plug, Scan, Lock };
struct CubeVisual { CubeGlyph status, bubble; bool recording, capturing_bubble; };

inline CubeVisual cube_visual(CubeScene s) {
    switch (s) {
        case CubeScene::Sleep: return {CubeGlyph::None, CubeGlyph::None, false, false};
        case CubeScene::Setup: return {CubeGlyph::Scan, CubeGlyph::None, false, false};
        case CubeScene::Pairing: return {CubeGlyph::Phone, CubeGlyph::Phone, false, false};
        case CubeScene::Listening: return {CubeGlyph::Mic, CubeGlyph::Mic, true, true};
        case CubeScene::Thinking: return {CubeGlyph::Dots, CubeGlyph::Dots, false, false};
        case CubeScene::Speaking: return {CubeGlyph::Speaker, CubeGlyph::Speaker, false, false};
        case CubeScene::NoWifi: return {CubeGlyph::Offline, CubeGlyph::Offline, false, false};
        case CubeScene::Service: return {CubeGlyph::Offline, CubeGlyph::Retry, false, false};
        case CubeScene::Account: return {CubeGlyph::Lock, CubeGlyph::Phone, false, false};
        case CubeScene::Volume: return {CubeGlyph::Speaker, CubeGlyph::Speaker, false, false};
        case CubeScene::Low: return {CubeGlyph::Plug, CubeGlyph::Plug, false, false};
        case CubeScene::Charging: return {CubeGlyph::Wifi, CubeGlyph::Mic, false, false};
        default: return {CubeGlyph::Wifi, CubeGlyph::Mic, false, false};
    }
}

// Body 31x14 in 40x24 viewBox: three 5px bars. No installed battery reads 0.
inline int cube_battery_bars(int percent) {
    if (percent <= 0) return 0;
    if (percent >= 100) return 3;
    return (percent + 32) / 33;
}
