#!/usr/bin/env python3
"""
Sentient — production setup helper.

Walks the operator through the manual host steps (docker access, hermes
host user, .env), reconciles the STT backend selected in deploy.conf
(native-whisper | docker-sensevoice), then offers to build images locally
and clear out old orchestrator-managed containers. Stops short of
`docker compose up` on purpose — the operator decides when to bring
services online.

STT reconcile (deploy.conf-driven, idempotent — installs a fresh host OR
migrates an existing one between backends):
  - seeds the mounted gateway config from gateway/config.yaml only if absent;
    an existing config is patched surgically (comment-preserving), never
    clobbered from the template.
  - patches stt.url / stt_health_url / managed_services.stt-service to match.
  - native-whisper: installs + starts the host Whisper launchd service and
    skips the SenseVoice image bake; docker-sensevoice: builds the SenseVoice
    image and stops any lingering native service.

TTS reconcile (native-only — Apple-silicon MLX/Metal, no docker fallback so no
selector): canonicalizes tts.url / companions.tts_health_url and installs +
starts the native Chatterbox-TTS launchd service. Declining the install leaves
the gateway with no TTS backend (text-only replies).

Idempotent: re-run any time after `git pull` to refresh images / re-sync the
backend. Persistent state under ~/.sentient/ (secrets, gateway-data, brain)
is never wiped — only the gateway config is patched in place.

Usage:
    python3 deploy/setup-prod.py            # targets deploy/mac-prod (production)
    python3 deploy/setup-prod.py <name>     # target deploy/<name> instead
"""
from __future__ import annotations

import grp
import os
import platform
import pwd
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parent.parent

# Which deploy/<dir> to target. Defaults to mac-prod (current production —
# Apple-silicon Mac mini). Pass a name to target another prod env, e.g.
#   python3 deploy/setup-prod.py docker
DEPLOY_NAME = sys.argv[1] if len(sys.argv) > 1 else "mac-prod"
DEPLOY_DIR = REPO_ROOT / "deploy" / DEPLOY_NAME
COMPOSE_FILE = DEPLOY_DIR / "docker-compose.yml"
ENV_FILE = DEPLOY_DIR / ".env"
ENV_EXAMPLE = DEPLOY_DIR / ".env.example"
SENTIENT_CERT_DIR = Path.home() / ".sentient" / "certs"

# --- STT backend selection (deploy.conf-driven) -----------------------------
# deploy.conf is the single source of truth for which STT backend the gateway
# dials. setup-prod.py reconciles all three moving parts to match it:
#   1. the mounted gateway config (stt.url / stt_health_url / managed_services)
#   2. the native Whisper launchd service
#   3. which STT image compose builds
NATIVE_BACKEND = "native-whisper"
DOCKER_BACKEND = "docker-sensevoice"
VALID_BACKENDS = (NATIVE_BACKEND, DOCKER_BACKEND)
DEPLOY_CONF = DEPLOY_DIR / "deploy.conf"
STT_BACKEND_SCRIPT = DEPLOY_DIR / "native" / "stt-backend.py"
WHISPER_LAUNCHER = DEPLOY_DIR / "native" / "whisper-stt.sh"
# TTS is native-only (Apple-silicon MLX/Metal) — no docker fallback, hence no
# selector like STT_BACKEND. When the deploy ships the native TTS pieces
# (mac-prod), setup installs + starts the Chatterbox-TTS launchd service and
# canonicalizes tts.url / companions.tts_health_url to the host service.
TTS_BACKEND_SCRIPT = DEPLOY_DIR / "native" / "tts-backend.py"
CHATTERBOX_LAUNCHER = DEPLOY_DIR / "native" / "chatterbox-tts.sh"
# Tooling venv for the config patcher (stt-backend.py needs ruamel.yaml). Kept
# out of system python to avoid PEP 668 externally-managed-environment errors.
TOOLING_VENV = DEPLOY_DIR / "native" / ".venv"
# The gateway reads its config from this host path (bind-mounted into the
# container at /app/config/config.yaml). Seeded from the repo default on a
# fresh host, then patched in place to match the selected backend.
MOUNTED_CONFIG = Path.home() / ".sentient" / "gateway" / "config" / "config.yaml"
SEED_CONFIG = REPO_ROOT / "gateway" / "config.yaml"

