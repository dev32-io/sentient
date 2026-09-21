#!/usr/bin/env python3
from __future__ import annotations

import http.client
import importlib.util
import json
import os
import runpy
import signal
import socket
import struct
import sys
import subprocess
import tempfile
import uuid
import threading
import zipfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location("attachment_parser", ROOT / "server.py")
assert SPEC and SPEC.loader
parser = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(parser)
CLIENT = ROOT / "exec_client.py"


def parse_frame(output: bytes):
    if len(output) < 4:
        raise AssertionError("missing frame header")
    header_length = struct.unpack(">I", output[:4])[0]
    header_end = 4 + header_length
    return json.loads(output[4:header_end]), output[header_end:]


def png_chunks(body: bytes) -> list[bytes]:
    chunks, offset = [], 8
    while offset + 12 <= len(body):
        length = struct.unpack(">I", body[offset:offset + 4])[0]
        chunks.append(body[offset + 4:offset + 8])
        offset += 12 + length
    return chunks


def synthetic_tiff(tag: int, cr2: bool = False) -> bytes:
    value = bytearray(30)
    value[:8] = b"II*\x00\x0c\x00\x00\x00"
    if cr2:
        value[8:12] = b"CR\x02\x00"
    struct.pack_into("<H", value, 12, 1)
    struct.pack_into("<HHII", value, 14, tag, 4, 1, 1)
    return bytes(value)


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str):
        super().__init__("localhost", timeout=5)
        self.socket_path = socket_path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


class ServiceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture_tmp = tempfile.TemporaryDirectory()
        cls.fixtures = Path(cls.fixture_tmp.name)
        os.environ["FIXTURE_DIR"] = str(cls.fixtures)
        runpy.run_path(str(Path(__file__).with_name("make_fixtures.py")))
        for name in (
            "known.jpg", "known.heic", "known.heif", "known.avif", "known.webp",
            "known.tiff", "known.bmp", "known.jp2", "known.jxl",
        ):
            subprocess.run(
                ["vips", "copy", str(cls.fixtures / "known.png"), str(cls.fixtures / name)],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        subprocess.run(
            ["ffmpeg", "-v", "error", "-threads", "1", "-filter_threads", "1", "-f", "lavfi", "-i", "testsrc=size=24x18:rate=10:duration=0.3", str(cls.fixtures / "animated.gif")],
            check=True,
        )
        for orientation in range(1, 9):
            subprocess.run(["python3", "-c", "import pyvips,sys; a=pyvips.Image.new_from_file(sys.argv[1]); a.set_type(pyvips.GValue.gint_type, 'orientation', int(sys.argv[3])); a.jpegsave(sys.argv[2], Q=95)", str(cls.fixtures / "known.png"), str(cls.fixtures / f"orientation{orientation}.jpg"), str(orientation)], check=True)
        subprocess.run(["vips", "bandjoin_const", str(cls.fixtures / "known.png"), str(cls.fixtures / "alpha.png"), "128"], check=True)
        subprocess.run(["vips", "cast", str(cls.fixtures / "known.png"), str(cls.fixtures / "16bit.tiff"), "ushort"], check=True)
        subprocess.run(["vips", "tiffsave", str(cls.fixtures / "known.png"), str(cls.fixtures / "compressed.tiff"), "--compression", "lzw"], check=True)
        subprocess.run(
            ["python3", "-c", "import pyvips,sys; a=pyvips.Image.new_from_file(sys.argv[1]); b=a.invert(); out=a.join(b, 'vertical'); out.set_type(pyvips.GValue.gint_type, 'page-height', a.height); out.tiffsave(sys.argv[2], page_height=a.height)", str(cls.fixtures / "known.png"), str(cls.fixtures / "multipage.tiff")],
            check=True,
        )
        cls.tmp = tempfile.TemporaryDirectory()
        cls.socket_path = str(Path(cls.tmp.name) / "parser.sock")
        cls.server = parser.UnixHTTPServer(cls.socket_path, parser.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.tmp.cleanup()
        cls.fixture_tmp.cleanup()
        os.environ.pop("FIXTURE_DIR", None)

    def request(self, route: str, body: bytes, content_type: str):
        connection = UnixConnection(self.socket_path)
        connection.request("POST", route, body=body, headers={"Content-Type": content_type, "Content-Length": str(len(body))})
        response = connection.getresponse()
        payload = response.read()
        headers = dict(response.getheaders())
        connection.close()
        return response.status, headers, payload

    def request_get(self, route: str):
        connection = UnixConnection(self.socket_path)
        connection.request("GET", route)
        response = connection.getresponse()
        payload = response.read()
        headers = dict(response.getheaders())
        connection.close()
        return response.status, headers, payload

    def test_health_and_exec_metadata_use_manifest(self) -> None:
        status, _, payload = self.request_get("/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(payload), {"status": "ok", **parser.ADDON_METADATA})

        request_id = str(uuid.uuid4())
        result = subprocess.run(
            ["python3", str(CLIENT), "metadata", request_id],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, "PARSER_SOCKET": self.socket_path},
            check=False,
        )
        header, body = parse_frame(result.stdout)
        self.assertEqual((result.returncode, result.stderr, header["version"], header["requestId"]), (0, b"", 1, request_id))
        self.assertEqual((header["status"], header["contentType"], header["contentLength"]), (200, "application/json", len(body)))
        self.assertEqual(json.loads(body), parser.ADDON_METADATA)

        health = subprocess.run(
            ["python3", str(CLIENT), "--health", "--deadline-ms", "1000"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, "PARSER_SOCKET": self.socket_path},
            check=False,
        )
        self.assertEqual((health.returncode, health.stderr), (0, b""))
        self.assertEqual(json.loads(health.stdout), parser.ADDON_METADATA)

    def test_pdf_header_text_and_render(self) -> None:
        body = (self.fixtures / "text.pdf").read_bytes()
        status, _, result = self.request("/v1/pdf/header", body, "application/pdf")
        self.assertEqual((status, json.loads(result)), (200, {"pageCount": 2}))

        status, headers, result = self.request("/v1/pdf/text?first_page=2&last_page=2", body, "application/pdf")
        self.assertEqual(status, 200)
        self.assertEqual(headers["X-Sentient-Page-Range"], "2-2")
        self.assertIn(b"KNOWN_TEXT_P2", result)
        self.assertNotIn(b"KNOWN_TEXT_P1", result)

        status, headers, result = self.request("/v1/pdf/render?page=1&max_edge=256", body, "application/pdf")
        self.assertEqual(status, 200)
        self.assertEqual(headers["X-Sentient-Page"], "1")
        self.assertTrue(result.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_all_supported_images_header_and_normalization(self) -> None:
        for filename, media_type in (
            ("known.png", "image/png"),
            ("known.jpg", "image/jpeg"),
            ("known.heic", "image/heic"),
            ("known.heif", "image/heif"),
            ("known.avif", "image/avif"),
            ("known.webp", "image/webp"),
            ("animated.gif", "image/gif"),
            ("known.tiff", "image/tiff"),
            ("known.bmp", "image/bmp"),
            ("known.jp2", "image/jp2"),
            ("known.jxl", "image/jxl"),
        ):
            body = (self.fixtures / filename).read_bytes()
            status, _, result = self.request("/v1/image/header", body, media_type)
            self.assertEqual(status, 200)
            source = json.loads(result)
            expected_dimensions = (24, 18) if media_type == "image/gif" else (32, 24)
            self.assertEqual((source["width"], source["height"]), expected_dimensions)
            status, headers, result = self.request("/v1/image/normalize?max_edge=16", body, media_type)
            self.assertEqual(status, 200, filename)
            self.assertTrue(result.startswith(b"\x89PNG\r\n\x1a\n"))
            self.assertTrue(set(png_chunks(result)).isdisjoint({b"eXIf", b"iCCP", b"tEXt", b"zTXt", b"iTXt"}))
            metadata = json.loads(headers["X-Sentient-Visual-Metadata"])
            self.assertEqual(metadata["source"]["mediaType"], media_type)
            self.assertLessEqual(max(metadata["view"]["width"], metadata["view"]["height"]), 16)

    def test_all_orientation_landmarks(self) -> None:
        expected = {
            1: ("R", "K", "Y", "G"), 2: ("K", "R", "G", "Y"),
            3: ("G", "Y", "K", "R"), 4: ("Y", "G", "R", "K"),
            5: ("R", "Y", "K", "G"), 6: ("Y", "R", "G", "K"),
            7: ("G", "K", "Y", "R"), 8: ("K", "G", "R", "Y"),
        }
        for orientation, landmarks in expected.items():
            body = (self.fixtures / f"orientation{orientation}.jpg").read_bytes()
            status, headers, result = self.request("/v1/image/normalize?max_edge=1024", body, "image/jpeg")
            self.assertEqual(status, 200)
            view = json.loads(headers["X-Sentient-Visual-Metadata"])["view"]
            with tempfile.NamedTemporaryFile(suffix=".png") as output:
                output.write(result)
                output.flush()
                points = json.loads(subprocess.check_output(["python3", "-c", "import json,pyvips,sys; a=pyvips.Image.new_from_file(sys.argv[1]); print(json.dumps([a.getpoint(x,y)[:2] for x,y in ((2,2),(a.width-3,2),(2,a.height-3),(a.width-3,a.height-3))]))", output.name]))
            labels = tuple("Y" if r > 128 and g > 128 else "R" if r > 128 else "G" if g > 128 else "K" for r, g in points)
            self.assertEqual(labels, landmarks, orientation)
            self.assertEqual((view["width"], view["height"]), (32, 24) if orientation <= 4 else (24, 32))

    def test_orientation_alpha_animation_tiff_and_original_roi(self) -> None:
        body = (self.fixtures / "orientation8.jpg").read_bytes()
        status, _, result = self.request("/v1/image/header", body, "image/jpeg")
        self.assertEqual(status, 200)
        self.assertEqual((json.loads(result)["orientation"], json.loads(result)["width"], json.loads(result)["height"]), (8, 24, 32))
        status, headers, _ = self.request(
            "/v1/image/normalize?max_edge=1024&region_x=.5&region_y=0&region_width=.5&region_height=.5",
            body,
            "image/jpeg",
        )
        self.assertEqual(status, 200)
        view = json.loads(headers["X-Sentient-Visual-Metadata"])["view"]
        self.assertEqual((view["kind"], view["sourceWidth"], view["sourceHeight"], view["downsampled"]), ("crop", 24, 32, False))
        self.assertEqual((view["width"], view["height"]), (12, 16))

        status, _, result = self.request("/v1/image/header", (self.fixtures / "alpha.png").read_bytes(), "image/png")
        self.assertEqual((status, json.loads(result)["hasAlpha"]), (200, True))

        animated = (self.fixtures / "animated.gif").read_bytes()
        status, _, result = self.request("/v1/image/header", animated, "image/gif")
        source = json.loads(result)
        self.assertEqual(
            (status, source["kind"], source["width"], source["height"], source["storedWidth"], source["storedHeight"], source["frameCount"]),
            (200, "animation", 24, 18, 24, 18, 3),
        )
        self.assertGreater(source["durationMs"], 0)
        frames = []
        for frame_index in range(3):
            status, headers, result = self.request(
                f"/v1/image/normalize?max_edge=32&frame_index={frame_index}", animated, "image/gif"
            )
            self.assertEqual(status, 200)
            metadata = json.loads(headers["X-Sentient-Visual-Metadata"])
            self.assertEqual(
                (metadata["source"]["width"], metadata["source"]["height"], metadata["view"]["sourceWidth"], metadata["view"]["sourceHeight"], metadata["view"]["frameIndex"]),
                (24, 18, 24, 18, frame_index),
            )
            self.assertEqual(struct.unpack(">II", result[16:24]), (24, 18))
            frames.append(result)
        status, headers, timed = self.request("/v1/image/normalize?max_edge=32&time_ms=150", animated, "image/gif")
        self.assertEqual(status, 200)
        self.assertIn("timeMs", json.loads(headers["X-Sentient-Visual-Metadata"])["view"])
        self.assertNotEqual(frames[0], timed)

        for filename in ("16bit.tiff", "compressed.tiff"):
            status, _, result = self.request("/v1/image/normalize?max_edge=16", (self.fixtures / filename).read_bytes(), "image/tiff")
            self.assertEqual(status, 200, filename)
            self.assertTrue(result.startswith(b"\x89PNG"))
        multipage = (self.fixtures / "multipage.tiff").read_bytes()
        status, _, result = self.request("/v1/image/header", multipage, "image/tiff")
        self.assertEqual(status, 200)
        source = json.loads(result)
        self.assertEqual(
            (source["kind"], source["pageCount"], source["width"], source["height"], source["storedWidth"], source["storedHeight"]),
            ("multi_page_image", 2, 32, 24, 32, 24),
        )
        for frame_index in (0, 1):
            status, headers, result = self.request(
                f"/v1/image/normalize?max_edge=64&frame_index={frame_index}", multipage, "image/tiff"
            )
            self.assertEqual(status, 200)
            view = json.loads(headers["X-Sentient-Visual-Metadata"])["view"]
            self.assertEqual((view["sourceWidth"], view["sourceHeight"], view["frameIndex"]), (32, 24, frame_index))
            self.assertEqual(struct.unpack(">II", result[16:24]), (32, 24))

    def test_gif_region_and_parser_limits(self) -> None:
        animated = (self.fixtures / "animated.gif").read_bytes()
        status, headers, result = self.request(
            "/v1/image/normalize?max_edge=32&region_x=.25&region_y=.25&region_width=.5&region_height=.5",
            animated,
            "image/gif",
        )
        self.assertEqual(status, 200)
        view = json.loads(headers["X-Sentient-Visual-Metadata"])["view"]
        self.assertEqual((view["kind"], view["width"], view["height"]), ("crop", 12, 10))
        self.assertEqual(
            view["region"],
            {"x": 6 / 24, "y": 4 / 18, "width": 12 / 24, "height": 10 / 18},
        )
        self.assertTrue(result.startswith(b"\x89PNG"))

        too_many_entries = self.fixtures / "too-many-entries.zip"
        with zipfile.ZipFile(too_many_entries, "w") as archive:
            for index in range(5):
                archive.writestr(f"entry-{index}", b"fixture")
        status, _, result = self.request(
            "/v1/image/header", too_many_entries.read_bytes(), "application/vnd.sentient.live-photo+zip"
        )
        self.assertEqual((status, json.loads(result)["error"]), (422, "archive_entry_limit"))

        status, _, result = self.request(
            "/v1/pdf/header", (self.fixtures / "too-many_pages.pdf").read_bytes(), "application/pdf"
        )
        self.assertEqual((status, json.loads(result)["error"]), (422, "pdf_page_limit"))

        previous = parser.MAX_INPUT_BYTES
        parser.MAX_INPUT_BYTES = 8
        try:
            status, _, result = self.request("/v1/image/header", animated, "image/gif")
        finally:
            parser.MAX_INPUT_BYTES = previous
        self.assertEqual((status, json.loads(result)["error"]), (413, "input_too_large"))

    def test_live_photo_bundle_and_archive_rejections(self) -> None:
        motion = self.fixtures / "motion.mov"
        subprocess.run(["ffmpeg", "-v", "error", "-threads", "1", "-filter_threads", "1", "-f", "lavfi", "-i", "testsrc=size=32x24:rate=5:duration=0.4", "-an", str(motion)], check=True)
        bundle = self.fixtures / "live.zip"
        manifest = {"version": 1, "still": {"name": "live-photo/still.jpg", "mediaType": "image/jpeg"}, "motion": {"name": "live-photo/motion.mov", "mediaType": "video/quicktime"}}
        with zipfile.ZipFile(bundle, "w") as archive:
            archive.writestr("live-photo/manifest.json", json.dumps(manifest))
            archive.write(self.fixtures / "known.jpg", "live-photo/still.jpg")
            archive.write(motion, "live-photo/motion.mov")
        body = bundle.read_bytes()
        status, _, result = self.request("/v1/image/header", body, "application/vnd.sentient.live-photo+zip")
        source = json.loads(result)
        self.assertEqual((status, source["kind"], source["motionAvailable"]), (200, "live_photo", True))
        status, headers, result = self.request("/v1/image/normalize?max_edge=16&time_ms=100", body, "application/vnd.sentient.live-photo+zip")
        self.assertEqual(status, 200)
        self.assertTrue(result.startswith(b"\x89PNG"))
        self.assertEqual(json.loads(headers["X-Sentient-Visual-Metadata"])["source"]["kind"], "live_photo")

        malicious = self.fixtures / "malicious.zip"
        with zipfile.ZipFile(malicious, "w") as archive:
            archive.writestr("live-photo/manifest.json", json.dumps(manifest))
            archive.writestr("live-photo/still.jpg", b"bad")
            archive.writestr("live-photo/motion.mov", b"bad")
            archive.writestr("../escape", b"bad")
        status, _, result = self.request("/v1/image/header", malicious.read_bytes(), "application/vnd.sentient.live-photo+zip")
        self.assertEqual((status, json.loads(result)["error"]), (422, "unsafe_archive"))

        bomb = self.fixtures / "bomb.zip"
        with zipfile.ZipFile(bomb, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("live-photo/manifest.json", json.dumps(manifest))
            archive.writestr("live-photo/still.jpg", b"x" * 1024)
            archive.writestr("live-photo/motion.mov", b"y" * 1024)
        previous = parser.MAX_EXPANDED_BYTES
        parser.MAX_EXPANDED_BYTES = 1024
        try:
            status, _, result = self.request("/v1/image/header", bomb.read_bytes(), "application/vnd.sentient.live-photo+zip")
        finally:
            parser.MAX_EXPANDED_BYTES = previous
        self.assertEqual((status, json.loads(result)["error"]), (422, "archive_expanded_limit"))

        wrong_still = self.fixtures / "wrong-still.zip"
        with zipfile.ZipFile(wrong_still, "w") as archive:
            archive.writestr("live-photo/manifest.json", json.dumps(manifest))
            archive.write(self.fixtures / "known.png", "live-photo/still.jpg")
            archive.write(motion, "live-photo/motion.mov")
        status, _, result = self.request("/v1/image/header", wrong_still.read_bytes(), "application/vnd.sentient.live-photo+zip")
        self.assertEqual((status, json.loads(result)["error"]), (415, "mime_magic_mismatch"))

        mp4 = self.fixtures / "disguised.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-threads", "1", "-filter_threads", "1", "-f", "lavfi", "-i", "testsrc=size=32x24:rate=5:duration=0.2", "-an", "-f", "mp4", str(mp4)], check=True)
        wrong_motion = self.fixtures / "wrong-motion.zip"
        with zipfile.ZipFile(wrong_motion, "w") as archive:
            archive.writestr("live-photo/manifest.json", json.dumps(manifest))
            archive.write(self.fixtures / "known.jpg", "live-photo/still.jpg")
            archive.write(mp4, "live-photo/motion.mov")
        status, _, result = self.request("/v1/image/header", wrong_motion.read_bytes(), "application/vnd.sentient.live-photo+zip")
        self.assertEqual((status, json.loads(result)["error"]), (422, "invalid_live_photo"))

    def test_yuv420_live_photo_odd_origin_one_pixel_crop_is_exact(self) -> None:
        still = self.fixtures / "known.jpg"
        landmark = self.fixtures / "yuv-landmark.pgm"
        pixels = bytearray([16] * (32 * 24))
        pixels[3 * 32 + 3] = 235
        landmark.write_bytes(b"P5\n32 24\n255\n" + pixels)
        motion = self.fixtures / "yuv420-motion.mov"
        subprocess.run([
            "ffmpeg", "-v", "error", "-y", "-loop", "1", "-framerate", "1", "-i", str(landmark),
            "-t", "1", "-an", "-c:v", "libx264", "-crf", "0", "-pix_fmt", "yuv420p", str(motion),
        ], check=True)
        pixel_format = subprocess.check_output([
            "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt",
            "-of", "default=noprint_wrappers=1:nokey=1", str(motion),
        ], text=True).strip()
        self.assertEqual(pixel_format, "yuv420p")
        manifest = {"version": 1, "still": {"name": "live-photo/still.jpg", "mediaType": "image/jpeg"}, "motion": {"name": "live-photo/motion.mov", "mediaType": "video/quicktime"}}
        bundle = self.fixtures / "yuv420-live.zip"
        with zipfile.ZipFile(bundle, "w") as archive:
            archive.writestr("live-photo/manifest.json", json.dumps(manifest))
            archive.write(still, "live-photo/still.jpg")
            archive.write(motion, "live-photo/motion.mov")
        status, headers, result = self.request(
            "/v1/image/normalize?max_edge=32&time_ms=0&region_x=.09375&region_y=.125&region_width=.03125&region_height=.0416666667",
            bundle.read_bytes(),
            "application/vnd.sentient.live-photo+zip",
        )
        self.assertEqual(status, 200)
        self.assertEqual(struct.unpack(">II", result[16:24]), (1, 1))
        view = json.loads(headers["X-Sentient-Visual-Metadata"])["view"]
        self.assertEqual(view["region"], {"x": 3 / 32, "y": 3 / 24, "width": 1 / 32, "height": 1 / 24})
        with tempfile.NamedTemporaryFile(suffix=".png") as output:
            output.write(result)
            output.flush()
            point = json.loads(subprocess.check_output([
                "python3", "-c", "import json,pyvips,sys; a=pyvips.Image.new_from_file(sys.argv[1]); print(json.dumps(a.getpoint(0,0)[:3]))", output.name,
            ]))
        self.assertGreater(min(point), 180)

    def test_raw_tiff_classification_and_motion_pixel_gate(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "source.tiff"
            for tag, cr2 in ((50706, False), (41730, False), (256, True)):
                path.write_bytes(synthetic_tiff(tag, cr2))
                self.assertEqual(parser._classify_tiff(path), "raw")
            path.write_bytes(synthetic_tiff(256))
            self.assertEqual(parser._classify_tiff(path), "supported")
        probe = json.dumps({"streams": [{"width": 5000, "height": 4000}]}).encode()
        with patch.object(parser, "_run", return_value=probe):
            with self.assertRaisesRegex(parser.ParserError, "image_pixel_limit"):
                parser._motion_probe(Path("motion.mov"))

    def test_large_48mp_jpeg_and_200mp_tiff_downsample(self) -> None:
        subprocess.run(["vips", "black", str(self.fixtures / "large48.v"), "8000", "6000", "--bands", "3"], check=True)
        subprocess.run(["vips", "jpegsave", str(self.fixtures / "large48.v"), str(self.fixtures / "large48.jpg"), "--Q", "80"], check=True)
        subprocess.run(["vips", "black", str(self.fixtures / "large200.v"), "20000", "10000", "--bands", "3"], check=True)
        subprocess.run(["vips", "tiffsave", str(self.fixtures / "large200.v"), str(self.fixtures / "large200.tiff"), "--compression", "deflate", "--tile"], check=True)
        for filename, media_type in (("large48.jpg", "image/jpeg"), ("large200.tiff", "image/tiff")):
            original = (self.fixtures / filename).read_bytes()
            digest = __import__("hashlib").sha256(original).digest()
            status, headers, result = self.request("/v1/image/normalize?max_edge=1600", original, media_type)
            self.assertEqual(status, 200, filename)
            self.assertTrue(result.startswith(b"\x89PNG"))
            metadata = json.loads(headers["X-Sentient-Visual-Metadata"])
            self.assertEqual(metadata["source"]["sizeBytes"], len(original))
            self.assertLessEqual(max(metadata["view"]["width"], metadata["view"]["height"]), 1600)
            self.assertEqual(__import__("hashlib").sha256(original).digest(), digest)

    def test_rejects_limits_malformed_and_mime_magic_mismatch(self) -> None:
        status, _, result = self.request(
            "/v1/image/header", (self.fixtures / "oversize-header.png").read_bytes(), "image/png"
        )
        self.assertEqual((status, json.loads(result)["error"]), (422, "image_pixel_limit"))

        status, _, result = self.request("/v1/pdf/header", (self.fixtures / "malformed.pdf").read_bytes(), "application/pdf")
        self.assertEqual((status, json.loads(result)["error"]), (422, "decode_failed"))

        status, _, result = self.request("/v1/image/header", (self.fixtures / "known.png").read_bytes(), "image/jpeg")
        self.assertEqual((status, json.loads(result)["error"]), (415, "mime_magic_mismatch"))

    def test_exec_transport_streams_framed_response(self) -> None:
        body = (self.fixtures / "text.pdf").read_bytes()
        request_id = str(uuid.uuid4())
        result = subprocess.run(
            [
                "python3",
                str(CLIENT),
                "request",
                request_id,
                "pdf-text",
                "application/pdf",
                str(len(body)),
                "--first-page",
                "2",
                "--last-page",
                "2",
                "--deadline-ms",
                "5000",
            ],
            input=body,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, "PARSER_SOCKET": self.socket_path},
            check=False,
        )
        self.assertEqual((result.returncode, result.stderr), (0, b""))
        header, payload = parse_frame(result.stdout)
        self.assertEqual(
            header,
            {
                "version": 1,
                "requestId": request_id,
                "status": 200,
                "contentType": "text/plain; charset=utf-8",
                "contentLength": len(payload),
                "headers": {"X-Sentient-Page-Range": "2-2"},
                "error": None,
            },
        )
        self.assertIn(b"KNOWN_TEXT_P2", payload)
        self.assertNotIn(b"KNOWN_TEXT_P1", payload)

        invalid = subprocess.run(
            [
                "python3",
                str(CLIENT),
                "request",
                str(uuid.uuid4()),
                "image-header",
                "image/png",
                "8",
                "--page",
                "1",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        invalid_header, invalid_body = parse_frame(invalid.stdout)
        self.assertEqual((invalid.returncode, invalid.stderr, invalid_body), (1, b"", b""))
        self.assertEqual((invalid_header["status"], invalid_header["error"]), (400, "invalid_arguments"))

    def test_exec_cancel_kills_client_and_closes_internal_request(self) -> None:
        request_id = str(uuid.uuid4())
        socket_path = str(Path(self.tmp.name) / "blocked.sock")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(socket_path)
        listener.listen(1)
        accepted = threading.Event()
        closed = threading.Event()

        def blocked_server() -> None:
            connection, _ = listener.accept()
            accepted.set()
            try:
                while connection.recv(64 * 1024):
                    pass
            finally:
                connection.close()
                listener.close()
                closed.set()

        thread = threading.Thread(target=blocked_server, daemon=True)
        thread.start()
        process = subprocess.Popen(
            [
                "python3",
                str(CLIENT),
                "request",
                request_id,
                "image-header",
                "image/png",
                "8",
                "--deadline-ms",
                "5000",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, "PARSER_SOCKET": socket_path},
        )
        assert process.stdin is not None
        process.stdin.write(b"12345678")
        process.stdin.close()
        pid_path = Path("/tmp/attachment-parser-exec") / f"{request_id}.pid"
        self.assertTrue(accepted.wait(2))
        self.assertTrue(pid_path.exists())
        cancel = subprocess.run(
            ["python3", str(CLIENT), "cancel", request_id],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        cancel_header, cancel_body = parse_frame(cancel.stdout)
        self.assertEqual((cancel.returncode, cancel.stderr, cancel_body), (0, b"", b""))
        self.assertEqual((cancel_header["status"], cancel_header["error"]), (200, None))
        self.assertEqual(process.wait(timeout=2), -signal.SIGTERM)
        assert process.stdout is not None and process.stderr is not None
        process.stdout.close()
        process.stderr.close()
        self.assertTrue(closed.wait(2))
        thread.join(timeout=2)
        pid_path.unlink(missing_ok=True)

    def test_decoder_deadline_and_abort_are_bounded(self) -> None:
        with self.assertRaisesRegex(parser.ParserError, "deadline_exceeded"):
            parser._run(["python3", "-c", "import time; time.sleep(1)"], 0.01)

        request_socket, peer = socket.socketpair()
        parser._REQUEST.socket = request_socket
        timer = threading.Timer(0.01, peer.close)
        timer.start()
        try:
            with self.assertRaisesRegex(parser.ParserError, "request_aborted"):
                parser._run(["python3", "-c", "import time; time.sleep(1)"], 1)
        finally:
            timer.join()
            request_socket.close()
            del parser._REQUEST.socket

        body = (self.fixtures / "text.pdf").read_bytes()
        error = parser.ParserError(parser.HTTPStatus.REQUEST_TIMEOUT, "deadline_exceeded")
        with patch.object(parser, "_run", side_effect=error):
            status, _, result = self.request("/v1/pdf/header", body, "application/pdf")
        self.assertEqual((status, json.loads(result)), (408, {"error": "deadline_exceeded"}))


if __name__ == "__main__":
    unittest.main()
