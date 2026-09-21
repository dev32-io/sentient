#!/usr/bin/env python3
import importlib.util
import struct
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location("attachment_parser", ROOT / "server.py")
assert SPEC and SPEC.loader
parser = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(parser)


def classic(tags, byteorder="little"):
    prefix = "<" if byteorder == "little" else ">"
    value = bytearray(8 + 2 + len(tags) * 12 + 4)
    value[:2] = b"II" if byteorder == "little" else b"MM"
    struct.pack_into(prefix + "HI", value, 2, 42, 8)
    struct.pack_into(prefix + "H", value, 8, len(tags))
    for index, tag in enumerate(tags):
        struct.pack_into(prefix + "HHII", value, 10 + index * 12, tag, 4, 1, 1)
    return value


def big_tiff(byteorder):
    prefix = "<" if byteorder == "little" else ">"
    value = bytearray(52)
    value[:2] = b"II" if byteorder == "little" else b"MM"
    struct.pack_into(prefix + "HHHQ", value, 2, 43, 8, 0, 16)
    struct.pack_into(prefix + "QHHQQQ", value, 16, 1, 256, 4, 1, 1, 0)
    return value


def chain(count):
    value = bytearray(8 + count * 18)
    value[:8] = b"II*\x00\x08\x00\x00\x00"
    for index in range(count):
        offset = 8 + index * 18
        struct.pack_into("<HHHIII", value, offset, 1, 50706 if index == count - 1 else 256,
                         4, 1, 1, offset + 18 if index + 1 < count else 0)
    return value


def zero_then_raw_subifd():
    value = bytearray(52)
    value[:8] = b"II*\x00\x08\x00\x00\x00"
    struct.pack_into("<HHHIII", value, 8, 1, 330, 4, 2, 26, 0)
    struct.pack_into("<II", value, 26, 0, 34)
    struct.pack_into("<HHHIII", value, 34, 1, 50706, 4, 1, 1, 0)
    return value


class TiffClassifierTest(unittest.TestCase):
    def classify(self, value):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "source.tiff"
            path.write_bytes(value)
            return parser._classify_tiff(path)

    def test_common_classic_and_bigtiff_variants_are_supported(self):
        for value in (classic([256]), classic([256], "big"), big_tiff("little"), big_tiff("big")):
            self.assertEqual(self.classify(value), "supported")
        cycle = classic([256])
        struct.pack_into("<I", cycle, 22, 8)
        self.assertEqual(self.classify(cycle), "supported")

    def test_deep_and_late_raw_markers_are_not_treated_as_ordinary(self):
        self.assertEqual(self.classify(chain(17)), "raw")
        self.assertEqual(self.classify(classic([256] * 512 + [50706])), "raw")
        self.assertEqual(self.classify(zero_then_raw_subifd()), "raw")

    def test_standard_raw_values_are_recognized(self):
        photometric = classic([262])
        struct.pack_into("<I", photometric, 18, 34892)
        nikon = classic([259])
        struct.pack_into("<I", nikon, 18, 34713)
        self.assertEqual(self.classify(photometric), "raw")
        self.assertEqual(self.classify(nikon), "raw")

    def test_malformed_and_exhausted_metadata_fail_closed(self):
        self.assertEqual(self.classify(b"II*\x00\x08\x00\x00\x00"), "unresolved")
        exhausted = bytearray(b"II*\x00\x08\x00\x00\x00\x01\x20")
        self.assertEqual(self.classify(exhausted), "unresolved")
        huge_children = zero_then_raw_subifd()
        struct.pack_into("<I", huge_children, 14, 257)
        self.assertEqual(self.classify(huge_children), "unresolved")

    def test_parser_gate_rejects_unresolved_and_accepts_bigtiff(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "source.tiff"
            path.write_bytes(b"II*\x00\x08\x00\x00\x00")
            with self.assertRaises(parser.ParserError):
                parser._validate_file_magic("image/tiff", path)
            path.write_bytes(big_tiff("big"))
            parser._validate_file_magic("image/tiff", path)


if __name__ == "__main__":
    unittest.main()