# ANSI colors — works in any modern terminal; degrades gracefully if piped.
RESET = "\033[0m"
BOLD = "\033[1m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
DIM = "\033[2m"


def info(msg: str) -> None:
    print(f"{BOLD}==>{RESET} {msg}")


def ok(msg: str) -> None:
    print(f"  {GREEN}✓{RESET} {msg}")


def warn(msg: str) -> None:
    print(f"  {YELLOW}!{RESET} {msg}")


def fail(msg: str) -> None:
    print(f"  {RED}✗{RESET} {msg}", file=sys.stderr)


def confirm(prompt: str, default: bool = True) -> bool:
    suffix = "[Y/n]" if default else "[y/N]"
    raw = input(f"  {prompt} {suffix} ").strip().lower()
    if not raw:
        return default
    return raw in {"y", "yes"}


def run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, check=check, text=True, capture_output=True)


# --- Step 1: docker reachable -----------------------------------------------


def check_docker_cli() -> bool:
    if shutil.which("docker") is None:
        fail("`docker` not found on PATH.")
        if platform.system() == "Darwin":
            print(
                f"\n  Install Docker Desktop:  {DIM}brew install --cask docker{RESET}\n"
                f"  Launch once:             {DIM}open -a Docker{RESET}\n"
            )
        else:
            print(
                f"\n  Install:  {DIM}curl -fsSL https://get.docker.com | sh{RESET}\n"
                f"  Then:     {DIM}sudo usermod -aG docker $USER && newgrp docker{RESET}\n"
            )
        return False
    try:
        run(["docker", "version", "--format", "{{.Server.Version}}"])
    except subprocess.CalledProcessError as e:
        fail(f"`docker version` failed — daemon not reachable.\n  {e.stderr.strip()}")
        return False
    ok("docker reachable")
    return True


# --- Step 2: hermes host user (linux only) ----------------------------------


def check_hermes_user() -> bool:
    if platform.system() != "Linux":
        ok(f"hermes host user not required on {platform.system()}")
        return True
    try:
        entry = pwd.getpwnam("hermes")
    except KeyError:
        warn("hermes host user (uid=10000) does not exist")
        print(
            "\n  The sentient-hermes container runs as uid=10000. Without a\n"
            "  matching host user, bind-mounted per-user files end up owned\n"
            "  by an unnamed uid and can't be cleaned up via the host.\n\n"
            "  Run on the host:\n"
            f"    {DIM}sudo groupadd -g 10000 hermes{RESET}\n"
            f"    {DIM}sudo useradd  -u 10000 -g hermes -M -s /usr/sbin/nologin hermes{RESET}\n"
            f"    {DIM}sudo usermod -aG docker hermes{RESET}\n"
        )
        return False
    if entry.pw_uid != 10000:
        fail(f"hermes user exists but uid={entry.pw_uid}, expected 10000")
        return False
    ok(f"hermes user present (uid={entry.pw_uid})")
    return True


# --- Step 3: .env ------------------------------------------------------------


def detect_docker_gid() -> Optional[int]:
    if platform.system() == "Linux":
        try:
            return grp.getgrnam("docker").gr_gid
        except KeyError:
            return None
    # macOS Docker Desktop — GID inside the VM, not the host.
    try:
        out = run(
            [
                "docker",
                "run",
                "--rm",
                "-v",
                "/var/run/docker.sock:/var/run/docker.sock",
                "alpine",
                "stat",
                "-c",
                "%g",
                "/var/run/docker.sock",
            ]
        ).stdout.strip()
        return int(out)
    except (subprocess.CalledProcessError, ValueError):
        return None


