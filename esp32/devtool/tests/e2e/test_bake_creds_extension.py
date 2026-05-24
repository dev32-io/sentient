"""bake-creds extension e2e: the manifest-declared ``bake-creds`` command
must exec ``esp32/cube/scripts/bake-creds.sh`` and emit a valid
``sentient_creds.h`` header.

Mutates ``sentient_creds.h`` in place. Backs up the original bytes (if any)
into a pytest fixture finalizer so even SIGINT mid-test restores them — the
gitignored header is critical for cube builds and a corrupted version
breaks every subsequent flash. Does NOT reflash the cube.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Generator

import pytest


_BAKE_TIMEOUT_S = 30.0


@pytest.fixture
def creds_backup() -> Generator[Path, None, None]:
    """Snapshot ``sentient_creds.h`` (and the dev TLS cert sibling) before the
    test; restore exact bytes after — even on exception. Yields the header
    path so the test can read/assert it directly.
    """
    repo = subprocess.check_output(
        ["git", "rev-parse", "--show-toplevel"], text=True,
    ).strip()
    creds_h = Path(repo) / "esp32/cube/firmware/main/sentient_creds.h"
    cert = Path(repo) / "esp32/cube/firmware/main/sentient_dev_gateway.crt"

    header_backup = creds_h.read_bytes() if creds_h.exists() else None
    cert_backup = cert.read_bytes() if cert.exists() else None
    try:
        yield creds_h
    finally:
        if header_backup is not None:
            creds_h.write_bytes(header_backup)
        elif creds_h.exists():
            creds_h.unlink()
        if cert_backup is not None:
            cert.write_bytes(cert_backup)
        elif cert.exists():
            cert.unlink()


def test_bake_creds_runs_and_recreates_header(devtool, creds_backup: Path) -> None:
    # Sanity: .e2e-testing must exist or the bake-creds.sh would fail with a
    # missing-creds error unrelated to the wiring we're testing.
    repo = subprocess.check_output(
        ["git", "rev-parse", "--show-toplevel"], text=True,
    ).strip()
    e2e_creds = Path(repo) / "esp32/cube/.e2e-testing"
    assert e2e_creds.exists(), (
        f"{e2e_creds} missing — bake-creds e2e requires the gitignored creds file"
    )

    p = devtool("bake-creds", "--profile", "debug", timeout_s=_BAKE_TIMEOUT_S)
    assert p.returncode == 0, (
        f"bake-creds rc={p.returncode}\nstdout: {p.stdout}\nstderr: {p.stderr}"
    )
    assert creds_backup.exists(), "sentient_creds.h was not created"
    body = creds_backup.read_bytes()
    assert b"SENTIENT_WIFI_SSID" in body
    assert b"SENTIENT_PASETO_TOKEN" in body
    assert b"SENTIENT_DEVICE_ID" in body
