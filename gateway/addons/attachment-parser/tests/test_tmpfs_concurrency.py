#!/usr/bin/env python3
"""Real Docker regression for serialized near-limit parser inputs."""

from __future__ import annotations

import json
import os
import random
import re
import struct
import subprocess
import threading
import time
import uuid
import zlib
from pathlib import Path

IMAGE = os.environ.get(
    "ATTACHMENT_PARSER_IMAGE", "sentient/attachment-parser:local"
)
def png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def near_limit_png() -> bytes:
    width = height = 2635
    random_bytes = random.Random(0).randbytes(width * height * 3)
    rows = b"".join(b"\0" + random_bytes[offset : offset + width * 3] for offset in range(0, len(random_bytes), width * 3))
    body = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + png_chunk(b"IDAT", zlib.compress(rows, level=0))
        + png_chunk(b"IEND", b"")
    )
    assert 19 * 1024 * 1024 < len(body) < 20 * 1024 * 1024
    return body


def wait_ready(name: str) -> None:
    probe = "import socket;s=socket.socket(socket.AF_UNIX);s.connect('/tmp/attachment-parser/parser.sock');s.close()"
    for _ in range(100):
        if subprocess.run(
            ["docker", "exec", name, "python3", "-c", probe],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=5,
        ).returncode == 0:
            return
        time.sleep(0.05)
    raise AssertionError("parser container did not become ready")


def response_ok(process: subprocess.Popen[bytes]) -> bool:
    assert process.stdout is not None and process.stderr is not None
    process.stdin = None  # Request writers already closed stdin.
    output, _ = process.communicate(timeout=40)
    return_code = process.returncode
    if return_code != 0 or len(output) < 4:
        return False
    header_length = struct.unpack(">I", output[:4])[0]
    try:
        header = json.loads(output[4 : 4 + header_length])
    except (json.JSONDecodeError, UnicodeDecodeError):
        return False
    return header.get("status") == 200 and header.get("error") is None


def run_pair(tmpfs_size: str, memory_bytes: int, body: bytes) -> list[bool]:
    name = f"sentient-parser-tmpfs-test-{os.getpid()}-{tmpfs_size}-{uuid.uuid4().hex[:8]}"
    subprocess.run(
        [
            "docker", "run", "-d", "--name", name,
            "--network", "none", "--read-only",
            "--tmpfs", f"/tmp:rw,noexec,nosuid,nodev,size={tmpfs_size}",
            "--user", "65534:65534", "--memory", str(memory_bytes), "--memory-swap", str(memory_bytes),
            "--cpus", ".5", "--pids-limit", "32", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", IMAGE,
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        timeout=30,
    )
    processes: list[subprocess.Popen[bytes]] = []
    try:
        wait_ready(name)
        for _ in range(2):
            processes.append(
                subprocess.Popen(
                    [
                        "docker", "exec", "-i", name, "python3", "/app/exec_client.py",
                        "request", str(uuid.uuid4()), "image-header", "image/png", str(len(body)),
                        "--deadline-ms", "35000",
                    ],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
            )

        write_errors: list[BaseException] = []

        def send(process: subprocess.Popen[bytes]) -> None:
            assert process.stdin is not None
            try:
                process.stdin.write(body)
                process.stdin.close()
            except BaseException as error:
                write_errors.append(error)
                try:
                    process.stdin.close()
                except OSError:
                    pass

        threads = [threading.Thread(target=send, args=(process,)) for process in processes]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=40)
        if any(thread.is_alive() for thread in threads):
            raise AssertionError("concurrent request writers did not finish")
        results = [response_ok(process) for process in processes]
        if write_errors and all(results):
            raise AssertionError("request write failed despite successful responses")
        return results
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
        subprocess.run(
            ["docker", "rm", "-f", name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=15,
        )


def main() -> None:
    body = near_limit_png()
    template = (Path(__file__).resolve().parents[3] / "templates/services/attachment-parser.yaml").read_text()
    tmpfs = re.search(r"^\s+/tmp:.*\bsize=(\d+[kmg])", template, re.MULTILINE)
    memory = re.search(r"^mem_limit_bytes:\s*(\d+)", template, re.MULTILINE)
    assert tmpfs and memory, "parser template must specify bounded tmpfs and memory"
    memory_bytes = int(memory.group(1))
    configured_results = run_pair(tmpfs.group(1), memory_bytes, body)
    assert all(configured_results), f"configured single-decoder queue failed overlapping requests: {configured_results}"
    print(f"single-decoder queue regression: configured {tmpfs.group(1)} passed overlapping requests")


if __name__ == "__main__":
    main()