def check_env() -> bool:
    if ENV_FILE.exists():
        content = ENV_FILE.read_text()
        if "HOST_DOCKER_GID=" in content and "HOST_DOCKER_GID=\n" not in content:
            ok(f"{ENV_FILE.relative_to(REPO_ROOT)} present")
            return True
        warn(f"{ENV_FILE.relative_to(REPO_ROOT)} exists but HOST_DOCKER_GID is empty")

    gid = detect_docker_gid()
    if gid is None:
        fail("Could not auto-detect docker group GID.")
        print(
            f"\n  Find it manually and put in {ENV_FILE}:\n"
            f"    {DIM}HOST_DOCKER_GID=$(getent group docker | cut -d: -f3){RESET}\n"
        )
        return False

    print(f"  Detected HOST_DOCKER_GID={gid}.")
    if not confirm(f"Write to {ENV_FILE.relative_to(REPO_ROOT)}?"):
        return False

    ENV_FILE.write_text(f"HOST_DOCKER_GID={gid}\n")
    ok(f"wrote {ENV_FILE.relative_to(REPO_ROOT)}")
    return True


# --- STT backend reconcile (deploy.conf-driven) -----------------------------
#
# deploy.conf's STT_BACKEND drives three things that must agree:
#   1. the mounted gateway config (stt.url / stt_health_url / managed_services)
#   2. the native Whisper launchd service (running iff native-whisper)
#   3. which STT image compose builds (SenseVoice iff docker-sensevoice)
# Each helper is idempotent, so the same run installs a fresh host or migrates
# an existing one between backends.


def read_backend() -> Optional[str]:
    """Parse STT_BACKEND from deploy.conf. Returns None on missing/invalid."""
    if not DEPLOY_CONF.exists():
        fail(f"{DEPLOY_CONF.relative_to(REPO_ROOT)} missing — cannot select STT backend")
        return None
    backend: Optional[str] = None
    for line in DEPLOY_CONF.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        if key.strip() == "STT_BACKEND":
            backend = value.strip().strip("\"'")
    if backend not in VALID_BACKENDS:
        fail(
            f"STT_BACKEND={backend!r} invalid in {DEPLOY_CONF.relative_to(REPO_ROOT)}; "
            f"expected one of {VALID_BACKENDS}"
        )
        return None
    ok(f"STT backend: {backend}")
    return backend


def _module_present(python: str, module: str) -> bool:
    return run([python, "-c", f"import {module}"], check=False).returncode == 0


def ensure_ruamel_python() -> Optional[str]:
    """Return a python interpreter with ruamel.yaml available (for stt-backend.py).

    Prefers the interpreter running us; falls back to a dedicated tooling venv
    so we never touch the system site-packages (PEP 668 externally-managed).
    """
    if _module_present(sys.executable, "ruamel.yaml"):
        return sys.executable
    venv_python = TOOLING_VENV / "bin" / "python"
    if not venv_python.exists():
        info("Creating deploy tooling venv (ruamel.yaml for the config patcher)")
        try:
            run([sys.executable, "-m", "venv", str(TOOLING_VENV)])
        except subprocess.CalledProcessError as e:
            fail(f"could not create tooling venv: {e.stderr.strip()}")
            return None
    if not _module_present(str(venv_python), "ruamel.yaml"):
        try:
            run([str(venv_python), "-m", "pip", "install", "-q", "ruamel.yaml"])
        except subprocess.CalledProcessError as e:
            fail(f"could not install ruamel.yaml: {e.stderr.strip()}")
            return None
    return str(venv_python)


def seed_config_if_absent() -> bool:
    """Seed the mounted gateway config from the repo default on a fresh host.

    Never overwrites an existing config — an operator's live config is edited
    surgically (by stt-backend.py), never clobbered from the template.
    """
    if MOUNTED_CONFIG.exists():
        ok(f"mounted gateway config present ({MOUNTED_CONFIG}) — left in place")
        return True
    if not SEED_CONFIG.exists():
        fail(f"seed config {SEED_CONFIG.relative_to(REPO_ROOT)} not found")
        return False
    MOUNTED_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SEED_CONFIG, MOUNTED_CONFIG)
    ok(f"seeded {MOUNTED_CONFIG} from gateway/config.yaml")
    return True


