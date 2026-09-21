#!/usr/bin/env python3
"""Bounded attachment parser HTTP/1.1 service over a Unix-domain socket."""

from __future__ import annotations

import json
import os
import re
import selectors
import socket
import socketserver
import subprocess
import time
import tempfile
import threading
import zipfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from addon_metadata import ADDON_METADATA

SOCKET_PATH = os.environ.get("PARSER_SOCKET", "/tmp/attachment-parser/parser.sock")
MAX_INPUT_BYTES = int(os.environ.get("MAX_INPUT_BYTES", 512 * 1024 * 1024))
MAX_RESPONSE_BYTES = int(os.environ.get("MAX_RESPONSE_BYTES", 16 * 1024 * 1024))
MAX_TEXT_BYTES = int(os.environ.get("MAX_TEXT_BYTES", 2 * 1024 * 1024))
MAX_PIXELS = int(os.environ.get("MAX_PIXELS", 225_000_000))
MAX_MOTION_PIXELS = int(os.environ.get("MAX_MOTION_PIXELS", 16_000_000))
MAX_ARCHIVE_ENTRIES = int(os.environ.get("MAX_ARCHIVE_ENTRIES", 4))
MAX_EXPANDED_BYTES = int(os.environ.get("MAX_EXPANDED_BYTES", 512 * 1024 * 1024))
MAX_PDF_PAGES = int(os.environ.get("MAX_PDF_PAGES", 50))
MAX_TIFF_IFDS = 256
MAX_TIFF_ENTRIES = 8_192
MAX_TIFF_READ_BYTES = 1024 * 1024
MAX_EDGE = int(os.environ.get("MAX_EDGE", 1600))
HEADER_DEADLINE_SECONDS = float(os.environ.get("HEADER_DEADLINE_SECONDS", 2))
ITEM_DEADLINE_SECONDS = float(os.environ.get("ITEM_DEADLINE_SECONDS", 20))
TEXT_DEADLINE_SECONDS = float(os.environ.get("TEXT_DEADLINE_SECONDS", 30))
CONCURRENCY = int(os.environ.get("PARSER_CONCURRENCY", 1))

_IMAGE_TYPES = {
    "image/png": ("png", b"\x89PNG\r\n\x1a\n"),
    "image/jpeg": ("jpg", b"\xff\xd8\xff"),
    "image/heic": ("heic", None),
    "image/heif": ("heif", None),
    "image/avif": ("avif", None),
    "image/webp": ("webp", b"RIFF"),
    "image/gif": ("gif", b"GIF8"),
    "image/tiff": ("tiff", None),
    "image/bmp": ("bmp", b"BM"),
    "image/jp2": ("jp2", None),
    "image/jxl": ("jxl", None),
    "application/vnd.sentient.live-photo+zip": ("zip", b"PK\x03\x04"),
}
IMAGE_WORKER = "/app/image_worker.py"
LIVE_PHOTO_TYPE = "application/vnd.sentient.live-photo+zip"
_SEMAPHORE = threading.BoundedSemaphore(CONCURRENCY)
_REQUEST = threading.local()


class ParserError(Exception):
    def __init__(self, status: HTTPStatus, reason: str):
        super().__init__(reason)
        self.status = status
        self.reason = reason


def _positive_int(query: dict[str, list[str]], name: str, default: int | None = None) -> int:
    raw = query.get(name, [str(default) if default is not None else ""])[0]
    try:
        value = int(raw)
    except ValueError as exc:
        raise ParserError(HTTPStatus.BAD_REQUEST, f"invalid_{name}") from exc
    if value < 1:
        raise ParserError(HTTPStatus.BAD_REQUEST, f"invalid_{name}")
    return value


def _nonnegative_int(query: dict[str, list[str]], name: str) -> int | None:
    if name not in query:
        return None
    raw = query[name][0]
    try:
        value = int(raw)
    except ValueError as exc:
        raise ParserError(HTTPStatus.BAD_REQUEST, f"invalid_{name}") from exc
    if value < 0:
        raise ParserError(HTTPStatus.BAD_REQUEST, f"invalid_{name}")
    return value


