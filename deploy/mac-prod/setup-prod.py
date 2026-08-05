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
  * TLS VERIFICATION IS NEVER DISABLED. Two health probes gate a successful
    install: one against the gateway binary on 8888, pinned to its own
    self-signed certificate; one against the public edge on 443 through
    inbound-proxy, pinned to whichever certificate that proxy is actually
    configured to present. Both require CERT_REQUIRED against a pinned file on
    every attempt — the 8888 probe alone proves only that the process started,
    never that a user's browser could reach it.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import ssl
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import Path, PurePosixPath

# This script lives at <repo>/deploy/mac-prod/setup-prod.py and is run from the
# checkout, which supplies the service sources, the wheels and the plist.
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
# Seed for a fresh host only — ensure_state_dirs never overwrites an existing one.
TEMPLATE_CONFIG = "gateway/config.yaml"
# Where TEMPLATE_CONFIG lands once seeded under the operator's state tree. Read
# back (never written) to resolve inbound_proxy.cert_dir for the edge health
# probe — see resolve_outward_cert().
OPERATOR_CONFIG_RELATIVE = "gateway/config/config.yaml"
PLIST_SOURCE = "deploy/mac-prod/io.sentient.gateway.plist"
# scripts/build-gateway.sh writes `<tarball>.sha256` beside the tarball.
CHECKSUM_SUFFIX = ".sha256"
EXIT_OK = 0
EXIT_INSTALL_FAILED = 1

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

# --- edge (443) health gate tunables -----------------------------------------
# A SEPARATE budget from the 8888 one above, not a shared one, because the two
# probes do not face the same risk. `inbound-proxy` is a docker addon the
# gateway's own orchestrator applies fire-and-forget from inside
# createGatewayServices — before main.ts binds the port the 8888 probe polls
# ("accept traffic — LAST, and deliberately so"). The head start that actually
# matters, though, is against the moment the 8888 probe below reports healthy,
# since that is when THIS probe starts: on a warm restart both happen in
# milliseconds and the proxy gets little head start, but on a cold boot (the
# gateway minting a certificate can eat most of HEALTH_ATTEMPTS *
# HEALTH_INTERVAL_SECONDS) the proxy's own apply has been running the whole
# time the gateway probe was still retrying. Past that head start, this budget
# only has to cover container recreate plus the orchestrator's own bounded 30s
# TCP-health ceiling for inbound-proxy (config.yaml#managed_services.
# inbound-proxy.healthcheck), never a cold gateway boot — hence smaller than
# HEALTH_ATTEMPTS. On a freshly-rebooted mini where Docker Desktop itself has
# not started yet (a real, documented failure mode: docs/native-todo.md §3),
# this budget legitimately runs out — that is correct, not a bug, because the
# rollback target depends on the same proxy and `_roll_back` already turns
# "both versions unhealthy" into a named manual-intervention message rather
# than a silent symlink flip. Valid: 1..600 attempts. 30 x 2s = 60s, on top of
# whatever head start the proxy already banked while the 8888 probe was still
# retrying above.
EDGE_HEALTH_ATTEMPTS = 30
EDGE_HEALTH_INTERVAL_SECONDS = 2
# Bare root, not an API path: the thing being proved is "the proxy serves the
# webui on 443 at all," and the root is what a browser actually requests.
DEFAULT_EDGE_URL = "https://localhost/"
# The root may redirect to a login route; any 2xx or 3xx through the proxy
# already proves nginx, the outward cert and the reverse-proxy hop all work.
# Half-open range: [MIN, MAX_EXCLUSIVE).
EDGE_SUCCESS_STATUS_MIN = 200
EDGE_SUCCESS_STATUS_MAX_EXCLUSIVE = 400

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
STATE_ROOT = ".sentient"
# The gateway mints its own self-signed CA here on first boot; the health probe
# pins this file as its trust anchor.
#
# SOURCE OF TRUTH IS THE GATEWAY, and it is `gateway/certs`, not `certs`:
# `gateway/src/config/startup-config.ts` resolves the dir as
# `GATEWAY_CERTS_DIR ?? gatewayStateDir("certs")` — i.e. `~/.sentient/gateway/
# certs` — and io.sentient.gateway.plist sets that variable to exactly that
# path. `shared/tls/src/tls.ts` only mkdir's whatever it is handed, so it never
# pinned the location. This constant tracked the pre-native, container-era
# `~/.sentient/certs` mount; against the native gateway the anchor never
# appeared there and the health gate failed every install of a perfectly
# healthy release.
CERT_RELATIVE = "gateway/certs/cert.pem"

