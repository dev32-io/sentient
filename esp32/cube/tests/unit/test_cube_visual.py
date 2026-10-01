"""Stable Cube scene/icon and reference raster boundary; no panel claim."""
from io import BytesIO
from pathlib import Path
import re
import subprocess
import tempfile
from PIL import Image

BOARD = Path(__file__).resolve().parents[2] / 'firmware/main/boards/sentient-cube'
ASSETS = BOARD / 'character'
REFERENCE = Path(__file__).resolve().parents[4] / 'design/prototypes/companion-cube/prototype/pixel.js'


def test_scene_visual_mapping_and_battery_truth():
    source = '''#include <cassert>
#include "cube_visual.h"
int main() {
    CubeSignals s;
    s.connected = s.wifi = s.capturing = s.playback = s.low_battery = true;
    assert(cube_scene(s) == CubeScene::Listening);
    assert(cube_visual(cube_scene(s)).recording);
    assert(cube_visual(cube_scene(s)).capturing_bubble);
    s.capturing = false;
    assert(cube_scene(s) == CubeScene::Speaking);
    assert(cube_visual(cube_scene(s)).bubble == CubeGlyph::Speaker);
    s.playback = false;
    assert(cube_scene(s) == CubeScene::Low);
    assert(cube_visual(cube_scene(s)).bubble == CubeGlyph::Plug);
    assert(cube_visual(CubeScene::NoWifi).bubble == CubeGlyph::Offline);
    assert(cube_visual(CubeScene::Service).bubble == CubeGlyph::Retry);
    assert(cube_visual(CubeScene::Account).status == CubeGlyph::Lock);
    assert(cube_visual(CubeScene::Setup).bubble == CubeGlyph::None);
    assert(cube_visual(CubeScene::Sleep).status == CubeGlyph::None);
    assert(cube_battery_bars(0) == 0);
    assert(cube_battery_bars(1) == 1);
    assert(cube_battery_bars(33) == 1);
    assert(cube_battery_bars(34) == 2);
    assert(cube_battery_bars(66) == 2);
    assert(cube_battery_bars(67) == 3);
}
'''
    with tempfile.TemporaryDirectory() as tmp:
        binary = Path(tmp) / 'visual'
        subprocess.run(['c++', '-std=c++17', '-I', str(BOARD), '-x', 'c++', '-',
                        '-o', str(binary)], input=source, text=True, check=True)
        subprocess.run([str(binary)], check=True)


def test_reference_pixel_shape_and_glyph_palettes():
    def pixel(data, x, y, width):
        at = (y * width + x) * 2
        return int.from_bytes(data[at:at + 2], 'little')

    def rgb565(hex_color):
        return ((hex_color >> 19) << 11) | (((hex_color >> 8) & 255) >> 2) << 5 | ((hex_color & 255) >> 3)

    normal = (ASSETS / 'bubble.rgb565').read_bytes()
    active = (ASSETS / 'bubble-active.rgb565').read_bytes()
    assert len(normal) == len(active) == 72 * 72 * 2
    bg = rgb565(0x2B2621)
    assert pixel(normal, 0, 0, 72) == pixel(active, 0, 0, 72) == bg
    assert pixel(normal, 36, 4, 72) == rgb565(0x39322C)
    assert pixel(active, 36, 4, 72) == rgb565(0xF2A06A)
    assert pixel(normal, 12, 70, 72) == bg  # tail extends only near 20% x
    for name, color in [('icon-mic.i1', 0xD7C6AB),
                        ('icon-mic-active.i1', 0xF2A06A),
                        ('icon-mic-dark.i1', 0x241F1B),
                        ('battery-0.i1', 0xD7C6AB),
                        ('battery-0-low.i1', 0xE9B168)]:
        data = (ASSETS / name).read_bytes()
        assert data[:4] == bytes((color & 255, (color >> 8) & 255,
                                  color >> 16, 255))
        assert data[4:8] == b'\x00' * 4
        assert len(data) == 8 + (7 * 34 if name.startswith('battery') else 5 * 36)
    # Zero means empty body; charging keeps the supplied bolt and no bars.
    assert (ASSETS / 'battery-0.i1').read_bytes() != (ASSETS / 'battery-3.i1').read_bytes()
    assert (ASSETS / 'battery-charging.i1').read_bytes() != (ASSETS / 'battery-3.i1').read_bytes()


def test_exported_glyph_masks_match_supplied_svg_paths():
    paths = dict(re.findall(r"(mic|wifi|offline|speaker|phone|dots|retry|plug|scan|lock):'([^']+)'",
                            REFERENCE.read_text().split('const paths={', 1)[1].split('};', 1)[0]))
    assert paths['offline'].startswith('<path')
    assert len(paths) == 10
    for name, path in paths.items():
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" '
               f'fill="none" stroke="white" stroke-width="1.8" '
               f'stroke-linecap="round" stroke-linejoin="round">'
               f'{path.replace("currentColor", "white")}</svg>')
        image = Image.open(BytesIO(subprocess.check_output(
            ['rsvg-convert', '-w', '36', '-h', '36'], input=svg.encode()))).convert('RGBA')
        packed = (ASSETS / f'icon-{name}.i1').read_bytes()[8:]
        for y in range(36):
            for x in range(36):
                opaque = not packed[y * 5 + x // 8] & (0x80 >> (x % 8))
                assert opaque == (image.getpixel((x, y))[3] >= 128)