def apply_stt_backend(backend: str, ruamel_python: str) -> bool:
    """Patch the mounted gateway config to match the selected backend.

    Shows the surgical diff and confirms before writing. A no-op when the
    config already matches (idempotent).
    """
    base = [ruamel_python, str(STT_BACKEND_SCRIPT),
            "--backend", backend, "--config", str(MOUNTED_CONFIG)]
    dry = run(base, check=False)
    if dry.returncode != 0:
        fail(f"stt-backend.py failed:\n  {dry.stderr.strip()}")
        return False
    if "no change needed" in dry.stdout:
        ok(f"gateway config already set to {backend}")
        return True
    print(dry.stdout)
    if not confirm(f"Apply {backend} to {MOUNTED_CONFIG.name} (patch above)?"):
        warn("Skipped STT config patch — gateway config may not match STT_BACKEND.")
        return True
    applied = run(base + ["--apply"], check=False)
    if applied.returncode != 0:
        fail(f"stt-backend.py --apply failed:\n  {applied.stderr.strip()}")
        return False
    ok(f"patched gateway config → {backend}")
    return True


def configure_native_stt(backend: str) -> bool:
    """Reconcile the native Whisper launchd service with the selected backend.

    native-whisper: install (venv + models + launchd plist) and start it.
    docker-sensevoice: stop it if it happens to be loaded (migration cleanup).
    """
    if backend == NATIVE_BACKEND:
        if platform.system() != "Darwin":
            fail(f"native-whisper needs macOS launchd; host is {platform.system()}")
            return False
        if not confirm(
            "Install + start the native Whisper-STT launchd service now? "
            "(venv + model download, ~few min)"
        ):
            warn("Skipped native STT install — the gateway will have no STT backend to dial.")
            return True
        info("Installing native Whisper-STT (launchd). First run downloads models.")
        rc = subprocess.call(["bash", str(WHISPER_LAUNCHER), "install"], cwd=REPO_ROOT)
        if rc != 0:
            fail(f"whisper-stt.sh install exited with code {rc}")
            return False
        rc = subprocess.call(["bash", str(WHISPER_LAUNCHER), "start"], cwd=REPO_ROOT)
        if rc != 0:
            fail(f"whisper-stt.sh start exited with code {rc}")
            return False
        ok("native Whisper-STT installed + started (health: :8769/health)")
        return True

    # docker-sensevoice — ensure no native service lingers from a prior native run.
    subprocess.call(["bash", str(WHISPER_LAUNCHER), "stop"], cwd=REPO_ROOT)
    ok("native Whisper-STT stopped (docker-sensevoice owns STT)")
    return True


# --- Native Chatterbox-TTS reconcile (always native, no selector) -----------
#
# TTS mirrors the STT native path but has no backend selector: Chatterbox-TTS
# runs on Apple-silicon MLX/Metal only, so there is no docker fallback to choose
# between. Whenever the deploy ships the native TTS pieces (mac-prod), setup:
#   1. canonicalizes the mounted gateway config's tts.url / tts_health_url
#      (tts-backend.py — a VALUE rewriter; the tts block's SHAPE comes from the
#      seed config, so this is a no-op on a freshly-seeded host and a value fixup
#      on an already-shaped one).
#   2. installs + starts the Chatterbox-TTS launchd service.
# A missing TTS backend is not fatal — the gateway degrades to text-only.


def apply_tts_backend(ruamel_python: str) -> bool:
    """Point the mounted gateway config's tts.url + companions.tts_health_url at
    the native Chatterbox-TTS host service. Shows the surgical diff, confirms,
    and is a no-op when already matching (idempotent). tts-backend.py only
    rewrites values that already exist (the seed owns the tts-block shape)."""
    base = [ruamel_python, str(TTS_BACKEND_SCRIPT), "--config", str(MOUNTED_CONFIG)]
    dry = run(base, check=False)
    if dry.returncode != 0:
        fail(f"tts-backend.py failed:\n  {dry.stderr.strip()}")
        return False
    if "no change needed" in dry.stdout:
        ok("gateway config already points at native Chatterbox-TTS")
        return True
    print(dry.stdout)
    if not confirm(f"Apply native TTS endpoint to {MOUNTED_CONFIG.name} (patch above)?"):
        warn("Skipped TTS config patch — gateway config may not dial the local TTS service.")
        return True
    applied = run(base + ["--apply"], check=False)
    if applied.returncode != 0:
        fail(f"tts-backend.py --apply failed:\n  {applied.stderr.strip()}")
        return False
    ok("patched gateway config → native Chatterbox-TTS")
    return True