def _region(query: dict[str, list[str]]) -> tuple[float, float, float, float] | None:
    names = ("region_x", "region_y", "region_width", "region_height")
    if not any(name in query for name in names):
        return None
    if not all(len(query.get(name, [])) == 1 for name in names):
        raise ParserError(HTTPStatus.BAD_REQUEST, "invalid_region")
    try:
        x, y, width, height = (float(query[name][0]) for name in names)
    except ValueError as exc:
        raise ParserError(HTTPStatus.BAD_REQUEST, "invalid_region") from exc
    if not all(value >= 0 and value <= 1 for value in (x, y, width, height)) or width <= 0 or height <= 0 or x + width > 1 or y + height > 1:
        raise ParserError(HTTPStatus.BAD_REQUEST, "invalid_region")
    return x, y, width, height


def _run(argv: list[str], deadline: float) -> bytes:
    try:
        process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except OSError as exc:
        raise ParserError(HTTPStatus.INTERNAL_SERVER_ERROR, "decoder_unavailable") from exc
    assert process.stdout is not None
    output = bytearray()
    end = time.monotonic() + deadline
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    request_socket = getattr(_REQUEST, "socket", None)
    if request_socket is not None:
        selector.register(request_socket, selectors.EVENT_READ)
    try:
        while True:
            remaining = end - time.monotonic()
            events = selector.select(max(remaining, 0))
            if remaining <= 0 or not events:
                process.kill()
                process.wait()
                raise ParserError(HTTPStatus.REQUEST_TIMEOUT, "deadline_exceeded")
            stdout_ready = False
            for key, _ in events:
                if key.fileobj is process.stdout:
                    stdout_ready = True
                    continue
                try:
                    if request_socket.recv(1, socket.MSG_PEEK) == b"":
                        process.kill()
                        process.wait()
                        raise ParserError(HTTPStatus.REQUEST_TIMEOUT, "request_aborted")
                    selector.unregister(request_socket)  # pipelined bytes belong to next request
                except BlockingIOError:
                    pass
            if not stdout_ready:
                continue
            chunk = os.read(process.stdout.fileno(), 64 * 1024)
            if not chunk:
                break
            output.extend(chunk)
            if len(output) > MAX_RESPONSE_BYTES:
                process.kill()
                process.wait()
                raise ParserError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "response_too_large")
        remaining = end - time.monotonic()
        if remaining <= 0:
            process.kill()
            process.wait()
            raise ParserError(HTTPStatus.REQUEST_TIMEOUT, "deadline_exceeded")
        return_code = process.wait(timeout=remaining)
    except subprocess.TimeoutExpired as exc:
        process.kill()
        process.wait()
        raise ParserError(HTTPStatus.REQUEST_TIMEOUT, "deadline_exceeded") from exc
    finally:
        selector.close()
        process.stdout.close()
    if return_code != 0:
        raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "decode_failed")
    return bytes(output)


def _pdf_pages(path: Path) -> int:
    output = _run(["pdfinfo", str(path)], HEADER_DEADLINE_SECONDS).decode("utf-8", "replace")
    match = re.search(r"^Pages:\s+(\d+)\s*$", output, re.MULTILINE)
    if not match:
        raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "decode_failed")
    pages = int(match.group(1))
    if pages < 1 or pages > MAX_PDF_PAGES:
        raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "pdf_page_limit")
    return pages


def _image_metadata(path: Path, content_type: str, size_bytes: int) -> dict[str, object]:
    try:
        stored_width = int(_run(["vipsheader", "-f", "width", str(path)], HEADER_DEADLINE_SECONDS))
        stored_height = int(_run(["vipsheader", "-f", "height", str(path)], HEADER_DEADLINE_SECONDS))
    except ValueError as exc:
        raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "decode_failed") from exc
    if stored_width < 1 or stored_height < 1 or stored_width * stored_height > MAX_PIXELS:
        raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "image_pixel_limit")
    raw = _run(["python3", IMAGE_WORKER, "header", str(path), content_type, str(size_bytes)], HEADER_DEADLINE_SECONDS)
    try:
        value = json.loads(raw)
        width, height = value["width"], value["height"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "decode_failed") from exc
    if not isinstance(width, int) or not isinstance(height, int) or width < 1 or height < 1 or width * height > MAX_PIXELS:
        raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "image_pixel_limit")
    return value


