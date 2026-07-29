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
import os
import shutil
import ssl
import subprocess
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import Path, PurePosixPath

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

# --- release layout ----------------------------------------------------------
# Root-owned, immutable code. Nothing executable lives under $HOME.
OPT = Path("/opt/sentient")
# launchd's ProgramArguments points at the fixed `current/...` path, so a
# version flip is exactly this symlink swap.
CURRENT_LINK = "current"
CURRENT_STAGING = ".current.tmp"
# Relative to a release dir; produced by scripts/build-gateway.sh.
GATEWAY_BINARY = "bin/sentient-gateway"
CODE_OWNER = "root:wheel"
# 755: root writes, everyone executes. Never group- or world-writable — that
# would hand the service user a way to rewrite its own binary.
CODE_MODE = "755"
# macOS tar writes an AppleDouble `._<name>` sidecar beside any member carrying
# extended attributes. Metadata, not content — never a version directory.
APPLEDOUBLE_PREFIX = "._"
# How many past releases stay on disk after an install. Valid: 1..50. Must be
# >= 2 so there is always a rollback target besides the live release; 3 leaves
# room to roll back twice. Each release is ~30 MB unpacked plus its venvs.
RELEASES_TO_KEEP = 3

# --- launchd -----------------------------------------------------------------
# A LaunchDaemon in the `system` domain, not a LaunchAgent: the gateway must be
# up with nobody logged in.
LAUNCHD_LABEL = "io.sentient.gateway"
LAUNCHD_DOMAIN = "system"
LAUNCHD_DIR = Path("/Library/LaunchDaemons")
# The plist ships with this literal standing in for the operator's account name;
# the installer substitutes it. See deploy/mac-prod/io.sentient.gateway.plist.
OPERATOR_PLACEHOLDER = "OPERATOR"
PLIST_OWNER = "root:wheel"
# 0644: root writes, everyone reads. Anyone who can WRITE this file chooses what
# root launches at boot, so group/world write is a privilege-escalation hole.
PLIST_MODE = 0o644
SUDO_USER_VAR = "SUDO_USER"
ROOT_USER = "root"

# --- native python services --------------------------------------------------
# `gateway/config.yaml` starts each of these as
#   ["${SENTIENT_CODE}/<service>/venv/bin/python", "-m", "<module>"]
# with PYTHONPATH="${SENTIENT_CODE}/<service>/src". The keys below ARE those
# `<service>` path segments and must not drift from that config — the layout is
# a cross-process contract, pinned by
# tests/test_setup_prod.py::test_release_layout_matches_the_native_exec_contract.
SERVICE_SOURCES = {
    "whisper-stt": {
        "src": "capabilityServices/WhisperSTTService/src",
        "module": "whisper_stt",
    },
    "local-tts": {
        "src": "capabilityServices/LocalTTSService/src",
        "module": "local_tts",
    },
}
SERVICE_SRC_DIR = "src"
SERVICE_VENV_DIR = "venv"
# Installs with --no-index from vendored wheels: nothing fetches at deploy time.
INSTALL_VENV_SCRIPT = "deploy/mac-prod/native/install-venv.sh"
# Per-service vendored wheels, produced by scripts/build-python-wheels.sh.
WHEELS_ROOT = "dist/wheels"
# Build-host artefacts, never part of a release: stale bytecode can shadow the
# real sources, and egg-info describes the build tree rather than the release.
STAGE_EXCLUDES = ("__pycache__", "*.pyc", "*.egg-info")

# --- state layout ------------------------------------------------------------
# Mutable, operator-owned state. Mirrors what the compose deploy bind-mounted,
# so an existing mini keeps every path it already has. Relative to ~/.sentient.
STATE_DIRS = (
    "gateway/config",
    "gateway/logs",
    "gateway/clientLogs",
    "gateway/data",
    "gateway/users",
    "secrets",
    "certs",
    "run",
)
# 0700: only the operator may traverse the secrets dir. 0600 on the key file
# itself, because a mode that leaks is a security defect, not a nuisance.
SECRETS_DIR_MODE = 0o700
SECRETS_FILE_MODE = 0o600
SECRET_FILENAMES = ("keys.yaml",)


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


