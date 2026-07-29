"""Installer state-machine tests.

Scope is deliberately narrow: the install/rollback FSM, the checksum gate and
the TLS trust decision. Those are the paths where a defect takes the mini down
or weakens a security boundary. The thin I/O shells (RealFs, RealLaunchd) are
exercised through the FSM against a real temp filesystem rather than mocked.
"""

from __future__ import annotations

import hashlib
import ssl
import subprocess

import pytest
from setup_prod import (
    HealthProbe,
    InstallError,
    Installer,
    build_tls_context,
    verify_tarball_checksum,
)


class _FakeResponse:
    """Minimal stand-in for the urlopen context manager."""

    def __init__(self, status):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class FakeFs:
    def __init__(self):
        self.current = None
        self.installed = []

    def unpack(self, version, tarball):
        self.installed.append(version)

    def point_current_at(self, version):
        self.current = version

    def has_version(self, version):
        return version in self.installed


class FakeLaunchd:
    def __init__(self):
        self.kicks = 0

    def kickstart(self):
        self.kicks += 1


def test_health_failure_rolls_back_to_previous_version():
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.12.0")
    fs.installed.append("1.12.0")
    # health fails for the new version, succeeds once rolled back
    health = iter([False, True])
    inst = Installer(fs=fs, launchd=ld, health=lambda: next(health), verify_checksum=lambda p: True)

    with pytest.raises(InstallError):
        inst.install("1.13.0", tarball="x.tar.gz")

    assert fs.current == "1.12.0", "must roll back to the previous version"
    assert ld.kicks == 2, "must restart once for the install and once for the rollback"


def test_rollback_verifies_health_after_reverting():
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.12.0")
    fs.installed.append("1.12.0")
    # both the new version AND the rollback fail health
    inst = Installer(fs=fs, launchd=ld, health=lambda: False, verify_checksum=lambda p: True)

    with pytest.raises(InstallError) as e:
        inst.install("1.13.0", tarball="x.tar.gz")
    assert "rollback" in str(e.value).lower(), "a failed rollback must say so explicitly"


def test_bad_checksum_refuses_before_touching_anything():
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.12.0")
    inst = Installer(fs=fs, launchd=ld, health=lambda: True, verify_checksum=lambda p: False)

    with pytest.raises(InstallError):
        inst.install("1.13.0", tarball="x.tar.gz")

    assert fs.installed == [], "must not unpack an unverified tarball"
    assert fs.current == "1.12.0"
    assert ld.kicks == 0


def test_reinstalling_the_running_version_is_a_noop():
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.13.0")
    inst = Installer(fs=fs, launchd=ld, health=lambda: True, verify_checksum=lambda p: True)

    inst.install("1.13.0", tarball="x.tar.gz")

    assert ld.kicks == 0, "idempotent: a healthy identical install must not restart the service"


def test_first_ever_install_failure_says_there_is_nothing_to_roll_back_to():
    fs, ld = FakeFs(), FakeLaunchd()  # no `current` — fresh mini
    inst = Installer(fs=fs, launchd=ld, health=lambda: False, verify_checksum=lambda p: True)

    with pytest.raises(InstallError) as e:
        inst.install("1.13.0", tarball="x.tar.gz")

    assert "no previous version" in str(e.value).lower()
    assert ld.kicks == 1, "must not kickstart a rollback that cannot happen"


def test_repairing_the_running_version_never_claims_a_rollback():
    """Re-installing the CURRENT version when it is already unhealthy.

    There is no distinct rollback target here — flipping `current` back to the
    same version would restart into the same broken build while reporting a
    successful rollback. The failure must name that instead.
    """
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.13.0")
    fs.installed.append("1.13.0")
    inst = Installer(fs=fs, launchd=ld, health=lambda: False, verify_checksum=lambda p: True)

    with pytest.raises(InstallError) as e:
        inst.install("1.13.0", tarball="x.tar.gz")

    message = str(e.value).lower()
    assert "rolled back" not in message, "must not claim a rollback to itself"
    assert ld.kicks == 1, "one restart for the reinstall, no pointless rollback kick"


def test_rollback_target_missing_on_disk_is_reported_not_attempted():
    """`current` points at a version whose directory has been pruned away.

    Flipping the symlink at a directory that is not there leaves launchd with a
    dangling ProgramArguments path — a worse state than the failed install. The
    installer must refuse and say so.
    """
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.12.0")  # never added to fs.installed => not on disk
    inst = Installer(fs=fs, launchd=ld, health=lambda: False, verify_checksum=lambda p: True)

    with pytest.raises(InstallError) as e:
        inst.install("1.13.0", tarball="x.tar.gz")

    message = str(e.value).lower()
    assert "1.12.0" in message and "not on disk" in message
    assert fs.current == "1.13.0", "must not point `current` at a missing directory"
    assert ld.kicks == 1


