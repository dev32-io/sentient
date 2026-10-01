"""Host proof grouping and 466px round-screen/QR layout boundary."""
from pathlib import Path
import subprocess
import tempfile

BOARD = Path(__file__).resolve().parents[2] / 'firmware/main/boards/sentient-cube'


def test_pairing_display_layout_and_retirement():
    source = r'''
#include "cube_pairing_display.h"
#include <cassert>
#include <algorithm>
#include <string>
int main() {
    const std::string proof = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
    static_assert(kPairingQrSize == 288);
    static_assert((466 - kPairingQrSize) / 2 + kPairingQrCenterY >= 30);
    static_assert((466 + kPairingQrSize) / 2 + kPairingQrCenterY + 13 <= kPairingLocatorY);
    static_assert(kPairingLocatorY < kPairingTitleY && kPairingTitleY < kPairingProofY);
    static_assert(kPairingProofY + 55 < 466); // Three 14px lines with 5px gaps.
    auto grouped = cube_group_pairing_proof(proof);
    grouped.erase(std::remove_if(grouped.begin(), grouped.end(), [](char c) {
        return c == ' ' || c == '\n';
    }), grouped.end());
    assert(grouped == proof && proof.size() == 43);
    auto display = cube_group_pairing_proof(proof);
    assert(std::count(display.begin(), display.end(), '\n') == 2);
    // Encoder permits up to QR version 12 (65 modules): four-module quiet zone.
    for (int modules = 21; modules <= 65; modules += 4) {
        int scale = kPairingQrSize / (modules + 8);
        int inset = (kPairingQrSize - modules * scale) / 2;
        assert(scale >= 3 && inset >= 4 * scale);
    }
}
'''
    with tempfile.TemporaryDirectory() as directory:
        src = Path(directory) / 'test.cc'
        src.write_text(source)
        binary = Path(directory) / 'test'
        subprocess.run(['c++', '-std=c++17', '-I', str(BOARD), str(src), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True)

    renderer = (BOARD.parents[2] / 'ui-shared/cube_views.cc').read_text()
    adapter = (BOARD / 'toggle_button_screen.cc').read_text()
    controller = (BOARD / 'sentient_ui_controller.cc').read_text()
    hardware = (BOARD / 'cube_hardware.cc').read_text()
    board = (BOARD / 'sentient_cube.cc').read_text()
    assert 'toggle_button_screen_pairing(presentation.qr.c_str(), presentation.locator.c_str(), presentation.proof.c_str())' in controller
    assert 'setup ? cube_text(record_.bootstrap) : ""' in hardware
    assert 'qr_.clear()' in hardware
    # Shared view lifecycle/retirement is exercised against real LVGL by simulator CTest.
    assert 'view_host().protected_visible()' in adapter
    capture = board[board.index('extern "C" int cube_capture_ui_snapshot(uint16_t* dst, size_t dst_cap,\n                                         int* out_w, int* out_h) {'):]
    assert capture.index('Presentation().setup') < capture.index('lvgl_port_lock(kSnapLvglLockMs)')
    assert capture.index('lvgl_port_lock(kSnapLvglLockMs)') < capture.index('cube_setup_display_visible()') < capture.index('lv_snapshot_take_to_draw_buf(')
    assert 'lv_screen_active() == screen_ && plate_ && !lv_obj_has_flag(plate_, LV_OBJ_FLAG_HIDDEN)' in renderer
