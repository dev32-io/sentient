#pragma once
#include <string>

// 480px LVGL viewport and panel. Keep QR at 288px with its
// encoder's four-module quiet zone; text sits below, inside round corners.
constexpr int kPairingQrSize = 288;
constexpr int kPairingQrCenterY = -55;
constexpr int kPairingLocatorY = 335;
constexpr int kPairingTitleY = 360;
constexpr int kPairingProofY = 383;

inline std::string cube_group_pairing_proof(const std::string& proof) {
    std::string grouped;
    for (size_t i = 0; i < proof.size(); ++i) {
        if (i && i % 15 == 0) grouped += '\n';
        else if (i && i % 5 == 0) grouped += ' ';
        grouped += proof[i];
    }
    return grouped;
}
