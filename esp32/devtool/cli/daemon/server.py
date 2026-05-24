"""Port-holding daemon for esp32-devtool. Generalized from esp32/cube/scripts/_cube_daemon.py.

Opens the USB-CDC port ONCE and holds it across many client connections.
Each client connects via Unix socket; the daemon writes CMDs to serial,
reads matching responses from the event ring, and returns them.

Why a daemon? The ESP32-S3 USB-Serial-JTAG hardware interprets DTR/RTS
toggles as auto-reset / boot-mode signals. macOS sends a CDC
SET_CONTROL_LINE_STATE on every open(), which resets the cube. With
each tool invocation opening + closing the port, the cube reset-loops and
never reaches IDLE. The daemon opens the port exactly once.

Auto-exits after --idle-seconds of no client activity.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import sys
import threading
import time
from collections import deque
from pathlib import Path
from typing import Optional

import serial

from cli.daemon.lifecycle import (
    socket_path_for,
    pidfile_path_for,
    logfile_path_for,
)

TAG = "esp32-devtool.daemon"

RSP_PREFIX = "<<< RSP "
EVT_PREFIX = "<<< EVT "
CHECKPOINT_PREFIX = ">>> CHECKPOINT "
READY_MARKER = ">>> READY"


class CubeDaemon:
    def __init__(self, port: str, idle_seconds: int):
        self.port_name = port
        self.idle_seconds = idle_seconds
        self.last_activity = time.time()
        self.ser: Optional[serial.Serial] = None
        # 20000 lines: generous ring buffer so the full boot trace
        # (ROM bootloader → WiFi connect → IDLE) is always available.
        # ~3 MB host RAM worst-case for a long-running daemon.
        self.event_log: deque[str] = deque(maxlen=20000)
        self.read_lock = threading.Lock()
        self.stop = threading.Event()

    def _open_port(self) -> None:
        s = serial.Serial()
        s.port = self.port_name
        s.baudrate = 115200
        s.timeout = 0.1
        s.dsrdtr = False
        s.rtscts = False
        s.dtr = False
        s.rts = False
        s.open()
        self.ser = s

    def reader_thread(self) -> None:
        assert self.ser is not None
        while not self.stop.is_set():
            try:
                line = self.ser.readline().decode("utf-8", errors="replace").rstrip()
            except Exception as e:
                self.event_log.append(f"__reader_exc__ {e}")
                time.sleep(0.3)
                continue
            if not line:
                continue
            with self.read_lock:
                self.event_log.append(line)

    def send_cmd(self, body: dict, rpc_id, timeout: float) -> dict:
        assert self.ser is not None
        # Mark a baseline sentinel in the ring so we can find our cutoff
        # without index arithmetic against a maxlen-bounded deque.
        sentinel = f"__sentinel__ {time.time()}"
        with self.read_lock:
            self.event_log.append(sentinel)
        line = ">>> CMD " + json.dumps(body) + "\n"
        self.ser.write(line.encode())
        self.ser.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self.read_lock:
                snapshot = list(self.event_log)
            try:
                idx = snapshot.index(sentinel)
            except ValueError:
                idx = 0
            for candidate in snapshot[idx + 1:]:
                if not candidate.startswith(RSP_PREFIX):
                    continue
                payload = candidate[len(RSP_PREFIX):]
                try:
                    resp = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                if resp.get("id") == rpc_id:
                    return resp
            time.sleep(0.05)
        return {
            "jsonrpc": "2.0",
            "id": rpc_id,
            "error": {"code": -32001, "message": f"daemon timeout after {timeout}s"},
        }

    def get_recent_events(self, n: int = 200) -> list[str]:
        with self.read_lock:
            return list(self.event_log)[-n:]

    def serve(self, sock_path_str: str, pid_path_str: str) -> None:
        try:
            os.unlink(sock_path_str)
        except FileNotFoundError:
            pass
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(sock_path_str)
        srv.listen(8)
        srv.settimeout(1.0)
        with open(pid_path_str, "w") as f:
            f.write(str(os.getpid()))

        self._open_port()
        threading.Thread(target=self.reader_thread, daemon=True).start()

        sys.stderr.write(
            f"[{TAG}] listening on {sock_path_str} (pid={os.getpid()})\n"
        )

        try:
            while not self.stop.is_set():
                if time.time() - self.last_activity > self.idle_seconds:
                    sys.stderr.write(f"[{TAG}] idle exit\n")
                    break
                try:
                    conn, _ = srv.accept()
                except socket.timeout:
                    continue
                self.last_activity = time.time()
                threading.Thread(
                    target=self._handle_client, args=(conn,), daemon=True
                ).start()
        finally:
            self.stop.set()
            srv.close()
            try:
                os.unlink(sock_path_str)
            except OSError:
                pass
            try:
                os.unlink(pid_path_str)
            except OSError:
                pass
            # Drop the legacy-alias symlink so a future legacy spawn isn't
            # confused by a dangling pointer.
            try:
                if _LEGACY_CUBE_SOCK.is_symlink():
                    _LEGACY_CUBE_SOCK.unlink()
            except OSError:
                pass
            if self.ser:
                self.ser.close()

    def _handle_client(self, conn: socket.socket) -> None:
        try:
            # Recv until JSON parses or client closes write side.
            # audio.inject_pcm payload can be ~32KB base64; default recv(8192)
            # truncated it and broke parsing.
            conn.settimeout(5.0)
            chunks = []
            while True:
                try:
                    chunk = conn.recv(65536)
                except socket.timeout:
                    break
                if not chunk:
                    break
                chunks.append(chunk)
                try:
                    json.loads(b"".join(chunks).decode("utf-8"))
                    break
                except json.JSONDecodeError:
                    continue
            data = b"".join(chunks).decode("utf-8")
            if not data:
                return
            try:
                req = json.loads(data)
            except json.JSONDecodeError as e:
                conn.sendall(json.dumps({"error": f"bad request: {e}"}).encode())
                return
            kind = req.get("kind", "cmd")
            if kind == "cmd":
                # Wire format from UsbCdcClient: {"kind": "cmd", "json": <json-rpc-str>}
                # The "json" field contains the full JSON-RPC 2.0 object. Decode it
                # and forward verbatim to the serial line as ">>> CMD <json>".
                # Legacy callers (esp32/cube/scripts/_cube_cmd_helper.py) send a
                # FLAT envelope: {"kind":"cmd", "id":N, "method":..., "params":...}
                # and expect the bare JSON-RPC reply back (no kind:rsp wrapper).
                # We detect by the presence/absence of "json" and respond in the
                # matching shape so both clients work against the same daemon.
                raw_json = req.get("json")
                wrap_response = raw_json is not None
                if wrap_response:
                    try:
                        body = json.loads(raw_json)
                    except json.JSONDecodeError as e:
                        conn.sendall(
                            (json.dumps({"kind": "rsp", "json": json.dumps({
                                "jsonrpc": "2.0", "id": None,
                                "error": {"code": -32700, "message": f"parse error: {e}"},
                            })}) + "\n").encode()
                        )
                        return
                else:
                    body = {
                        "jsonrpc": "2.0",
                        "id": req.get("id", 1),
                        "method": req["method"],
                        "params": req.get("params", {}),
                    }
                resp = self.send_cmd(body, body["id"], req.get("timeout", 5.0))
                if wrap_response:
                    conn.sendall(
                        (json.dumps({"kind": "rsp", "json": json.dumps(resp)}) + "\n").encode()
                    )
                else:
                    conn.sendall(json.dumps(resp).encode())
            elif kind == "events":
                lines = self.get_recent_events(req.get("n", 200))
                conn.sendall(json.dumps({"events": lines}).encode())
            elif kind == "ping":
                conn.sendall(json.dumps({"ok": True}).encode())
            else:
                conn.sendall(json.dumps({"error": f"unknown kind: {kind}"}).encode())
            self.last_activity = time.time()
        finally:
            conn.close()


_LEGACY_CUBE_SOCK = Path("/tmp/cube-daemon.sock")
_LEGACY_CUBE_PID = Path("/tmp/cube-daemon.pid")


def _alias_legacy_socket(sock_path: Path) -> None:
    """Expose the devtool daemon at /tmp/cube-daemon.sock as well.

    Legacy callers (``esp32/cube/scripts/cube-cmd.sh`` →
    ``_cube_cmd_helper.py``) hardcode that path. The wire protocol on
    server.py already accepts both the legacy flat ``{kind:cmd,
    method, params}`` shape and the new ``{kind:cmd, json: <jsonrpc>}``
    shape, so symlinking the legacy path at this single daemon avoids
    spawning a second port-holder. AF_UNIX symlinks work on macOS/Linux
    and follow on connect().
    """
    try:
        if _LEGACY_CUBE_SOCK.is_symlink() or _LEGACY_CUBE_SOCK.exists():
            _LEGACY_CUBE_SOCK.unlink()
    except OSError:
        pass
    try:
        _LEGACY_CUBE_SOCK.symlink_to(sock_path)
    except OSError as e:
        sys.stderr.write(
            f"[{TAG}] warning: could not symlink {_LEGACY_CUBE_SOCK} → "
            f"{sock_path}: {e}\n"
        )


def serve(port: str, idle_seconds: int) -> int:
    sock_path = socket_path_for(port)
    pid_path = pidfile_path_for(port)
    sock_path.parent.mkdir(parents=True, exist_ok=True)

    if pid_path.exists():
        try:
            pid = int(pid_path.read_text().strip())
            os.kill(pid, 0)
            sys.stderr.write(f"[{TAG}] already running (pid={pid})\n")
            return 1
        except (ProcessLookupError, ValueError, OSError):
            pid_path.unlink(missing_ok=True)

    _alias_legacy_socket(sock_path)
    # Drop any stale legacy pidfile so HIL helpers don't think a separate
    # daemon process owns /tmp/cube-daemon.sock (they ping-then-spawn).
    _LEGACY_CUBE_PID.unlink(missing_ok=True)

    CubeDaemon(port, idle_seconds).serve(str(sock_path), str(pid_path))
    return 0


def _double_fork() -> None:
    if os.fork() != 0:
        os._exit(0)
    os.setsid()
    if os.fork() != 0:
        os._exit(0)
    sys.stdin = open(os.devnull, "r")


def serve_argv() -> int:
    p = argparse.ArgumentParser(prog="esp32-devtool-daemon")
    p.add_argument("--port", required=True)
    p.add_argument(
        "--idle-seconds",
        type=int,
        default=int(os.environ.get("ESP32_DEVTOOL_DAEMON_IDLE_SEC", "600")),
    )
    p.add_argument("--detach", action="store_true")
    args = p.parse_args()
    if args.detach:
        _double_fork()
    return serve(args.port, args.idle_seconds)


if __name__ == "__main__":
    sys.exit(serve_argv())
