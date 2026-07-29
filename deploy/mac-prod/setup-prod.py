#!/usr/bin/env python3
"""
Sentient — native production installer (Apple-silicon Mac mini).

Installs the compiled gateway from a release tarball into the root-owned
`/opt/sentient/<version>/` tree, points the `current` symlink at it, restarts
the `io.sentient.gateway` LaunchDaemon and health-gates the result. A release
that fails its health gate is rolled back automatically to the version that was
running before.

    sudo python3 deploy/mac-prod/setup-prod.py install dist/gateway/1.13.1.tar.gz

Invariants this script exists to hold:

  * CODE IS ROOT-OWNED AND IMMUTABLE; STATE IS USER-OWNED AND MUTABLE.
    `/opt/sentient/**` is root:wheel; `~/.sentient/**` belongs to the operator.
    Nothing executable lives under $HOME.
  * NOTHING FETCHES AT DEPLOY TIME. The gateway binary embeds its JS
    dependencies; python services install from vendored wheels with
    `pip install --no-index`.
  * THE OPERATOR'S config.yaml IS NEVER CLOBBERED. It is seeded once from the
    template and hand-edited thereafter.
  * TLS VERIFICATION IS NEVER DISABLED. The health probe pins the gateway's own
    certificate as its trust anchor.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

# Read the tarball in fixed-size blocks so a multi-hundred-MB release never
# lands in memory in one piece. Valid: any power of two >= 4096; 1 MiB is the
# usual sweet spot for local disks.
HASH_CHUNK_BYTES = 1024 * 1024
# A sha256 hex digest is exactly 64 hex characters. Anything else in the digest
# field of the sidecar is malformed, not a mismatch.
SHA256_HEX_LEN = 64


class InstallError(Exception):
    """Install or rollback failed. The message names which, and why."""


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(HASH_CHUNK_BYTES), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_tarball_checksum(tarball: Path, sidecar: Path) -> bool:
    """Compare the release tarball against its `.sha256` sidecar.

    Deliberately NOT `shasum -c`: `scripts/build-gateway.sh` writes the sidecar
    as `<digest>  <absolute build-host path>`, and that path does not exist on
    the mini — `shasum -c` would fail every genuine release. Only the digest
    field travels between hosts, so only the digest is compared.

    Fails closed on a missing or malformed sidecar: absent provenance is not
    the same as verified provenance.
    """
    try:
        recorded = sidecar.read_text().split()
    except OSError:
        return False
    if not recorded:
        return False
    digest = recorded[0].strip().lower()
    if len(digest) != SHA256_HEX_LEN or any(c not in "0123456789abcdef" for c in digest):
        return False
    try:
        return sha256_of(tarball) == digest
    except OSError:
        return False


class Installer:
    """Install/upgrade the native gateway.

    Ordering is deliberate: verify BEFORE unpacking, and health-gate AFTER
    flipping `current`, so a bad release is caught while the previous version
    is still on disk and can be restored.

    Every collaborator is injected so the state machine — the part that can
    take the mini down — is testable without root, launchd or a live gateway.
    """

    def __init__(self, fs, launchd, health, verify_checksum):
        self._fs = fs
        self._launchd = launchd
        self._health = health
        self._verify_checksum = verify_checksum

    def install(self, version, tarball):
        previous = self._fs.current

        # Idempotent: an identical, healthy install must not bounce the service.
        if previous == version and self._health():
            return

        if not self._verify_checksum(tarball):
            raise InstallError(f"checksum mismatch for {tarball}; refusing to install")

        self._fs.unpack(version, tarball)
        self._fs.point_current_at(version)
        self._launchd.kickstart()

        if self._health():
            return

        self._roll_back(failed=version, previous=previous)

    def _roll_back(self, failed, previous):
        """Restore `previous` and re-verify it. Always raises — the install failed.

        Each refusal below is a case where flipping the symlink would make
        things WORSE than the failed install, so it is reported instead of
        attempted. A rollback that leaves launchd pointing at nothing is the
        one outcome worse than a bad release.
        """
        if previous is None:
            raise InstallError(
                f"{failed} failed health and there is no previous version to roll back to"
            )
        if previous == failed:
            raise InstallError(
                f"{failed} failed health and it was already the current version, so there "
                "is no distinct build to revert to — the service is down and needs manual "
                "intervention"
            )
        if not self._fs.has_version(previous):
            raise InstallError(
                f"{failed} failed health and the rollback target {previous} is not on disk "
                "— refusing to point `current` at a missing directory; the service is down "
                "and needs manual intervention"
            )

        self._fs.point_current_at(previous)
        self._launchd.kickstart()
        if not self._health():
            raise InstallError(
                f"{failed} failed health AND the rollback to {previous} also failed health "
                "— the service is down and needs manual intervention"
            )
        raise InstallError(f"{failed} failed health; rolled back to {previous}")
