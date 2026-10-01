#!/usr/bin/env python3
"""Offline export from approved Cube SVG and pixel.js; rsvg-convert + Pillow only.

Character alternates for rendered review: listening/thinking close only eye pixels;
unavailable moves only tail tip. Every frame keeps 32x32 origin and expression.
No private pairing payload or runtime SVG is used.
"""
from io import BytesIO
from pathlib import Path
import re
import subprocess
from PIL import Image

root = Path(__file__).resolve().parents[6]
source = root / 'design/prototypes/companion-cube/prototype'
target = Path(__file__).resolve().parent / 'character'
target.mkdir(exist_ok=True)


def raster(svg, width, height):
    return Image.open(BytesIO(subprocess.check_output(
        ['rsvg-convert', '-w', str(width), '-h', str(height)], input=svg.encode()
    ))).convert('RGBA')


def rgb565(image):
    bg = Image.new('RGBA', image.size, (0x2b, 0x26, 0x21, 255))
    bg.alpha_composite(image)
    data = bytearray()
    for r, g, b, _ in bg.getdata():
        color = (r >> 3) << 11 | (g >> 2) << 5 | (b >> 3)
        data.extend((color & 255, color >> 8))
    return data


def i1(svg, width, height, color):
    image = raster(svg, width, height)
    data = bytearray((color & 255, (color >> 8) & 255, (color >> 16) & 255, 255,
                      0, 0, 0, 0))  # LVGL palette index 0 = color; index 1 = transparent
    for y in range(height):
        for x in range(0, width, 8):
            value = 0
            for bit in range(8):
                if x + bit >= width or image.getpixel((x + bit, y))[3] < 128:
                    value |= 0x80 >> bit
            data.append(value)
    return data


poses = {}
for name in ('ready', 'blink', 'listening', 'thinking', 'speaking', 'offline', 'low'):
    poses[name] = raster((source / 'assets' / f'cat-{name}.svg').read_text(), 32, 32)

# Derived frames: eyelids replace eye ink using neighboring fur; tail tip raises
# one source pixel. No silhouette/body/ear/pose changes. Compare rendered frames.
for name, eye_x in (('listening-blink', (10, 19)), ('thinking-blink', (12, 21))):
    pose = name.split('-')[0]
    image = poses[pose].copy()
    fur = (0xF2, 0xA0, 0x6A, 255)
    ink = (0x24, 0x1F, 0x1B, 255)
    for x in eye_x:
        for dx in range(2):
            image.putpixel((x + dx, 14), fur)
            image.putpixel((x + dx, 15), ink)
    poses[name] = image
image = poses['offline'].copy()
image.putpixel((27, 27), (0x2b, 0x26, 0x21, 255))
image.putpixel((27, 26), (0xF2, 0xA0, 0x6A, 255))
poses['offline-tail'] = image
for name, image in poses.items():
    (target / f'cat-{name}.rgb565').write_bytes(rgb565(image))

# Extract exact supplied SVG path markup; no handwritten substitutes or font glyphs.
js = (source / 'pixel.js').read_text()
paths = dict(re.findall(r"(mic|wifi|offline|speaker|phone|dots|retry|plug|scan|lock):'([^']+)'",
                        js.split('const paths={', 1)[1].split('};', 1)[0]))
assert len(paths) == 10
for name, body in paths.items():
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" '
           f'fill="none" stroke="white" stroke-width="1.8" '
           f'stroke-linecap="round" stroke-linejoin="round">'
           f'{body.replace("currentColor", "white")}</svg>')
    for suffix, color in (('', 0xD7C6AB), ('-active', 0xF2A06A), ('-dark', 0x241F1B)):
        if suffix and (name, suffix) not in (('mic', '-active'), ('mic', '-dark'), ('speaker', '-active')):
            continue
        (target / f'icon-{name}{suffix}.i1').write_bytes(i1(svg, 36, 36, color))

# CSS clip-path coordinates (percent of 72px); antialias from rsvg, matte RGB565.
points = '8,0 92,0 92,8 100,8 100,78 92,78 92,86 34,86 20,100 20,86 8,86 8,78 0,78 0,8 8,8'
polygon = ' '.join(f'{float(x)*.72:g},{float(y)*.72:g}' for x, y in (p.split(',') for p in points.split()))
for suffix, fill in (('', '#39322C'), ('-active', '#F2A06A')):
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><polygon points="{polygon}" fill="{fill}"/></svg>'
    (target / f'bubble{suffix}.rgb565').write_bytes(rgb565(raster(svg, 72, 72)))

# Exact 40x24 supplied battery outline + 0–3 bars / bolt, rendered at 54x34.
for warning, color in (('', 0xD7C6AB), ('-low', 0xE9B168)):
    for bars in range(4):
        body = ''.join(f'M{x} 8h5v8h-5z' for x in (6, 14, 22)[:bars])
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 24">'
               f'<path d="M2 5h31v14H2zM36 9h3v6h-3z" fill="none" stroke="white" stroke-width="2"/>'
               f'<path d="{body}" fill="white"/></svg>')
        (target / f'battery-{bars}{warning}.i1').write_bytes(i1(svg, 54, 34, color))
svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 24">'
       '<path d="M2 5h31v14H2zM36 9h3v6h-3z" fill="none" stroke="white" stroke-width="2"/>'
       '<path d="m20 6-8 8h6l-2 5 9-9h-7z" fill="white"/></svg>')
(target / 'battery-charging.i1').write_bytes(i1(svg, 54, 34, 0xD7C6AB))