def ensure_state_dirs(home: Path, template_config: Path, chown=None) -> None:
    """Create the operator's mutable state tree under `home/.sentient`.

    Idempotent by construction. `chown` is called for every path this function
    creates: the installer runs as root but the gateway runs as the operator,
    so anything root creates and forgets to hand back is a directory the
    gateway cannot write at next boot — a failure that surfaces hours later as
    a permission error rather than here.
    """
    handed_back = chown or (lambda _path: None)
    root = home / ".sentient"

    for relative in ("",) + STATE_DIRS:
        path = root / relative if relative else root
        path.mkdir(parents=True, exist_ok=True)
        handed_back(path)

    secrets = root / "secrets"
    secrets.chmod(SECRETS_DIR_MODE)
    for name in SECRET_FILENAMES:
        secret = secrets / name
        if secret.exists():
            secret.chmod(SECRETS_FILE_MODE)
            handed_back(secret)

    # HARD RULE: the operator edits config.yaml by hand. Seed it once, never
    # clobber it. Reverting a hand-tuned production config is silent data loss.
    config = root / "gateway/config/config.yaml"
    if config.exists():
        return
    if not template_config.is_file():
        raise InstallError(
            f"no config template at {template_config} and no existing config at {config} "
            "— the gateway has nothing to read at startup"
        )
    shutil.copyfile(template_config, config)
    handed_back(config)


def read_release_version(tarball: Path) -> str:
    """The version a release tarball actually contains.

    `scripts/build-gateway.sh` packs `tar -czf <v>.tar.gz -C dist/gateway <v>`,
    so the archive's single top-level directory is the authoritative version.
    The FILENAME is only a label — an operator can rename or mistype it, and
    trusting it would unpack `1.13.0/` while pointing `current` at `9.9.9/`,
    leaving launchd exec'ing a path that does not exist.

    Also the guard for an archive that writes outside the release root. This
    runs as root, so a `../` member would land anywhere on the system.
    """
    try:
        with tarfile.open(tarball, "r:gz") as archive:
            names = archive.getnames()
    except (OSError, tarfile.TarError) as e:
        raise InstallError(f"cannot read release archive {tarball}: {e}") from e

    tops = set()
    for name in names:
        parts = PurePosixPath(name).parts
        if name.startswith("/") or ".." in parts:
            raise InstallError(
                f"release archive {tarball} contains {name!r}, which escapes the "
                "release root — refusing to extract it as root"
            )
        # AppleDouble sidecars are metadata, not content. macOS tar emits a
        # `._<name>` beside every xattr-bearing member, so counting them as
        # top-level directories would reject a genuine release built on such a
        # host. The traversal guard above still applies to them.
        if parts and not parts[0].startswith(APPLEDOUBLE_PREFIX):
            tops.add(parts[0])

    if len(tops) != 1:
        raise InstallError(
            f"release archive {tarball} must hold exactly one top-level version "
            f"directory, found {sorted(tops) or 'none'}"
        )
    return tops.pop()


