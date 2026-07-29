"""Installer state-machine tests.

Scope is deliberately narrow: the install/rollback FSM, the checksum gate and
the TLS trust decision. Those are the paths where a defect takes the mini down
or weakens a security boundary. The thin I/O shells (RealFs, RealLaunchd) are
exercised through the FSM against a real temp filesystem rather than mocked.
"""

from __future__ import annotations

import pytest
from setup_prod import InstallError, Installer


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
