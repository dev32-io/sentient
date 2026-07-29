"""Installer state-machine tests.

Scope is deliberately narrow: the install/rollback FSM, the checksum gate and
the TLS trust decision. Those are the paths where a defect takes the mini down
or weakens a security boundary. The thin I/O shells (RealFs, RealLaunchd) are
exercised through the FSM against a real temp filesystem rather than mocked.
"""

from __future__ import annotations

import hashlib
import ssl
import os
import stat
import subprocess
import tarfile
from pathlib import Path

import pytest
from setup_prod import (
    INSTALL_VENV_SCRIPT,
    SERVICE_SOURCES,
    HealthProbe,
    InstallError,
    Installer,
    RealFs,
    RealLaunchd,
    build_tls_context,
    ensure_state_dirs,
    read_release_version,
    resolve_operator,
    stage_native_services,
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


# --- user-owned state (data-loss + privilege boundary) ------------------------


def test_operator_config_is_never_clobbered(tmp_path):
    """The operator hand-edits config.yaml. Re-running the installer must not
    revert those edits — this has bitten before."""
    home = tmp_path / "home"
    template = tmp_path / "template.yaml"
    template.write_text("orchestrator:\n  model: template-default\n")
    cfg = home / ".sentient/gateway/config/config.yaml"
    cfg.parent.mkdir(parents=True)
    cfg.write_text("orchestrator:\n  model: operator-tuned\n")

    ensure_state_dirs(home, template)
    ensure_state_dirs(home, template)  # idempotent: twice must be identical

    assert cfg.read_text() == "orchestrator:\n  model: operator-tuned\n"


def test_config_is_seeded_from_the_template_on_a_fresh_host(tmp_path):
    home = tmp_path / "home"
    template = tmp_path / "template.yaml"
    template.write_text("orchestrator:\n  model: template-default\n")

    ensure_state_dirs(home, template)

    assert (home / ".sentient/gateway/config/config.yaml").read_text() == template.read_text()


def test_secrets_are_not_readable_by_group_or_world(tmp_path):
    home = tmp_path / "home"
    template = tmp_path / "template.yaml"
    template.write_text("orchestrator: {}\n")
    ensure_state_dirs(home, template)
    keys = home / ".sentient/secrets/keys.yaml"
    keys.write_text("paseto: redacted\n")
    keys.chmod(0o644)

    ensure_state_dirs(home, template)

    assert stat.S_IMODE((home / ".sentient/secrets").stat().st_mode) == 0o700
    assert stat.S_IMODE(keys.stat().st_mode) == 0o600


def test_state_created_under_sudo_is_handed_back_to_the_operator(tmp_path):
    """The installer runs as root; the gateway runs as the operator.

    Anything root creates under ~/.sentient and forgets to chown is a directory
    the gateway cannot write at next boot — a failure that shows up hours later
    as a permission error, not here.
    """
    home = tmp_path / "home"
    template = tmp_path / "template.yaml"
    template.write_text("orchestrator: {}\n")
    chowned = []

    ensure_state_dirs(home, template, chown=chowned.append)

    created = {p for p in chowned}
    assert home / ".sentient" in created
    assert home / ".sentient/secrets" in created
    assert home / ".sentient/gateway/config/config.yaml" in created, "the seeded config too"


# --- release archive -> disk (untrusted-archive boundary + layout invariant) ---
#
# `scripts/build-gateway.sh` packs `tar -czf <v>.tar.gz -C dist/gateway <v>`, so
# the archive's single top-level directory IS the version. The filename is just
# a label an operator can rename or mistype; the archive is the fact.


def _release_tarball(tmp_path, version, members=()):
    """A tarball shaped exactly like `scripts/build-gateway.sh` emits."""
    staging = tmp_path / "staging"
    release = staging / version
    (release / "bin").mkdir(parents=True, exist_ok=True)
    (release / "bin/sentient-gateway").write_text("#!/bin/sh\nexit 0\n")
    (release / "share").mkdir(exist_ok=True)
    for name in members:
        member = release / name
        member.parent.mkdir(parents=True, exist_ok=True)
        member.write_text("x")
    tarball = tmp_path / f"{version}.tar.gz"
    # COPYFILE_DISABLE mirrors the real `dist/gateway/<v>.tar.gz`, which has zero
    # AppleDouble members (verified). Without it macOS tar emits a `._<name>`
    # sidecar for every xattr-bearing file, which is a DIFFERENT archive shape —
    # covered explicitly by test_applesingle_sidecars_do_not_hide_the_version.
    subprocess.run(
        ["tar", "-czf", str(tarball), "-C", str(staging), version],
        check=True, capture_output=True, env={**os.environ, "COPYFILE_DISABLE": "1"},
    )
    return tarball


def _rootless_runner(recorded):
    """Run `tar` for real; record the privileged calls instead of running them.

    The hardening commands need root. Recording them keeps the extraction path
    genuinely exercised while letting the layout invariants be verified without
    sudo — and lets the tests assert that hardening was actually requested.
    """
    def runner(argv, **kwargs):
        recorded.append(list(argv))
        if argv[0] == "tar":
            return subprocess.run(argv, **kwargs)
        return subprocess.CompletedProcess(argv, 0)
    return runner


def test_release_version_comes_from_the_archive_not_the_filename(tmp_path):
    tarball = _release_tarball(tmp_path, "1.13.0")
    renamed = tmp_path / "9.9.9.tar.gz"
    tarball.rename(renamed)

    assert read_release_version(renamed) == "1.13.0"


def test_applesingle_sidecars_do_not_hide_the_version(tmp_path):
    """A build host whose files carry xattrs makes macOS tar emit a `._<name>`
    AppleDouble sidecar beside every member.

    Today's `dist/gateway/<v>.tar.gz` happens to have none, but treating those
    sidecars as a second top-level directory would reject EVERY genuine release
    the day a build host starts adding xattrs — the same shape of bug as
    trusting the absolute path in the `.sha256` sidecar.
    """
    tarball = tmp_path / "1.13.0.tar.gz"
    payload = tmp_path / "sentient-gateway"
    payload.write_text("#!/bin/sh\nexit 0\n")
    with tarfile.open(tarball, "w:gz") as archive:
        archive.add(payload, arcname="1.13.0/bin/sentient-gateway")
        archive.add(payload, arcname="._1.13.0")
        archive.add(payload, arcname="1.13.0/bin/._sentient-gateway")

    assert read_release_version(tarball) == "1.13.0"


def test_a_tarball_disagreeing_with_the_requested_version_is_refused(tmp_path):
    """The failure this prevents: unpacking `1.13.0/` but pointing `current` at
    `9.9.9/`, leaving launchd exec'ing a path that does not exist."""
    tarball = _release_tarball(tmp_path, "1.13.0")
    fs = RealFs(tmp_path / "opt", runner=_rootless_runner([]))

    with pytest.raises(InstallError) as e:
        fs.unpack("9.9.9", tarball)

    assert "1.13.0" in str(e.value) and "9.9.9" in str(e.value)


def test_an_archive_escaping_the_release_root_is_refused(tmp_path):
    """A member outside `<version>/` writes over arbitrary paths as root."""
    payload = tmp_path / "evil"
    payload.write_text("pwned")
    tarball = tmp_path / "1.13.0.tar.gz"
    # Written with tarfile, not `tar`: bsdtar normalises `../` out of member
    # names, so shelling out would silently build a BENIGN archive and the
    # test would pass without ever exercising the guard.
    with tarfile.open(tarball, "w:gz") as archive:
        archive.add(payload, arcname="../../etc/evil")

    with pytest.raises(InstallError) as e:
        read_release_version(tarball)

    assert "escape" in str(e.value).lower() or "outside" in str(e.value).lower()


def test_unpack_lays_down_a_runnable_release_and_hardens_it(tmp_path):
    """CODE IS ROOT-OWNED: the service user must not be able to rewrite its own
    binary. That is the entire reason code does not live under $HOME."""
    tarball = _release_tarball(tmp_path, "1.13.0")
    opt = tmp_path / "opt"
    recorded = []
    fs = RealFs(opt, runner=_rootless_runner(recorded))

    fs.unpack("1.13.0", tarball)

    assert (opt / "1.13.0/bin/sentient-gateway").is_file()
    assert fs.has_version("1.13.0") is True
    hardening = [argv for argv in recorded if argv[0] == "chown"]
    assert hardening, "must chown the release"
    assert "root:wheel" in hardening[0]


def test_current_survives_a_tmp_symlink_left_by_a_crashed_run(tmp_path):
    """`current` must never be absent, and a half-finished previous run must not
    wedge the installer — that would turn a retry into an outage."""
    opt = tmp_path / "opt"
    (opt / "1.12.0").mkdir(parents=True)
    (opt / "1.13.0").mkdir(parents=True)
    fs = RealFs(opt, runner=_rootless_runner([]))
    fs.point_current_at("1.12.0")
    (opt / ".current.tmp").symlink_to(opt / "1.12.0")  # crashed mid-swap

    fs.point_current_at("1.13.0")

    assert fs.current == "1.13.0"
    assert (opt / "current").is_symlink()


# --- launchd (privilege boundary + fresh-install ordering) ---------------------
#
# The real plist is `deploy/mac-prod/io.sentient.gateway.plist`, owned by the
# native-cutover task. These tests use a synthetic plist of the same shape so
# the substitution and load ordering are pinned independently of that file.

SYNTHETIC_PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>io.sentient.gateway</string>
<key>UserName</key><string>OPERATOR</string>
<key>GATEWAY_CONFIG_PATH</key><string>/Users/OPERATOR/.sentient/gateway/config/config.yaml</string>
<key>StandardOutPath</key><string>/Users/OPERATOR/.sentient/gateway/logs/stdout.log</string>
</dict></plist>
"""


def _recording_runner(recorded, fails=()):
    """Capture argv; fail the subcommands named in `fails`."""
    def runner(argv, **kwargs):
        recorded.append(list(argv))
        if len(argv) > 1 and argv[1] in fails:
            raise subprocess.CalledProcessError(1, argv)
        return subprocess.CompletedProcess(argv, 0)
    return runner


def test_the_daemon_user_is_never_root():
    """The plist's UserName comes from here.

    If it resolved to `root` the gateway would run privileged and could rewrite
    its own binary under /opt — which is the exact invariant the root-owned code
    tree exists to enforce. Guessing an operator is worse than refusing.
    """
    assert resolve_operator({"SUDO_USER": "kevinye"}) == "kevinye"

    for hostile in ({}, {"SUDO_USER": ""}, {"SUDO_USER": "root"}):
        with pytest.raises(InstallError) as e:
            resolve_operator(hostile)
        assert "operator" in str(e.value).lower()


def test_installing_the_plist_leaves_no_operator_placeholder(tmp_path):
    """A surviving `OPERATOR` is not a cosmetic defect: UserName would name a
    user that does not exist, and GATEWAY_CONFIG_PATH would point at
    /Users/OPERATOR/... so the gateway would boot against no config."""
    source = tmp_path / "io.sentient.gateway.plist"
    source.write_text(SYNTHETIC_PLIST)
    daemons = tmp_path / "LaunchDaemons"
    daemons.mkdir()
    recorded = []
    ld = RealLaunchd(source, operator="kevinye", daemon_dir=daemons,
                     runner=_recording_runner(recorded))

    ld.install_plist()

    installed = (daemons / "io.sentient.gateway.plist").read_text()
    assert "OPERATOR" not in installed
    assert installed.count("kevinye") == 3, "UserName and both /Users paths"
    assert ["chown", "root:wheel", str(daemons / "io.sentient.gateway.plist")] in recorded
    assert stat.S_IMODE((daemons / "io.sentient.gateway.plist").stat().st_mode) == 0o644


def test_kickstart_bootstraps_an_unloaded_job_before_restarting_it(tmp_path):
    """On a fresh mini the job is not in the system domain yet, and
    `launchctl kickstart` on an unloaded label FAILS — so the very first install
    would die here if it did not bootstrap first."""
    source = tmp_path / "io.sentient.gateway.plist"
    source.write_text(SYNTHETIC_PLIST)
    daemons = tmp_path / "LaunchDaemons"
    daemons.mkdir()
    recorded = []
    ld = RealLaunchd(source, operator="kevinye", daemon_dir=daemons,
                     runner=_recording_runner(recorded, fails=("print",)))

    ld.kickstart()

    subcommands = [argv[1] for argv in recorded if argv[0] == "launchctl"]
    assert subcommands == ["print", "bootstrap"], "bootstrap replaces the kickstart"


def test_kickstart_restarts_an_already_loaded_job(tmp_path):
    source = tmp_path / "io.sentient.gateway.plist"
    source.write_text(SYNTHETIC_PLIST)
    daemons = tmp_path / "LaunchDaemons"
    daemons.mkdir()
    recorded = []
    ld = RealLaunchd(source, operator="kevinye", daemon_dir=daemons,
                     runner=_recording_runner(recorded))

    ld.kickstart()

    launchctl = [argv for argv in recorded if argv[0] == "launchctl"]
    assert [argv[1] for argv in launchctl] == ["print", "kickstart"]
    assert "-k" in launchctl[-1], "must restart, not no-op on an already-running job"


# --- native python services (cross-process layout contract) --------------------
#
# `gateway/config.yaml` spawns these directly:
#   exec:  ["${SENTIENT_CODE}/whisper-stt/venv/bin/python", "-m", "whisper_stt"]
#   env:   PYTHONPATH: "${SENTIENT_CODE}/whisper-stt/src"
# with SENTIENT_CODE=/opt/sentient/current. The installer is the only thing that
# puts those paths on disk, and `scripts/build-gateway.sh` stages ONLY bin/ and
# share/ — so if these two sides drift, both native services fail at every boot
# with ModuleNotFoundError or a missing interpreter.

REPO_ROOT = Path(__file__).resolve().parents[3]


def test_release_layout_matches_the_native_exec_contract():
    """Bind the installer's layout to the config that consumes it."""
    config = (REPO_ROOT / "gateway/config.yaml").read_text()

    for service, spec in SERVICE_SOURCES.items():
        assert f"${{SENTIENT_CODE}}/{service}/venv/bin/python" in config, service
        assert f"${{SENTIENT_CODE}}/{service}/src" in config, service
        assert f'"-m", "{spec["module"]}"' in config, service


def test_the_staged_src_tree_actually_contains_the_module_it_runs(tmp_path):
    """PYTHONPATH points at `<release>/<svc>/src`, and the service is started with
    `-m <module>`. Copying one directory level too high (the service root instead
    of its `src/`) leaves PYTHONPATH valid but the module unimportable — a boot
    failure that looks nothing like a packaging mistake."""
    repo = tmp_path / "repo"
    for spec in SERVICE_SOURCES.values():
        module = repo / spec["src"] / spec["module"]
        module.mkdir(parents=True)
        (module / "__init__.py").write_text("")
        (module / "__pycache__").mkdir()
        (module / "__pycache__/stale.pyc").write_text("stale")
    installer = repo / INSTALL_VENV_SCRIPT
    installer.parent.mkdir(parents=True)
    installer.write_text("#!/bin/sh\nexit 0\n")
    release = tmp_path / "opt/1.13.0"
    recorded = []

    stage_native_services(repo, release, wheels_root=repo / "dist/wheels",
                          runner=_recording_runner(recorded))

    for service, spec in SERVICE_SOURCES.items():
        staged = release / service / "src"
        assert (staged / spec["module"] / "__init__.py").is_file(), service
        assert not (staged / spec["module"] / "__pycache__").exists(), "no stale bytecode"


def test_staging_installs_each_venv_from_vendored_wheels(tmp_path):
    """The venv must come from the offline helper with a per-service wheels dir —
    nothing may fetch at deploy time."""
    repo = tmp_path / "repo"
    for spec in SERVICE_SOURCES.values():
        (repo / spec["src"] / spec["module"]).mkdir(parents=True)
    installer = repo / INSTALL_VENV_SCRIPT
    installer.parent.mkdir(parents=True)
    installer.write_text("#!/bin/sh\nexit 0\n")
    release = tmp_path / "opt/1.13.0"
    wheels = repo / "dist/wheels"
    recorded = []

    stage_native_services(repo, release, wheels_root=wheels,
                          runner=_recording_runner(recorded))

    for service in SERVICE_SOURCES:
        assert [
            str(installer), service,
            str(release / service / "venv"), str(wheels / service),
        ] in recorded, service


def test_staging_refuses_a_release_missing_its_service_source(tmp_path):
    """Fail here, loudly, rather than producing a release whose native services
    cannot start."""
    repo = tmp_path / "repo"
    installer = repo / INSTALL_VENV_SCRIPT
    installer.parent.mkdir(parents=True)
    installer.write_text("#!/bin/sh\nexit 0\n")

    with pytest.raises(InstallError) as e:
        stage_native_services(repo, tmp_path / "opt/1.13.0",
                              wheels_root=repo / "dist/wheels",
                              runner=_recording_runner([]))

    assert "whisper-stt" in str(e.value) or "local-tts" in str(e.value)
