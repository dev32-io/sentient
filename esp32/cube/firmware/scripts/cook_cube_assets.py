"""Deterministic Cube v1 read-only namespace; zlib decoded once into PSRAM."""
import json
from pathlib import Path
import re
import struct
import zlib

MAX_EXPANDED = 6 * 1024 * 1024
MAX_ENTRIES = 128
PATH_SIZE = 96
ENTRY_SIZE = 104
POSES = ("ready", "blink", "listening", "listening-blink", "thinking",
         "thinking-blink", "speaking", "offline", "offline-tail")


def pack(files):
    if not 0 < len(files) <= MAX_ENTRIES:
        raise ValueError("asset count exceeds pack contract")
    table = bytearray()
    payload = bytearray()
    base = len(files) * ENTRY_SIZE
    for name, data in sorted(files.items()):
        path = name.encode("ascii")
        if (len(path) >= PATH_SIZE or not re.fullmatch(r"/[A-Za-z0-9_.\-/]+", name)
                or any(p in ("", ".", "..") for p in name[1:].split("/")) or not data):
            raise ValueError("invalid asset path or empty payload")
        payload.extend(b"\0" * (-(base + len(payload)) % 4))
        table.extend(struct.pack("<96sII", path, base + len(payload), len(data)))
        payload.extend(data)
    expanded = table + payload
    if len(expanded) > MAX_EXPANDED:
        raise ValueError("expanded pack exceeds PSRAM admission limit")
    compressed = zlib.compress(expanded, 9)
    result = struct.pack("<8sIIII", b"CUBEPAK1", 1, len(files), len(expanded), len(compressed)) + compressed
    if len(result) > 0xfe0000:
        raise ValueError("pack exceeds factory partition")
    return result


def cook(board, font, output, srmodels=None, multinet_model=None):
    board, font = Path(board), Path(font)
    font_name = "/ui/fonts/" + font.name
    index = {"version": 1, "text_font": font_name}
    files = {font_name: font.read_bytes(),
             "/companions/cat/companion.json": (board / "companion.json").read_bytes()}
    for pose in POSES:
        files["/companions/cat/" + pose + ".rgb565"] = (board / "character" / ("cat-" + pose + ".rgb565")).read_bytes()
    for path in sorted((board / "character").glob("*.i1")):
        files["/ui/" + path.name] = path.read_bytes()
    for path in sorted((board / "character").glob("bubble*.rgb565")):
        files["/ui/" + path.name] = path.read_bytes()
    if srmodels:
        index["srmodels"] = "/models/srmodels.bin"
        files[index["srmodels"]] = Path(srmodels).read_bytes()
    if multinet_model:
        index["multinet_model"] = multinet_model
    files["/index.json"] = json.dumps(index, sort_keys=True, separators=(",", ":")).encode()
    result = pack(files)
    Path(output).write_bytes(result)
    print(f"Cube pack: entries={len(files)} expanded={struct.unpack_from('<I', result, 16)[0]} packed={len(result)}")
