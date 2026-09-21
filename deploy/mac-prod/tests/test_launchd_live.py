"""Isolated rehearsal of launchd branching with no real launchctl calls.

The installer gets a fake process boundary here: plist rendering remains real,
while bootstrap/kickstart/print semantics and service starts are modeled in
memory. Production launchd is never loaded or mutated.
"""

from __future__ import annotations

import plistlib
import subprocess
from pathlib import Path

from setup_prod import OPERATOR_PLACEHOLDER, PLIST_SOURCE, REPO_ROOT, RealLaunchd

REHEARSAL_LABEL = "io.sentient.launchd-rehearsal"


class FakeLaunchctl:
    def __init__(self):
        self.loaded = False
        self.calls: list[list[str]] = []
        self.starts = 0

    def run(self, command, **kwargs):
        command = [str(part) for part in command]
        self.calls.append(command)
        verb = command[1]
        if verb == "print":
            if not self.loaded:
                raise subprocess.CalledProcessError(1, command)
        elif verb == "bootstrap":
            self.loaded = True
            self.starts += 1
        elif verb == "kickstart":
            if not self.loaded:
                raise subprocess.CalledProcessError(1, command)
            self.starts += 1
        elif verb == "bootout":
            self.loaded = False
        else:  # pragma: no cover - fake seam should stay narrow
            raise AssertionError(command)
        return subprocess.CompletedProcess(command, 0, "", "")


def _rehearsal_plist(source: Path, evidence: Path, probe: Path, logs: Path) -> str:
    """Render shipped plist while redirecting only disposable paths."""
    plist = plistlib.loads(source.read_bytes())
    plist["Label"] = REHEARSAL_LABEL
    plist["ProgramArguments"] = [str(probe)]
    plist["StandardOutPath"] = str(logs / "stdout.log")
    plist["StandardErrorPath"] = str(logs / "stderr.log")
    plist["KeepAlive"] = False
    plist["EnvironmentVariables"]["EVIDENCE_PATH"] = str(evidence)
    return plistlib.dumps(plist).decode()


def test_fake_launchctl_bootstraps_then_kickstarts_without_system_mutation(tmp_path):
    daemon_dir, logs = tmp_path / "daemons", tmp_path / "logs"
    daemon_dir.mkdir()
    logs.mkdir()
    evidence = tmp_path / "evidence.txt"
    probe = tmp_path / "probe.sh"
    probe.write_text("#!/bin/sh\n")
    source = tmp_path / "rehearsal.plist"
    source.write_text(_rehearsal_plist(REPO_ROOT / PLIST_SOURCE, evidence, probe, logs))

    fake = FakeLaunchctl()
    launchd = RealLaunchd(
        source,
        operator="operator",
        label=REHEARSAL_LABEL,
        daemon_dir=daemon_dir,
        runner=fake.run,
        domain="gui",
        release_root=tmp_path,
    )

    launchd.install_plist()
    installed = launchd.installed_plist.read_text()
    assert OPERATOR_PLACEHOLDER not in installed

    launchd.kickstart()
    launchd.kickstart()

    assert [call[1] for call in fake.calls] == [
        "print",
        "bootstrap",
        "print",
        "kickstart",
    ]
    assert fake.starts == 2
    assert not evidence.exists(), "fake service must not spawn a process"