# --- outward (443) cert resolution -------------------------------------------
# Mirrors gateway/src/bootstrap/phase-orchestrator.ts EXACTLY: the operator's
# `inbound_proxy.cert_dir` wins when that PATH exists on disk at all (matching
# `existsSync(configuredCertDir)` there — type-agnostic, so this also does not
# distinguish file from directory; the cert.pem file inside it is not checked
# at this stage, same as the TS side), else the fallback is the gateway's own
# self-signed material at CERT_RELATIVE above. Installer and gateway must
# never disagree about which cert is in play, or a correctly configured mini
# could fail this gate on a cert the running proxy never used.
INBOUND_PROXY_SECTION = "inbound_proxy:"
CERT_DIR_KEY = "cert_dir"
CERT_FILENAME = "cert.pem"
STATE_DIRS = (
    "gateway/config",
    "gateway/logs",
    "gateway/clientLogs",
    "gateway/data",
    "gateway/users",
    # Created here rather than left to the gateway's own mkdir so the trust
    # anchor's parent exists, and is operator-owned, before the daemon boots.
    "gateway/certs",
    "secrets",
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
    give_back = chown or (lambda _path: None)
    seen: set[Path] = set()

    def handed_back(path: Path) -> None:
        """Hand one path to the operator, once per run."""
        if path in seen:
            return
        seen.add(path)
        give_back(path)

    root = home / STATE_ROOT

    root.mkdir(parents=True, exist_ok=True)
    handed_back(root)
    for relative in STATE_DIRS:
        # ONE LEVEL AT A TIME, and hand back every level — never
        # `mkdir(parents=True)`. That call creates INTERMEDIATE directories as
        # a silent side effect and reports none of them, so `~/.sentient/
        # gateway` (the parent of gateway/config, and the directory the gateway
        # writes internal-secrets.json, users.json and auth-secret.key straight
        # into) was created by root and never handed back. The daemon runs
        # unprivileged as the operator, so its first boot died on EACCES and
        # KeepAlive turned that into a crash loop.
        #
        # Handing back unconditionally, not only for paths this run created,
        # also REPAIRS a host an earlier install left root-owned.
        path = root
        for part in PurePosixPath(relative).parts:
            path = path / part
            path.mkdir(exist_ok=True)
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
    config = root / OPERATOR_CONFIG_RELATIVE
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
        domain: str = LAUNCHD_DOMAIN,
    ):
        self._source = Path(plist_source)
        self._operator = operator
        self._label = label
        self._dir = Path(daemon_dir)
        self._run = runner
        # `system` in production, and deliberately NOT a CLI flag — a gateway
        # loaded into a per-user domain would die at logout. It is a constructor
        # argument so the rehearsal in tests/test_launchd_live.py can exercise
        # this exact code against the REAL launchctl in an unprivileged domain,
        # which is the only way to verify the bootstrap/kickstart branch without
        # root. See deploy/mac-prod/README.md.
        self._domain = domain

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
                ["launchctl", "print", f"{self._domain}/{self._label}"],
                check=True, capture_output=True,
            )
            return True
        except subprocess.CalledProcessError:
            return False

    def kickstart(self) -> None:
        """Restart the daemon, bootstrapping it first if it is not loaded yet.

        `launchctl kickstart` FAILS on a label that is not in the domain yet
        (verified against the real launchctl: exit 113, "Could not find service"),
        so a fresh mini has to be bootstrapped — and bootstrap itself starts the
        job, which is why it replaces the kickstart rather than preceding it.
        """
        if not self._is_loaded():
            self._run(
                ["launchctl", "bootstrap", self._domain, str(self.installed_plist)],
                check=True,
            )
            return
        self._run(
            ["launchctl", "kickstart", "-k", f"{self._domain}/{self._label}"],
            check=True,
        )


