# Sentient — deploy

The gateway runs in Docker and spawns its sibling services
(`sentient-hermes` per user, `stt-service`, `egress-proxy`, MCP sidecars)
on demand via the host docker socket. **All provider keys, voice IDs,
and admin secrets are entered through the webui setup wizard** on first
launch — there is nothing to configure on disk beyond `HOST_DOCKER_GID`,
which `setup-prod.py` autodetects.

Three compose files:

| File | Purpose |
|------|---------|
| `deploy/macos/docker-compose.yml` | Local dev on macOS Docker Desktop — uses a docker named volume for the supervisord socket because virtiofs bind-mounts reject AF_UNIX bind(). See header in that file. |
| `deploy/docker/docker-compose.yml` | Local dev on Linux — bind-mounts everything under `~/.sentient/`. |
| `deploy/pi/docker-compose.yml`     | Pi / production — builds **all** images locally (gateway + sibling services) from this checkout. No registry needed. |

The Pi flow is the supported deploy path. The dev flows are for working
on the gateway itself.

---

## Pi install

The Pi clones the repo and builds images locally. No private registry,
no CI dependency.

### 1. One-time host setup

```bash
# Install docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# Hermes host user — uid=10000 must match the in-container uid so
# bind-mounted per-user files have stable ownership across recreates.
sudo groupadd -g 10000 hermes
sudo useradd  -u 10000 -g hermes -M -s /usr/sbin/nologin hermes
sudo usermod -aG docker hermes
```

### 2. Clone

```bash
git clone https://lab.null32.com/kevin-ye/sentient.git ~/sentient
cd ~/sentient
```

### 3. Run setup-prod.py

```bash
python3 deploy/setup-prod.py
```

What it does:
1. Verifies docker is reachable
2. Verifies the `hermes` host user exists (Linux)
3. Writes `deploy/pi/.env` with the auto-detected `HOST_DOCKER_GID`
4. Asks if you want to build images now (`docker compose ... build`,
   live progress streamed)
5. Asks if you want to remove existing orchestrator-managed containers
   so the next start picks up the freshly-built images
6. Prints the `docker compose up` command — does **not** run it itself

This is idempotent. Run it again any time after `git pull` to refresh.

### 4. Bring it up

```bash
docker compose -f deploy/pi/docker-compose.yml up -d
docker compose -f deploy/pi/docker-compose.yml logs -f gateway
```

### 5. First launch

Open `https://<pi-ip>:8888` in a browser. Accept the self-signed cert
(one warning per device, persists). The setup wizard walks through:

- Admin password / PIN
- LLM provider + key (Ollama Cloud — direct API to ollama.com — or
  OpenRouter, or Custom for a local LAN ollama daemon)
- TTS provider + voice (Fish Audio)
- Optional MCPs (Home Assistant, Music Assistant)

Once finished, the gateway spawns the per-user Hermes worker and is
ready for voice traffic.

---

## Updates

```bash
cd ~/sentient
git pull
python3 deploy/setup-prod.py     # rebuild + clear old containers
docker compose -f deploy/pi/docker-compose.yml up -d
```

User accounts, secrets, and profiles persist across image bumps —
they live in `~/.sentient/` outside the container.

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
`http://192.168.0.240:11434/v1` for an ollama daemon on the Pi itself.

Find your Pi's LAN IP:

```bash
hostname -I | awk '{print $1}'
```

Why this works (and why it's not a router hop): the Pi's kernel sees
its own LAN IP as a local address, so traffic from the gateway
container to `192.168.0.240` short-circuits via the kernel's `local`
routing table. The packet never touches the home router. Same
mechanism for any other LAN device — just type its LAN address.

### One gotcha — local Ollama daemon binding

Skip this section if you're using **Ollama Cloud** (direct API at
`https://ollama.com/v1`). It only matters for the **Custom** tab when
you're running an ollama daemon on the Pi host.

Ollama's default install binds `127.0.0.1` only. Containers can't reach
loopback-bound services on the host, even with the right IP — the
kernel's socket lookup rejects packets whose dest IP doesn't match
the bind. Override with one systemd drop-in, then restart:

```bash
sudo systemctl edit ollama
```

Paste:

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
```

Save, then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
ss -tlnp | grep 11434     # confirm: 0.0.0.0:11434, not 127.0.0.1:11434
```

Other LAN services (HA, MA) already bind their LAN interface — no
override needed. Just type their address.

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

The hermes uid=10000 host user is **not** required on macOS — Docker
Desktop's VM handles socket perms internally.

### macOS wipe

```bash
docker compose -f deploy/macos/docker-compose.yml down
rm -rf ~/.sentient/                       # bind-mounted state
docker volume rm sentient-supervisor      # supervisord socket + programs
```
