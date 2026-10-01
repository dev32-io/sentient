"""Host-check compact sprite export against supplied 32px SVG art."""
from io import BytesIO
from pathlib import Path
import subprocess
from PIL import Image

ROOT = Path(__file__).resolve().parents[4]
SRC = ROOT / 'design/prototypes/companion-cube/prototype/assets'
OUT = ROOT / 'esp32/cube/firmware/main/boards/sentient-cube/character'


def test_cat_rasters():
    frames = {}
    for pose in ('ready', 'blink', 'listening', 'thinking', 'speaking', 'offline', 'low'):
        image = Image.open(BytesIO(subprocess.check_output([
            'rsvg-convert', '-w', '32', '-h', '32', str(SRC / f'cat-{pose}.svg')
        ]))).convert('RGBA')
        raw = (OUT / f'cat-{pose}.rgb565').read_bytes()
        assert len(raw) == 32 * 32 * 2
        bg = Image.new('RGBA', (32, 32), (0x2b, 0x26, 0x21, 255))
        bg.alpha_composite(image)
        for y in range(32):
            for x in range(32):
                r, g, b, _ = bg.getpixel((x, y))
                expected = (r >> 3) << 11 | (g >> 2) << 5 | (b >> 3)
                offset = (y * 32 + x) * 2
                assert int.from_bytes(raw[offset:offset + 2], 'little') == expected
        frames[pose] = raw
    assert frames['ready'] != frames['blink']
    assert frames['offline'] == frames['low']
    for derived, original in (('listening-blink', 'listening'),
                              ('thinking-blink', 'thinking'), ('offline-tail', 'offline')):
        data = (OUT / f'cat-{derived}.rgb565').read_bytes()
        changes = [i // 2 for i in range(0, len(data), 2)
                   if data[i:i + 2] != frames[original][i:i + 2]]
        assert 1 <= len(changes) <= 8
        if derived == 'offline-tail':
            assert all(25 <= pixel // 32 <= 28 for pixel in changes)
        else:
            assert all(14 <= pixel // 32 <= 15 for pixel in changes)
