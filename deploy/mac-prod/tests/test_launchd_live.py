"""@live rehearsal of the launchd contract against the REAL `launchctl`.

WHY THIS EXISTS
---------------
`RealLaunchd.kickstart()` is the one piece of the installer whose behaviour is
defined by another process's semantics rather than by our own code: whether
`launchctl print` exits non-zero for an unknown label, whether `kickstart` can
start a job that was never bootstrapped, and whether the plist we render is
something real launchd will actually accept and run. The unit suite fakes the
runner, so it pins our branch logic and nothing about launchd.

Production loads the gateway into the `system` domain, which needs root — not
available on a dev box, and prod is observational-only. So this rehearsal drives
the SAME class into the per-user `gui/<uid>` domain, where an unprivileged
account may bootstrap jobs. Everything except the domain and the privilege level
is real: the real `launchctl` binary, the real plist template, real substitution
through `install_plist()`, and a real spawned process reporting back what it
actually got.

Still NOT covered here, and unverifiable without root — see README.md:
  * `chown root:wheel` actually changing ownership (the rehearsal records the
    call and skips it; an unprivileged chown to root cannot succeed);
  * the `system` domain itself, and `UserName` switching launchd to a DIFFERENT
    account than the caller.

Opt-in, because it bootstraps and boots out a real launchd job:
    SENTIENT_LAUNCHD_REHEARSAL=1 python3 -m pytest deploy/mac-prod/tests/ -q

Takes ~20s and looks stalled while it runs. That is real launchd, not a hang:
`kickstart -k` BLOCKS for the remainder of launchd's 10s throttle window when
the job last started inside it. Production sees the same thing — an
install-then-rollback does two kickstarts back to back, so the second returns
about 10s later, before the health budget starts counting.
"""

from __future__ import annotations

import os
import plistlib
import subprocess
import time
from pathlib import Path

import pytest
from setup_prod import OPERATOR_PLACEHOLDER, PLIST_SOURCE, REPO_ROOT, RealLaunchd

REHEARSAL_ENV_VAR = "SENTIENT_LAUNCHD_REHEARSAL"
# Distinct from io.sentient.gateway so a rehearsal can never collide with, or be
# mistaken for, a real gateway job in anyone's domain.
REHEARSAL_LABEL = "io.sentient.launchd-rehearsal"
# The job writes one line and exits; launchd needs a moment to spawn it. Two
# seconds is ~20x the observed spawn time and keeps a failure fast.
SPAWN_TIMEOUT_SECONDS = 2.0
SPAWN_POLL_SECONDS = 0.05
CHOWN_COMMAND = "chown"

pytestmark = pytest.mark.skipif(
    os.environ.get(REHEARSAL_ENV_VAR) != "1",
    reason=f"launchd rehearsal is opt-in; set {REHEARSAL_ENV_VAR}=1",
)


def _user_domain() -> str:
    return f"gui/{os.getuid()}"


def _rehearsal_plist(source: Path, evidence: Path, probe: Path, logs: Path) -> str:
    """The production plist with ONLY what cannot exist here redirected.

    Everything else — `UserName`, `RunAtLoad`, and the whole
    `EnvironmentVariables` block with its OPERATOR placeholders — is carried
    over untouched, so real launchd validates the actual shipped key set.

    Deviations, each forced:
      * `Label`  — a rehearsal must never be mistaken for a real gateway job;
      * `ProgramArguments` — production points at RELEASE_ROOT/current/bin,
        which does not exist until an install has run;
      * `Standard{Out,Error}Path` — must not write into the operator's real
        state dir;
      * `KeepAlive` — production keeps the gateway alive forever, but the probe
        exits immediately, and a KeepAlive respawn is indistinguishable from the
        kickstart this test is trying to observe.
    """
    plist = plistlib.loads(source.read_bytes())
    plist["Label"] = REHEARSAL_LABEL
    plist["ProgramArguments"] = [str(probe)]
    plist["StandardOutPath"] = str(logs / "stdout.log")
    plist["StandardErrorPath"] = str(logs / "stderr.log")
    plist["KeepAlive"] = False
    plist["EnvironmentVariables"]["EVIDENCE_PATH"] = str(evidence)
    return plistlib.dumps(plist).decode()


