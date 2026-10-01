"""Cooked bytes through production archive loader; zlib stands in for S3 ROM."""
import ctypes
import importlib.util
from pathlib import Path
import struct
import subprocess
import zlib

import pytest

CUBE = Path(__file__).resolve().parents[2]
MAIN = CUBE / "firmware/main"
spec = importlib.util.spec_from_file_location("cook_cube_assets", CUBE / "firmware/scripts/cook_cube_assets.py")
cook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cook)


@pytest.fixture(scope="module")
def loader(tmp_path_factory):
    temp = tmp_path_factory.mktemp("archive")
    (temp / "esp_heap_caps.h").write_text("""
#pragma once
#include <cstddef>
#define MALLOC_CAP_SPIRAM 1
#define MALLOC_CAP_8BIT 2
void* heap_caps_malloc(size_t, unsigned);
void heap_caps_free(void*);
""")
    (temp / "miniz.h").write_text("""
#pragma once
#include <cstddef>
#include <cstdint>
struct tinfl_decompressor { unsigned m_state; };
#define tinfl_init(p) ((p)->m_state = 0)
#define TINFL_FLAG_PARSE_ZLIB_HEADER 1
#define TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF 4
#define TINFL_STATUS_DONE 0
int tinfl_decompress(tinfl_decompressor*, const uint8_t*, size_t*, uint8_t*, uint8_t*, size_t*, unsigned);
""")
    (temp / "host.cc").write_text("""
#include "asset_archive.h"
#include "esp_heap_caps.h"
#include "miniz.h"
#include <cassert>
#include <cstdlib>
#include <zlib.h>
static int fail_at, calls, live;
void* heap_caps_malloc(size_t size, unsigned caps) {
    assert(caps == (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (++calls == fail_at) return nullptr;
    void* p = malloc(size); if (p) ++live; return p;
}
void heap_caps_free(void* p) { if (p) --live; free(p); }
int tinfl_decompress(tinfl_decompressor*, const uint8_t* in, size_t* in_size,
                     uint8_t* start, uint8_t* out, size_t* out_size, unsigned flags) {
    assert(start == out && flags == 5);
    z_stream z{};
    assert(inflateInit(&z) == Z_OK);
    z.next_in = const_cast<uint8_t*>(in); z.avail_in = *in_size;
    z.next_out = out; z.avail_out = *out_size;
    int result = inflate(&z, Z_FINISH);
    *in_size = z.total_in; *out_size = z.total_out;
    inflateEnd(&z);
    return result == Z_STREAM_END ? 0 : -1;
}
extern "C" void* load(const uint8_t* bytes, size_t size, int fail, size_t* count) {
    assert(live == 0); fail_at = fail; calls = 0;
    uint8_t* data = reinterpret_cast<uint8_t*>(1); *count = 999;
    bool ok = cube_assets::Decode(bytes, size, data, *count);
    if (!ok) { assert(!data && !*count && live == 0); }
    return data;
}
extern "C" void release(void* p) { heap_caps_free(p); assert(live == 0); }
""")
    lib_path = temp / "archive.dylib"
    subprocess.run(["c++", "-std=c++17", "-Wall", "-Wextra", "-Werror", "-shared", "-fPIC",
                    "-I", str(temp), "-I", str(MAIN), str(MAIN / "asset_archive.cc"),
                    str(temp / "host.cc"), "-lz", "-o", str(lib_path)], check=True)
    lib = ctypes.CDLL(str(lib_path))
    lib.load.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.c_int, ctypes.POINTER(ctypes.c_size_t)]
    lib.load.restype = ctypes.c_void_p
    lib.release.argtypes = [ctypes.c_void_p]

    def decode(blob, fail=0):
        count = ctypes.c_size_t()
        data = lib.load(blob, len(blob), fail, ctypes.byref(count))
        if not data:
            return None
        try:
            return ctypes.string_at(data, struct.unpack_from("<I", blob, 16)[0]), count.value
        finally:
            lib.release(data)
    return decode


def repack(blob, raw):
    return blob[:16] + struct.pack("<II", len(raw), len(zlib.compress(raw))) + zlib.compress(raw)


def test_decode_exact_and_allocation_failure(loader):
    files = {"/index.json": b'{"version":1}', "/ui/test.bin": bytes(range(256)) * 4096}
    blob = cook.pack(files)
    assert blob == cook.pack(dict(reversed(list(files.items()))))
    raw, count = loader(blob)
    assert raw == zlib.decompress(blob[24:]) and count == 2
    for i, (name, payload) in enumerate(sorted(files.items())):
        path, offset, size = struct.unpack_from("<96sII", raw, i * 104)
        assert path.rstrip(b"\0").decode() == name
        assert offset % 4 == 0 and raw[offset:offset + size] == payload
    assert loader(blob, fail=1) is None
    assert loader(blob, fail=2) is None


