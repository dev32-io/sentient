#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from addon_metadata import load_metadata  # noqa: E402

CLIENT = ROOT / "exec_client.py"
MANIFEST = json.loads((ROOT / "addon.json").read_text(encoding="utf-8"))


class HealthServer:
    def __init__(self, value: object, status: int = 200, delay: float = 0) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / "parser.sock")
        self.value = value
        self.status = status
        self.delay = delay
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(self.path)
        self.listener.listen(1)
        self.thread = threading.Thread(target=self._serve, daemon=True)

    def __enter__(self) -> "HealthServer":
        self.thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self.listener.close()
        self.thread.join(timeout=1)
        self.tmp.cleanup()

    def _serve(self) -> None:
        try:
            connection, _ = self.listener.accept()
        except OSError:
            return
        with connection:
            try:
                connection.recv(4096)
                if self.delay:
                    time.sleep(self.delay)
                body = json.dumps(self.value, separators=(",", ":")).encode("utf-8")
                response = (
                    f"HTTP/1.1 {self.status} test\r\n"
                    "Content-Type: application/json\r\n"
                    f"Content-Length: {len(body)}\r\n"
                    "Connection: close\r\n\r\n"
                ).encode("ascii")
                connection.sendall(response + body)
            except OSError:
                pass


def run_client(*args: str, socket_path: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [sys.executable, str(CLIENT), *args],
        env={**os.environ, "PARSER_SOCKET": socket_path},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


class MetadataAndHealthTest(unittest.TestCase):
    def test_manifest_accepts_semver_prerelease_build_and_64_char_version(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "addon.json"
            for version in ("1.2.3-alpha.1+build.5", "1.2.3+" + "a" * 58):
                value = {**MANIFEST, "version": version}
                path.write_text(json.dumps(value), encoding="utf-8")
                self.assertEqual(load_metadata(path)["version"], version)

            for version in ("01.2.3", "1.2.3-", "1.2.3-01", "1.2.3+", "1.2.3+" + "a" * 59):
                path.write_text(json.dumps({**MANIFEST, "version": version}), encoding="utf-8")
                with self.assertRaises(ValueError):
                    load_metadata(path)

            path.write_text(json.dumps({**MANIFEST, "description": "x" * 257}), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_metadata(path)

    def test_metadata_reads_manifest_without_server(self) -> None:
        result = run_client("metadata", "123e4567-e89b-12d3-a456-426614174000", socket_path="/missing/parser.sock")
        self.assertEqual((result.returncode, result.stderr), (0, b""))
        header_length = struct.unpack(">I", result.stdout[:4])[0]
        header = json.loads(result.stdout[4 : 4 + header_length])
        body = result.stdout[4 + header_length :]
        self.assertEqual(header["status"], 200)
        self.assertEqual(json.loads(body), MANIFEST)

    def test_health_returns_live_manifest_as_plain_json(self) -> None:
        with HealthServer({"status": "ok", **MANIFEST}) as server:
            result = run_client("--health", "--deadline-ms", "100", socket_path=server.path)
        self.assertEqual((result.returncode, result.stderr), (0, b""))
        self.assertEqual(json.loads(result.stdout), MANIFEST)

    def test_health_rejects_unavailable_timeout_and_wrong_metadata_safely(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            unavailable = run_client("--health", "--deadline-ms", "100", socket_path=str(Path(tmp) / "missing.sock"))
        self.assertEqual(unavailable.returncode, 1)
        self.assertEqual(unavailable.stdout, b"")
        self.assertEqual(unavailable.stderr, b"health check failed: health_unavailable\n")

        with HealthServer({"status": "ok", **MANIFEST}, delay=0.1) as server:
            timeout = run_client("--health", "--deadline-ms", "10", socket_path=server.path)
        self.assertEqual(timeout.returncode, 1)
        self.assertEqual(timeout.stdout, b"")
        self.assertEqual(timeout.stderr, b"health check failed: health_timeout\n")

        with HealthServer({"status": "ok", **{**MANIFEST, "version": "9.9.9"}}) as server:
            wrong = run_client("--health", socket_path=server.path)
        self.assertEqual(wrong.returncode, 1)
        self.assertEqual(wrong.stdout, b"")
        self.assertEqual(wrong.stderr, b"health check failed: health_metadata_mismatch\n")


if __name__ == "__main__":
    unittest.main()