class RealFs:
    """The `/opt/sentient` release tree.

    Code lives here and nowhere else: root-owned and immutable, so the
    unprivileged service user cannot rewrite the binary it runs. `current` is a
    symlink, swapped atomically, because launchd's ProgramArguments points at
    the fixed `current/bin/sentient-gateway` path — the version flip IS the
    symlink swap.
    """

    def __init__(self, opt_root: Path = OPT, runner=subprocess.run):
        self._root = Path(opt_root)
        self._run = runner

    @property
    def current(self) -> str | None:
        link = self._root / CURRENT_LINK
        if not link.is_symlink():
            return None
        return Path(os.readlink(link)).name

    def has_version(self, version: str) -> bool:
        return (self._root / version).is_dir()

    def unpack(self, version: str, tarball: Path) -> None:
        contained = read_release_version(tarball)
        if contained != version:
            raise InstallError(
                f"release archive {tarball} contains {contained}, not the requested "
                f"{version} — refusing to install a version that is not there"
            )

        self._root.mkdir(parents=True, exist_ok=True)
        self._run(["tar", "-xzf", str(tarball), "-C", str(self._root)], check=True)

        release = self._root / version
        binary = release / GATEWAY_BINARY
        if not binary.is_file():
            raise InstallError(
                f"release {version} unpacked without {GATEWAY_BINARY} — the archive is "
                "not a gateway release"
            )
        self._harden(release)

    def _harden(self, release: Path) -> None:
        # CODE IS ROOT-OWNED: the service runs as the operator and must not be
        # able to rewrite its own binary. This is the whole reason code does not
        # live under $HOME.
        self._run(["chown", "-R", CODE_OWNER, str(release)], check=True)
        self._run(["chmod", "-R", CODE_MODE, str(release)], check=True)

    def point_current_at(self, version: str) -> None:
        """Swap `current` via rename, so it is never momentarily absent.

        An unlink-then-symlink would leave a window in which launchd has no
        binary to exec. `Path.replace` is a rename(2) — atomic on the same
        filesystem.
        """
        staging = self._root / CURRENT_STAGING
        # A previous run killed mid-swap leaves this behind. Clearing it turns a
        # retry into a retry rather than an outage.
        if staging.is_symlink() or staging.exists():
            staging.unlink()
        staging.symlink_to(self._root / version)
        staging.replace(self._root / CURRENT_LINK)

    def _releases(self) -> list[Path]:
        """Release directories only.

        `current` resolves as a directory but is a SYMLINK living in the same
        parent. Including it would let `rmtree` delete straight through it and
        take out the live release — so real directories only, symlinks excluded.
        """
        if not self._root.is_dir():
            return []
        return [
            path for path in self._root.iterdir()
            if path.is_dir() and not path.is_symlink()
        ]

    def prune(self, keep: int = RELEASES_TO_KEEP, protect=()) -> None:
        """Delete old releases, keeping the `keep` most recently installed.

        `current` and everything in `protect` survive regardless of age. That is
        not belt-and-braces: mtime order does not protect `current` (an operator
        who reinstalls an older build to roll forward-fix leaves the live release
        as the oldest directory on disk), and pruning the rollback target is
        exactly what turns a failed upgrade into a manual-intervention outage.
        """
        keeping = {self.current, *protect} - {None}
        # Most recently installed first; mtime is install order and needs no
        # version-string parsing, which would break on any `-rc1` suffix.
        ordered = sorted(self._releases(), key=lambda p: p.stat().st_mtime, reverse=True)
        keeping.update(path.name for path in ordered[:keep])

        for release in ordered:
            if release.name in keeping:
                continue
            shutil.rmtree(release)


def stage_native_services(repo: Path, release: Path, wheels_root: Path, runner=subprocess.run) -> None:
    """Lay down each native Python service's source tree and offline venv.

    `scripts/build-gateway.sh` stages only `bin/` and `share/`, so this is the
    only thing that puts `<release>/<service>/{src,venv}` on disk — the exact
    paths `gateway/config.yaml` names under `${SENTIENT_CODE}`. Without it both
    native services fail at every boot.

    The venv is built by `native/install-venv.sh`, which installs with
    `--no-index` from the per-service vendored wheels: nothing fetches at deploy
    time.
    """
    helper = repo / INSTALL_VENV_SCRIPT
    if not helper.is_file():
        raise InstallError(f"missing the offline venv helper {helper}")

    for service, spec in SERVICE_SOURCES.items():
        source = repo / spec["src"]
        if not (source / spec["module"]).is_dir():
            raise InstallError(
                f"{service}: no {spec['module']} package under {source} — the release "
                "would start with an unimportable module"
            )

        staged = release / service / SERVICE_SRC_DIR
        if staged.exists():
            shutil.rmtree(staged)
        staged.parent.mkdir(parents=True, exist_ok=True)
        # Bytecode and build metadata are the build host's, not the release's;
        # copying them ships staleness and can shadow the real sources.
        shutil.copytree(source, staged, ignore=shutil.ignore_patterns(*STAGE_EXCLUDES))

        runner(
            [
                str(helper), service,
                str(release / service / SERVICE_VENV_DIR),
                str(wheels_root / service),
            ],
            check=True,
        )


