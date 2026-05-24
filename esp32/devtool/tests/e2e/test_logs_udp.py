"""Parity test: `esp32-devtool logs --source udp --follow` sees relay traffic.

The cube firmware's devtool companion can install a vprintf hook that tees
every ESP_LOGx line to a UDP socket on the gateway host (port read from
``SENTIENT_GATEWAY_LOG_PORT`` in sentient_creds.h, mirrored to
``manifest.log_relay.port`` in ``boards/cube.yaml``). T33 changed the dev
default to OFF — the vprintf hook allocated heap per log line and starved
lwIP's pbuf pool during chunked HTTP sends, stalling /screenshot +
/audio/record. Operators flip ``CONFIG_ESP32_DEVTOOL_LOG_RELAY_ENABLE=y``
via menuconfig when actively debugging gateway log ingestion; this test
is skipped on default debug builds.
"""
from __future__ import annotations

import pytest
import subprocess
import time
from pathlib import Path


_DEVTOOL_BIN = str(Path(__file__).resolve().parents[2] / "bin" / "esp32-devtool")


@pytest.mark.skip(
    reason="UDP log relay defaults to OFF in dev (T33). Enable "
           "CONFIG_ESP32_DEVTOOL_LOG_RELAY_ENABLE=y via menuconfig to run."
)
def test_logs_udp_sees_traffic_within_10s(devtool):
    proc = subprocess.Popen(
        [_DEVTOOL_BIN, "logs", "--source", "udp", "--follow"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        for _ in range(5):
            subprocess.run(
                [_DEVTOOL_BIN, "cmd", "mark", "--param", "label=ping"],
                check=True, capture_output=True, timeout=5.0,
            )
            time.sleep(0.3)
        time.sleep(2.0)
    finally:
        proc.terminate()
        try:
            stdout, stderr = proc.communicate(timeout=3.0)
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()

    assert "[udp" in stdout or "udp " in stdout, (
        f"no UDP-sourced lines (net_logger may be off):\n"
        f"stdout: {stdout[:1500]}\nstderr: {stderr[:500]}"
    )
