#!/usr/bin/env python3
"""Bounded stdin/stdout bridge from Docker exec to parser's internal UDS."""

from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import signal
import socket
import struct
import sys
import time
from pathlib import Path
from urllib.parse import urlencode

from addon_metadata import ADDON_METADATA

SOCKET_PATH = os.environ.get("PARSER_SOCKET", "/tmp/attachment-parser/parser.sock")
MAX_INPUT_BYTES = int(os.environ.get("MAX_INPUT_BYTES", 512 * 1024 * 1024))
MAX_RESPONSE_BYTES = int(os.environ.get("MAX_RESPONSE_BYTES", 16 * 1024 * 1024))
MAX_HEALTH_RESPONSE_BYTES = 16 * 1024
MAX_EDGE = int(os.environ.get("MAX_EDGE", 1600))
PID_DIR = Path("/tmp/attachment-parser-exec")
MAX_DEADLINE_MS = 35_000
REQUEST_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
MEDIA_TYPES = {
    "application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif", "image/avif",
    "image/webp", "image/gif", "image/tiff", "image/bmp", "image/jp2", "image/jxl",
    "application/vnd.sentient.live-photo+zip",
}
OPERATIONS = {"pdf-header", "pdf-text", "pdf-render", "image-header", "image-normalize"}


class ClientError(Exception):
    def __init__(self, status: int, reason: str):
        super().__init__(reason)
        self.status = status
        self.reason = reason


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ClientError(400, "invalid_arguments")


class DeadlineExpired(Exception):
    pass


class OutputStarted(Exception):
    pass


def _deadline(_signum: int, _frame: object) -> None:
    raise DeadlineExpired()


def _write_header(
    request_id: str | None,
    status: int,
    content_type: str,
    content_length: int,
    headers: dict[str, str],
    error: str | None,
    body: bytes = b"",
) -> None:
    metadata = json.dumps(
        {
            "version": 1,
            "requestId": request_id,
            "status": status,
            "contentType": content_type,
            "contentLength": content_length,
            "headers": headers,
            "error": error,
        },
        separators=(",", ":"),
    ).encode("utf-8")
    sys.stdout.buffer.write(struct.pack(">I", len(metadata)))
    sys.stdout.buffer.write(metadata)
    if body:
        sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def _parser() -> ArgumentParser:
    parser = ArgumentParser(add_help=False)
    parser.add_argument("--health", action="store_true")
    parser.add_argument("--deadline-ms", dest="health_deadline_ms", type=int, default=MAX_DEADLINE_MS)
    sub = parser.add_subparsers(dest="command")
    request = sub.add_parser("request", add_help=False)
    request.add_argument("request_id")
    request.add_argument("operation", choices=sorted(OPERATIONS))
    request.add_argument("media_type", choices=sorted(MEDIA_TYPES))
    request.add_argument("content_length", type=int)
    request.add_argument("--first-page", type=int)
    request.add_argument("--last-page", type=int)
    request.add_argument("--page", type=int)
    request.add_argument("--max-edge", type=int)
    request.add_argument("--region-x", type=float)
    request.add_argument("--region-y", type=float)
    request.add_argument("--region-width", type=float)
    request.add_argument("--region-height", type=float)
    request.add_argument("--frame-index", type=int)
    request.add_argument("--time-ms", type=int)
    request.add_argument("--deadline-ms", type=int, default=MAX_DEADLINE_MS)
    cancel = sub.add_parser("cancel", add_help=False)
    cancel.add_argument("request_id")
    metadata = sub.add_parser("metadata", add_help=False)
    metadata.add_argument("request_id")
    return parser