def read_inbound_proxy_cert_dir(config_path: Path) -> Path | None:
    """The operator's `inbound_proxy.cert_dir` from their seeded config.yaml.

    Deliberately NOT a YAML parse: this installer runs the system `python3`,
    outside every service's own vendored venv, so importing PyYAML here would
    be a new deploy-time dependency of exactly the kind "NOTHING FETCHES AT
    DEPLOY TIME" (see the module docstring) exists to forbid. `inbound_proxy`
    is a flat, single-key block (see gateway/config.yaml) with no nested lists
    or multiline scalars, so a scoped line scan reads this one value exactly
    without parsing the rest of the document.

    Returns None on a missing file, a missing section, an explicit `null`/`~`,
    or any shape this scanner does not recognize. Every one of those means
    "fall back to the gateway's own material" in resolve_outward_cert() below,
    which is also the correct reading of an unset value.
    """
    try:
        text = config_path.read_text()
    except OSError:
        return None

    in_section = False
    for raw_line in text.splitlines():
        line = raw_line.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        if not raw_line[:1].isspace():
            # A new top-level key. Re-evaluate whether we are still inside
            # `inbound_proxy:` rather than trusting a stale flag from before.
            in_section = line.strip() == INBOUND_PROXY_SECTION
            continue
        if not in_section:
            continue
        key, sep, value = line.strip().partition(":")
        if not sep or key.strip() != CERT_DIR_KEY:
            continue
        value = value.strip().strip("'\"")
        if not value or value in ("null", "~"):
            return None
        return Path(value).expanduser()
    return None


def resolve_outward_cert(home: Path, config_path: Path) -> tuple[Path, str, bool]:
    """The certificate the edge probe pins, plus why — see module-level comment
    above INBOUND_PROXY_SECTION for the fallback this mirrors.

    Returns (cert_path, log_message, is_fallback). `is_fallback` is True only
    when the operator explicitly configured a `cert_dir` that does not exist —
    a real misconfiguration or timing issue worth a warning, not the ordinary
    dev-default case of leaving it `null`, which is the expected path on any
    host that has not been pointed at a real acme.sh certificate yet.
    """
    fallback = home / STATE_ROOT / CERT_RELATIVE
    configured_dir = read_inbound_proxy_cert_dir(config_path)
    if configured_dir is None:
        return (
            fallback,
            f"inbound_proxy.cert_dir is unset — edge probe pinned to the gateway's own {fallback}",
            False,
        )
    if not configured_dir.exists():
        return (
            fallback,
            f"inbound_proxy.cert_dir={configured_dir} does not exist yet — edge probe "
            f"falling back to the gateway's own {fallback}",
            True,
        )
    resolved = configured_dir / CERT_FILENAME
    return (resolved, f"edge probe pinned to configured inbound_proxy.cert_dir: {resolved}", False)


