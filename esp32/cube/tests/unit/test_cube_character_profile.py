"""Host-check actual UI timing aggregates without firmware build or device."""
from pathlib import Path
import subprocess
import tempfile

BOARD = Path(__file__).resolve().parents[2] / 'firmware/main/boards/sentient-cube'


def test_profile_records_render_flush_and_touch_only_on_visual_flush():
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / 'profile.cc'
        source.write_text('''#include <cassert>
#include "character_profile.h"
int main() {
    CharacterProfile p;
    p.render(true, 100);
    p.render(false, 180);
    p.render(true, 200);
    p.render(false, 220);
    assert(p.max_render_us == 80);
    p.visual_press_us = 300;
    p.flush(true, 310, true, false);
    p.flush(false, 320, true, false); // unrelated display area
    p.flush(true, 325, false, false);
    p.flush(false, 335, false, true); // visual area, wrong scene
    assert(p.max_touch_to_flush_cb_us == 0 && p.visual_press_us == 300);
    p.flush(true, 340, true, false);
    p.flush(false, 365, true, true);
    assert(p.max_flush_cb_us == 25 && p.max_touch_to_flush_cb_us == 65);
    assert(p.visual_press_us == 0);
}
''')
        binary = Path(directory) / 'profile'
        subprocess.run(['c++', '-std=c++17', '-I', str(BOARD), str(source), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True)