def _validate_magic(content_type: str, prefix: bytes) -> str:
    if content_type == "application/pdf":
        if not prefix.startswith(b"%PDF-"):
            raise ParserError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "mime_magic_mismatch")
        return "pdf"
    image = _IMAGE_TYPES.get(content_type)
    if image is None:
        raise ParserError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type")
    suffix, magic = image
    if magic is not None and not prefix.startswith(magic):
        raise ParserError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "mime_magic_mismatch")
    if content_type == "image/webp" and prefix[8:12] != b"WEBP":
        raise ParserError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "mime_magic_mismatch")
    if content_type in {"image/heic", "image/heif", "image/avif"}:
        brands = prefix[8:32] if len(prefix) >= 12 and prefix[4:8] == b"ftyp" else b""
        allowed = {"image/heic": (b"heic", b"heix", b"hevc", b"hevx"), "image/heif": (b"mif1", b"msf1", b"heic", b"heif"), "image/avif": (b"avif", b"avis")}[content_type]
        if not any(brand in brands for brand in allowed):
            raise ParserError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "mime_magic_mismatch")
    if content_type == "image/tiff" and prefix[:4] not in {b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+"}:
        raise ParserError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "mime_magic_mismatch")
    if content_type == "image/jp2" and not (prefix.startswith(b"\x00\x00\x00\x0cjP  \r\n\x87\n") or prefix.startswith(b"\xffO\xffQ")):
        raise ParserError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "mime_magic_mismatch")
    if content_type == "image/jxl" and not (prefix.startswith(b"\xff\x0a") or prefix.startswith(b"\x00\x00\x00\x0cJXL \r\n\x87\n")):
        raise ParserError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "mime_magic_mismatch")
    return suffix


def _classify_tiff(path: Path) -> str:
    """Return supported/raw/unresolved within aggregate IFD, entry, and read bounds."""
    type_sizes = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4,
                  10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8}
    size = path.stat().st_size
    bytes_read = 0

    class Unresolved(Exception):
        pass

    with path.open("rb") as source:
        def read(offset: int, length: int) -> bytes:
            nonlocal bytes_read
            if offset < 0 or length < 0 or offset + length > size or bytes_read + length > MAX_TIFF_READ_BYTES:
                raise Unresolved
            source.seek(offset)
            value = source.read(length)
            if len(value) != length:
                raise Unresolved
            bytes_read += length
            return value

        try:
            first = read(0, 8)
            if first[:2] not in (b"II", b"MM"):
                raise Unresolved
            byteorder = "little" if first[:2] == b"II" else "big"
            u16 = lambda value, offset=0: int.from_bytes(value[offset:offset + 2], byteorder)
            u32 = lambda value, offset=0: int.from_bytes(value[offset:offset + 4], byteorder)
            u64 = lambda value, offset=0: int.from_bytes(value[offset:offset + 8], byteorder)
            magic = u16(first, 2)
            if magic == 42:
                big, first_ifd = False, u32(first, 4)
                if size >= 12 and read(8, 4) == b"CR\x02\x00":
                    return "raw"
            elif magic == 43:
                if u16(first, 4) != 8 or u16(first, 6) != 0:
                    raise Unresolved
                big, first_ifd = True, u64(read(8, 8))
            else:
                raise Unresolved
            if first_ifd == 0:
                raise Unresolved

            count_size, entry_size, inline_size = (8, 20, 8) if big else (2, 12, 4)
            pending, visited, entries_seen = [first_ifd], set(), 0
            while pending:
                offset = pending.pop(0)
                if offset == 0 or offset in visited:
                    continue
                if len(visited) >= MAX_TIFF_IFDS:
                    raise Unresolved
                visited.add(offset)
                count_buffer = read(offset, count_size)
                count = u64(count_buffer) if big else u16(count_buffer)
                if count > MAX_TIFF_ENTRIES - entries_seen:
                    raise Unresolved
                table = read(offset + count_size, count * entry_size + inline_size)
                entries_seen += count
                for index in range(count):
                    entry = table[index * entry_size:(index + 1) * entry_size]
                    tag, field_type = u16(entry), u16(entry, 2)
                    type_size = type_sizes.get(field_type)
                    if type_size is None:
                        raise Unresolved
                    item_count = u64(entry, 4) if big else u32(entry, 4)
                    value_length = item_count * type_size
                    value_field = 12 if big else 8
                    value_offset = u64(entry, value_field) if big else u32(entry, value_field)
                    if value_length > inline_size and value_offset + value_length > size:
                        raise Unresolved
                    if tag in (33421, 33422, 41730, 50706):
                        return "raw"
                    if tag in (259, 262) and item_count and field_type in (3, 4, 16):
                        value = (entry[value_field:value_field + inline_size] if value_length <= inline_size
                                 else read(value_offset, type_size))
                        scalar = (u16 if field_type == 3 else u32 if field_type == 4 else u64)(value)
                        if (tag == 262 and scalar in (32803, 34892)) or (tag == 259 and scalar == 34713):
                            return "raw"
                    if tag != 330:
                        continue
                    if field_type not in (4, 13, 16, 18) or item_count > MAX_TIFF_IFDS:
                        raise Unresolved
                    value = (entry[value_field:value_field + inline_size] if value_length <= inline_size
                             else read(value_offset, value_length))
                    width = 4 if field_type in (4, 13) else 8
                    for child in range(item_count):
                        child_offset = (u32 if width == 4 else u64)(value, child * width)
                        if child_offset:
                            pending.append(child_offset)
                next_ifd = (u64 if big else u32)(table, count * entry_size)
                if next_ifd:
                    pending.append(next_ifd)
            return "supported"
        except (Unresolved, OverflowError, ValueError):
            return "unresolved"