def configure_native_tts() -> bool:
    """Install + start the native Chatterbox-TTS launchd service.

    Native-only (Apple-silicon MLX/Metal); there is no docker fallback, so this
    always installs+starts when the operator opts in. Idempotent — the launcher's
    install/start survive re-runs. Declining leaves the gateway with no TTS
    backend, which degrades to text-only replies rather than failing.
    """
    if platform.system() != "Darwin":
        warn(
            f"native Chatterbox-TTS needs macOS/Apple-silicon; host is "
            f"{platform.system()} — skipping (gateway degrades to text-only)"
        )
        return True
    if not confirm(
        "Install + start the native Chatterbox-TTS launchd service now? "
        "(venv + model download, ~few min)"
    ):
        warn("Skipped native TTS install — the gateway will have no TTS backend (text-only replies).")
        return True
    info("Installing native Chatterbox-TTS (launchd). First run downloads models.")
    rc = subprocess.call(["bash", str(CHATTERBOX_LAUNCHER), "install"], cwd=REPO_ROOT)
    if rc != 0:
        fail(f"chatterbox-tts.sh install exited with code {rc}")
        return False
    rc = subprocess.call(["bash", str(CHATTERBOX_LAUNCHER), "start"], cwd=REPO_ROOT)
    if rc != 0:
        fail(f"chatterbox-tts.sh start exited with code {rc}")
        return False
    ok("native Chatterbox-TTS installed + started (health: :8771/health)")
    return True


# --- Step 4: build images ----------------------------------------------------


def build_images(backend: Optional[str]) -> bool:
    # SenseVoice image is skipped ONLY for native-whisper (~10 min saved). For
    # docker-sensevoice it is profile-gated in the mac-prod compose (stt-docker);
    # for legacy targets with no deploy.conf (backend is None) it stays under the
    # build-only profile, so build it there too.
    services = ["gateway", "hermes", "ma-mcp", "searxng-mcp", "fetch-mcp"]
    profiles = ["build-only"]
    if backend != NATIVE_BACKEND:
        services.insert(1, "stt-service")
        if backend == DOCKER_BACKEND:
            profiles.append("stt-docker")

    if not confirm(f"Build sibling images now? ({', '.join(services)})"):
        profile_flags = " ".join(f"--profile {p}" for p in profiles)
        info("Skipped image build — run later with:")
        print(
            f"    {DIM}docker compose -f {COMPOSE_FILE.relative_to(REPO_ROOT)} "
            f"{profile_flags} build {' '.join(services)}{RESET}"
        )
        return True

    info("Building images. First run takes ~10-20 min (Hermes image bakes).")
    # Explicit working set — skip signal-cli (optional Signal bridge): its
    # upstream Dockerfile currently fails on a libsignal-client jar version
    # mismatch and it's not part of the core voice/chat path. Add it back here
    # once that pin is fixed.
    profile_args = [arg for p in profiles for arg in ("--profile", p)]
    cmd = [
        "docker", "compose", "-f", str(COMPOSE_FILE),
        *profile_args, "build", *services,
    ]
    # Stream output directly — buildx already renders its own progress UI.
    rc = subprocess.call(cmd, cwd=REPO_ROOT)
    if rc != 0:
        fail(f"build exited with code {rc}")
        return False
    ok("all images built")
    return True


# --- Step 5: clear ALL sentient containers ----------------------------------
#
# Two populations live side-by-side:
#   1. The compose-managed gateway (sentient-gateway) — owned by docker compose.
#   2. Orchestrator-managed siblings (label=sentient.managed=true) — owned by
#      the gateway's dockerode driver, invisible to compose.
#
# Leaving the gateway up across rebuilds is the trap: it keeps the old image,
# carries stale in-memory wizard state, and never picks up new code. We
# `compose down` the gateway and `docker rm -f` the labeled siblings, so the
# next `compose up` starts genuinely fresh.


