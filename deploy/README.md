# Sentient — deploy

The gateway itself is a **compiled native binary supervised by `launchd`** —
not a Docker container. It is the host orchestrator: it creates, starts,
health-checks and recreates every sibling addon itself, over the host docker
socket for docker addons (MCP tool servers, searxng,
egress-proxy/ingress-proxy) and via `Bun.spawn` for native addons
(whisper-stt, local-tts). Hermes is never a managed service — it's a one-shot
exec invoked only via `delegateTask`. **All provider keys, voice IDs, and
admin secrets are entered through the webui setup wizard** on first launch —
there is nothing to configure on disk.

One compose file. It has no long-running gateway service — its whole job is
baking the `:local` image tags the gateway's orchestrator creates addon
containers from:

| File | Purpose |
|------|---------|
| `deploy/mac-prod/docker-compose.yml` | Addon image bakery — macOS Docker Desktop (Apple-silicon). The one image list, used by prod AND local dev (`--profile build-only build`). |

`deploy/macos/` (a second, local-dev-only bakery) was **removed** with the
signal-cli removal: `signal-cli` was the only service it built, and
`deploy/mac-prod/`'s `build-only` profile was already the complete superset of
the same images.

`deploy/docker/` (local dev on Linux) was **removed** with the native cutover.
It was a single-service compose that ran the gateway itself from
`gateway/Dockerfile`, and the gateway is a native launchd-supervised binary now —
that Dockerfile, the supervisord/per-user-hermes env it wired up, and the
containerised `stt-service` are all gone. Linux is not a target either way: two
`optional: false` services (`whisper-stt`, `local-tts`) run natively on
Metal/MLX, which is Apple-silicon only. Recover it from git history if you want
the old containerised-gateway layout as a starting point (same as the retired
`deploy/pi/` compose).

## Why macOS for production

Production moved from a Raspberry Pi 5 to an Apple-silicon **Mac mini**.
The Pi couldn't give the speech/agent stack enough headroom; the Mac's
unified memory + Neural Engine do. The drivers were:

- **Faster agent loop** (Hermes round-trips).
- **Local Whisper-large STT** running on-device.
- **Large local TTS models** with real headroom.

A **gateway-on-a-Pi split is no longer possible** now that the gateway is the
native host process: whisper-stt and local-tts are `Bun.spawn`ed as local
child processes of the gateway itself, not remote-capable, and both are
Apple-silicon-only (Metal/MLX). Whatever host runs the gateway also runs
native STT/TTS — that host must be Apple silicon. The docker-based addons
(MCPs, searxng) remain plain containers and could in principle
point at a remote docker host, but the gateway + native addons cannot be
split off the mini. `deploy/mac-prod/` targets the only supported shape —
everything on one macOS host. (The retired `deploy/pi/` all-on-Pi compose was
removed; recover it from git history if you want the old single-Pi layout as
a historical reference — it predates the native-stack migration and does not
reflect the current addon model.)

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

### 2. Bake the addon images

```bash
git clone <repo-url> ~/sentient
cd ~/sentient
docker compose -f deploy/mac-prod/docker-compose.yml --profile build-only build
```

Produces the `:local` image tags for `ma-mcp`, `fetch-mcp`, `searxng-mcp` and
`ingress-proxy` — the gateway's orchestrator creates
containers from these at startup; `up`/`down` are never used here. `ha-mcp`
is a third-party image (`ghcr.io/homeassistant-ai/ha-mcp:stable`), pulled by
the orchestrator directly, not built. **Re-run the build any time after
`git pull`** to refresh.

### 3. Build and install the gateway binary

```bash
./scripts/build-gateway.sh --release
sudo python3 deploy/mac-prod/setup-prod.py install dist/gateway/<version>.tar.gz
```

