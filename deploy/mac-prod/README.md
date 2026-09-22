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

Compose builds only the four repository-owned images:

- `sentient/attachment-parser:local`
- `sentient/outbound-worker:local`
- `sentient/ingress-proxy:local`
- `sentient/inbound-proxy:local`

Parser build args come from `gateway/addons/attachment-parser/addon.json`
and source revision. Bootstrap them before any direct Compose command:
`eval "$(scripts/stack.sh parser-env)"`. No fixed parser-version default exists.

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

# Bootstrap parser args from addon.json and source revision. This is required
# even when Compose targets only non-parser services.
eval "$(scripts/stack.sh parser-env)"

# Bake non-parser local images. --release below builds and packages parser image
# under its revision-derived tag from addon.json.
docker compose -f deploy/mac-prod/docker-compose.yml \
  --profile build-only build outbound-worker ingress-proxy inbound-proxy

./scripts/build-python-wheels.sh
./scripts/build-gateway.sh --release
```

`build-python-wheels.sh` uses the three committed, hashed locks under
`deploy/mac-prod/native/requirements/` and creates the offline wheel payload.
`build-gateway.sh` refuses to package a release without all three wheel sets.
The resulting tarball and checksum are under `dist/gateway/`.

Nothing fetches during installation: current archives carry the compiled gateway,
runtime assets, native-service sources, locks, vendored wheels, and
`addons/attachment-parser/{addon.json,identity.json,image.tar}`. Pre-parser
legacy archives legitimately omit that directory. When present, parser payload
is built with manifest-derived `ADDON_NAME`/`ADDON_VERSION`/
`ADDON_PROTOCOL_VERSION`/`ADDON_REVISION`, saved under a revision-derived
release tag, and checked by image ID, labels, and payload checksum before
activation. Clean revision tags identify one build; dirty staging tags may
repeat, so image ID and archive checksum are the immutable artifact identity.
`protocolVersion: 2` is compatibility metadata; it does not change the parser
Docker frame version.

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

For either domain, paired releases require the explicit operator-config
prerequisite below. The installer checks it after checksum verification and
before creating state, rewriting the plist, extracting a release, loading or
tagging Docker images, or restarting launchd. Existing operator config is
never silently migrated.

```yaml
managed_services:
  attachment-parser:
    template: attachment-parser.yaml
    allowed_images: ["sentient/attachment-parser:local"]
    networks: []
    healthcheck:
      noop: true
    depends_on: []
    optional: false
```

If an existing `~/.sentient/gateway/config/config.yaml` lacks this block,
merge it manually from tracked `gateway/config.yaml` and retry. A fresh host
uses the tracked template as seed. Legacy archives without parser payload do
not require this check.

For either domain, the installer:

1. verifies the adjacent `.sha256` file and parser operator prerequisite;
2. extracts and stages the release;
3. builds native-service venvs offline from vendored wheels;
4. loads and checks the packaged parser image when the parser payload exists;
   a true legacy archive skips parser staging;
5. switches `current` and, for paired releases, the parser `:local` alias in a
   guarded activation sequence;
6. starts or restarts the `io.sentient.gateway` job; and
7. health-gates gateway liveness, paired-release parser image plus live UDS
   manifest metadata, and public edge on `:443` with certificate verification.
The parser check proves container running image ID and asks its live UDS server
through `python3 /app/exec_client.py --health`; it does not trust `addon.json`
alone. Parser directory absence means legacy; a partial parser directory fails
closed. Same-version installs verify or repair the **installed** payload; they do
not replace it from a rebuilt archive. Use a new gateway release version whenever
the binary or bundled parser changes.

A failed health gate restores both the previous gateway release and the image
ID previously held by `sentient/attachment-parser:local`, then rechecks health.
A legacy candidate keeps that previous paired alias in place; it does not look
up a receipt for the candidate version. When a paired release later replaces a
legacy release, installer-owned receipt records the legacy release's prior
parser image identity (or an intentionally absent alias) for future rollback.
Before loading or activating a new pairing, the installer also tags that known
previous image as `sentient/attachment-parser:retained-<sha256hex>`. This
non-runtime tag keeps it out of ordinary dangling-image cleanup and is never
auto-deleted. Explicit tag removal or `docker system prune --all` can still
remove the retained image, so a missing or pruned receipt/image refuses
rollback with receipt restoration, `docker load --input <saved-image.tar>`, or
release-reinstall guidance instead of guessing at the current image. Docker
tags and the `current` symlink have no cross-system atomic commit; activation is
therefore ordered and guarded, not claimed atomic. A host kill in that narrow
window needs the normal manual rollback command.

A failed health gate rolls back to the previous release. Operator state and
configuration are shared across releases and are not rolled back.

**Private calendar storage cutover:** startup imports private calendars into
`store.db_filename` in each user's data directory, verifies and durably flushes
the import, then removes the legacy `calendar-v2/calendar.db`. Household calendar
storage is unchanged. There is no compatibility alias or reverse migration:
rolling back to a binary that expects the old private-calendar path does not
restore calendar access. Treat recovery after this cutover as a forward repair,
not a guaranteed binary rollback.

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

## Disposable rehearsal

Run installer tests and the local rehearsal before an operator run:

```bash
source scripts/env.sh
python3 -m pytest deploy/mac-prod/tests/test_setup_prod.py \
  deploy/mac-prod/tests/test_launchd_live.py \
  scripts/test_attachment_parser_metadata.py
bash deploy/mac-prod/tests/e2e-install.sh /tmp/sentient-mac-prod-e2e
```

The rehearsal uses fake `launchctl`, Docker, native-venv, and ownership seams,
plus disposable local HTTPS endpoints. It never invokes production launchd,
Docker daemon state, native services, or production paths. Real `launchctl`
behavior, launchd domain loading, and launchctl throttling are **not exercised**
after fake replacement; those remain operator-run boundaries.

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