def test_reject_invalid_archive_without_publication(loader):
    blob = cook.pack({"/a": b"hello", "/b": b"world"})
    for offset, value in ((8, 2), (12, 0), (12, 129), (12, 1), (16, 6 * 1024 * 1024 + 1),
                          (16, 1), (16, 220), (16, 222), (20, 0), (20, 999)):
        bad = bytearray(blob)
        struct.pack_into("<I", bad, offset, value)
        assert loader(bytes(bad)) is None, (offset, value)
    assert loader(b"wrongpak" + blob[8:]) is None
    for n in range(24):
        assert loader(blob[:n]) is None
    for bad in (blob[:-1], blob + b"x", blob[:-1] + bytes([blob[-1] ^ 1])):
        assert loader(bad) is None
    # Concatenated streams, even with a matching outer packed length, are rejected.
    bad = bytearray(blob + zlib.compress(b"hidden"))
    struct.pack_into("<I", bad, 20, len(bad) - 24)
    assert loader(bytes(bad)) is None
    original = zlib.decompress(blob[24:])
    for path in (b"a", b"/", b"//a", b"/a/", b"/a/../b", b"/./a", b"/a\\b", b"/a\xff"):
        raw = bytearray(original)
        raw[:96] = path.ljust(96, b"\0")
        assert loader(repack(blob, raw)) is None, path
    for offset, value in ((96, 0), (96, 209), (100, 0), (100, 0xffffffff), (200, 208)):
        raw = bytearray(original)
        struct.pack_into("<I", raw, offset, value)
        assert loader(repack(blob, raw)) is None
    raw = bytearray(original)
    raw[104:200] = raw[:96]  # Duplicate path
    assert loader(repack(blob, raw)) is None
    raw = bytearray(original)
    raw[2:96] = b"x" * 94  # Unterminated path
    assert loader(repack(blob, raw)) is None
    raw = bytearray(original)
    raw[213] = 1  # Nonzero alignment padding
    assert loader(repack(blob, raw)) is None


def test_real_namespace_preserves_full_font_and_art(loader, tmp_path):
    board = MAIN / "boards/sentient-cube"
    font = CUBE / "firmware/managed_components/78__xiaozhi-fonts/cbin/font_puhui_common_30_4.bin"
    output = tmp_path / "cube_assets.bin"
    cook.cook(board, font, output)
    raw, count = loader(output.read_bytes())
    files = {}
    for i in range(count):
        name, offset, size = struct.unpack_from("<96sII", raw, i * 104)
        files[name.rstrip(b"\0").decode()] = raw[offset:offset + size]
    assert files["/ui/fonts/" + font.name] == font.read_bytes()
    assert files["/companions/cat/companion.json"] == (board / "companion.json").read_bytes()
    for pose in cook.POSES:
        assert files[f"/companions/cat/{pose}.rgb565"] == (board / "character" / f"cat-{pose}.rgb565").read_bytes()
    for path in (board / "character").glob("*.i1"):
        assert files["/ui/" + path.name] == path.read_bytes()


def test_factory_layout_preserves_private_regions():
    import csv
    rows = {}
    for row in csv.reader((CUBE / "firmware/partitions/v2/16m.csv").read_text().splitlines()):
        if row and not row[0].startswith("#"):
            name, kind, subtype, offset, size, *_ = (s.strip() for s in row)
            rows[name] = (kind, subtype, int(offset, 0), int(size, 0))
    assert rows == {
        "nvs": ("data", "nvs", 0x9000, 0x4000),
        "phy_init": ("data", "phy", 0xf000, 0x1000),
        "cube_auth": ("data", "nvs", 0x10000, 0xf000),
        "cube_seal": ("data", "0x40", 0x1f000, 0x1000),
        "factory": ("app", "factory", 0x20000, 0xfe0000),
    }
    assert rows["factory"][2] + rows["factory"][3] == 16 * 1024 * 1024


def test_configured_models_remain_in_reproducible_pack(loader, tmp_path):
    import json
    import sys
    firmware = CUBE / 'firmware'
    config = tmp_path / 'sdkconfig'
    config.write_text('CONFIG_USE_AFE_WAKE_WORD=y\nCONFIG_SR_WN_WN9_NIHAOXIAOZHI_TTS=y\n')
    output = tmp_path / 'cube.bin'
    args = [sys.executable, str(firmware / 'scripts/build_default_assets.py'),
            '--sdkconfig', str(config), '--builtin_text_font', 'font_puhui_basic_30_4',
            '--cube-board', str(MAIN / 'boards/sentient-cube'), '--output', str(output),
            '--xiaozhi_fonts_path', str(firmware / 'managed_components/78__xiaozhi-fonts'),
            '--esp_sr_model_path', str(firmware / 'managed_components/espressif__esp-sr/model')]
    subprocess.run(args, check=True, capture_output=True)
    first = output.read_bytes()
    subprocess.run(args, check=True, capture_output=True)
    assert output.read_bytes() == first
    raw, count = loader(first)
    files = {}
    for i in range(count):
        path, offset, size = struct.unpack_from('<96sII', raw, i * 104)
        files[path.rstrip(b'\0').decode()] = raw[offset:offset + size]
    index = json.loads(files['/index.json'])
    model = files[index['srmodels']]
    assert struct.unpack_from('<I', model)[0] == 1
    name, nfiles = struct.unpack_from('<32sI', model, 4)
    assert name.rstrip(b'\0') == b'wn9_nihaoxiaozhi_tts'
    source = firmware / 'managed_components/espressif__esp-sr/model/wakenet_model/wn9_nihaoxiaozhi_tts'
    for i in range(nfiles):
        path, offset, size = struct.unpack_from('<32sII', model, 40 + i * 40)
        assert model[offset:offset + size] == (source / path.rstrip(b'\0').decode()).read_bytes()
    config.write_text('CONFIG_USE_AFE_WAKE_WORD=y\nCONFIG_SR_WN_MISSING=y\n')
    result = subprocess.run(args, capture_output=True, text=True)
    assert result.returncode != 0 and 'Selected wake models are missing' in result.stderr