def build_tls_context(ca_bundle: Path, check_hostname: bool = True) -> ssl.SSLContext:
    """Trust context for a health probe, pinned to one specific certificate.

    The gateway mints a self-signed CA into `~/.sentient/gateway/certs/cert.pem`
    on first boot, so that file — not the system trust store — is the anchor
    for the 8888 probe. The edge (443) probe pins a possibly different file
    (see resolve_outward_cert()), but the same rule applies either way:
    `verify_mode` is unconditionally `ssl.CERT_REQUIRED` against the pinned
    `cafile`, never anything looser.

    There is deliberately no "skip verification" path. An installer is exactly
    the kind of script that gets copied to a target that is not loopback, and a
    `verify=False` written here would travel with it. A missing bundle means
    the install is broken anyway, so it fails closed with a named cause.

    `check_hostname` defaults to True: the 8888 probe dials `127.0.0.1` against
    a cert whose SAN carries exactly that IP, so the name check is meaningful
    and must run. The edge probe passes False for a specific, narrow reason —
    it deliberately dials `localhost` while the production cert on the mini
    names `sentient.dev32.io`, the operator's real DNS name, not a loopback
    alias. Disabling the name check there does NOT weaken verification: chain
    verification against the pinned `cafile` still runs on every attempt
    (`verify_mode` stays `CERT_REQUIRED` regardless of this flag), so trust in
    the exact pinned certificate is still required — it is only the NAME check
    that is inapplicable to a deliberate loopback-vs-DNS-name mismatch, never
    the chain check. Do not "simplify" this to `CERT_NONE`: that would drop the
    chain check too, and a health gate that accepts any certificate cannot tell
    "the proxy came up" from "something else answered on 443."
    """
    if not ca_bundle.is_file():
        raise InstallError(
            f"TLS trust anchor {ca_bundle} not found — cannot verify the health "
            f"endpoint at this address. Point the cert override at the right cert.pem; "
            "verification is never disabled."
        )
    context = ssl.create_default_context(cafile=str(ca_bundle))
    context.check_hostname = check_hostname
    context.verify_mode = ssl.CERT_REQUIRED
    return context


