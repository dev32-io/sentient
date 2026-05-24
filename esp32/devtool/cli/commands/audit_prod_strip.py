"""esp32-devtool audit-prod-strip — verify no devtool symbols leak into prod ELF.

Runs ``xtensa-esp32s3-elf-objdump -t`` over the cube's built ELF, greps for
the devtool API surface, and fails if any defined symbol matches. The intent
is to prove the ``CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE=n`` gate fully
strips the companion path — every devtool symbol present in prod is, by
definition, a Kconfig gating bug.

Host-only: this command never flashes. The caller must have built the prod
profile beforehand (the e2e parity test builds + restores debug around it).

Toolchain resolution: ``xtensa-esp32s3-elf-objdump`` lives next to the
addr2line binary the cube uses for panic decode — under
``~/.espressif/tools/xtensa-esp-elf/<version>/xtensa-esp-elf/bin/`` — and is
not on PATH unless ``export.sh`` has been sourced. We glob it directly so
``audit-prod-strip`` works from a vanilla shell. ``$XTENSA_OBJDUMP`` wins if
set (e.g. for an alternate IDF install).
"""
from __future__ import annotations

import glob
import os
import subprocess
from pathlib import Path

import click

from cli.board import BOARDS_DIR, detect_board
from cli.errors import EXIT_OK, EXIT_TRANSPORT_UNAVAILABLE, EXIT_VERB_ERROR
from cli.repo_root import resolve_repo_root


# Symbols that ONLY exist when CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE=y is
# compiled. Catching any of these in prod means the Kconfig gate leaked.
#
# Notes on selection:
# - Public-API surface symbols (`esp32_devtool_companion_start`,
#   `devtool_register_verb`, `devtool_register_http`, the `set_*_provider`
#   family, etc.) are ALSO defined as no-op stubs in `companion_stub.cc` so
#   the cube's unguarded callers (devtool_verbs/*, application.cc) link in
#   prod. Those stubs are intentional — they're not a leak signal.
# - The patterns below are symbols defined ONLY inside the enabled path
#   (companion.cc + handlers/* + http_server.cc + log_relay.cc + verb
#   dispatcher impl). If any show up in the prod ELF symbol table with a
#   non-`*UND*` section, the COMPANION_ENABLE branch leaked into prod.
LEAK_PATTERNS = (
    # Provider entry points — defined only in companion.cc.
    "esp32_devtool_get_info",
    "esp32_devtool_get_snapshot",
    "esp32_devtool_invoke_touch",
    "esp32_devtool_invoke_audio_record",
    "esp32_devtool_invoke_audio_inject",
    # Subsystem starters — defined only in their respective enabled-path TUs.
    "devtool_http_server_start",
    "devtool_log_relay_start",
    "devtool_verb_dispatcher_init",
    "devtool_usb_cdc_reader_start",
)

# Plan's original "symbol-table line with `*UND*`" filter rejects undefined
# imports (e.g. forward declarations) so only emitted code counts as a leak.
_UNDEFINED_TOKEN = "*UND*"

_OBJDUMP_GLOB = (
    "~/.espressif/tools/xtensa-esp-elf/*/xtensa-esp-elf/bin/"
    "xtensa-esp32s3-elf-objdump"
)
_OBJDUMP_TIMEOUT_S = 30.0
_MAX_REPORT_LINES = 20


def _resolve_objdump() -> str | None:
    """Find the toolchain objdump without requiring ``export.sh``.

    Order: ``$XTENSA_OBJDUMP`` → ``$IDF_PYTHON_ENV_PATH`` sibling → glob of
    the espressif install dir → ``which`` (in case the user did source IDF).
    First match wins; later versions sort lexically last so reverse-sort
    picks the freshest.
    """
    override = os.environ.get("XTENSA_OBJDUMP")
    if override and Path(override).is_file():
        return override
    matches = sorted(glob.glob(os.path.expanduser(_OBJDUMP_GLOB)), reverse=True)
    if matches:
        return matches[0]
    on_path = subprocess.run(
        ["which", "xtensa-esp32s3-elf-objdump"], capture_output=True, text=True,
    )
    if on_path.returncode == 0 and on_path.stdout.strip():
        return on_path.stdout.strip()
    return None


def _scan_for_leaks(objdump_output: str) -> list[str]:
    """Filter symbol-table lines to defined matches against LEAK_PATTERNS."""
    return [
        line for line in objdump_output.splitlines()
        if any(pat in line for pat in LEAK_PATTERNS)
        and _UNDEFINED_TOKEN not in line
    ]


def _report_leaks(leaks: list[str]) -> None:
    click.echo(
        f"[esp32-devtool] {len(leaks)} leaked devtool symbol(s) — Kconfig "
        f"gating bug; the CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE=n branch "
        f"left companion code in prod:", err=True,
    )
    for line in leaks[:_MAX_REPORT_LINES]:
        click.echo(f"   {line}", err=True)
    if len(leaks) > _MAX_REPORT_LINES:
        click.echo(f"   ... +{len(leaks) - _MAX_REPORT_LINES} more", err=True)


def run(ctx_obj: dict) -> int:
    manifest = detect_board(boards_dir=BOARDS_DIR,
                            override_name=ctx_obj.get("board"))
    repo = resolve_repo_root()
    if not manifest.firmware_path:
        click.echo(
            f"[esp32-devtool] manifest '{manifest.name}' has no firmware_path",
            err=True)
        return EXIT_VERB_ERROR
    elf = repo / manifest.firmware_path / "build" / "sentient_cube.elf"
    if not elf.exists():
        click.echo(
            f"[esp32-devtool] ELF not found: {elf} — build first with "
            f"`idf.py build` (prod profile) before running audit",
            err=True)
        return EXIT_TRANSPORT_UNAVAILABLE

    objdump = _resolve_objdump()
    if objdump is None:
        click.echo(
            "[esp32-devtool] xtensa-esp32s3-elf-objdump not found; set "
            "$XTENSA_OBJDUMP or install ESP-IDF toolchain under "
            "~/.espressif/tools/xtensa-esp-elf/",
            err=True)
        return EXIT_TRANSPORT_UNAVAILABLE

    result = subprocess.run(
        [objdump, "-t", str(elf)],
        capture_output=True, text=True, timeout=_OBJDUMP_TIMEOUT_S,
    )
    if result.returncode != 0:
        click.echo(
            f"[esp32-devtool] objdump failed rc={result.returncode}: "
            f"{result.stderr[:400]}", err=True)
        return EXIT_VERB_ERROR

    leaks = _scan_for_leaks(result.stdout)
    if leaks:
        _report_leaks(leaks)
        return EXIT_VERB_ERROR

    click.echo("audit-prod-strip: no leaked symbols")
    return EXIT_OK