def _validate_file_magic(content_type: str, path: Path) -> None:
    with path.open("rb") as source:
        prefix = source.read(32)
    _validate_magic(content_type, prefix)
    if content_type == "image/tiff" and _classify_tiff(path) != "supported":
        raise ParserError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type")


def _validate_quicktime(path: Path) -> None:
    with path.open("rb") as source:
        prefix = source.read(32)
    if len(prefix) < 12 or prefix[4:8] != b"ftyp" or b"qt  " not in prefix[8:]:
        raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_live_photo")


def _bounded_file(path: Path, limit: int = MAX_RESPONSE_BYTES) -> bytes:
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "decode_failed") from exc
    if size > limit:
        raise ParserError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "response_too_large")
    return path.read_bytes()


def _live_photo(path: Path) -> tuple[Path, str, Path]:
    archive: zipfile.ZipFile | None = None
    try:
        archive = zipfile.ZipFile(path)
        entries = archive.infolist()
        if len(entries) < 3 or len(entries) > MAX_ARCHIVE_ENTRIES:
            raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "archive_entry_limit")
        names = [entry.filename for entry in entries]
        if len(names) != len(set(names)):
            raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "unsafe_archive")
        for entry in entries:
            mode = entry.external_attr >> 16
            if entry.flag_bits & 1 or "\\" in entry.filename or entry.filename.startswith("/") or ".." in Path(entry.filename).parts or (mode & 0o170000) == 0o120000:
                raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "unsafe_archive")
        if sum(entry.file_size for entry in entries) > MAX_EXPANDED_BYTES:
            raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "archive_expanded_limit")
        manifest_entry = archive.getinfo("live-photo/manifest.json")
        if manifest_entry.file_size > 64 * 1024:
            raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_live_photo")
        manifest = json.loads(archive.read(manifest_entry))
        if not isinstance(manifest, dict) or set(manifest) != {"version", "still", "motion"} or manifest["version"] != 1:
            raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_live_photo")
        still, motion = manifest["still"], manifest["motion"]
        if not isinstance(still, dict) or set(still) != {"name", "mediaType"} or not isinstance(motion, dict) or set(motion) != {"name", "mediaType"}:
            raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_live_photo")
        if motion != {"name": "live-photo/motion.mov", "mediaType": "video/quicktime"}:
            raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_live_photo")
        still_type = still.get("mediaType")
        expected_suffix = _IMAGE_TYPES.get(still_type, (None, None))[0]
        if still_type == LIVE_PHOTO_TYPE or expected_suffix is None or still.get("name") != f"live-photo/still.{expected_suffix}":
            raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_live_photo")
        allowed = {"live-photo/manifest.json", still["name"], motion["name"], "live-photo/"}
        if set(names) - allowed or not {"live-photo/manifest.json", still["name"], motion["name"]}.issubset(names):
            raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_live_photo")
        still_path, motion_path = path.parent / f"live-still.{expected_suffix}", path.parent / "live-motion.mov"
        copied = 0
        for name, target in ((still["name"], still_path), (motion["name"], motion_path)):
            with archive.open(name) as source, target.open("wb") as output:
                while chunk := source.read(64 * 1024):
                    copied += len(chunk)
                    if copied > MAX_EXPANDED_BYTES:
                        raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "archive_expanded_limit")
                    output.write(chunk)
        _validate_file_magic(still_type, still_path)
        _validate_quicktime(motion_path)
        return still_path, still_type, motion_path
    except ParserError:
        raise
    except (KeyError, OSError, ValueError, zipfile.BadZipFile, json.JSONDecodeError) as exc:
        raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_live_photo") from exc
    finally:
        if archive is not None:
            archive.close()