class HealthProbe:
    """Poll an HTTP(S) endpoint over verified TLS, with a bounded budget.

    Shared by both health gates: the 8888 probe (gateway binary, exact-200
    success) and the 443 edge probe (through inbound-proxy, 2xx/3xx success,
    hostname check off, own retry budget) — see `is_success` and
    `check_hostname` below. One retry/backoff/classification shape for both,
    so a passing edge probe is held to the exact same TLS rigor as the
    long-standing 8888 one, not a second, looser style next to it.

    Failure shapes are classified, because the right response differs:

    * a refused connection means "not up *yet*" and is retried;
    * an anchor that is not readable yet is also "not *yet*" — on a genuinely
      fresh host the pinned cert.pem does not exist until whatever mints it
      (the gateway, for either cert) has run, so the FIRST probe of every
      fresh install races that file into existence and MUST retry;
    * a TLS trust failure *against a cert the far end actually served* is
      permanent and is reported immediately. Retrying it would hide it behind
      a timeout, and the tempting fix for a timeout is to turn verification
      off.

    Retrying a missing anchor never weakens the boundary: verification is still
    required on every attempt, and if the anchor never appears the budget runs
    out and `wait()` returns False naming it. The cost is that a genuinely
    wrong cert path is reported after the budget rather than instantly — the
    price of not aborting every fresh install on a race.
    """

    def __init__(
        self,
        url: str,
        ca_bundle: Path,
        opener=None,
        attempts: int = HEALTH_ATTEMPTS,
        interval_seconds: float = HEALTH_INTERVAL_SECONDS,
        timeout_seconds: float = HEALTH_TIMEOUT_SECONDS,
        check_hostname: bool = True,
        is_success=lambda status: status == HTTP_OK,
    ):
        self._url = url
        self._ca_bundle = ca_bundle
        self._opener = opener or urllib.request.urlopen
        self._attempts = attempts
        self._interval = interval_seconds
        self._timeout = timeout_seconds
        self._check_hostname = check_hostname
        self._is_success = is_success
        self.last_reason = "not probed"

    def _trust(self) -> tuple[ssl.SSLContext | None, str]:
        """Load the pinned anchor, or say why it is not usable *yet*.

        Never raises: a probe that cannot load its anchor is a retryable "not
        ready" verdict, not an exception. Raising here would escape `wait()`,
        escape the caller's health closure, and take `Installer.install()`'s
        rollback path with it — leaving an unverified release `current`.
        """
        try:
            return (build_tls_context(self._ca_bundle, check_hostname=self._check_hostname), "")
        except InstallError as e:
            return (None, str(e))
        except OSError as e:
            # ssl.SSLError is an OSError: a cert file caught mid-write parses as
            # garbage, and the next attempt sees the finished file.
            return (None, f"TLS trust anchor {self._ca_bundle} is not loadable yet: {e}")

    def _attempt(self) -> tuple[bool, bool, str]:
        """Return (healthy, retryable, reason) for a single request."""
        context, trust_reason = self._trust()
        if context is None:
            return (False, True, trust_reason)
        try:
            with self._opener(self._url, timeout=self._timeout, context=context) as response:
                status = getattr(response, "status", None)
                if status is not None and self._is_success(status):
                    return (True, False, f"{self._url} returned {status}")
                return (False, True, f"{self._url} returned HTTP {status}")
        except ssl.SSLError as e:
            return (False, False, f"TLS verification failed against {self._ca_bundle}: {e}")
        except urllib.error.HTTPError as e:
            # A redirect that urlopen could not itself follow (loop, cross-
            # scheme, etc.) surfaces here rather than as a plain response, so
            # the edge probe's own success predicate must still get a look.
            if self._is_success(e.code):
                return (True, False, f"{self._url} returned {e.code}")
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

    def __init__(self, fs, launchd, health, verify_checksum, prepare=None):
        self._fs = fs
        self._launchd = launchd
        self._health = health
        self._verify_checksum = verify_checksum
        self._prepare = prepare or (lambda _version: None)

    def install(self, version, tarball):
        previous = self._fs.current

        # Verify FIRST, before even the idempotency shortcut. The operator handed
        # us an artifact; if we cannot verify it we say so rather than reporting
        # "live and healthy" because the version happened to match what is
        # already running. Otherwise a corrupted release re-deployed to repair a
        # host looks like a successful deploy.
        if not self._verify_checksum(tarball):
            raise InstallError(f"checksum mismatch for {tarball}; refusing to install")

        # Idempotent: an identical, healthy install must not bounce the service.
        # Only probed when the version already matches — on an upgrade the OLD
        # version's health is irrelevant, and probing it would burn the whole
        # budget before unpacking whenever the running gateway is down.
        if previous == version:
            already_healthy, _ = self._is_healthy()
            if already_healthy:
                return

        self._fs.unpack(version, tarball)
        # Finish the release BEFORE it goes live. The native services' venvs are
        # built here, and a failure must leave the working version current
        # rather than hand launchd a release with no interpreter.
        self._prepare(version)
        self._fs.point_current_at(version)
        self._launchd.kickstart()

        healthy, cause = self._is_healthy()
        if healthy:
            return

        self._roll_back(failed=version, previous=previous, cause=cause)

    def _is_healthy(self) -> tuple[bool, str | None]:
        """Health as a verdict, never as an exception. Returns (healthy, cause).

        `health` is an injected collaborator that touches the filesystem and the
        network, so it CAN raise. The only safe reading of a raise is "not
        verified", because the alternative is the exception unwinding past
        `_roll_back` and leaving an unverified release `current` with the
        service pointed at it. Observed: an absent TLS anchor on a fresh host
        aborted the install with `current` already flipped and zero restarts.

        `health()` may return either a plain bool or an `(is_healthy, cause)`
        pair. The pair form lets a health check that fails WITHOUT raising
        still name which sub-check failed — e.g. "gateway healthy, edge (443)
        not" — the same way a raised exception's message already survives into
        the rollback message below via the `except` branch. Every existing
        caller returns a plain bool, so both shapes are accepted rather than
        forcing one convention to change.
        """
        try:
            result = self._health()
        except (InstallError, OSError) as e:
            return (False, f"health check could not complete: {e}")
        if isinstance(result, tuple):
            healthy, cause = result
            return (bool(healthy), cause)
        return (bool(result), None)

    def _roll_back(self, failed, previous, cause=None):
        """Restore `previous` and re-verify it. Always raises — the install failed.

        Each refusal below is a case where flipping the symlink would make
        things WORSE than the failed install, so it is reported instead of
        attempted. A rollback that leaves launchd pointing at nothing is the
        one outcome worse than a bad release.
        """
        # Carried through every exit: the operator's whole diagnosis of a failed
        # deploy is this one line.
        detail = f" [{cause}]" if cause else ""
        if previous is None:
            raise InstallError(
                f"{failed} failed health and there is no previous version to roll back "
                f"to{detail}"
            )
        if previous == failed:
            raise InstallError(
                f"{failed} failed health and it was already the current version, so there "
                "is no distinct build to revert to — the service is down and needs manual "
                f"intervention{detail}"
            )
        if not self._fs.has_version(previous):
            raise InstallError(
                f"{failed} failed health and the rollback target {previous} is not on disk "
                "— refusing to point `current` at a missing directory; the service is down "
                f"and needs manual intervention{detail}"
            )

        self._fs.point_current_at(previous)
        self._launchd.kickstart()
        healthy, rollback_cause = self._is_healthy()
        if not healthy:
            rollback_detail = f" [rollback: {rollback_cause}]" if rollback_cause else ""
            raise InstallError(
                f"{failed} failed health AND the rollback to {previous} also failed health "
                f"— the service is down and needs manual intervention{detail}{rollback_detail}"
            )
        raise InstallError(f"{failed} failed health; rolled back to {previous}{detail}")