def list_managed_sibling_containers() -> list[str]:
    try:
        out = run(
            ["docker", "ps", "-a", "--filter", "label=sentient.managed=true",
             "--format", "{{.Names}}"]
        ).stdout.strip()
    except subprocess.CalledProcessError:
        return []
    return [n for n in out.splitlines() if n]


def gateway_container_present() -> bool:
    try:
        out = run(
            ["docker", "ps", "-a", "--filter", "name=^sentient-gateway$",
             "--format", "{{.Names}}"]
        ).stdout.strip()
    except subprocess.CalledProcessError:
        return False
    return bool(out)


def clear_old_containers() -> bool:
    siblings = list_managed_sibling_containers()
    has_gateway = gateway_container_present()

    if not siblings and not has_gateway:
        ok("no sentient containers present — nothing to clear")
        return True

    print("  Found existing sentient container(s):")
    if has_gateway:
        print("    - sentient-gateway (compose)")
    for name in siblings:
        print(f"    - {name} (orchestrator)")
    print(
        "\n  Leaving the gateway up across a rebuild is the most common\n"
        "  cause of 'why didn't my changes take effect' — it keeps the old\n"
        "  image and stale in-memory state. Removing all of them now lets\n"
        "  the next `compose up` start fresh against the new images."
    )
    if not confirm("Stop and remove?"):
        warn("Skipped container cleanup. Stale containers may keep running old images.")
        return True

    # Always rm by name, never by compose project — `docker compose down`
    # only matches containers tagged with the same compose project label, so
    # a gateway started from a different cwd (project name = parent dir of
    # cwd at start) is invisible to compose and silently survives.
    targets = (["sentient-gateway"] if has_gateway else []) + siblings
    for name in targets:
        try:
            run(["docker", "rm", "-f", name])
            ok(f"removed {name}")
        except subprocess.CalledProcessError as e:
            warn(f"could not remove {name}: {e.stderr.strip()}")

    # Migrate older deploys: the supervisor state used to live in a docker
    # named volume (`sentient-supervisor`). It now lives at
    # ~/.sentient/supervisor/ so a single `rm -rf ~/.sentient` is enough to
    # reset everything. Drop the legacy volume if it's still around — leaving
    # it would shadow the bind mount on next compose up.
    try:
        out = run(["docker", "volume", "ls", "--filter", "name=^sentient-supervisor$",
                   "--format", "{{.Name}}"]).stdout.strip()
        if out:
            run(["docker", "volume", "rm", "sentient-supervisor"])
            ok("removed legacy sentient-supervisor volume")
    except subprocess.CalledProcessError as e:
        warn(f"could not remove legacy sentient-supervisor volume: {e.stderr.strip()}")
    return True


# --- Optional: TLS cert symlink ---------------------------------------------