# --- checksum gate (supply-chain boundary) -----------------------------------
#
# `scripts/build-gateway.sh` writes the sidecar with
#   shasum -a 256 dist/gateway/<v>.tar.gz > dist/gateway/<v>.tar.gz.sha256
# which records the BUILD HOST's absolute path alongside the digest. `shasum -c`
# on the mini therefore checks a path that does not exist there. The digest is
# the only field that travels.


def _release(tmp_path, body=b"gateway release bytes"):
    tarball = tmp_path / "1.13.0.tar.gz"
    tarball.write_bytes(body)
    return tarball


def test_checksum_matches_despite_a_foreign_path_in_the_sidecar(tmp_path):
    tarball = _release(tmp_path)
    digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
    sidecar = tmp_path / "1.13.0.tar.gz.sha256"
    sidecar.write_text(f"{digest}  /Users/builder/sentient/dist/gateway/1.13.0.tar.gz\n")

    assert verify_tarball_checksum(tarball, sidecar) is True


def test_checksum_mismatch_is_refused(tmp_path):
    tarball = _release(tmp_path)
    sidecar = tmp_path / "1.13.0.tar.gz.sha256"
    sidecar.write_text(f"{'0' * 64}  1.13.0.tar.gz\n")

    assert verify_tarball_checksum(tarball, sidecar) is False


def test_missing_sidecar_fails_closed(tmp_path):
    """No sidecar means no provenance. It must never mean 'assume fine'."""
    tarball = _release(tmp_path)

    assert verify_tarball_checksum(tarball, tmp_path / "absent.sha256") is False


def test_malformed_sidecar_fails_closed(tmp_path):
    tarball = _release(tmp_path)
    sidecar = tmp_path / "1.13.0.tar.gz.sha256"
    sidecar.write_text("not-a-digest\n")

    assert verify_tarball_checksum(tarball, sidecar) is False


# --- TLS health gate (security boundary) --------------------------------------
#
# The gateway serves HTTPS with a self-signed cert it mints into
# ~/.sentient/certs/cert.pem (CN=sentient, CA:TRUE, SAN localhost + 127.0.0.1 —
# verified on the live host). The probe pins THAT file as its trust anchor.
# `verify=False` is never an option: an installer is exactly the kind of script
# that gets copied to a target that is not loopback.


def _self_signed(tmp_path, san="DNS:localhost,IP:127.0.0.1"):
    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
         "-keyout", str(key), "-out", str(cert), "-subj", "/CN=sentient",
         "-addext", f"subjectAltName={san}"],
        check=True, capture_output=True,
    )
    return cert


def test_health_probe_context_requires_verification_and_hostname_match(tmp_path):
    ctx = build_tls_context(_self_signed(tmp_path))

    assert ctx.verify_mode == ssl.CERT_REQUIRED
    assert ctx.check_hostname is True


def test_health_probe_without_a_ca_bundle_fails_closed(tmp_path):
    """No trust anchor must mean 'refuse', never 'skip verification'."""
    with pytest.raises(InstallError) as e:
        build_tls_context(tmp_path / "absent.pem")

    assert "absent.pem" in str(e.value)


def test_tls_trust_failure_is_reported_not_retried(tmp_path):
    """A cert the probe cannot trust is a permanent condition.

    Burning the whole retry budget on it hides the cause behind a timeout, and
    the tempting "fix" for a timeout is to disable verification. Fail fast with
    the real reason instead.
    """
    calls = []

    def opener(request, timeout, context):
        calls.append(request)
        raise ssl.SSLCertVerificationError("certificate verify failed: self-signed certificate")

    probe = HealthProbe(
        url="https://127.0.0.1:8888/api/v1/health",
        ca_bundle=_self_signed(tmp_path),
        opener=opener,
        attempts=10,
        interval_seconds=0,
    )

    assert probe.wait() is False
    assert len(calls) == 1, "a trust failure must not be retried"
    assert "tls" in probe.last_reason.lower()


def test_health_probe_retries_while_the_gateway_is_still_booting(tmp_path):
    """launchd returns before the process is listening; the gate must wait."""
    attempts = iter([ConnectionRefusedError(), ConnectionRefusedError(), None])

    def opener(request, timeout, context):
        outcome = next(attempts)
        if outcome is not None:
            raise outcome
        return _FakeResponse(200)

    probe = HealthProbe(
        url="https://127.0.0.1:8888/api/v1/health",
        ca_bundle=_self_signed(tmp_path),
        opener=opener,
        attempts=5,
        interval_seconds=0,
    )

    assert probe.wait() is True


def test_health_probe_gives_up_within_its_budget(tmp_path):
    calls = []

    def opener(request, timeout, context):
        calls.append(request)
        raise ConnectionRefusedError()

    probe = HealthProbe(
        url="https://127.0.0.1:8888/api/v1/health",
        ca_bundle=_self_signed(tmp_path),
        opener=opener,
        attempts=4,
        interval_seconds=0,
    )

    assert probe.wait() is False
    assert len(calls) == 4, "bounded retry budget — never an unbounded wait"
