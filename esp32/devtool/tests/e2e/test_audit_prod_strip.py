"""audit-prod-strip e2e: build prod variant, assert no devtool symbols leak.

Host-only — the cube is never reflashed. The prod ELF lives in the local
build dir; we restore the debug ELF in the finally block so the cube's
auto_recover_per_test hook (which may invoke ``flash --profile debug``) never
mistakenly flashes a prod binary onto the cube.

Burns no flashes; runs two back-to-back ``idf.py build`` (prod, then debug)
which together take ~3-5 min.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path


_BUILD_TIMEOUT_S = 600.0
_AUDIT_TIMEOUT_S = 60.0


def _strip_uv_prefixes(path: str) -> str:
    """Drop uv venv + cache prefixes so system python3 (what ESP-IDF was
    installed against) is first on PATH. Mirrors cli/commands/flash.py — uv's
    pinned 3.11 makes ESP-IDF's export.sh derive an env name that doesn't
    exist and bail."""
    return os.pathsep.join(
        p for p in path.split(os.pathsep)
        if "/uv/" not in p and "/.venv/" not in p
        and "/environments-" not in p
    )


def _build(firmware: Path, env_sh: Path, env: dict[str, str]) -> int:
    """Source env.sh + ESP-IDF export.sh (the latter only if idf.py isn't
    already on PATH), then run ``idf.py build``. Matches the bash chain in
    cli/commands/flash.py — env.sh wires the devtool bin dir, export.sh
    populates ESP-IDF + xtensa toolchain. SDKCONFIG_DEFAULTS in env steers
    the profile (debug vs prod).

    The cached ``sdkconfig`` is removed first: SDKCONFIG_DEFAULTS only
    seeds the FIRST build; once the resolved ``sdkconfig`` exists, ESP-IDF
    prefers it and silently ignores the env override. Without the rm, a
    prod-profile build that follows a debug build inherits all the debug
    Kconfig values (in particular CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE=y),
    which masks the very leaks this audit exists to catch.
    """
    idf_path = env.get("IDF_PATH") or str(Path.home() / "esp" / "esp-idf")
    bash_cmd = (
        f'source {env_sh} && '
        f'if ! command -v idf.py >/dev/null 2>&1; then '
        f'  cd "{idf_path}" && . ./export.sh >/dev/null 2>&1 || true; '
        f'fi; '
        f'cd "{firmware}" && rm -f sdkconfig && idf.py build'
    )
    return subprocess.run(
        ["bash", "-c", bash_cmd],
        env=env,
        timeout=_BUILD_TIMEOUT_S,
    ).returncode


def test_audit_clean_after_prod_build(devtool):
    repo = subprocess.check_output(
        ["git", "rev-parse", "--show-toplevel"], text=True,
    ).strip()
    firmware = Path(repo) / "esp32/cube/firmware"
    env_sh = Path(repo) / "scripts" / "env.sh"

    env = os.environ.copy()
    env["PATH"] = _strip_uv_prefixes(env.get("PATH", ""))
    env["SDKCONFIG_DEFAULTS"] = "sdkconfig.defaults;sdkconfig.defaults.prod"

    rc = _build(firmware, env_sh, env)
    assert rc == 0, f"prod build failed rc={rc}"

    try:
        p = devtool("audit-prod-strip", check=True, timeout_s=_AUDIT_TIMEOUT_S)
        assert "no leaked symbols" in p.stdout, (
            f"audit unexpected stdout: {p.stdout}\nstderr: {p.stderr}"
        )
    finally:
        # Restore debug ELF so subsequent tests and the conftest's
        # auto-recover-via-flash hook don't accidentally use a prod build.
        env["SDKCONFIG_DEFAULTS"] = "sdkconfig.defaults;sdkconfig.defaults.debug"
        _build(firmware, env_sh, env)