# --- operator-facing output ---------------------------------------------------
# Matches the helper shape in deploy/setup-prod.py: this is a CLI whose stdout IS
# the operator interface. Every step, refusal and fallback names its reason so a
# failed deploy can be diagnosed from the transcript alone.
BOLD, GREEN, YELLOW, RED, RESET = "\033[1m", "\033[32m", "\033[33m", "\033[31m", "\033[0m"


def info(message: str) -> None:
    print(f"{BOLD}==>{RESET} {message}")


def ok(message: str) -> None:
    print(f"  {GREEN}✓{RESET} {message}")


def warn(message: str) -> None:
    print(f"  {YELLOW}!{RESET} {message}", file=sys.stderr)


def fail(message: str) -> None:
    print(f"  {RED}✗{RESET} {message}", file=sys.stderr)


def positive_int(raw: str) -> int:
    """At least 1. A zero-attempt health budget would silently disable the gate."""
    value = int(raw)
    if value < 1:
        raise argparse.ArgumentTypeError(f"must be at least 1, got {value}")
    return value


def parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="setup-prod.py",
        description="Install or upgrade the native Sentient gateway on this host.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    install = commands.add_parser("install", help="install a release tarball")
    install.add_argument("tarball", type=Path, help="dist/gateway/<version>.tar.gz")
    # Overrides exist for staging a release somewhere other than the live tree.
    # There is deliberately no flag that skips verification, the health gate or
    # the rollback — those are the reasons this script exists.
    install.add_argument("--opt-root", type=Path, default=OPT,
                         help=f"release tree root (default {OPT})")
    install.add_argument("--repo", type=Path, default=REPO_ROOT,
                         help="checkout supplying service sources and the plist")
    install.add_argument("--wheels", type=Path, default=None,
                         help=f"vendored wheels root (default <repo>/{WHEELS_ROOT})")
    install.add_argument("--plist", type=Path, default=None,
                         help=f"launchd plist (default <repo>/{PLIST_SOURCE})")
    install.add_argument("--launchd-dir", type=Path, default=LAUNCHD_DIR,
                         help=f"where the plist is installed (default {LAUNCHD_DIR})")
    install.add_argument("--home", type=Path, default=None,
                         help="operator home holding ~/.sentient (default the operator's)")
    install.add_argument("--ca-bundle", type=Path, default=None,
                         help="TLS anchor for the health probe (default <home>/.sentient/gateway/certs/cert.pem)")
    install.add_argument("--health-url", default=DEFAULT_HEALTH_URL)
    # The default budget suits a cold start that has to mint a certificate. A
    # slower host may need more; a rehearsal wants less. Neither can disable the
    # gate — a budget of 0 attempts is rejected by argparse's type below.
    install.add_argument("--health-attempts", type=positive_int, default=HEALTH_ATTEMPTS,
                         help=f"health probes before giving up (default {HEALTH_ATTEMPTS})")
    install.add_argument("--health-interval", type=float, default=HEALTH_INTERVAL_SECONDS,
                         help=f"seconds between probes (default {HEALTH_INTERVAL_SECONDS})")
    # The edge (443) probe proves the whole stack, not just the binary — see
    # resolve_outward_cert() and the EDGE_* tunables for why its cert and its
    # budget are resolved separately from the 8888 probe above.
    install.add_argument("--outward-cert", type=Path, default=None,
                         help="TLS anchor for the edge probe (default: inbound_proxy.cert_dir/cert.pem "
                              "if that directory exists, else the same cert as --ca-bundle)")
    install.add_argument("--edge-url", default=DEFAULT_EDGE_URL,
                         help=f"edge probe target through inbound-proxy (default {DEFAULT_EDGE_URL})")
    install.add_argument("--edge-attempts", type=positive_int, default=EDGE_HEALTH_ATTEMPTS,
                         help=f"edge probes before giving up (default {EDGE_HEALTH_ATTEMPTS})")
    install.add_argument("--edge-interval", type=float, default=EDGE_HEALTH_INTERVAL_SECONDS,
                         help=f"seconds between edge probes (default {EDGE_HEALTH_INTERVAL_SECONDS})")
    install.add_argument("--keep", type=int, default=RELEASES_TO_KEEP,
                         help=f"past releases to retain (default {RELEASES_TO_KEEP})")
    install.add_argument("--operator", default=None,
                         help="account the daemon runs as (default $SUDO_USER)")
    return parser.parse_args(argv)