def configure_tls_cert() -> bool:
    """Optional: symlink an existing TLS cert into ~/.sentient/certs/.

    Lets the gateway serve a real cert (e.g. a Let's Encrypt cert that
    another container on the host already manages) instead of the
    self-signed default. Idempotent — pressing Enter at the prompt leaves
    whatever is already in ~/.sentient/certs/ untouched.

    Skipped automatically when stdin is not a TTY (e.g. piped `yes |
    setup-prod.py`), so automation paths still work.
    """
    if not sys.stdin.isatty():
        ok("non-interactive — skipping cert step (default: self-signed)")
        return True

    current = current_cert_state()
    if current is not None:
        info_lines = "\n".join(f"  {DIM}{line}{RESET}" for line in current)
        print(f"\n  Current cert state:\n{info_lines}")
    print(
        "\n  The gateway serves TLS on :8888. Default = self-signed cert\n"
        "  generated at boot (one browser warning per device). If you\n"
        "  already manage a real cert on this host (e.g. for another\n"
        "  service), point the gateway at it via symlink. The symlink\n"
        "  follows in-place renewals; the gateway picks up new certs at\n"
        "  next image rebuild (no restart hook is added)."
    )
    raw = input(
        "\n  Existing cert dir? Path containing `fullchain.pem` + `key.pem`,\n"
        "  blank to keep current state: "
    ).strip()
    if not raw:
        ok("keeping current cert state")
        return True

    cert_dir = Path(raw).expanduser().resolve()
    fullchain = cert_dir / "fullchain.pem"
    key = cert_dir / "key.pem"
    if not fullchain.is_file():
        fail(f"{fullchain} not found")
        return False
    if not key.is_file():
        fail(f"{key} not found")
        return False
    if not os.access(fullchain, os.R_OK):
        fail(f"{fullchain} not readable by the current user")
        return False
    # key.pem is typically 0600 owned by the cert manager (root or a
    # dedicated user). Skip the host-side R_OK check — the gateway
    # container runs as root and reads the bind-mounted file regardless
    # of host-side perms. Caller can `sudo cat` if they want to verify.

    SENTIENT_CERT_DIR.mkdir(parents=True, exist_ok=True)
    cert_link = SENTIENT_CERT_DIR / "cert.pem"
    key_link = SENTIENT_CERT_DIR / "key.pem"

    for link, target in ((cert_link, fullchain), (key_link, key)):
        if link.is_symlink():
            link.unlink()
        elif link.exists():
            # A regular file at this path is the gateway's previously-
            # generated self-signed cert. Replace it without prompting —
            # the operator just answered the prompt to switch certs.
            link.unlink()
        link.symlink_to(target)
        ok(f"linked {link.name} → {target}")

    # Tell compose to bind-mount the cert dir at the same path inside the
    # container so the symlinks above resolve. Without this the container
    # sees a dangling symlink, the gateway treats the cert as missing, and
    # boot falls back to self-signed generation against a read-only mount
    # (which then errors on key.pem write). See the volumes block in
    # the deploy compose's volumes block.
    upsert_env(ENV_FILE, "HOST_CERT_DIR", str(cert_dir))
    ok(f"wrote HOST_CERT_DIR={cert_dir} to {ENV_FILE.relative_to(REPO_ROOT)}")
    return True


def upsert_env(env_path: Path, key: str, value: str) -> None:
    """Set `KEY=VALUE` in a dotenv file, replacing any existing assignment.

    Comments and unrelated lines are preserved. The file is created if it
    doesn't exist.
    """
    lines: list[str] = []
    if env_path.is_file():
        lines = env_path.read_text().splitlines()
    out: list[str] = []
    found = False
    for line in lines:
        if line.startswith(f"{key}="):
            out.append(f"{key}={value}")
            found = True
        else:
            out.append(line)
    if not found:
        out.append(f"{key}={value}")
    env_path.write_text("\n".join(out) + "\n")


def current_cert_state() -> Optional[list[str]]:
    """Summarize what's in ~/.sentient/certs/ for the prompt header."""
    cert_link = SENTIENT_CERT_DIR / "cert.pem"
    key_link = SENTIENT_CERT_DIR / "key.pem"
    if not cert_link.exists() and not key_link.exists():
        return ["~/.sentient/certs/ empty — gateway will self-sign on next boot"]
    lines: list[str] = []
    for link in (cert_link, key_link):
        if not link.exists() and not link.is_symlink():
            lines.append(f"{link.name}: missing")
        elif link.is_symlink():
            lines.append(f"{link.name} → {link.resolve()}")
        else:
            lines.append(f"{link.name}: regular file (likely self-signed)")
    return lines


# --- Final guidance ----------------------------------------------------------


