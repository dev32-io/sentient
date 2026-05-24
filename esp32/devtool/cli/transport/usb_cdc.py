"""USB-CDC daemon client. JSON-RPC over Unix socket to the port-holding daemon."""
from __future__ import annotations

import glob as glob_mod
import itertools
import json
import socket
from dataclasses import dataclass
from typing import Any, Callable

from cli.board import BoardManifest
from cli.daemon.lifecycle import ensure_daemon, socket_path_for
from cli.errors import TransportUnavailable, VerbError, DevtoolTimeout


_ID_COUNTER = itertools.count(1)


def _next_id() -> int:
    return next(_ID_COUNTER)


@dataclass
class UsbCdcClient:
    port: str
    timeout_s: float = 5.0
    _auto_ensure: bool = True

    @classmethod
    def for_manifest(
        cls,
        manifest: BoardManifest,
        *,
        port_override: str | None = None,
        scan_ports: Callable[[str], list[str]] = lambda g: sorted(glob_mod.glob(g)),
    ) -> "UsbCdcClient":
        port = port_override
        if port is None:
            glob_pat = manifest.usb.port_glob
            if not glob_pat:
                raise TransportUnavailable(
                    f"board {manifest.name}: usb.port_glob is empty",
                    next_step="set usb.port_glob in the manifest or pass --port",
                )
            ports = scan_ports(glob_pat)
            if not ports:
                raise TransportUnavailable(
                    f"no ports matched {glob_pat}",
                    next_step="check USB cable + `ls /dev/cu.usbmodem*`",
                )
            port = ports[0]
        return cls(port=port)

    def invoke(self, method: str, params: dict | None = None) -> dict[str, Any]:
        if self._auto_ensure:
            ensure_daemon(self.port)
        sock_path = socket_path_for(self.port)
        req_id = _next_id()
        json_rpc = {"jsonrpc": "2.0", "id": req_id, "method": method,
                    "params": params or {}}
        wire = {"kind": "cmd", "json": json.dumps(json_rpc)}

        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout_s)
        try:
            s.connect(str(sock_path))
            s.sendall((json.dumps(wire) + "\n").encode())
            chunks: list[bytes] = []
            while True:
                c = s.recv(65536)
                if not c:
                    break
                chunks.append(c)
                if b"\n" in c:
                    break
        except socket.timeout as e:
            raise DevtoolTimeout(
                f"daemon timeout {self.timeout_s}s on '{method}'",
                next_step="try `esp32-devtool restart` or physical recovery",
            ) from e
        finally:
            s.close()

        raw = b"".join(chunks).decode().strip()
        try:
            envelope = json.loads(raw)
        except json.JSONDecodeError as e:
            raise VerbError(f"daemon returned non-JSON: {raw[:120]!r}") from e
        if envelope.get("kind") != "rsp":
            raise VerbError(f"unexpected envelope kind: {envelope}")
        payload = json.loads(envelope["json"])
        if "error" in payload:
            err = payload["error"]
            raise VerbError(
                f"{method}: {err.get('message', 'unknown')} "
                f"(code {err.get('code')})"
            )
        return payload.get("result") or {}

    def daemon_reachable(self) -> bool:
        try:
            ensure_daemon(self.port, spawn_timeout_s=2.0)
            return True
        except TransportUnavailable:
            return False