def resolve_operator(environ) -> str:
    """The unprivileged user the daemon runs as.

    Substituted into the plist's `UserName`, so `root` here would run the whole
    gateway privileged — and a privileged gateway can rewrite its own binary
    under /opt, which is precisely what the root-owned code tree exists to
    prevent. There is no fallback: guessing an operator is worse than refusing.
    """
    operator = str(environ.get(SUDO_USER_VAR) or "").strip()
    if not operator or operator == ROOT_USER:
        raise InstallError(
            f"cannot determine the operator account from ${SUDO_USER_VAR} (got "
            f"{operator or 'nothing'!r}). Run this with `sudo` from the operator's "
            "own login; the gateway must never run as root."
        )
    return operator


class RealLaunchd:
    """The `io.sentient.gateway` LaunchDaemon.

    A LaunchDaemon, not a LaunchAgent: the gateway must be up with no one logged
    in. The plist is root-owned and points at the fixed `current/` path, so it is
    installed once and a version flip is just a restart.
    """

    def __init__(
        self,
        plist_source: Path,
        operator: str,
        label: str = LAUNCHD_LABEL,
        daemon_dir: Path = LAUNCHD_DIR,
        runner=subprocess.run,
    ):
        self._source = Path(plist_source)
        self._operator = operator
        self._label = label
        self._dir = Path(daemon_dir)
        self._run = runner

    @property
    def installed_plist(self) -> Path:
        return self._dir / f"{self._label}.plist"

    def install_plist(self) -> None:
        try:
            template = self._source.read_text()
        except OSError as e:
            raise InstallError(f"cannot read the launchd plist {self._source}: {e}") from e

        rendered = template.replace(OPERATOR_PLACEHOLDER, self._operator)
        if OPERATOR_PLACEHOLDER in rendered:
            raise InstallError(
                f"plist still contains {OPERATOR_PLACEHOLDER} after substitution — "
                "refusing to install a daemon whose user and paths are placeholders"
            )

        target = self.installed_plist
        target.write_text(rendered)
        # Root-owned and not group/world writable: anyone who can edit this file
        # chooses what root launches at boot.
        self._run(["chown", PLIST_OWNER, str(target)], check=True)
        target.chmod(PLIST_MODE)

    def _is_loaded(self) -> bool:
        try:
            self._run(
                ["launchctl", "print", f"{LAUNCHD_DOMAIN}/{self._label}"],
                check=True, capture_output=True,
            )
            return True
        except subprocess.CalledProcessError:
            return False

    def kickstart(self) -> None:
        """Restart the daemon, bootstrapping it first if it is not loaded yet.

        `launchctl kickstart` FAILS on a label that is not in the system domain,
        so a fresh mini has to be bootstrapped — and bootstrap itself starts the
        job, which is why it replaces the kickstart rather than preceding it.
        """
        if not self._is_loaded():
            self._run(
                ["launchctl", "bootstrap", LAUNCHD_DOMAIN, str(self.installed_plist)],
                check=True,
            )
            return
        self._run(
            ["launchctl", "kickstart", "-k", f"{LAUNCHD_DOMAIN}/{self._label}"],
            check=True,
        )


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