def _motion_probe(path: Path) -> tuple[dict[str, object], int, int]:
    raw = _run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_frames,duration:stream_side_data=rotation", "-of", "json", str(path)], HEADER_DEADLINE_SECONDS)
    try:
        stream = json.loads(raw)["streams"][0]
        width, height = stream["width"], stream["height"]
    except (json.JSONDecodeError, KeyError, IndexError, TypeError, ValueError) as exc:
        raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_live_photo") from exc
    if not isinstance(width, int) or not isinstance(height, int) or width < 1 or height < 1 or width * height > MAX_MOTION_PIXELS:
        raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "image_pixel_limit")
    rotation = next((item.get("rotation") for item in stream.get("side_data_list", []) if isinstance(item, dict) and isinstance(item.get("rotation"), int)), 0)
    upright_width, upright_height = (height, width) if rotation % 180 else (width, height)
    result: dict[str, object] = {}
    if isinstance(stream.get("duration"), str):
        duration = round(float(stream["duration"]) * 1000)
        if duration >= 0:
            result["durationMs"] = duration
    if isinstance(stream.get("nb_frames"), str) and stream["nb_frames"].isdigit() and int(stream["nb_frames"]) > 0:
        result["frameCount"] = int(stream["nb_frames"])
    return result, upright_width, upright_height


def _motion_metadata(path: Path) -> dict[str, object]:
    return _motion_probe(path)[0]


