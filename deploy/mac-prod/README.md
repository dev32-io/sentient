# Sentient — macOS production deploy (`mac-prod`)

The production deploy target: gateway + all sibling services on a single
Apple-silicon Mac. **This replaces the retired Raspberry Pi deploy** — see
[Why macOS](#why-macos).

## Why macOS

The Pi 5 couldn't give local speech models enough headroom. Running the
heavy pieces — **a faster agent loop, local Whisper-large STT, and large
local TTS models** — needs an Apple-silicon box with unified memory and the
Neural Engine. So the canonical production target moved from the Pi to a Mac
mini.

You are **not** forced into all-on-one. The architecture still supports a
split: run the lightweight **gateway on a Pi** (or any small box) and point
its orchestrator at **sibling services hosted on a more powerful machine**.
This folder simply targets the common case: everything on one macOS host.

## Layout

Only the **gateway** is a long-running compose service. `hermes`,
`stt-service`, the MCPs and `signal-cli` are `build-only` — the gateway's
orchestrator creates/starts/recreates them at runtime over
`/var/run/docker.sock`. Compose only builds their images.

### State lives under `~/.sentient/`
Every piece of persistent state — gateway data, profiles, secrets, and the
**Hermes "brain"** (`~/.sentient/hermes/data`: chat sessions, memories,
`SOUL.md`, skills) — is bind-mounted under `~/.sentient/`. Migrating or
backing up the whole assistant is a single `rsync` of `~/.sentient/`.

Two deliberate exceptions, both non-state:
- **`/data/supervisor`** is a named docker volume (`sentient-supervisor`),
  not a bind. Docker Desktop's virtiofs rejects the supervisord AF_UNIX
  socket `bind()`; a named volume (ext4 in the VM) fixes it. Runtime only.
- **TLS cert** at `~/.data/certs/sentient.dev32.io/` — externally managed by
  `acme.sh` (DNS-01 via Route53) on the LAN, renewed + rsynced in. Infra,
  re-derivable on renewal, not app state.

## First boot

```bash
cp deploy/mac-prod/.env.example deploy/mac-prod/.env
# set HOST_DOCKER_GID — detect with:
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock alpine stat -c '%g' /var/run/docker.sock

# build sibling images, then the gateway
docker compose -f deploy/mac-prod/docker-compose.yml --profile build-only build
docker compose -f deploy/mac-prod/docker-compose.yml build gateway

docker compose -f deploy/mac-prod/docker-compose.yml up -d
```
Then visit `https://sentient.dev32.io:8888` — the wizard handles secrets,
voice, and MCP setup.

## Headless 24×7 host notes

The Mac mini runs headless. Required host setup (auto-login so Docker Desktop
starts after reboot, power/no-sleep, firewall, stable MAC, etc.) is out of
scope for this compose — keep it in your ops runbook.

## Ownership / uid

The hermes container runs as uid:gid **10000** (`USER hermes`). On Linux the
bind-mount host dirs must be chowned to 10000 (the gateway does this via
`admin/chown-hermes.ts`, overridable with `SENTIENT_HERMES_UID`/`_GID`). On
macOS Docker Desktop, virtiofs remaps bind-mount ownership, so the container
reads/writes regardless of host ownership.

## Dev vs prod

- `deploy/mac-prod/` — this folder, release build (`BUILD_PROFILE=release`).
- `deploy/macos/` — local Docker Desktop **dev** (debug build).
