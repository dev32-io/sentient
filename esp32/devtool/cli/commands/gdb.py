"""esp32-devtool gdb — openocd + xtensa-gdb pair, optional batch script.

Absorbs ``esp32/cube/scripts/gdb-batch.sh``: spawn ``idf.py openocd`` in the
firmware dir (it owns the ESP-IDF env), wait for it to come up, then invoke
``xtensa-esp32s3-elf-gdb`` against the cube's ELF. Clean teardown via
process-group SIGTERM + pkill so the openocd grandchild doesn't dangle.

Built-in ESP32-S3 USB-Serial-JTAG: openocd halts the cube while attached.
gdb's default ``quit`` does NOT resume a halted remote target — we wrap the
user batch script with a ``monitor resume`` + ``detach`` postamble so the
cube returns to running state cleanly.
"""
from __future__ import annotations

import glob as gl
import os
import signal
import subprocess
import tempfile
import time
from pathlib import Path

import click

from cli.board import BOARDS_DIR, detect_board
from cli.errors import DevtoolError, report_devtool_error
from cli.idf_env import strip_uv_venv_from_path, wrap_with_idf_env
from cli.repo_root import resolve_repo_root


# openocd JTAG listens on 3333 by default; gdb's ``target remote :3333``
# matches gdb-batch.sh's .gdbinit-batch.
_GDB_REMOTE = "target remote :3333"

# openocd needs a moment after spawn to claim the JTAG interface + start
# listening on 3333. gdb-batch.sh sleeps 2s; we extend that to 5s and verify
# the log shows ``Listening on port 3333`` before handing off to gdb.
_OPENOCD_WAIT_TIMEOUT_S = 15.0
_OPENOCD_POLL_INTERVAL_S = 0.25
_OPENOCD_READY_MARKER = "Listening on port 3333"
_OPENOCD_LOG_PATH = Path("/tmp/esp32-devtool-openocd.log")

# Cleanup grace — openocd handshakes the JTAG release on SIGTERM. 3s is the
# gdb-batch.sh trap value; we keep it.
_OPENOCD_TEARDOWN_S = 3.0

# Glob for the currently-installed xtensa gdb. ESP-IDF versions this dir; we
# resolve dynamically rather than pinning. ``XTENSA_GDB`` env var overrides.
_GDB_GLOB = str(
    Path.home()
    / ".espressif/tools/xtensa-esp-elf-gdb/*/xtensa-esp-elf-gdb/bin/"
      "xtensa-esp32s3-elf-gdb"
)


def _resolve_gdb_bin() -> str | None:
    """Resolve xtensa gdb: env override first, then glob the espressif dir."""
    override = os.environ.get("XTENSA_GDB")
    if override and Path(override).exists():
        return override
    matches = sorted(gl.glob(_GDB_GLOB))
    if not matches:
        return None
    return matches[-1]  # latest version (lexicographic sort works for our dirs)


def _spawn_openocd(firmware_path: Path) -> subprocess.Popen:
    """Spawn ``idf.py openocd`` in a new process group so we can kill the
    whole tree (idf.py + openocd grandchild) on teardown.

    PYTHONUNBUFFERED=1 is essential — idf.py is a Python script and without
    it the openocd-ready marker doesn't reach the log file until exit.
    """
    env = os.environ.copy()
    strip_uv_venv_from_path(env)
    env["PYTHONUNBUFFERED"] = "1"
    cmd = wrap_with_idf_env(
        firmware_path, "exec idf.py openocd", idf_path=env.get("IDF_PATH"),
    )
    log_file = open(_OPENOCD_LOG_PATH, "wb")
    return subprocess.Popen(
        ["bash", "-c", cmd],
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )


def _wait_for_openocd_ready(proc: subprocess.Popen) -> bool:
    """Poll the openocd log until it announces port 3333 is open."""
    deadline = time.time() + _OPENOCD_WAIT_TIMEOUT_S
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        try:
            text = _OPENOCD_LOG_PATH.read_text(errors="replace")
        except OSError:
            text = ""
        if _OPENOCD_READY_MARKER in text:
            return True
        time.sleep(_OPENOCD_POLL_INTERVAL_S)
    return False


