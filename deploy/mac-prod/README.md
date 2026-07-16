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

Only the **gateway** is a long-running compose service. `hermes`, the MCPs
and `signal-cli` are `build-only` — the gateway's orchestrator
creates/starts/recreates them at runtime over `/var/run/docker.sock`. Compose
only builds their images. `stt-service` (SenseVoice) is gated behind the
`stt-docker` profile: built/managed **only** when the docker-sensevoice STT
backend is selected (see [STT backend](#stt-backend-deployconf)).

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

## STT backend (`deploy.conf`)

`deploy/mac-prod/deploy.conf` is the single source of truth for which STT
service the gateway dials. `setup-prod.py` reads it and reconciles the three
parts that must agree:

| `STT_BACKEND` | STT service | gateway config | compose |
|---------------|-------------|----------------|---------|
| `native-whisper` (default) | host MLX Whisper on `:8768`, launchd (`native/whisper-stt.sh`) | `stt.url` → `host.docker.internal:8768`; `managed_services.stt-service` removed | SenseVoice image **not** built |
| `docker-sensevoice` | orchestrator-managed SenseVoice container on `:8766` | `stt.url` → `sentient-stt-service:8766`; `managed_services.stt-service` present | SenseVoice built via `--profile stt-docker` |

Switching backend = edit `STT_BACKEND` in `deploy.conf`, re-run
`setup-prod.py`, `compose up`. The run is idempotent — it installs a fresh
host or **migrates** an existing stack between backends (patches the config in
place, installs/stops the native service, and clears the old STT container as
part of the normal container reset).

The default is **native-whisper**, matching the `deploy/macos/` dev stack.

## First boot / migrate

```bash
cp deploy/mac-prod/.env.example deploy/mac-prod/.env
# set HOST_DOCKER_GID — detect with:
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock alpine stat -c '%g' /var/run/docker.sock

# Reconcile STT backend (deploy.conf), build images, clear stale containers.
# Idempotent — same command installs a new host or migrates an existing one.
python3 deploy/setup-prod.py

docker compose -f deploy/mac-prod/docker-compose.yml up -d
```
Then visit `https://sentient.dev32.io:8888` — the wizard handles secrets,
voice, and MCP setup. For `native-whisper`, verify the host service first with
`bash deploy/mac-prod/native/whisper-stt.sh status`.

## Migrating an existing Chatterbox-TTS host to local-tts

The TTS service was renamed `chatterbox-tts` → `local-tts` and its engine
swapped from Chatterbox to Qwen3-TTS. A host that was set up before this
change (launchd label `io.dev32.sentient.chatterbox-tts`, data dir
`~/.sentient/chatterbox-tts`) needs a one-time migration — `setup-prod.py`
does not do this automatically, since it never deletes or renames existing
host state. Run these steps **on the Mac mini** once, before re-running
`setup-prod.py`:

```bash
# stop + remove the old agent
launchctl bootout gui/$(id -u)/io.dev32.sentient.chatterbox-tts 2>/dev/null || launchctl unload ~/Library/LaunchAgents/io.dev32.sentient.chatterbox-tts.plist
rm -f ~/Library/LaunchAgents/io.dev32.sentient.chatterbox-tts.plist

# migrate data dir (config + user voices + logs)
mv ~/.sentient/chatterbox-tts ~/.sentient/local-tts

# update the migrated config to the qwen engine
#   model: mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit
#   add: default_lang: "auto"   ;  remove: exaggeration, cfg_weight

# reinstall + start under the new label
bash deploy/mac-prod/native/local-tts.sh install
bash deploy/mac-prod/native/local-tts.sh start
bash deploy/mac-prod/native/local-tts.sh status   # expect :8771/health OK
```

User-created voice packs under `voices/` are moved with the data dir, but
any pack that was cloned under the **old Chatterbox** engine holds a
`conds.safetensors` (no `ref.wav`), which Qwen cannot use — those packs
silently resolve to the default voice at synth time (`voice_store.get`
logs `fallback=default reason=unknown_voice`; the service never errors on
them) and must be **re-cloned** to sound like themselves again. Packs
cloned after the swap are already `ref.wav`-format and carry over as-is.
The built-in voice packs ship with the service itself, so nothing to copy
there. Once the agent is loaded and healthy, re-run
`python3 deploy/setup-prod.py` as usual to reconcile the gateway config's
`tts.url` / `companions.tts_health_url`.

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
