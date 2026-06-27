#!/usr/bin/env python3
"""
Sentient — production setup helper.

Walks the operator through the manual host steps (docker access, hermes
host user, .env), then offers to build all images locally and clear out
old orchestrator-managed containers. Stops short of `docker compose up`
on purpose — the operator decides when to bring services online.

Idempotent: re-run any time after `git pull` to refresh images. Existing
state (~/.sentient/, secrets, gateway-data) is never touched.

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


# --- Step 4: build images ----------------------------------------------------


def build_images() -> bool:
    if not confirm(
        "Build all sibling images now? (gateway, stt-service, hermes, ma-mcp, searxng-mcp, fetch-mcp)"
    ):
        info("Skipped image build — run later with:")
        print(
            f"    {DIM}docker compose -f {COMPOSE_FILE.relative_to(REPO_ROOT)} "
            f"--profile build-only build{RESET}"
        )
        return True

    info("Building images. First run takes ~10-20 min (STT + Hermes images bake).")
    # Explicit working set — skip signal-cli (optional Signal bridge): its
    # upstream Dockerfile currently fails on a libsignal-client jar version
    # mismatch and it's not part of the core voice/chat path. Add it back here
    # once that pin is fixed.
    cmd = [
        "docker", "compose", "-f", str(COMPOSE_FILE),
        "--profile", "build-only", "build",
        "gateway", "stt-service", "hermes", "ma-mcp", "searxng-mcp", "fetch-mcp",
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


def print_next_steps() -> None:
    print(
        f"\n{BOLD}Setup complete.{RESET} Bring the stack up when you're ready:\n\n"
        f"    {GREEN}docker compose -f {COMPOSE_FILE.relative_to(REPO_ROOT)} "
        f"up -d{RESET}\n\n"
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

    info("Configuring TLS cert (optional)")
    if not configure_tls_cert():
        return 1

    info("Building images")
    if not build_images():
        return 1

    info("Clearing old sentient containers (gateway + orchestrator-managed)")
    if not clear_old_containers():
        return 1

    print_next_steps()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nAborted.", file=sys.stderr)
        sys.exit(130)