`setup-prod.py install` is the native installer: it verifies the tarball
checksum, unpacks to `/opt/sentient/<version>/` (root:wheel, immutable),
builds the `whisper-stt`/`local-tts` venvs **offline** from vendored wheels,
flips the `current` symlink, installs/kickstarts the
`io.sentient.gateway` LaunchDaemon, and **health-gates the result over
verified TLS — auto-rolling back to the previous release if the new one does
not come up**. Idempotent; re-running with an already-current, healthy
version is a no-op. See `deploy/mac-prod/README.md` for the full installer
contract (rollback, offline-install proof, first-real-run checklist).

### 4. First launch

Open `https://sentient.dev32.io` (port 443) or `https://<host>:8888`. The
setup wizard walks through:

- Admin password / PIN
- LLM provider + key (Ollama Cloud — direct API to ollama.com — or
  OpenRouter, or Custom for a local LAN or on-host ollama daemon)
- Voice step (acknowledge-and-advance — local-tts needs no key)
- Optional MCPs (Home Assistant, Music Assistant)

Once finished, the gateway is ready for voice traffic. Hermes is never a
standing worker — it runs as a one-shot process only when the agent
delegates a task (`delegateTask`), invoked and exited per call.

User accounts, secrets, profiles, **and the Hermes "brain"**
(`~/.sentient/hermes/data`) all live under `~/.sentient/`, user-owned and
mutable — migrate or back up the whole assistant with one `rsync` of
`~/.sentient/`. Code is root-owned and immutable under `/opt/sentient/`. (The
TLS cert at `~/.data/certs/` is the one intentional exception to the state
path — externally managed by `acme.sh`.)

---

## Updates

```bash
cd ~/sentient
git pull
docker compose -f deploy/mac-prod/docker-compose.yml --profile build-only build   # refresh addon images
./scripts/build-gateway.sh --release
sudo python3 deploy/mac-prod/setup-prod.py install dist/gateway/<version>.tar.gz
```

State in `~/.sentient/` persists across upgrades. A release that fails its
health gate is rolled back automatically — the mini is never left on a
broken version.

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

## Reaching LAN devices from docker addons

The gateway itself is a **native host process** now, so it reaches a local
ollama daemon (Custom provider tab) the same way any Mac app does —
`http://127.0.0.1:11434/v1` works directly. There is no container-to-host hop
any more: Ollama's historical `127.0.0.1`-only-bind gotcha no longer applies
to the gateway's own LLM provider dial, and no `OLLAMA_HOST=0.0.0.0` override
or LAN-IP workaround is needed for it.

The docker addons that reach out to genuinely separate LAN devices — `ha-mcp`
→ Home Assistant, `ma-mcp` → Music Assistant — are still containers, so
**their** targets need real LAN reachability:

- **The wizard's HA/MA URL fields take the device's LAN IP or hostname
  directly** — these are other boxes on the network, not the gateway host.
- Docker has no mDNS resolver, so a `.local` hostname (`homeassistant.local`)
  needs a static `extra_hosts:` map — see
  `.claude/rules/gateway/mcp-deployment.md`.

Find the mini's own LAN IP if a LAN device needs to reach back to it:

```bash
ipconfig getifaddr en0     # ethernet (or en1 for Wi-Fi)
```

---

## Local dev — macOS

Two independent pieces: bake the addon images once, then run the gateway
natively with hot reload — no build step for the gateway itself.

```bash
# Addon images (one list, shared with prod — there is no dev-only bakery):
docker compose -f deploy/mac-prod/docker-compose.yml --profile build-only build

# Gateway, from the checkout:
source scripts/env.sh
cd gateway && bun --hot src/main.ts
```

The native driver launches whisper-stt/local-tts from repo-local venvs; the
orchestrator creates the addon containers from the images baked above on
first boot. Wizard URL: `https://localhost:8888`.

### macOS dev wipe

```bash
rm -rf ~/.sentient/     # gateway config/logs/data/certs (incl. the Hermes brain)
docker ps -a --filter "name=sentient-" --format "{{.Names}}" | xargs -r docker rm -f
```

The gateway's orchestrator creates addon containers directly (not via
`docker compose up`), so there is no compose stack to `down` — remove them by
name instead. Restarting the gateway after a wipe recreates them fresh.
