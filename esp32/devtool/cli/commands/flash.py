"""esp32-devtool flash — build + flash via idf.py + eager daemon respawn.

Absorbs ``esp32/cube/scripts/flash.sh``: kill legacy + devtool daemons (port
contention shows up as "No serial data received", not an AXP2101 fault),
run bake-creds, idf.py flash, eager-spawn the devtool daemon (T31), wait
for ``>>> READY`` in the ring, then poll ``state`` until past pre-WiFi.
"""
from __future__ import annotations

import os
import signal
import subprocess
import time
from pathlib import Path

import click

from cli.board import BOARDS_DIR, detect_board, resolve_usb_port
from cli.daemon.lifecycle import ensure_daemon, fetch_events, _runtime_dir
from cli.errors import DevtoolError, report_devtool_error
from cli.idf_env import strip_uv_venv_from_path, wrap_with_idf_env
from cli.repo_root import resolve_repo_root, substitute
from cli.transport.usb_cdc import UsbCdcClient


# Legacy `_cube_daemon.py` artifacts. The devtool daemon symlinks the legacy
# /tmp/cube-daemon.sock to its own per-port-hash socket on startup, so legacy
# callers keep working through the same converged daemon.
_LEGACY_SOCK = Path("/tmp/cube-daemon.sock")
_LEGACY_PID = Path("/tmp/cube-daemon.pid")

# Firmware emits >>> READY at end of boot; we gate flash's return on it so
# callers see "flash + boot complete", not just esptool's RTS reset.
_READY_MARKER = ">>> READY"

# Cube cold boot from ROM → WiFi → IDLE typically completes in 8-15 s;
# 45 s leaves headroom without masking AXP2101-fault hangs. Daemon spawn is
# slightly slower than the 12 s default after a fresh flash because pyserial
# has to reopen the just-reset CDC.
_READY_TIMEOUT_S = 45.0
_DAEMON_SPAWN_TIMEOUT_S = 15.0
_RING_POLL_INTERVAL_S = 0.5
_RING_LINES_PER_POLL = 500


def _signal_pidfile(pid_path: Path) -> None:
    try:
        os.kill(int(pid_path.read_text().strip()), signal.SIGTERM)
    except (ValueError, ProcessLookupError, PermissionError, OSError):
        pass


def _unlink_quiet(path: Path) -> None:
    try:
        if path.is_symlink() or path.exists():
            path.unlink()
    except OSError:
        pass


def _kill_all_daemons() -> None:
    """Tear down both legacy (_cube_daemon.py) and devtool daemons before
    flash so esptool has the serial port. Pidfile unlink prevents
    ensure_daemon's "already running" guard from refusing the respawn.
    Legacy first so its symlink unlink doesn't confuse the spawn coming up."""
    if _LEGACY_PID.exists():
        _signal_pidfile(_LEGACY_PID)
    try:
        subprocess.run(["pkill", "-f", "_cube_daemon"], check=False,
                       capture_output=True, timeout=5.0)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    _unlink_quiet(_LEGACY_SOCK)
    _unlink_quiet(_LEGACY_PID)
    runtime = _runtime_dir()
    if runtime.exists():
        for pid_path in runtime.glob("*.pid"):
            _signal_pidfile(pid_path)
            _unlink_quiet(pid_path)
        for sock_path in runtime.glob("*.sock"):
            _unlink_quiet(sock_path)
    # pyserial close() needs ~hundreds of ms to release the CDC fd.
    time.sleep(1.0)


def _run_bake_creds(manifest, repo_root: Path) -> int:
    """Invoke the manifest's ``bake-creds`` extension verbatim. No
    ``--profile`` synthesis per task spec; bake-creds defaults to debug
    which matches the only profile tested. Prod parity → Task 22."""
    for ext in manifest.extensions:
        if ext.cmd != "bake-creds":
            continue
        exec_path = substitute(ext.exec, repo_root=repo_root)
        if ext.transient:
            click.echo(
                f"[esp32-devtool] running transient extension: bake-creds "
                f"({exec_path})", err=True)
        return subprocess.run([exec_path], check=False).returncode
    return 0


def _run_idf_flash(firmware_path: Path, port: str, profile: str) -> int:
    """Invoke ``idf.py -p <port> flash`` with flash.sh's SDKCONFIG chain.
    Re-sources export.sh inside IDF_PATH (flash.sh lines 52-60) when idf.py
    is absent. Plan's ``sdkconfig.defaults.esp32s3`` chain entry is a no-op
    file in this repo, dropped to match flash.sh exactly."""
    env = os.environ.copy()
    sdkconfig_chain = f"sdkconfig.defaults;sdkconfig.defaults.{profile}"
    env["SDKCONFIG_DEFAULTS"] = sdkconfig_chain
    strip_uv_venv_from_path(env)
    click.echo(
        f"[esp32-devtool] profile={profile} SDKCONFIG_DEFAULTS={sdkconfig_chain}",
        err=True,
    )
    flash_cmd = wrap_with_idf_env(
        firmware_path,
        f'idf.py -p "{port}" flash',
        idf_path=env.get("IDF_PATH"),
    )
    return subprocess.run(["bash", "-c", flash_cmd], env=env, check=False).returncode


