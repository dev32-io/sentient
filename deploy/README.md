# Sentient deployment

Production runs on one Apple-silicon Mac. The Raspberry Pi and containerized
gateway deployments are retired.

The gateway is a standalone Bun-compiled executable supervised by `launchd`.
It is also the host orchestrator:

- Docker addons are created and reconciled through Docker Desktop;
- native `whisper-stt`, `local-tts`, and optional `deep-memory` addons are
  spawned as gateway child processes; and
- Hermes is invoked only as a one-shot `delegateTask` executable, never as a
  managed service.

See [`deploy/mac-prod/README.md`](mac-prod/README.md) for the complete install,
upgrade, rollback, configuration, and verification contract.

## Deployment assets

| Path | Purpose |
|---|---|
| `deploy/mac-prod/docker-compose.yml` | Build-only image bakery for the three repository-owned addon images. It is not a runtime compose stack. |
| `deploy/mac-prod/setup-prod.py` | Release installer, launchd integration, verified health gate, and rollback. |
| `deploy/mac-prod/io.sentient.gateway.plist` | LaunchAgent/LaunchDaemon template rendered by the installer. Do not install it by hand. |
| `deploy/mac-prod/native/requirements/*.lock` | Committed, hashed dependency locks for all three native Python addons. |
| `deploy/egress-proxy/` | Historical/source tinyproxy files; active copies are seeded under the gateway operator config tree. |

The image bakery builds:

- `sentient/outbound-worker:local`
- `sentient/ingress-proxy:local`
- `sentient/inbound-proxy:local`

SearXNG and egress-proxy use configured public images that the gateway pulls
and manages. Compose does not define runtime networks or start any service.

## Build and install

```bash
source scripts/env.sh

docker compose -f deploy/mac-prod/docker-compose.yml \
  --profile build-only build
./scripts/build-python-wheels.sh
./scripts/build-gateway.sh --release
```

`build-python-wheels.sh` consumes the committed `whisper-stt.lock`,
`local-tts.lock`, and `deep-memory.lock`. The release archive contains the
compiled gateway, assets, native-service sources, locks, and vendored wheels,
so installation performs no network dependency fetches.

Before the first install on a host, create the operator-owned native-service
configs. The installer currently seeds only the gateway config:

```bash
mkdir -p ~/.sentient/{whisper-stt,local-tts,deep-memory}/config
cp -n capabilityServices/WhisperSTTService/config/config.example.yaml \
  ~/.sentient/whisper-stt/config/config.yaml
cp -n capabilityServices/LocalTTSService/config/config.example.yaml \
  ~/.sentient/local-tts/config/config.yaml
cp -n capabilityServices/DeepMemoryService/config/config.example.yaml \
  ~/.sentient/deep-memory/config/config.yaml
```

Install the default GUI LaunchAgent without `sudo`:

```bash
python3 deploy/mac-prod/setup-prod.py install \
  dist/gateway/<version>.tar.gz
```

For a true headless LaunchDaemon instead of the default GUI LaunchAgent:

```bash
sudo python3 deploy/mac-prod/setup-prod.py install \
  dist/gateway/<version>.tar.gz --domain system
```

The installer verifies the archive checksum, stages native venvs offline,
atomically switches the `current` symlink, restarts launchd, and health-gates
both the loopback gateway and public edge over verified TLS. Failure rolls back
the selected release.

## Release and state layout

The default GUI-domain layout is:

```text
~/.sentient/gateway/releases/<version>/
~/.sentient/gateway/current -> releases/<version>
~/Library/LaunchAgents/io.sentient.gateway.plist
```

The optional system-domain layout is:

```text
/opt/sentient/releases/<version>/
/opt/sentient/current -> releases/<version>
/Library/LaunchDaemons/io.sentient.gateway.plist
```

Mutable Sentient operator state lives under `~/.sentient/`. Optional Hermes
delegation also depends on its separate `~/.hermes/` profile store; include
both roots in host backup and restore procedures. The active production gateway
configuration is:

```text
~/.sentient/gateway/config/config.yaml
```

The installer seeds it from the tracked `gateway/config.yaml` once and never
overwrites it. Release rollback does not roll back this shared operator state
or reverse config migrations.

The first-run web wizard stores admin, provider, and integration settings in
the operator state tree. Process-only secrets required by a native addon, such
as deep-memory's bearer tokens, must be provided to the gateway launchd
environment and must not be placed in `config.yaml`.

## Native capabilities

### Whisper STT

`whisper-stt` is the supported production STT path. It runs natively on Apple
silicon from the release's Python 3.14 venv and binds loopback on WebSocket port
8768. The older SenseVoice `capabilityServices/STTService` and the Pi PoCs are
retained only as historical evidence.

### Local TTS

`local-tts` is the supported production TTS path. It runs Qwen3-TTS/MLX from
the release's Python 3.11 venv and binds loopback on WebSocket port 8770.
The old localTTS bake-off remains a historical benchmark, not a deployment
selection.

### Deep memory

`deep-memory` is a native Python 3.14 addon on `127.0.0.1:8772`. It is optional:
if unavailable, memory recall/tools degrade while the voice path remains
healthy. Its committed lock is
`deploy/mac-prod/native/requirements/deep-memory.lock`; no manual first-build
lock generation is required.

Its service config must use the gateway root as `storage.data_root` so both
private and household index paths are inside the allowed root:

```yaml
storage:
  data_root: "~/.sentient/gateway"
```

The gateway passes `DEEP_MEMORY_ADMIN_TOKEN` and
`DEEP_MEMORY_DATA_TOKEN` from its own process environment. Generate distinct,
high-entropy values and add them to the installed launchd job environment; an
empty token makes the addon fail closed.

## TLS and reachability

The native gateway binds `127.0.0.1:8888`. `inbound-proxy` is the public door
on ports 80/443, so clients use the configured HTTPS hostname, not port 8888.

`inbound_proxy.cert_dir` in the active operator config selects the outward
certificate. The proxy separately trusts the gateway's self-signed certificate
under `~/.sentient/gateway/certs/` for the loopback upstream hop.

When an externally managed certificate is renewed in place, reload nginx:

```bash
docker kill -s HUP sentient-inbound-proxy
```

A gateway restart is not equivalent because an unchanged infra container may
be left running by design.

## Local development

```bash
source scripts/env.sh
bun run dev
bun run stack:status
bun run stack:down
```

The local launcher uses `bun --watch`, not `bun --hot`, and lets the gateway own
all addon lifecycles. The normal local URL is `https://localhost/`; direct
`:8888` access is diagnostic only.