def run_install(args) -> None:
    operator = args.operator or resolve_operator(os.environ)
    home = args.home or Path(f"/Users/{operator}")
    repo = args.repo
    wheels = args.wheels or repo / WHEELS_ROOT
    plist = args.plist or repo / PLIST_SOURCE
    ca_bundle = args.ca_bundle or home / STATE_ROOT / CERT_RELATIVE

    version = read_release_version(args.tarball)
    info(f"installing gateway {version} for operator {operator}")

    info("seeding operator state")
    ensure_state_dirs(home, repo / TEMPLATE_CONFIG,
                      chown=lambda path: shutil.chown(path, user=operator))
    ok(f"{home / STATE_ROOT} ready")

    # Resolved AFTER ensure_state_dirs, and not alongside ca_bundle above: on a
    # genuinely fresh host the operator's config.yaml does not exist until the
    # seed above just created it, and this must read the real, possibly
    # hand-edited file rather than race that seed.
    if args.outward_cert:
        outward_cert = args.outward_cert
    else:
        outward_cert, cert_reason, cert_is_fallback = resolve_outward_cert(
            home, home / STATE_ROOT / OPERATOR_CONFIG_RELATIVE
        )
        (warn if cert_is_fallback else info)(cert_reason)

    info("installing the launchd daemon")
    launchd = RealLaunchd(plist, operator=operator, daemon_dir=args.launchd_dir)
    launchd.install_plist()
    ok(f"{launchd.installed_plist}")

    fs = RealFs(args.opt_root)
    previous = fs.current
    probe = HealthProbe(args.health_url, ca_bundle,
                        attempts=args.health_attempts,
                        interval_seconds=args.health_interval)
    # check_hostname=False: this dials `localhost`, but the pinned cert may be
    # the mini's real acme.sh certificate for `sentient.dev32.io` — see
    # build_tls_context()'s docstring for why the name check is inapplicable
    # here while chain verification (verify_mode=CERT_REQUIRED) still runs
    # unconditionally. is_success accepts 2xx/3xx: the root may redirect to a
    # login route, and a redirect through nginx already proves the proxy, the
    # cert and the reverse-proxy path all work.
    edge_probe = HealthProbe(args.edge_url, outward_cert,
                             attempts=args.edge_attempts,
                             interval_seconds=args.edge_interval,
                             check_hostname=False,
                             is_success=lambda status: (
                                 EDGE_SUCCESS_STATUS_MIN <= status < EDGE_SUCCESS_STATUS_MAX_EXCLUSIVE
                             ))

    def prepare(staged: str) -> None:
        info(f"staging native services into {version}")
        stage_native_services(repo, args.opt_root / staged, wheels)
        ok("whisper-stt + local-tts venvs built from vendored wheels")

    def health() -> tuple[bool, str | None]:
        """Gateway (8888) first, edge (443) second — both must pass.

        Returns (healthy, cause): the two failures are named distinctly both
        on the console (via `ok`/`fail` below, for a human reading the live
        transcript) AND in the returned `cause` (for `_roll_back`'s raised
        message — see `Installer._is_healthy`'s "pair form" comment — so
        anything capturing only the final exception text still learns which
        probe failed, not just that install failed). The edge probe is skipped
        entirely when the gateway itself is not healthy: proxying through a
        dead upstream cannot succeed, and there is no reason to burn the edge
        probe's own budget finding that out a second way.
        """
        gateway_healthy = probe.wait()
        (ok if gateway_healthy else fail)(f"gateway (8888): {probe.last_reason}")
        if not gateway_healthy:
            fail("gateway not healthy — the binary itself did not come up; edge (443) was not probed")
            return (False, f"gateway not healthy: {probe.last_reason}")

        edge_healthy = edge_probe.wait()
        (ok if edge_healthy else fail)(f"edge (443): {edge_probe.last_reason}")
        if not edge_healthy:
            fail("gateway healthy, edge not — nginx config, the web bundle, or the outward "
                 "cert is broken even though the gateway binary is fine")
            return (False, f"gateway healthy, edge (443) not: {edge_probe.last_reason}")
        return (True, None)

    installer = Installer(
        fs=fs,
        launchd=launchd,
        health=health,
        verify_checksum=lambda tarball: verify_tarball_checksum(
            tarball, tarball.with_suffix(tarball.suffix + CHECKSUM_SUFFIX)
        ),
        prepare=prepare,
    )
    info(f"verifying and installing (previous: {previous or 'none'})")
    installer.install(version, args.tarball)
    ok(f"gateway {version} is live and healthy")

    # Protect the version we just replaced: it is the rollback target for a
    # future failed upgrade, and prune must never be what removes it.
    fs.prune(keep=args.keep, protect=(previous,) if previous else ())
    ok(f"kept the {args.keep} most recent releases")


def main(argv=None) -> int:
    args = parse_args(argv)
    try:
        run_install(args)
    except InstallError as e:
        fail(str(e))
        return EXIT_INSTALL_FAILED
    except subprocess.CalledProcessError as e:
        fail(f"command failed: {' '.join(str(part) for part in e.cmd)}")
        return EXIT_INSTALL_FAILED
    except OSError as e:
        # Almost always "not running under sudo": writing /opt/sentient and
        # /Library/LaunchDaemons both need root. Name it rather than tracebacking.
        fail(f"{e} — run this with sudo, or point --opt-root/--launchd-dir at a writable tree")
        return EXIT_INSTALL_FAILED
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
