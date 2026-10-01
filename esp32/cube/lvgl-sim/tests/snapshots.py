"""Deterministic shipping renderer snapshots; no device or setup proof export."""
from pathlib import Path
import subprocess
import sys
import tempfile
from PIL import Image

binary, board = Path(sys.argv[1]), Path(sys.argv[2])


def rgb565(value):
    r, g, b = value >> 11, (value >> 5) & 63, value & 31
    return (r << 3 | r >> 2, g << 2 | g >> 4, b << 3 | b >> 2)


with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)

    def render(name, *args):
        path = root / f'{name}.png'
        subprocess.run([str(binary), '--snapshot', str(path), *args], check=True)
        image = Image.open(path).convert('RGB')
        assert image.size == (480, 480)
        return path.read_bytes(), image

    cases = [
        ('ready', 'ready', 0), ('blink', 'ready', 3300),
        ('listening', 'listening', 0), ('listening-blink', 'listening', 900),
        ('ready', 'thinking', 0), ('thinking', 'thinking', 180),
        ('thinking-blink', 'thinking', 1080), ('thinking', 'thinking', 3780),
        ('speaking', 'speaking', 0), ('ready', 'speaking', 500),
        ('offline', 'offline', 0), ('offline-tail', 'offline', 3300),
    ]
    for index, (pose, scene, at) in enumerate(cases):
        data, image = render(str(index), '--scene', scene, '--at-ms', str(at))
        repeat, _ = render(f'{index}-repeat', '--scene', scene, '--at-ms', str(at))
        assert data == repeat, (scene, at, 'nondeterministic')
        raw = (board / 'character' / f'cat-{pose}.rgb565').read_bytes()
        matte = int.from_bytes(raw[:2], 'little')
        # Interior samples of nearest-neighbor transformed 32px source. Avoid
        # matte: firmware ground/cue intentionally overlap background only.
        for y in range(32):
            for x in range(32):
                offset = (y * 32 + x) * 2
                pixel = int.from_bytes(raw[offset:offset + 2], 'little')
                if pixel != matte:
                    assert image.getpixel((116 + x * 8, 116 + y * 8)) == rgb565(pixel), (scene, at, x, y)

    _, ready = render('cue-ready', '--scene', 'ready')
    _, listening = render('cue-listening', '--scene', 'listening')
    assert ready.getpixel((115, 85)) == rgb565((0x2b >> 3) << 11 | (0x26 >> 2) << 5 | (0x21 >> 3))
    assert listening.getpixel((115, 85)) == rgb565((0xf2 >> 3) << 11 | (0xa0 >> 2) << 5 | (0x6a >> 3))
    assert ready.getpixel((380, 114)) != listening.getpixel((380, 114))
    boot, _ = render('boot', '--not-ready')
    error, _ = render('error', '--boot-error')
    assert boot != error
    forbidden = root / 'setup.png'
    denied = subprocess.run([str(binary), '--snapshot', str(forbidden), '--scene', 'setup'], capture_output=True)
    assert denied.returncode == 2 and not forbidden.exists()
print('deterministic shipping snapshots and setup protection passed')
