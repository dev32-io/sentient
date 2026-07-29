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
import ssl
import time
import urllib.error
import urllib.request
from pathlib import Path

# Read the tarball in fixed-size blocks so a multi-hundred-MB release never
# lands in memory in one piece. Valid: any power of two >= 4096; 1 MiB is the
# usual sweet spot for local disks.
HASH_CHUNK_BYTES = 1024 * 1024
# A sha256 hex digest is exactly 64 hex characters. Anything else in the digest
# field of the sidecar is malformed, not a mismatch.
SHA256_HEX_LEN = 64

# --- health gate tunables ----------------------------------------------------
# These live here rather than in gateway/config.yaml on purpose: the installer
# runs BEFORE the gateway it is installing can be asked anything, and it must
# behave identically on a host whose config is broken. Every one is overridable
# from the command line.
#
# Loopback, and 127.0.0.1 rather than `localhost`: the gateway's self-signed
# cert carries both `DNS:localhost` and `IP:127.0.0.1` in its SAN, and the
# numeric form cannot be redirected by /etc/hosts.
DEFAULT_HEALTH_URL = "https://127.0.0.1:8888/api/v1/health"
# launchd returns as soon as it has forked; the gateway then loads config,
# mints certs and binds. Valid: 1..600 attempts. 45 x 2s = 90s, comfortably
# past a cold start that has to generate a certificate.
HEALTH_ATTEMPTS = 45
HEALTH_INTERVAL_SECONDS = 2
# Hard per-request timeout so a half-open socket cannot stall the install.
# Valid: 1..60 seconds.
HEALTH_TIMEOUT_SECONDS = 5
HTTP_OK = 200


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


def build_tls_context(ca_bundle: Path) -> ssl.SSLContext:
    """Trust context for the health probe, pinned to the gateway's own cert.

    The gateway mints a self-signed CA into `~/.sentient/certs/cert.pem` on
    first boot, so that file — not the system trust store — is the anchor.

    There is deliberately no "skip verification" path. An installer is exactly
    the kind of script that gets copied to a target that is not loopback, and a
    `verify=False` written here would travel with it. A missing bundle means
    the install is broken anyway, so it fails closed with a named cause.
    """
    if not ca_bundle.is_file():
        raise InstallError(
            f"TLS trust anchor {ca_bundle} not found — cannot verify the gateway's "
            "health endpoint. Point --ca-bundle at the gateway's cert.pem; verification "
            "is never disabled."
        )
    context = ssl.create_default_context(cafile=str(ca_bundle))
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    return context


class HealthProbe:
    """Poll the gateway's health endpoint over verified TLS, with a bounded budget.

    Two failure shapes are treated differently, because the right response
    differs: a refused connection means "not up *yet*" and is retried, while a
    TLS trust failure is permanent and is reported immediately. Retrying a
    trust failure would hide it behind a timeout, and the tempting fix for a
    timeout is to turn verification off.
    """

    def __init__(
        self,
        url: str,
        ca_bundle: Path,
        opener=None,
        attempts: int = HEALTH_ATTEMPTS,
        interval_seconds: float = HEALTH_INTERVAL_SECONDS,
        timeout_seconds: float = HEALTH_TIMEOUT_SECONDS,
    ):
        self._url = url
        self._ca_bundle = ca_bundle
        self._opener = opener or urllib.request.urlopen
        self._attempts = attempts
        self._interval = interval_seconds
        self._timeout = timeout_seconds
        self.last_reason = "not probed"

    def _attempt(self) -> tuple[bool, bool, str]:
        """Return (healthy, retryable, reason) for a single request."""
        context = build_tls_context(self._ca_bundle)
        try:
            with self._opener(self._url, timeout=self._timeout, context=context) as response:
                status = getattr(response, "status", None)
                if status == HTTP_OK:
                    return (True, False, f"{self._url} returned {HTTP_OK}")
                return (False, True, f"{self._url} returned HTTP {status}")
        except ssl.SSLError as e:
            return (False, False, f"TLS verification failed against {self._ca_bundle}: {e}")
        except urllib.error.HTTPError as e:
            return (False, True, f"{self._url} returned HTTP {e.code}")
        except urllib.error.URLError as e:
            # urlopen wraps the real cause; a TLS failure arrives here in
            # production even though the raw form is raised under test.
            if isinstance(e.reason, ssl.SSLError):
                return (
                    False,
                    False,
                    f"TLS verification failed against {self._ca_bundle}: {e.reason}",
                )
            return (False, True, f"{self._url} unreachable: {e}")
        except OSError as e:
            return (False, True, f"{self._url} unreachable: {e}")

    def wait(self) -> bool:
        for attempt in range(1, self._attempts + 1):
            healthy, retryable, reason = self._attempt()
            self.last_reason = reason
            if healthy:
                return True
            if not retryable:
                return False
            if attempt < self._attempts:
                time.sleep(self._interval)
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