def _kill_openocd_group(proc: subprocess.Popen) -> None:
    """SIGTERM the whole tree.

    Two layers, because idf.py spawns openocd via subprocess.Popen and on
    macOS the grandchild lands in a separate process group:
    1. killpg(bash group) — takes down idf.py + any same-group children.
    2. ``pkill -f "openocd-esp32"`` — sweeps any openocd grandchildren that
       broke away (the actual JTAG-holding process). Without this they
       linger and block subsequent attaches.
    """
    if proc.poll() is None:
        try:
            pgid = os.getpgid(proc.pid)
            os.killpg(pgid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            pass
        try:
            proc.wait(timeout=_OPENOCD_TEARDOWN_S)
        except subprocess.TimeoutExpired:
            try:
                pgid = os.getpgid(proc.pid)
                os.killpg(pgid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                pass
    # Belt-and-suspenders: sweep any orphaned openocd process that was
    # spawned by idf.py in its own group and survived the killpg above.
    try:
        subprocess.run(
            ["pkill", "-TERM", "-f", "openocd-esp32"],
            check=False, capture_output=True, timeout=2.0,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass


# Without these trailing safety commands the cube stays halted after gdb's
# default ``quit`` (gdb disconnects but does NOT resume the remote target),
# wedging USB-CDC until openocd shuts down and forcing a daemon-induced
# reset to recover. We strip any user-supplied ``quit`` and append our own
# resume + detach + quit so the cube always returns to running state.
_GDB_SAFETY_POSTAMBLE = (
    "monitor resume\n"
    "detach\n"
    "quit\n"
)


def _wrap_batch_script(user_script: Path) -> str:
    """Strip a trailing ``quit`` from the user script and append the safety
    postamble. Returns the path to a temp .gdb file (caller cleans up)."""
    text = user_script.read_text()
    lines = [ln for ln in text.splitlines() if ln.strip().lower() != "quit"]
    wrapped = "\n".join(lines) + "\n" + _GDB_SAFETY_POSTAMBLE
    fd, path = tempfile.mkstemp(suffix=".gdb", prefix="esp32-devtool-batch-")
    with os.fdopen(fd, "w") as f:
        f.write(wrapped)
    return path


def _build_gdb_args(gdb_bin: str, elf: Path,
                    wrapped_script: str | None) -> list[str]:
    """Compose gdb argv. Batch mode runs the wrapped script (user batch +
    safety postamble); interactive mode opens a prompt with the cube halted
    at its current PC."""
    if wrapped_script:
        return [
            gdb_bin,
            "-batch",
            "-ex", _GDB_REMOTE,
            "-ex", "set pagination off",
            "-ex", "set confirm off",
            "-x", wrapped_script,
            str(elf),
        ]
    return [
        gdb_bin,
        "-q",
        "-ex", _GDB_REMOTE,
        "-ex", "set pagination off",
        str(elf),
    ]


def _resolve_firmware_and_elf(ctx_obj: dict) -> tuple[Path, Path] | int:
    """Resolve board → firmware path → ELF. Returns (firmware, elf) on
    success or an exit-code int on failure."""
    try:
        manifest = detect_board(
            boards_dir=BOARDS_DIR,
            override_name=ctx_obj.get("board"),
        )
    except DevtoolError as e:
        report_devtool_error(e, json_out=ctx_obj.get("json_out", False))
        return e.exit_code
    if not manifest.firmware_path:
        click.echo(
            f"[esp32-devtool] manifest '{manifest.name}' has no firmware_path",
            err=True,
        )
        return 5
    repo_root = resolve_repo_root()
    firmware = repo_root / manifest.firmware_path
    elf = firmware / "build" / "sentient_cube.elf"
    if not elf.exists():
        click.echo(
            f"[esp32-devtool] ELF not found: {elf}\n"
            f"   next step: run 'idf.py build' from {firmware} first",
            err=True,
        )
        return 4
    return firmware, elf


def run(ctx_obj: dict, batch_script: str | None,
        openocd_config: str | None) -> int:
    resolved = _resolve_firmware_and_elf(ctx_obj)
    if isinstance(resolved, int):
        return resolved
    firmware, elf = resolved

    if openocd_config is not None:
        # Reserved for future per-board configs; ``idf.py openocd`` picks
        # the right interface automatically for the chip in sdkconfig.
        click.echo(
            f"[esp32-devtool] --openocd-config={openocd_config} ignored; "
            f"using 'idf.py openocd' (auto-selects board config)",
            err=True,
        )

    gdb_bin = _resolve_gdb_bin()
    if gdb_bin is None:
        click.echo(
            f"[esp32-devtool] xtensa-esp32s3-elf-gdb not found under "
            f"~/.espressif/tools/xtensa-esp-elf-gdb/*/; install ESP-IDF "
            f"or set XTENSA_GDB env var",
            err=True,
        )
        return 4

    wrapped_script: str | None = None
    if batch_script:
        wrapped_script = _wrap_batch_script(Path(batch_script))

    click.echo(
        f"[esp32-devtool] spawning openocd (idf.py openocd in {firmware})",
        err=True,
    )
    openocd = _spawn_openocd(firmware)
    try:
        if not _wait_for_openocd_ready(openocd):
            try:
                tail = _OPENOCD_LOG_PATH.read_text(errors="replace")[-2000:]
            except OSError:
                tail = "<no log>"
            click.echo(
                f"[esp32-devtool] openocd did not open port 3333 within "
                f"{_OPENOCD_WAIT_TIMEOUT_S}s; log tail:\n{tail}",
                err=True,
            )
            return 4
        click.echo(f"[esp32-devtool] openocd ready, launching gdb", err=True)
        args = _build_gdb_args(gdb_bin, elf, wrapped_script)
        rc = subprocess.call(args)
        return 0 if rc == 0 else 5
    finally:
        _kill_openocd_group(openocd)
        if wrapped_script:
            try:
                os.unlink(wrapped_script)
            except OSError:
                pass