def _wait_for_ready(timeout_s: float = _READY_TIMEOUT_S) -> bool:
    """Poll the daemon ring for >>> READY via the legacy symlink."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        events = fetch_events(_LEGACY_SOCK, _RING_LINES_PER_POLL)
        if any(_READY_MARKER in line for line in events):
            return True
        time.sleep(_RING_POLL_INTERVAL_S)
    return False


# READY fires before WiFi connect (5-10 s later). Flash callers expect a
# settled state by the time flash returns, so we also wait past pre-WiFi.
_PRE_WIFI_STATES = frozenset({"UNKNOWN", "STARTING", "WIFI_CONFIGURING"})
_STATE_SETTLE_TIMEOUT_S = 20.0


def _wait_for_settled_state(port: str) -> bool:
    """Poll ``state`` until the cube leaves pre-WiFi states."""
    client = UsbCdcClient(port=port, timeout_s=3.0)
    deadline = time.time() + _STATE_SETTLE_TIMEOUT_S
    while time.time() < deadline:
        try:
            state = client.invoke("state").get("state")
        except DevtoolError:
            state = None
        if state and state not in _PRE_WIFI_STATES:
            return True
        time.sleep(_RING_POLL_INTERVAL_S)
    return False


def _resolve_firmware_path(manifest, repo_root: Path) -> Path | None:
    if not manifest.firmware_path:
        click.echo(
            f"[esp32-devtool] manifest '{manifest.name}' has no firmware_path",
            err=True)
        return None
    firmware_path = repo_root / manifest.firmware_path
    if not firmware_path.exists():
        click.echo(
            f"[esp32-devtool] firmware_path '{firmware_path}' does not exist",
            err=True)
        return None
    return firmware_path


def _respawn_daemon_and_wait_ready(port: str) -> int:
    """Eager-spawn the devtool daemon + wait for >>> READY + wait for the
    cube to settle past pre-WiFi states. Returns 0 or the exit code."""
    try:
        ensure_daemon(port, spawn_timeout_s=_DAEMON_SPAWN_TIMEOUT_S)
    except DevtoolError as e:
        click.echo(f"[esp32-devtool] daemon respawn failed: {e}", err=True)
        if e.next_step:
            click.echo(f"   next step: {e.next_step}", err=True)
        return e.exit_code
    if not _wait_for_ready():
        click.echo(
            f"[esp32-devtool] cube did not emit '{_READY_MARKER}' within "
            f"{_READY_TIMEOUT_S}s; inspect ring via 'esp32-devtool daemon "
            f"ring --port {port}'",
            err=True,
        )
        return 6
    if not _wait_for_settled_state(port):
        click.echo(
            f"[esp32-devtool] cube stayed in pre-WiFi state for "
            f"{_STATE_SETTLE_TIMEOUT_S}s after READY; inspect WiFi creds",
            err=True,
        )
        return 6
    return 0


def run(ctx_obj: dict, profile: str) -> int:
    try:
        manifest = detect_board(
            boards_dir=BOARDS_DIR,
            override_name=ctx_obj.get("board"),
        )
    except DevtoolError as e:
        report_devtool_error(e, json_out=ctx_obj.get("json_out", False))
        return e.exit_code

    repo_root = resolve_repo_root()
    firmware_path = _resolve_firmware_path(manifest, repo_root)
    if firmware_path is None:
        return 5

    port = resolve_usb_port(manifest, ctx_obj.get("port"))
    if port is None:
        click.echo("[esp32-devtool] no USB port detected", err=True)
        return 3
    click.echo(f"[esp32-devtool] port={port}", err=True)

    rc = _run_bake_creds(manifest, repo_root)
    if rc != 0:
        click.echo(f"[esp32-devtool] bake-creds failed rc={rc}", err=True)
        return 5

    click.echo("[esp32-devtool] killing existing daemons before flash", err=True)
    _kill_all_daemons()

    rc = _run_idf_flash(firmware_path, port, profile)
    if rc != 0:
        click.echo(f"[esp32-devtool] idf.py flash failed rc={rc}", err=True)
        return 5

    rc = _respawn_daemon_and_wait_ready(port)
    if rc != 0:
        return rc

    click.echo(f"flash OK — port={port} profile={profile}")
    return 0
