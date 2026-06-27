# Sentient — deploy

The gateway runs in Docker and spawns its sibling services
(`sentient-hermes` per user, `stt-service`, `egress-proxy`, MCP sidecars)
on demand via the host docker socket. **All provider keys, voice IDs,
and admin secrets are entered through the webui setup wizard** on first
launch — there is nothing to configure on disk beyond `HOST_DOCKER_GID`.

Three compose files:

| File | Purpose |
|------|---------|
| `deploy/mac-prod/docker-compose.yml` | **Production** — macOS Docker Desktop (Apple-silicon Mac mini). Builds all images locally; release profile. The supported deploy path. |
| `deploy/macos/docker-compose.yml` | Local dev on macOS Docker Desktop — debug build. Uses a docker named volume for the supervisord socket (virtiofs rejects AF_UNIX `bind()`). |
| `deploy/docker/docker-compose.yml` | Local dev on Linux — bind-mounts everything under `~/.sentient/`. |

## Why macOS for production

Production moved from a Raspberry Pi 5 to an Apple-silicon **Mac mini**.
The Pi couldn't give the speech/agent stack enough headroom; the Mac's
unified memory + Neural Engine do. The drivers were:

- **Faster agent loop** (Hermes round-trips).
- **Local Whisper-large STT** running on-device.
- **Large local TTS models** with real headroom.

You are not locked into all-on-one. The architecture still supports a
**split**: run the lightweight **gateway on a Pi** (or any small box) and
point its orchestrator at **sibling services hosted on a more powerful
machine**. The `mac-prod` folder just targets the common case — everything
on one macOS host. (The retired `deploy/pi/` all-on-Pi compose was removed;
recover it from git history if you want the old single-Pi layout as a
starting point.)

---

## Production install (macOS)

The Mac clones the repo and builds images locally. No private registry,
no CI dependency.

### 1. Host setup

Install Docker Desktop (no Apple ID / App Store needed):

```bash
brew install --cask docker
open -a Docker            # accept terms on first launch
```

Enable **Settings → General → "Start Docker Desktop when you sign in"** and
set up **auto-login** so the daemon comes back after an unattended reboot.
(Full headless 24×7 host setup — power/no-sleep, firewall, stable MAC,
auto security updates — lives in your ops runbook, not here.)

The hermes uid=10000 host user is **not** required on macOS — Docker
Desktop's VM handles bind-mount ownership internally.

### 2. Clone + run the setup helper

```bash
git clone <repo-url> ~/sentient
cd ~/sentient
python3 deploy/setup-prod.py
```

`setup-prod.py` is the install/update helper: it verifies docker, auto-detects
and writes `HOST_DOCKER_GID` into `deploy/mac-prod/.env`, builds the images, and
clears stale containers — then stops short of `up` so you choose when to go
live. **Re-run it any time after `git pull`** to refresh. Targets
`deploy/mac-prod` by default; pass a name (e.g. `python3 deploy/setup-prod.py docker`)
to target another deploy dir.

<details><summary>Manual equivalent (if you skip the script)</summary>

```bash
cp deploy/mac-prod/.env.example deploy/mac-prod/.env
# HOST_DOCKER_GID = GID inside the Docker Desktop VM:
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock alpine stat -c '%g' /var/run/docker.sock
docker compose -f deploy/mac-prod/docker-compose.yml --profile build-only build \
  gateway stt-service hermes ma-mcp searxng-mcp fetch-mcp
```
</details>

### 3. Bring it up

```bash
docker compose -f deploy/mac-prod/docker-compose.yml up -d
docker compose -f deploy/mac-prod/docker-compose.yml logs -f gateway
```

### 4. First launch

Open `https://sentient.dev32.io` (port 443) or `https://<host>:8888`. The
setup wizard walks through:

- Admin password / PIN
- LLM provider + key (Ollama Cloud — direct API to ollama.com — or
  OpenRouter, or Custom for a local LAN ollama daemon)
- TTS provider + voice (Fish Audio)
- Optional MCPs (Home Assistant, Music Assistant)

Once finished, the gateway spawns the per-user Hermes worker and is
ready for voice traffic.