class Handler(BaseHTTPRequestHandler):
    server_version = "sentient-attachment-parser/1"
    protocol_version = "HTTP/1.1"

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(TEXT_DEADLINE_SECONDS)

    def log_message(self, _format: str, *_args: object) -> None:
        pass

    def do_GET(self) -> None:
        if self.path != "/health":
            self._error(ParserError(HTTPStatus.NOT_FOUND, "not_found"))
            return
        self._send(
            HTTPStatus.OK,
            "application/json",
            json.dumps({"status": "ok", **ADDON_METADATA}, separators=(",", ":")).encode(),
        )

    def do_POST(self) -> None:
        if not _SEMAPHORE.acquire(timeout=ITEM_DEADLINE_SECONDS):
            self._error(ParserError(HTTPStatus.SERVICE_UNAVAILABLE, "busy"))
            return
        try:
            self._handle_post()
        except ParserError as exc:
            self._error(exc)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except TimeoutError:
            self._error(ParserError(HTTPStatus.REQUEST_TIMEOUT, "deadline_exceeded"))
        except Exception:
            self._error(ParserError(HTTPStatus.INTERNAL_SERVER_ERROR, "internal_error"))
        finally:
            _SEMAPHORE.release()

    def _handle_post(self) -> None:
        route = urlsplit(self.path)
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError as exc:
            raise ParserError(HTTPStatus.LENGTH_REQUIRED, "content_length_required") from exc
        if length < 1 or length > MAX_INPUT_BYTES:
            raise ParserError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "input_too_large")

        with tempfile.TemporaryDirectory(dir="/tmp") as tmp:
            prefix = b""
            input_path = Path(tmp) / "input"
            remaining = length
            with input_path.open("wb") as output:
                while remaining:
                    chunk = self.rfile.read(min(64 * 1024, remaining))
                    if not chunk:
                        raise ParserError(HTTPStatus.BAD_REQUEST, "incomplete_body")
                    if len(prefix) < 32:
                        prefix += chunk[: 32 - len(prefix)]
                    output.write(chunk)
                    remaining -= len(chunk)
            suffix = _validate_magic(content_type, prefix)
            typed_path = input_path.with_suffix(f".{suffix}")
            input_path.rename(typed_path)
            if content_type == "image/tiff":
                _validate_file_magic(content_type, typed_path)
            _REQUEST.socket = self.connection
            try:
                body, response_type, extra_headers = self._dispatch(
                    route.path, parse_qs(route.query), content_type, typed_path
                )
            finally:
                del _REQUEST.socket
            self._send(HTTPStatus.OK, response_type, body, extra_headers)

    def _dispatch(
        self, route: str, query: dict[str, list[str]], content_type: str, path: Path
    ) -> tuple[bytes, str, dict[str, str]]:
        if route.startswith("/v1/pdf/") and content_type != "application/pdf":
            raise ParserError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type")
        if route.startswith("/v1/image/") and content_type not in _IMAGE_TYPES:
            raise ParserError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type")

        if route == "/v1/pdf/header":
            return json.dumps({"pageCount": _pdf_pages(path)}, separators=(",", ":")).encode(), "application/json", {}
        if route == "/v1/pdf/text":
            pages = _pdf_pages(path)
            first = _positive_int(query, "first_page", 1)
            last = _positive_int(query, "last_page", pages)
            if first > last or last > pages:
                raise ParserError(HTTPStatus.BAD_REQUEST, "invalid_page_range")
            output = path.parent / "text.txt"
            _run(["pdftotext", "-f", str(first), "-l", str(last), "-layout", str(path), str(output)], TEXT_DEADLINE_SECONDS)
            return _bounded_file(output, MAX_TEXT_BYTES), "text/plain; charset=utf-8", {"X-Sentient-Page-Range": f"{first}-{last}"}
        if route == "/v1/pdf/render":
            pages = _pdf_pages(path)
            page = _positive_int(query, "page")
            edge = min(_positive_int(query, "max_edge", MAX_EDGE), MAX_EDGE)
            if page > pages:
                raise ParserError(HTTPStatus.BAD_REQUEST, "invalid_page")
            root = path.parent / "render"
            _run(["pdftoppm", "-f", str(page), "-l", str(page), "-singlefile", "-png", "-scale-to", str(edge), str(path), str(root)], ITEM_DEADLINE_SECONDS)
            return _bounded_file(root.with_suffix(".png")), "image/png", {"X-Sentient-Page": str(page)}
        if route == "/v1/image/header":
            if content_type == LIVE_PHOTO_TYPE:
                still_path, still_type, motion_path = _live_photo(path)
                still = _image_metadata(still_path, still_type, still_path.stat().st_size)
                body = {**still, "kind": "live_photo", "mediaType": content_type, "sizeBytes": path.stat().st_size, "motionAvailable": True, **_motion_metadata(motion_path)}
            else:
                body = _image_metadata(path, content_type, path.stat().st_size)
            return json.dumps(body, separators=(",", ":")).encode(), "application/json", {}
        if route == "/v1/image/normalize":
            edge = min(_positive_int(query, "max_edge", MAX_EDGE), MAX_EDGE)
            frame_index = _nonnegative_int(query, "frame_index")
            time_ms = _nonnegative_int(query, "time_ms")
            if frame_index is not None and time_ms is not None:
                raise ParserError(HTTPStatus.BAD_REQUEST, "invalid_frame_selection")
            region = _region(query)
            output, metadata = path.parent / "normalized.png", path.parent / "metadata.json"
            source_path, source_type = path, content_type
            if content_type == LIVE_PHOTO_TYPE:
                still_path, still_type, motion_path = _live_photo(path)
                if frame_index is not None or time_ms is not None:
                    source_path, source_type = path.parent / "motion.png", "image/png"
                    _, motion_width, motion_height = _motion_probe(motion_path)
                    filters = []
                    if frame_index is not None:
                        filters.append(f"select=eq(n\\,{frame_index})")
                    if region:
                        x, y, width, height = region
                        left, top = int(x * motion_width), int(y * motion_height)
                        right, bottom = min(motion_width, int((x + width) * motion_width + .999999)), min(motion_height, int((y + height) * motion_height + .999999))
                        filters.append(f"crop=w={right - left}:h={bottom - top}:x={left}:y={top}:exact=1")
                    filters.append(f"scale=w=min({edge}\\,iw):h=min({edge}\\,ih):force_original_aspect_ratio=decrease")
                    argv = ["ffmpeg", "-v", "error", "-threads", "1", "-filter_threads", "1"]
                    if time_ms is not None:
                        argv += ["-ss", f"{time_ms / 1000:.3f}"]
                    argv += ["-i", str(motion_path), "-vf", ",".join(filters)]
                    if frame_index is not None:
                        argv += ["-vsync", "0"]
                    argv += ["-frames:v", "1", str(source_path)]
                    _run(argv, ITEM_DEADLINE_SECONDS)
                    if not source_path.is_file():
                        raise ParserError(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_frame_selection")
                else:
                    source_path, source_type = still_path, still_type
            argv = ["python3", IMAGE_WORKER, "render", str(source_path), source_type, str(source_path.stat().st_size), "--output", str(output), "--metadata", str(metadata), "--max-edge", str(edge)]
            if content_type != LIVE_PHOTO_TYPE:
                if frame_index is not None:
                    argv += ["--frame-index", str(frame_index)]
                if time_ms is not None:
                    argv += ["--time-ms", str(time_ms)]
            if region and not (content_type == LIVE_PHOTO_TYPE and (frame_index is not None or time_ms is not None)):
                argv += ["--region", *(str(value) for value in region)]
            _run(argv, ITEM_DEADLINE_SECONDS)
            rendered = json.loads(_bounded_file(metadata, 16 * 1024))
            if content_type == LIVE_PHOTO_TYPE:
                still_meta = _image_metadata(still_path, still_type, still_path.stat().st_size)
                rendered["source"] = {**still_meta, "kind": "live_photo", "mediaType": content_type, "sizeBytes": path.stat().st_size, "motionAvailable": True, **_motion_metadata(motion_path)}
                rendered["view"]["partialCoverage"] = True
                if frame_index is not None or time_ms is not None:
                    _, motion_width, motion_height = _motion_probe(motion_path)
                    rendered["view"].update({"kind": "crop" if region else "frame", "sourceWidth": motion_width, "sourceHeight": motion_height})
                    rendered["view"].pop("timeMs", None)  # requested time is not an observed frame timestamp
                    rendered["view"].pop("frameIndex", None)
                    if frame_index is not None:
                        rendered["view"]["frameIndex"] = frame_index
                    if region:
                        x, y, width, height = region
                        left, top = int(x * motion_width), int(y * motion_height)
                        right, bottom = min(motion_width, int((x + width) * motion_width + .999999)), min(motion_height, int((y + height) * motion_height + .999999))
                        rendered["view"]["region"] = {"x": left / motion_width, "y": top / motion_height, "width": (right - left) / motion_width, "height": (bottom - top) / motion_height}
                        rendered["view"]["downsampled"] = rendered["view"]["width"] < right - left or rendered["view"]["height"] < bottom - top
                    else:
                        rendered["view"]["downsampled"] = rendered["view"]["width"] < motion_width or rendered["view"]["height"] < motion_height
            return _bounded_file(output), "image/png", {"X-Sentient-Visual-Metadata": json.dumps(rendered, separators=(",", ":"))}
        raise ParserError(HTTPStatus.NOT_FOUND, "not_found")

    def _error(self, error: ParserError) -> None:
        body = json.dumps({"error": error.reason}, separators=(",", ":")).encode()
        try:
            self._send(error.status, "application/json", body, {"Connection": "close"})
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send(self, status: HTTPStatus, content_type: str, body: bytes, headers: dict[str, str] | None = None) -> None:
        if len(body) > MAX_RESPONSE_BYTES:
            raise ParserError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "response_too_large")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        for offset in range(0, len(body), 64 * 1024):
            self.wfile.write(body[offset : offset + 64 * 1024])


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 8


def main() -> None:
    socket_path = Path(SOCKET_PATH)
    socket_path.parent.mkdir(parents=True, exist_ok=True)
    socket_path.unlink(missing_ok=True)
    server = UnixHTTPServer(str(socket_path), Handler)
    os.chmod(socket_path, 0o660)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        socket_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
