"""Check packaged Cube font against xiaozhi cbin/LVGL cmap format."""
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest

FIRMWARE = Path(__file__).resolve().parents[2] / 'firmware'
IMAGE = FIRMWARE / 'build/generated_assets.bin'


def asset(image, name):
    count, checksum, length = struct.unpack_from('<III', image)
    assert sum(image[12:12 + length]) & 0xffff == checksum
    for i in range(count):
        entry = 12 + 44 * i
        filename = image[entry:entry + 32].split(b'\0')[0].decode()
        size, offset = struct.unpack_from('<II', image, entry + 32)
        if filename == name:
            start = 12 + 44 * count + offset
            assert image[start:start + 2] == b'ZZ'
            return image[start + 2:start + 2 + size]
    raise AssertionError(f'missing asset: {name}')


def contains_glyph(font, codepoint):
    # cbin_font_create rebases dsc/cmaps relative to their containing structs.
    dsc = struct.unpack_from('<I', font, 24)[0]
    cmaps = dsc + struct.unpack_from('<I', font, dsc + 8)[0]
    count = struct.unpack_from('<H', font, dsc + 18)[0] & 0x1ff
    for i in range(count):
        pos = cmaps + 20 * i
        first, length, glyph, unicode_offset, ids_offset, n, kind, _ = struct.unpack_from('<IHHIIHBB', font, pos)
        if not first <= codepoint < first + length:
            continue
        relative = codepoint - first
        if kind == 2:  # LV_FONT_FMT_TXT_CMAP_FORMAT0_TINY
            return glyph > 0
        if kind == 0:  # LV_FONT_FMT_TXT_CMAP_FORMAT0_FULL
            return font[cmaps + ids_offset + relative] != 0
        if kind in (1, 3):  # sparse full / tiny
            offsets = struct.unpack_from(f'<{n}H', font, cmaps + unicode_offset)
            if relative not in offsets:
                return False
            index = offsets.index(relative)
            return kind == 3 or struct.unpack_from('<H', font, cmaps + ids_offset + 2 * index)[0] != 0
    return False


class CjkFontAssetTest(unittest.TestCase):
    def test_cube_loader_rejects_bad_offsets_before_cbin_create(self):
        source = (FIRMWARE / 'main/assets.cc').read_text()
        validator = source.split('static bool ValidCubeCBinTextFont', 1)[1].split('\n\nbool Assets::LoadTextFont', 1)[0]
        cpp = r'''
#include <cassert>
#include <cstdint>
#include <fstream>
#include <iterator>
#include <vector>
static bool ValidCubeCBinTextFont''' + validator + r'''
int main(int argc, char** argv) {
    assert(argc == 2);
    std::ifstream stream(argv[1], std::ios::binary);
    std::vector<uint8_t> font(std::istreambuf_iterator<char>{stream}, {});
    auto valid = [&] { return ValidCubeCBinTextFont(font.data(), font.size()); };
    assert(valid());
    auto reject = [&](size_t position, uint32_t value) {
        uint32_t original = 0;
        for (int i = 0; i < 4; ++i) original |= uint32_t(font[position + i]) << (i * 8);
        for (int i = 0; i < 4; ++i) font[position + i] = value >> (i * 8);
        assert(!valid()); // reject before cbin_font_create rebases pointer
        for (int i = 0; i < 4; ++i) font[position + i] = original >> (i * 8);
        assert(valid());
    };
    auto read = [&](size_t pos) {
        uint32_t n = 0;
        for (int i = 0; i < 4; ++i) n |= uint32_t(font[pos + i]) << (i * 8);
        return n;
    };
    size_t dsc = read(24), cmaps = dsc + read(dsc + 8), kern = dsc + read(dsc + 12);
    reject(28, 0xfffffff0);             // unresolved fallback font pointer
    reject(dsc, 0xfffffff0);            // bitmap pointer (reported crash)
    reject(dsc + 4, 0xfffffff0);        // glyph descriptors
    reject(dsc + 8, 0xfffffff0);        // cmap table
    reject(kern + 4, 0xfffffff0);       // kerning class mapping
    reject(cmaps + 8, 0xfffffff0);     // nested unicode list
    reject(dsc + read(dsc + 4) + 16 * 3, 0xfffffff0); // glyph bitmap index
    font[dsc + 19] |= 0x40;            // unsupported compressed format
    assert(!valid());
}
'''
        font = FIRMWARE / 'managed_components/78__xiaozhi-fonts/cbin/font_puhui_common_30_4.bin'
        with tempfile.TemporaryDirectory() as tmp:
            cpp_path = Path(tmp) / 'check.cc'
            cpp_path.write_text(cpp)
            executable = Path(tmp) / 'check'
            subprocess.run(['c++', '-std=c++17', str(cpp_path), '-o', str(executable)], check=True)
            subprocess.run([str(executable), str(font)], check=True)

    def test_cube_font_covers_ascii_and_cjk(self):
        source = FIRMWARE / 'managed_components/78__xiaozhi-fonts/cbin/font_puhui_common_30_4.bin'
        font = source.read_bytes()
        if IMAGE.exists():
            image = IMAGE.read_bytes()
            index = json.loads(asset(image, 'index.json'))
            self.assertEqual(index['version'], 1)
            self.assertEqual(asset(image, index['text_font']), font)
        for letter in 'A中文':
            with self.subTest(codepoint=hex(ord(letter))):
                self.assertTrue(contains_glyph(font, ord(letter)))


if __name__ == '__main__':
    unittest.main()