User accounts, secrets, profiles, **and the Hermes "brain"**
(`~/.sentient/hermes/data`) all live under `~/.sentient/` outside the
container — migrate or back up the whole assistant with one `rsync` of
`~/.sentient/`. (The TLS cert at `~/.data/certs/` is the one intentional
exception — externally managed by `acme.sh`.)

---

## Updates

```bash
cd ~/sentient
git pull
python3 deploy/setup-prod.py          # rebuild images + clear stale containers
docker compose -f deploy/mac-prod/docker-compose.yml up -d
```

State in `~/.sentient/` persists across image bumps.

### Upgrade note — gateway 1.11.1 migrates `session.*` config automatically

Gateway **1.11.1** (activity-idle watchdog) changes the `session:` block: it
**adds** two REQUIRED keys (`per_user_max_sessions`, `idle_timeout_ms`) and
**removes** the now-dead `retention_ttl_ms` (plus `session_persist_ms`,
`inactivity_*`, `hermes.defaults.request_timeout_ms` / `idempotency_window_s`,
and `hermes.resource_management`).

**No manual edit needed.** A version-anchored migrator runs at boot
(`operator-config-migrator`): a pre-existing operator config at
`schema_version: "0.1.0"` is rewritten in place to `"0.1.1"` — the new required
keys are backfilled (`per_user_max_sessions: 40`, `idle_timeout_ms: 900000`) and
the dead keys are stripped, so it passes schema validation and the gateway
starts. The migration is idempotent (no-op once at 0.1.1). Your other operator
values are preserved.

> History: gateway **1.11.0** (WS resilience) added `ws_idle_timeout_ms`,
> `retention_ttl_ms`, `replay_buffer_max_bytes` and required a manual edit.
> 1.11.1 supersedes that note — the migrator now handles both the 1.11.0 and
> 1.11.1 deltas in one pass. `ws_idle_timeout_ms` and `replay_buffer_max_bytes`
> stay; `retention_ttl_ms` is replaced by the activity-based `idle_timeout_ms`.

---

## Reaching host services from the gateway container

The gateway runs in docker; ollama-on-host (Custom provider tab),
Home Assistant, Music Assistant, and any other LAN service does not.
**The wizard's URL fields take the host's LAN IP directly** — e.g.
`http://192.168.0.240:11434/v1` for an ollama daemon on the host itself.

Find the host's LAN IP (macOS):

```bash
ipconfig getifaddr en0     # ethernet (or en1 for Wi-Fi)
```

### One gotcha — local Ollama daemon binding

Skip this if you're using **Ollama Cloud** (direct API at
`https://ollama.com/v1`). It only matters for the **Custom** tab with a
local ollama daemon.

Ollama's default install binds `127.0.0.1` only. Containers can't reach
loopback-bound services on the host. Override the bind to `0.0.0.0:11434`
(on macOS: Ollama app → Settings → "Expose to network", or set
`OLLAMA_HOST=0.0.0.0:11434`), then restart ollama. Confirm it's no longer
loopback-only before pointing the wizard at the host LAN IP.

---

## Local dev — Linux

```bash
cd deploy/docker
cp .env.example .env       # set HOST_DOCKER_GID
docker compose build
docker compose up -d
```

Wizard URL: `https://localhost:8888`.

## Local dev — macOS

Docker Desktop's virtiofs bind-mounts can't host an AF_UNIX socket
(supervisord's `unix_http_server` fails with errno 22 on first boot),
so the macOS compose backs `/data/supervisor` with a docker named
volume instead of a bind under `~/.sentient/`. Everything else still
bind-mounts under `~/.sentient/`.

```bash
cd deploy/macos
cp .env.example .env       # set HOST_DOCKER_GID
docker compose build
docker compose up -d
```

Wizard URL: `https://localhost:8888`.

`HOST_DOCKER_GID` on macOS is the GID inside the Docker Desktop VM,
not the host. Detect with:

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  alpine stat -c '%g' /var/run/docker.sock
```

### macOS wipe

```bash
docker compose -f deploy/macos/docker-compose.yml down   # or mac-prod
rm -rf ~/.sentient/                       # bind-mounted state (incl. hermes brain)
docker volume rm sentient-supervisor      # supervisord socket + programs
```