def _validate_request(args: argparse.Namespace) -> tuple[str, dict[str, int]]:
    if not REQUEST_ID_RE.fullmatch(args.request_id):
        raise ClientError(400, "invalid_request_id")
    if args.content_length < 1 or args.content_length > MAX_INPUT_BYTES:
        raise ClientError(413, "input_too_large")
    if args.deadline_ms < 1 or args.deadline_ms > MAX_DEADLINE_MS:
        raise ClientError(400, "invalid_deadline")

    expected_type = "application/pdf" if args.operation.startswith("pdf-") else "image/"
    if (expected_type == "application/pdf" and args.media_type != expected_type) or (
        expected_type == "image/" and not (args.media_type.startswith(expected_type) or args.media_type == "application/vnd.sentient.live-photo+zip")
    ):
        raise ClientError(415, "unsupported_media_type")

    query: dict[str, int] = {}
    supplied = {name for name in ("first_page", "last_page", "page", "max_edge", "region_x", "region_y", "region_width", "region_height", "frame_index", "time_ms") if getattr(args, name) is not None}
    allowed: set[str]
    if args.operation == "pdf-header":
        route, allowed = "/v1/pdf/header", set()
    elif args.operation == "pdf-text":
        route, allowed = "/v1/pdf/text", {"first_page", "last_page"}
    elif args.operation == "pdf-render":
        route, allowed = "/v1/pdf/render", {"page", "max_edge"}
        if args.page is None:
            raise ClientError(400, "invalid_arguments")
    elif args.operation == "image-header":
        route, allowed = "/v1/image/header", set()
    else:
        route, allowed = "/v1/image/normalize", {"max_edge", "region_x", "region_y", "region_width", "region_height", "frame_index", "time_ms"}
    if not supplied.issubset(allowed):
        raise ClientError(400, "invalid_arguments")
    region_names = {"region_x", "region_y", "region_width", "region_height"}
    if supplied & region_names and not region_names.issubset(supplied):
        raise ClientError(400, "invalid_region")
    if args.frame_index is not None and args.time_ms is not None:
        raise ClientError(400, "invalid_frame_selection")
    for name in supplied:
        value = getattr(args, name)
        if name in region_names:
            if value < 0 or value > 1 or (name in {"region_width", "region_height"} and value == 0):
                raise ClientError(400, "invalid_region")
        elif name in {"frame_index", "time_ms"}:
            if value < 0:
                raise ClientError(400, f"invalid_{name}")
        elif value < 1 or (name == "max_edge" and value > MAX_EDGE):
            raise ClientError(400, f"invalid_{name}")
        query[name] = value
    if region_names.issubset(supplied) and (args.region_x + args.region_width > 1 or args.region_y + args.region_height > 1):
        raise ClientError(400, "invalid_region")
    if args.operation == "pdf-text" and args.first_page is not None and args.last_page is not None and args.first_page > args.last_page:
        raise ClientError(400, "invalid_page_range")
    return route, query


def _pid_path(request_id: str) -> Path:
    if not REQUEST_ID_RE.fullmatch(request_id):
        raise ClientError(400, "invalid_request_id")
    return PID_DIR / f"{request_id}.pid"


def _register(request_id: str) -> Path:
    PID_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = _pid_path(request_id)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise ClientError(409, "request_already_running") from exc
    with os.fdopen(descriptor, "w", encoding="ascii") as output:
        output.write(str(os.getpid()))
    return path


def _cancel(request_id: str) -> None:
    path = _pid_path(request_id)
    try:
        pid = int(path.read_text(encoding="ascii"))
        command = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
    except (FileNotFoundError, ValueError, OSError):
        path.unlink(missing_ok=True)
        _write_header(request_id, 404, "application/octet-stream", 0, {}, "request_not_running")
        return
    encoded_id = request_id.encode("ascii")
    if b"/app/exec_client.py" not in command or encoded_id not in command:
        path.unlink(missing_ok=True)
        _write_header(request_id, 404, "application/octet-stream", 0, {}, "request_not_running")
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        path.unlink(missing_ok=True)
        _write_header(request_id, 404, "application/octet-stream", 0, {}, "request_not_running")
        return
    for _ in range(50):
        if not Path(f"/proc/{pid}").exists():
            break
        time.sleep(0.01)
    path.unlink(missing_ok=True)
    _write_header(request_id, 200, "application/octet-stream", 0, {}, None)


def _metadata(request_id: str) -> None:
    if not REQUEST_ID_RE.fullmatch(request_id):
        raise ClientError(400, "invalid_request_id")
    body = json.dumps(ADDON_METADATA, separators=(",", ":")).encode("utf-8")
    _write_header(request_id, 200, "application/json", len(body), {}, None, body)


