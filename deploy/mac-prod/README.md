# Sentient — macOS production deploy (`mac-prod`)

The supported production shape is one Apple-silicon Mac running:

- a standalone Bun-compiled gateway supervised by `launchd`;
- native, gateway-managed `whisper-stt`, `local-tts`, and optional
  `deep-memory` processes; and
- gateway-managed Docker addons.

The Raspberry Pi deployment, containerized gateway, SenseVoice
`stt-service`, per-service STT/TTS LaunchAgents, and compose-based runtime are
retired. `deploy/mac-prod/docker-compose.yml` is only an image bakery; do not
run `docker compose up` from this directory.

## Runtime ownership

The gateway is the only long-running host supervisor. It starts native addons
as child processes and creates/reconciles addon containers through Docker
Desktop. Hermes is not a managed service or container; `delegateTask` invokes
it as a one-shot executable.

Compose builds only the three repository-owned images:

- `sentient/outbound-worker:local`
- `sentient/ingress-proxy:local`
- `sentient/inbound-proxy:local`

The orchestrator pulls the configured public images for `egress-proxy` and
SearXNG itself. Runtime networks and containers are defined by
`gateway/config.yaml` plus `gateway/templates/services/`, not by compose.

## Prerequisites

- Apple-silicon macOS
- Docker Desktop, configured to start after login
- Bun (source `scripts/env.sh` before repository commands)
- Homebrew Python 3.14 for `whisper-stt` and `deep-memory`
- Homebrew Python 3.11 for `local-tts`
- `opus` and `ffmpeg`

The default production domain is a GUI LaunchAgent, so the operator must log in
(or use auto-login) after boot for both the gateway and Docker Desktop to run.
For a machine that must run with nobody logged in, explicitly select the
`system` LaunchDaemon domain; Docker availability remains an operator concern.

## Build a release

From the repository root:

```bash
source scripts/env.sh

docker compose -f deploy/mac-prod/docker-compose.yml \
  --profile build-only build

./scripts/build-python-wheels.sh
./scripts/build-gateway.sh --release
```

`build-python-wheels.sh` uses the three committed, hashed locks under
`deploy/mac-prod/native/requirements/` and creates the offline wheel payload.
`build-gateway.sh` refuses to package a release without all three wheel sets.
The resulting tarball and checksum are under `dist/gateway/`.

Nothing fetches during installation: the archive carries the compiled gateway,
runtime assets, native-service sources, locks, and vendored wheels.

Before the first install on a host, create the operator-owned native-service
configs. `setup-prod.py` currently seeds only the gateway config:

```bash
mkdir -p ~/.sentient/{whisper-stt,local-tts,deep-memory}/config
cp -n capabilityServices/WhisperSTTService/config/config.example.yaml \
  ~/.sentient/whisper-stt/config/config.yaml
cp -n capabilityServices/LocalTTSService/config/config.example.yaml \
  ~/.sentient/local-tts/config/config.yaml
cp -n capabilityServices/DeepMemoryService/config/config.example.yaml \
  ~/.sentient/deep-memory/config/config.yaml
```

## Install or upgrade

### Default: GUI LaunchAgent

```bash
python3 deploy/mac-prod/setup-prod.py install \
  dist/gateway/<version>.tar.gz
```

This installs immutable versioned releases under
`~/.sentient/gateway/releases/`, points
`~/.sentient/gateway/current` at the selected release, and installs
`~/Library/LaunchAgents/io.sentient.gateway.plist`.

### Optional: system LaunchDaemon

```bash
sudo python3 deploy/mac-prod/setup-prod.py install \
  dist/gateway/<version>.tar.gz --domain system
```

This installs root-owned releases under `/opt/sentient/releases/`, points
`/opt/sentient/current` at the selected release, and installs
`/Library/LaunchDaemons/io.sentient.gateway.plist`. The daemon still runs as
the operator named by the installer.

For either domain, the installer:

1. verifies the adjacent `.sha256` file;
2. extracts and stages the release;
3. builds native-service venvs offline from vendored wheels;
4. atomically switches `current`;
5. starts or restarts the `io.sentient.gateway` job; and
6. health-gates both the gateway on `:8888` and the public edge on `:443` with
   certificate verification.

A failed health gate rolls back to the previous release. Operator state and
configuration are shared across releases and are not rolled back.

## Configuration and state

The installer seeds, but never overwrites:

```text
~/.sentient/gateway/config/config.yaml
```

That is the active operator config in production. The tracked
`gateway/config.yaml` is its seed/template and the local-development default.
The gateway's installed plist sets `GATEWAY_CONFIG_PATH` to the operator copy.

Other mutable Sentient state remains under `~/.sentient/`, including gateway
data, secrets, users, logs, certificates, and native-addon state. Optional
Hermes delegation uses a separate `~/.hermes/` profile store. Back up both
roots when Hermes is configured. In GUI-domain installs `~/.sentient/` also
contains the immutable release tree under `gateway/releases/`; in system-domain
installs executable code is under `/opt/sentient/` instead.

The first-run web wizard creates the admin and stores provider/integration
secrets. Operator-only process environment such as
`DEEP_MEMORY_ADMIN_TOKEN` and `DEEP_MEMORY_DATA_TOKEN` must still be supplied
to the gateway's launchd job; those values do not belong in `config.yaml`.

## TLS and URLs

The gateway binds loopback on `https://127.0.0.1:8888`. The public
`inbound-proxy` exposes ports 80/443; clients use the hostname configured for
the installation, without port 8888.

`inbound_proxy.cert_dir` in the operator config selects the outward certificate
directory. If it is absent, the proxy falls back to the gateway's self-signed
certificate under `~/.sentient/gateway/certs/`. The proxy always verifies its
loopback TLS hop using that gateway certificate as a separate trust anchor.

After an externally managed certificate is renewed in place, reload the
running proxy so nginx rereads it:

```bash
docker kill -s HUP sentient-inbound-proxy
```

Restarting the gateway does not necessarily recreate an unchanged infra
container, so it is not a substitute for the HUP.

## Verification

For the default GUI domain:

```bash
launchctl print gui/$(id -u)/io.sentient.gateway | grep -E 'state|path'
curl --cacert ~/.sentient/gateway/certs/cert.pem \
  https://127.0.0.1:8888/api/v1/health
curl -I https://<configured-host>/
```

For the system domain, inspect
`system/io.sentient.gateway` instead. Addon state is available through the
admin UI/API; `docker ps --filter label=sentient.managed=true` is the direct
container diagnostic.

## Local development

Local development does not use the production LaunchAgent:

```bash
source scripts/env.sh
bun run dev
```

`scripts/stack.sh` performs preflight, builds the web UI and repository-owned
addon images, starts the gateway with `bun --watch` (never `--hot`), and lets
the gateway supervise native and Docker addons. Use `bun run stack:status` and
`bun run stack:down` for that local stack.