def _probe_script(path: Path) -> Path:
    """A stand-in for the gateway that reports what launchd actually handed it."""
    path.write_text(
        "#!/bin/sh\n"
        'printf "%s %s %s\\n" "$(id -un)" "$GATEWAY_CONFIG_PATH" "$HOME" '
        '>> "$EVIDENCE_PATH"\n'
    )
    path.chmod(0o755)
    return path


def _await_lines(evidence: Path, count: int) -> list[str]:
    deadline = time.monotonic() + SPAWN_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if evidence.is_file():
            lines = evidence.read_text().split("\n")
            written = [line for line in lines if line]
            if len(written) >= count:
                return written
        time.sleep(SPAWN_POLL_SECONDS)
    existing = evidence.read_text() if evidence.is_file() else "<no file>"
    raise AssertionError(f"launchd never ran the job {count}x; evidence so far: {existing!r}")


def _rehearsal_runner(recorded: list[list[str]]):
    """Real subprocess.run for launchctl; records-and-skips the root-only chown."""

    def run(command, **kwargs):
        recorded.append([str(part) for part in command])
        if command[0] == CHOWN_COMMAND:
            return subprocess.CompletedProcess(command, 0)
        return subprocess.run(command, **kwargs)

    return run


def test_real_launchctl_bootstraps_a_new_label_then_kickstarts_it(tmp_path):
    """The bootstrap-vs-kickstart branch, decided by the real launchctl.

    Pins the process-boundary facts the branch exists for: `print` fails for a
    label launchd does not know, bootstrap both loads AND starts the job, and a
    second kickstart restarts the already-loaded job instead of failing.
    """
    daemon_dir, logs = tmp_path / "daemons", tmp_path / "logs"
    daemon_dir.mkdir()
    logs.mkdir()
    evidence = tmp_path / "evidence.txt"
    operator = subprocess.run(["id", "-un"], capture_output=True, text=True,
                              check=True).stdout.strip()
    source = tmp_path / "rehearsal.plist"
    source.write_text(
        _rehearsal_plist(REPO_ROOT / PLIST_SOURCE, evidence,
                         _probe_script(tmp_path / "probe.sh"), logs)
    )

    recorded: list[list[str]] = []
    launchd = RealLaunchd(
        source, operator=operator, label=REHEARSAL_LABEL, daemon_dir=daemon_dir,
        runner=_rehearsal_runner(recorded), domain=_user_domain(),
        release_root=tmp_path,
    )
    try:
        launchd.install_plist()
        installed = launchd.installed_plist.read_text()
        assert OPERATOR_PLACEHOLDER not in installed, "real plist left a placeholder"

        launchd.kickstart()  # label unknown to launchd => must bootstrap
        first = _await_lines(evidence, 1)

        launchd.kickstart()  # now loaded => must kickstart, not re-bootstrap
        _await_lines(evidence, 2)
    finally:
        subprocess.run(["launchctl", "bootout", f"{_user_domain()}/{REHEARSAL_LABEL}"],
                       capture_output=True)

    launchctl_calls = [call for call in recorded if call[0] != CHOWN_COMMAND]
    verbs = [call[1] for call in launchctl_calls]
    assert verbs == ["print", "bootstrap", "print", "kickstart"], (
        f"expected bootstrap-then-kickstart against the real launchctl, got {verbs}"
    )

    # The substituted plist reached a real process: its own account, and the
    # GATEWAY_CONFIG_PATH the installer wrote for that account.
    ran_as, config_path, home = first[0].split(" ")
    assert ran_as == operator
    assert config_path == f"/Users/{operator}/.sentient/gateway/config/config.yaml"
    assert home == f"/Users/{operator}"
