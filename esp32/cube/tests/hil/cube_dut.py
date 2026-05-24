"""CubeDut: HIL test wrapper that dispatches via `esp32-devtool` subprocess.

Each `cmd()` call shells out to the absolute path of the `esp32-devtool` binary
(`<repo>/esp32/devtool/bin/esp32-devtool`). The devtool resolves the daemon socket
itself and returns the verb's JSON-RPC `result` payload on stdout — identical
shape to the legacy `_cube_cmd_helper.py` path. Tests that previously consumed
that dict continue to work unchanged.

expect_checkpoint() / expect_log() delegate to an injected SerialDut (`self.dut`).
For verb-only tests, `self.dut` may be None — those methods are not used.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any

CUBE_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = CUBE_DIR.parents[1]
DEVTOOL_BIN = REPO_ROOT / "esp32" / "devtool" / "bin" / "esp32-devtool"


class CubeDut:
    """JSON-RPC verb sender backed by `esp32-devtool cmd`.

    Phase 6 test files depend on the `cmd(method, *, params=None, timeout=...)`
    signature returning the verb's `result` dict — do NOT change.
    """

    def __init__(self, serial_dut: Any, port: str) -> None:
        self.dut = serial_dut
        self.port = port
        self.devtool_bin = str(DEVTOOL_BIN)

    def cmd(
        self,
        method: str,
        *,
        params: dict[str, Any] | None = None,
        timeout: float = 10.0,
    ) -> dict[str, Any]:
        args: list[str] = [
            self.devtool_bin,
            "--port", self.port,
            "--json",
            "cmd", method,
        ]
        for key, value in (params or {}).items():
            # Strings pass through; everything else JSON-encodes so the
            # devtool's _parse_params() rebuilds the original type.
            if isinstance(value, str):
                arg_value = value
            else:
                arg_value = json.dumps(value)
            args += ["--param", f"{key}={arg_value}"]

        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout + 5.0,
        )
        if result.returncode != 0:
            raise AssertionError(
                f"esp32-devtool cmd {method} failed rc={result.returncode}: "
                f"stderr={result.stderr.strip()} stdout={result.stdout.strip()}"
            )
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def expect_checkpoint(self, label: str, timeout: float = 10.0):
        return self.dut.expect(rf">>> CHECKPOINT {re.escape(label)} (\d+)", timeout=timeout)

    def expect_log(self, pattern: str, timeout: float = 10.0):
        return self.dut.expect(re.compile(pattern), timeout=timeout)