def _health(deadline_ms: int) -> None:
    if deadline_ms < 1 or deadline_ms > MAX_DEADLINE_MS:
        raise ClientError(400, "invalid_deadline")
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    response: http.client.HTTPResponse | None = None
    previous_handler = signal.signal(signal.SIGALRM, _deadline)
    signal.setitimer(signal.ITIMER_REAL, deadline_ms / 1000)
    try:
        client.settimeout(deadline_ms / 1000)
        client.connect(SOCKET_PATH)
        client.sendall(b"GET /health HTTP/1.1\r\nHost: attachment-parser\r\nConnection: close\r\n\r\n")
        response = http.client.HTTPResponse(client)
        response.begin()
        if response.status != 200:
            raise ClientError(503, "health_unavailable")
        if response.getheader("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise ClientError(502, "health_invalid")
        raw_length = response.getheader("Content-Length")
        try:
            content_length = int(raw_length) if raw_length is not None else -1
        except ValueError as exc:
            raise ClientError(502, "health_invalid") from exc
        if content_length < 0 or content_length > MAX_HEALTH_RESPONSE_BYTES:
            raise ClientError(502, "health_invalid")
        body = response.read(content_length)
        if len(body) != content_length:
            raise ClientError(502, "health_invalid")
    except ClientError:
        raise
    except (DeadlineExpired, socket.timeout, TimeoutError) as exc:
        raise ClientError(408, "health_timeout") from exc
    except (ConnectionError, OSError, http.client.HTTPException) as exc:
        raise ClientError(503, "health_unavailable") from exc
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        if response is not None:
            response.close()
        client.close()

    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ClientError(502, "health_invalid") from exc
    if (
        not isinstance(value, dict)
        or set(value) != {"status", *ADDON_METADATA}
        or value.get("status") != "ok"
        or {key: value.get(key) for key in ADDON_METADATA} != ADDON_METADATA
    ):
        raise ClientError(503, "health_metadata_mismatch")
    sys.stdout.write(json.dumps({key: value[key] for key in ADDON_METADATA}, separators=(",", ":")) + "\n")


def _request(args: argparse.Namespace) -> None:
    route, query = _validate_request(args)
    output_started = False
    path = _register(args.request_id)
    client: socket.socket | None = None
    previous_handler = signal.signal(signal.SIGALRM, _deadline)
    signal.setitimer(signal.ITIMER_REAL, args.deadline_ms / 1000)
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(args.deadline_ms / 1000)
        client.connect(SOCKET_PATH)
        target = route + (f"?{urlencode(query)}" if query else "")
        request_headers = (
            f"POST {target} HTTP/1.1\r\n"
            "Host: attachment-parser\r\n"
            f"Content-Type: {args.media_type}\r\n"
            f"Content-Length: {args.content_length}\r\n"
            "Connection: close\r\n\r\n"
        ).encode("ascii")
        client.sendall(request_headers)
        remaining = args.content_length
        while remaining:
            chunk = sys.stdin.buffer.read(min(64 * 1024, remaining))
            if not chunk:
                raise ClientError(400, "incomplete_body")
            client.sendall(chunk)
            remaining -= len(chunk)
        if sys.stdin.buffer.read(1):
            raise ClientError(400, "body_too_large")

        response = http.client.HTTPResponse(client)
        response.begin()
        try:
            content_length = int(response.getheader("Content-Length", ""))
        except ValueError as exc:
            raise ClientError(502, "invalid_parser_response") from exc
        if content_length < 0 or content_length > MAX_RESPONSE_BYTES:
            raise ClientError(502, "parser_response_too_large")
        content_type = response.getheader("Content-Type", "application/octet-stream")
        forwarded = {
            name: value
            for name in ("X-Sentient-Page", "X-Sentient-Page-Range", "X-Sentient-Visual-Metadata")
            if (value := response.getheader(name)) is not None
        }
        if response.status >= 400:
            payload = response.read(content_length)
            try:
                reason = json.loads(payload).get("error", "parser_error")
            except (json.JSONDecodeError, AttributeError):
                reason = "parser_error"
            if not isinstance(reason, str) or not re.fullmatch(r"[a-z0-9_]{1,64}", reason):
                reason = "parser_error"
            _write_header(args.request_id, response.status, content_type, 0, forwarded, reason)
            return

        _write_header(args.request_id, response.status, content_type, content_length, forwarded, None)
        output_started = True
        remaining = content_length
        while remaining:
            chunk = response.read(min(64 * 1024, remaining))
            if not chunk:
                raise OutputStarted()
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
            remaining -= len(chunk)
    except DeadlineExpired as exc:
        if output_started:
            raise OutputStarted() from exc
        raise ClientError(408, "deadline_exceeded") from exc
    except (ConnectionError, OSError, http.client.HTTPException) as exc:
        if output_started:
            raise OutputStarted() from exc
        raise ClientError(502, "parser_unavailable") from exc
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        if client is not None:
            client.close()
        path.unlink(missing_ok=True)


def main() -> int:
    request_id: str | None = None
    args: argparse.Namespace | None = None
    try:
        args = _parser().parse_args()
        request_id = getattr(args, "request_id", None)
        if args.health:
            if args.command is not None:
                raise ClientError(400, "invalid_arguments")
            _health(args.health_deadline_ms)
        elif args.command == "cancel":
            _cancel(args.request_id)
        elif args.command == "metadata":
            _metadata(args.request_id)
        elif args.command == "request":
            _request(args)
        else:
            raise ClientError(400, "invalid_arguments")
        return 0
    except ClientError as exc:
        if args is not None and args.health:
            print(f"health check failed: {exc.reason}", file=sys.stderr)
            return 1
        _write_header(request_id, exc.status, "application/octet-stream", 0, {}, exc.reason)
        return 1
    except (BrokenPipeError, OutputStarted):
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