def print_next_steps(backend: Optional[str]) -> None:
    stt_note = ""
    if backend == NATIVE_BACKEND:
        stt_note = (
            f"\n  STT backend is {BOLD}native-whisper{RESET} — verify the host "
            f"service is up before the gateway dials it:\n\n"
            f"    {DIM}bash {WHISPER_LAUNCHER.relative_to(REPO_ROOT)} status{RESET}\n"
        )
    elif backend == DOCKER_BACKEND:
        stt_note = (
            f"\n  STT backend is {BOLD}docker-sensevoice{RESET} — the orchestrator "
            f"spawns sentient-stt-service from the built image at `compose up`.\n"
        )
    tts_note = ""
    if CHATTERBOX_LAUNCHER.exists():
        tts_note = (
            f"\n  TTS is {BOLD}native Chatterbox-TTS{RESET} (Apple-silicon MLX) — "
            f"verify the host service is up before the gateway dials it:\n\n"
            f"    {DIM}bash {CHATTERBOX_LAUNCHER.relative_to(REPO_ROOT)} status{RESET}\n"
        )
    print(
        f"\n{BOLD}Setup complete.{RESET} Bring the stack up when you're ready:\n\n"
        f"    {GREEN}docker compose -f {COMPOSE_FILE.relative_to(REPO_ROOT)} "
        f"up -d{RESET}\n"
        f"{stt_note}"
        f"{tts_note}\n"
        f"  All persistent state lives at {DIM}~/.sentient/{RESET} — "
        f"`rm -rf ~/.sentient` is the only wipe needed for a fresh start.\n\n"
        "  Then open the wizard:\n\n"
        f"    {GREEN}https://localhost:8888{RESET}    "
        f"{DIM}(or https://<host>:8888 from another device){RESET}\n\n"
        "  Tail logs:\n\n"
        f"    {DIM}docker compose -f {COMPOSE_FILE.relative_to(REPO_ROOT)} "
        f"logs -f gateway{RESET}\n"
    )


def main() -> int:
    print(f"{BOLD}Sentient — production setup{RESET}  {DIM}(deploy/{DEPLOY_NAME}){RESET}\n")

    if not COMPOSE_FILE.exists():
        fail(f"no compose at {COMPOSE_FILE.relative_to(REPO_ROOT)} — check the deploy-dir arg")
        return 1

    info("Checking docker access")
    if not check_docker_cli():
        return 1

    info("Checking hermes host user")
    if not check_hermes_user():
        return 1

    info(f"Checking {ENV_FILE.relative_to(REPO_ROOT)}")
    if not check_env():
        return 1

    # STT backend reconcile only applies to deploys that ship the selector
    # (mac-prod: deploy.conf + native/). Generic targets (e.g. deploy/docker)
    # have no deploy.conf — skip the reconcile and fall back to legacy behavior
    # (build the full image set incl. SenseVoice, no config patch).
    backend: Optional[str] = None
    if DEPLOY_CONF.exists():
        info(f"Reading STT backend from {DEPLOY_CONF.relative_to(REPO_ROOT)}")
        backend = read_backend()
        if backend is None:  # present but invalid — fail loudly
            return 1
    else:
        ok(f"no {DEPLOY_CONF.relative_to(REPO_ROOT)} — STT backend reconcile skipped")

    info("Configuring TLS cert (optional)")
    if not configure_tls_cert():
        return 1

    if backend is not None:
        info("Seeding mounted gateway config (if absent)")
        if not seed_config_if_absent():
            return 1

        info(f"Reconciling gateway config → {backend}")
        ruamel_python = ensure_ruamel_python()
        if ruamel_python is None:
            return 1
        if not apply_stt_backend(backend, ruamel_python):
            return 1

        # TTS is native-only (no selector); canonicalize its endpoint whenever
        # the deploy ships the native TTS pieces (mac-prod). Reuses the ruamel
        # interpreter resolved above.
        if TTS_BACKEND_SCRIPT.exists():
            info("Reconciling gateway config → native Chatterbox-TTS")
            if not apply_tts_backend(ruamel_python):
                return 1

    info("Building images")
    if not build_images(backend):
        return 1

    if backend is not None:
        info(f"Configuring native Whisper-STT service ({backend})")
        if not configure_native_stt(backend):
            return 1

        # TTS is native-only — install/start the Chatterbox-TTS launchd service
        # whenever the deploy ships its launcher (mac-prod).
        if CHATTERBOX_LAUNCHER.exists():
            info("Configuring native Chatterbox-TTS service")
            if not configure_native_tts():
                return 1

    info("Clearing old sentient containers (gateway + orchestrator-managed)")
    if not clear_old_containers():
        return 1

    print_next_steps(backend)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nAborted.", file=sys.stderr)
        sys.exit(130)
