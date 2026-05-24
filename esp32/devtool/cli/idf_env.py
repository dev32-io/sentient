"""Helpers for invoking idf.py from inside a uv-managed CLI session.

uv's per-script venv prepends `~/.cache/uv/environments-v2/...` to PATH, which
shadows the homebrew python that ESP-IDF's `export.sh` derives its `py3.11_env`
location from. ESP-IDF then bails with "Please run the install script". Stripping
the uv prefix before re-sourcing `export.sh` keeps idf.py runnable.
"""
from __future__ import annotations

import os
from pathlib import Path


def strip_uv_venv_from_path(env: dict[str, str]) -> dict[str, str]:
    """Return `env` with uv-managed PATH prefixes removed (in place is fine)."""
    path = env.get("PATH", "")
    parts = [p for p in path.split(os.pathsep)
             if "/uv/" not in p and "/.venv/" not in p
             and "/environments-" not in p]
    env["PATH"] = os.pathsep.join(parts)
    return env


def wrap_with_idf_env(firmware_path: Path | str, cmd: str,
                      idf_path: str | None = None) -> str:
    """Wrap `cmd` so ESP-IDF's env is sourced first if idf.py isn't on PATH.

    Returns a bash one-liner safe to pass as `bash -c <ret>`. The export.sh
    invocation suppresses stdout/stderr and is ``|| true``'d so a re-source on
    an already-prepared shell never trips the surrounding ``bash -c``.
    """
    idf_path = idf_path or os.environ.get("IDF_PATH", str(Path.home() / "esp/esp-idf"))
    return (
        f'if ! command -v idf.py >/dev/null 2>&1; then '
        f'  cd "{idf_path}" && . ./export.sh >/dev/null 2>&1 || true; '
        f'fi; '
        f'cd "{firmware_path}" && {cmd}'
    )
