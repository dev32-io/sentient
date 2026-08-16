# Sentient — deploy

The gateway itself is a **compiled native binary supervised by `launchd`** —
not a Docker container. It is the host orchestrator: it creates, starts,
health-checks and recreates every sibling addon itself, over the host docker
socket for docker addons (MCP tool servers, searxng,
egress-proxy/ingress-proxy) and via `Bun.spawn` for native addons
(whisper-stt, local-tts, deep-memory). Hermes is never a managed service — it's a one-shot
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
Metal/MLX, which is Apple-silicon only — and the third native service,
`deep-memory` (optional, MLX embeddings), is Apple-silicon-only for the same
reason even though its absence does not block boot. Recover it from git history if you want
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

Produces the `:local` image tags for `outbound-worker`, `ingress-proxy`, and
`inbound-proxy`; the gateway orchestrator creates containers from these at
startup, so `up`/`down` are never used here. **Re-run the build after `git pull`**
to refresh them.

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

Open `https://sentient.dev32.io` (port 443) — `inbound-proxy` is the one
outward-facing door, and the gateway itself binds `127.0.0.1`, so it is not
reachable from another host on `8888`. (`https://<host>:8888` still answers
*from the mini itself* — useful as a diagnostic, never as the URL you hand a
device.) The setup wizard walks through:

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
`~/.sentient/`. Code is root-owned and immutable under `/opt/sentient/`.

**Two cert roles, not one.** `inbound-proxy` terminates TLS twice, for two
different purposes:

| Role | Cert | Set via |
|---|---|---|
| Outward identity — what the browser sees on 443 | `~/.data/certs/sentient.dev32.io` — the real cert, externally managed by `acme.sh`. The one intentional exception to the `~/.sentient/` state path | `inbound_proxy.cert_dir` in `config.yaml` |
| Upstream trust anchor — the loopback hop to `:8888` | `~/.sentient/gateway/certs` — the gateway's own self-signed `cert.pem`, always | not configurable; the same cert in dev and prod |

The upstream hop is never verified against the `acme.sh` cert — `inbound-proxy`
trusts the gateway's own self-signed material for that hop in both
environments, so it stays a verified TLS connection rather than merely an
encrypted one.

**`acme.sh` renewing the cert does not reload nginx.** Run this after every
renewal so `inbound-proxy` picks up the new files:

    docker kill -s HUP sentient-inbound-proxy

**Restarting the gateway is NOT an alternative, and neither is rebooting.** The
orchestrator decides whether to recreate `inbound-proxy` by hashing the
container *spec* — image, ports, mounts, limits. A cert renewed in place is the
same path with new bytes, so the hash is unchanged, the infra-class service is
skipped as unchanged-and-running (by design: an unconditional recreate would
drop 80/443 on every `bun --watch` save), and the nginx that is already running
keeps the old certificate loaded in memory. The `HUP` above is the only thing
that makes it re-read the file. The same applies to the gateway's own
self-signed material after a `tls.hostnames` change — see the step list at
`gateway/config.yaml`'s TLS block.

**SAN note:** a browser on a LAN phone gets no microphone unless that host's
IP or name is in `tls.hostnames` (`config.yaml`) — a SAN mismatch produces a
hard browser warning *and* refuses mic access, since browsers gate `getUserMedia`
on a fully-trusted origin. Native mobile apps are unaffected; they use platform
mic permission, not browser origin rules.

---

## deep-memory (optional memory-recall addon)

A native, loopback-only HTTP index engine (SQLite + FTS5 + sqlite-vec + MLX
multilingual embeddings) that backs the assistant's long-term memory
(`orchestrator.memory` — MEMORY.md, spark recall, `memory_recall`). Full
wire contract: `capabilityServices/DeepMemoryService/CONTRACT.md`.

**Optional, not voice-path-critical.** Unlike whisper-stt/local-tts
(`optional: false` — the mini refuses to come up healthy without them),
`managed_services.deep-memory` is `optional: true`: if it is absent, fails
its venv build, or fails its health gate, the gateway still comes up and
serves voice traffic — memory tools (`memory_recall`, etc.) simply go
unavailable rather than blocking boot. This is the spec §11 degradation
model, not a bug.

### Install / upgrade

No separate step — it rides the same native-service pipeline as
whisper-stt/local-tts:

```bash
docker compose -f deploy/mac-prod/docker-compose.yml --profile build-only build   # addon images, unrelated but usually run together
./scripts/build-python-wheels.sh                                                  # vendors deep-memory's wheels too
./scripts/build-gateway.sh --release
sudo python3 deploy/mac-prod/setup-prod.py install dist/gateway/<version>.tar.gz
```

`setup-prod.py install` stages `<release>/deep-memory/{src,venv}` and builds
its offline venv from vendored wheels exactly as it does for the other two
native services (`SERVICE_SOURCES` in `setup-prod.py`); `deep-memory`'s
schema-versioned data lives under `~/.sentient/deep-memory/`, mutable and
operator-owned, untouched by the release swap.

**Before the first real wheel build**, `deploy/mac-prod/native/requirements/
deep-memory.lock` must exist — it does not ship yet. `build-python-wheels.sh`
now **fails loud** with the generate recipe when the lock is absent (rather
than a confusing `grep` error or a partial wheel set), so a release build
cannot silently skip deep-memory. Generate it via the recipe documented in
the header of the sibling `whisper-stt.lock` / `local-tts.lock` files (`uv pip
freeze` against the tested
`capabilityServices/DeepMemoryService/.venv/bin/python`, then `uv pip
compile`, then `scripts/build-python-wheels.sh` to fill in the wheel hashes)
before running `build-python-wheels.sh` for a release.

### Token provisioning

The service speaks two bearer tokens (`DEEP_MEMORY_ADMIN_TOKEN` /
`DEEP_MEMORY_DATA_TOKEN` — CONTRACT.md §2), injected as **gateway process
environment**, never written to `config.yaml` or to the service's own
on-disk config. Generate two high-entropy random strings and add them to the
gateway's `EnvironmentVariables` (the launchd plist,
`deploy/mac-prod/io.sentient.gateway.plist`, alongside `SENTIENT_CODE` /
`HOST_HOME`):

```bash
openssl rand -hex 32   # run twice — one value per token
```

An unset or empty token is a hard startup failure for deep-memory
(`auth.py` — the service never comes up accepting an empty bearer), which is
non-fatal for the gateway as a whole (see "optional" above) but means memory
tools stay unavailable until the tokens are set and the gateway restarted.
In local dev, export the same two vars before `bun run dev` (`scripts/env.sh`
does not set them — they are per-operator secrets, not repo-shape config).

### Rollback smoke (install → health-gate → rollback)

Same shape as any other release, exercised end-to-end on a real install:

1. `sudo python3 deploy/mac-prod/setup-prod.py install dist/gateway/<good-version>.tar.gz`
   — confirm `managed_services.deep-memory` reaches `ready` (health-check
   passes at `GET http://127.0.0.1:8772/health`):
   `docker compose ...` is irrelevant here since this is a native service —
   check via the gateway's own service-status API/webui, or
   `curl -s http://127.0.0.1:8772/health` directly on the mini.
2. Install a deliberately broken build (e.g. a tarball missing the
   `deep_memory` package under `capabilityServices/DeepMemoryService/src`) —
   `stage_native_services` raises `InstallError` before the venv step, and
   `setup-prod.py` rolls the `current` symlink back to the previous release
   automatically. Confirm the gateway is still serving on the last-known-good
   binary and `deep-memory` is still healthy at 8772.
3. Because `deep-memory` is `optional: true`, a health-gate failure isolated
   to `deep-memory` alone (service up but `/health` never turns green) does
   **not** by itself fail the release's overall health gate the way a
   whisper-stt/local-tts failure would — verify the gateway still installs
   successfully and simply logs the addon as degraded, memory tools absent.

### Deploy alignment — `storage.data_root` must be the gateway ROOT

The gateway registers a user's PRIVATE scope at indexPath
`<user_data_root>/<userId>/deep-memory/index.db` (default `<user_data_root>` =
`~/.sentient/gateway/users`) AND the shared HOUSEHOLD scope under
`~/.sentient/gateway/shared/...` (memory-system design §5.3, T15/T24 review).
deep-memory's OWN `config.yaml`
(`~/.sentient/deep-memory/config/config.yaml`, `storage.data_root`) must be set
so BOTH those paths resolve inside it. The only root that covers both is their
common parent, the gateway root: `storage.data_root: "~/.sentient/gateway"`.

Two mis-settings to avoid — each fails silently, not loudly:
- `~/.sentient/gateway/users` (the gateway's `user_data_root`) covers private
  scopes but NOT the household scope under `.../shared`, so family memory
  breaks the moment a household index registers.
- `~/.sentient/deep-memory/scopes` (the old service-local default) contains NO
  gateway index path at all — dead on arrival, every scope refused.

A mismatch does not crash either process: `register-scope` refuses with
`path_outside_data_root` (CONTRACT.md §4), and the memory system degrades
non-fatally per the §11 model — `memory_recall` and the memory tools simply
report unavailable, silently, with no boot failure to flag it. Verify this
alignment explicitly after any change to either root (fresh install, `~/
.sentient` relocation, multi-tenant reconfiguration) — `curl` a `/register-
scope` call or check the gateway log for `path_outside_data_root` after
restart.

### Dreamer uses the gateway's global provider model, not a per-user one

The nightly/on-demand dreamer (`gateway/src/memory/dreamer/`) calls the LLM
through the same `orchestrator.provider.model` every live session falls back
to (`phase-services.ts` wires `createDreamRunner({ model:
orchestratorCfg.provider.model, ... })`) — there is no separate "background
model" tier and no per-user override; whatever model backs live chat also
backs every dreamer map/reduce call, for every user. Two operational
consequences: (1) provider rate limits and per-token cost must be sized for
dreamer traffic on top of live chat — a household with `dreaming: true` for
every member adds one map call per session-window plus one reduce call, per
user, per night; (2) swapping `orchestrator.provider.model` (e.g. moving to a
cheaper/local model) changes dreamer output quality identically to live chat
— there is no way to pin the dreamer to a different model without a code
change today.

### Operator purge runbook — remediating a poisoned session

A tool-derived or trigger-sourced session can carry hostile content that the
dreamer distilled into MEMORY.md before anyone noticed (the inbound-gate
raises risk on read, it does not retroactively unwrite a fact already
committed the prior night). Memory's file layer never hard-deletes
automatically (spec §3.6 no-hard-delete invariant) — remediation is a
deliberate operator action, not something a tool call can trigger. Steps:

1. **Identify the poisoned session.** Every fact op the dreamer applies is
   logged in that night's `journal/YYYY-MM-DD.md` under `## memory updates`
   with its source citations: `- ADD MEMORY.md: <line>  [sessions: <id>,
   ...; seqs: <fromSeq>-<toSeq>, ...]`. Grep the affected user's journal
   directory for the suspect fact text, or work backward from an
   `inbound-gate.flagged` / `memory-tools.scan.rejected` log line's
   `sessionId` (`~/.sentient/gateway/logs/YYYY-MM-DD.log`) to the journal
   entries citing it.
2. **Purge the session from the index** via the deep-memory admin plane —
   `POST /purge` with the admin token (`DEEP_MEMORY_ADMIN_TOKEN`, §"Token
   provisioning" above), scoped to the user's private scope id
   (`user:<userId>`) and filtered by the poisoned `sessionId`:

   ```bash
   curl -s -X POST http://127.0.0.1:8772/purge \
     -H "Authorization: Bearer ${DEEP_MEMORY_ADMIN_TOKEN}" \
     -H "Content-Type: application/json" \
     -d '{"scopeId": "user:<userId>", "filter": {"sessionId": "<poisonedSessionId>"}}'
   ```

   This drops every indexed entry (episode summaries, fact/`file-section`
   entries, the journal entry itself) whose `sessionRef.sessionId` matches —
   the reason episode-writer.ts pins every fact's `sessionRef` to its
   MOST-TAINTED contributing session (§3.8): a fact distilled from a mixed
   `[clean, poison]` window purges correctly rather than surviving under the
   clean session's id.
3. **Fix the file layer.** `/purge` only removes the SEARCH index — the
   canonical MEMORY.md/topic files and the journal itself are untouched (the
   index is derived and rebuildable; the files are the source of truth,
   spec §2). Use the journal's op-log citations from step 1 to find the exact
   MEMORY.md/topic line(s) the poisoned session contributed, then either:
   - have the assistant `memory_write` a `SUPERSEDE`/removal of the
     compromised line (routes through the normal write-time scan), or
   - hand-edit `~/.sentient/gateway/users/<userId>/memory/MEMORY.md` (or the
     relevant `topics/<slug>.md`) directly as the operator — a human edit is
     the one path allowed to bypass the model, but it still passes through
     the store's write-time scan on next read/render.
4. **Rebuild if the index looks inconsistent** after multiple purges or a
   suspected broader compromise — `POST /rebuild` with the same admin token
   drops and re-derives the WHOLE scope's index from the (now-fixed) files:

   ```bash
   curl -s -X POST http://127.0.0.1:8772/rebuild \
     -H "Authorization: Bearer ${DEEP_MEMORY_ADMIN_TOKEN}" \
     -H "Content-Type: application/json" \
     -d '{"scopeId": "user:<userId>"}'
   ```

   `rebuild` is also the fix for `409 rebuild_required` (an embedding-model
   change) — same call, different trigger.

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
health gate is rolled back automatically — the mini is never left running a
broken *binary*.

**Config migration is one-way, and rollback does not undo it.** The two
mechanisms have different granularity, and it is worth being blunt about the
gap: `setup-prod.py` rolls back by flipping the `current` symlink to the
previous release, but the operator config at `~/.sentient/gateway/config.yaml`
is shared STATE — a boot-time migrator rewrites it in place, and the
rolled-back binary then reads the already-migrated file. There is no
down-migration. So:

- Rolling back recovers from a bad *binary*, not from a bad *migration*.
- Every migration step must therefore leave a config that BOTH the new and the
  previous release can boot on, and must never remove a way in without adding
  its replacement in the same step. The 0.1.3 → 0.1.4 step is the worked
  example: it moves `host` to `127.0.0.1` **and** writes the
  `managed_services.inbound-proxy` entry in one atomic write, because the bind
  change alone would leave the mini reachable from nowhere but itself — a state
  no rollback could repair, since the previous release would re-read the same
  loopback bind and the health gate would fail identically.
- Recovery from a genuinely bad migration is a hand-edit of
  `~/.sentient/gateway/config.yaml` over SSH. Keep a copy before a major
  upgrade if that matters to you: `cp ~/.sentient/gateway/config.yaml{,.bak}`.

### Upgrade note — per-tool permissions make `tier:` mandatory on every catalogued tool

The release that adds per-tool permissions changes the shape of
`mcp_catalog.*.tools.include` (and `.available`) from a bare name list to
`{ name, tier }` entries. **`tier` is required and has no default**, and the
operator config is validated by a `schema.parse` that throws on a path the boot
sequence does not catch — so an untiered catalog is not a degraded gateway, it
is a gateway that does not start. Every existing host is affected, because
`setup-prod.py` never overwrites an existing `config.yaml` by hard rule.

**No manual edit needed.** The 0.1.4 → 0.1.5 migration rewrites every entry in
place, taking each tool's tier from the shipped catalog as it stood at that
step:

```yaml
tools:
  include:
    - ha_get_state          # before
    - { name: ha_get_state, tier: read }   # after
```

Your comments, ordering and blank lines survive; an entry you had already tiered
by hand is never overwritten.

**A tool the shipped catalog does not describe** — one you added for your own
MCP — gets `tier: admin`, the operator-only tier, plus an inline marker comment
naming it and a `WARN migration:0.1.5:unknown-tools` line in
`~/.sentient/gateway/logs/$(date +%F).log` (and on stderr, so it survives a boot
that dies before the logger). It does
**not** get `read`. The migration cannot know an unknown tool's blast radius,
and the two ways of guessing fail asymmetrically: `read` would hand a guest
something nobody vetted and say nothing, while `admin` costs you one edit that
the log and the file both point at. Re-tier those entries deliberately —
`read | write | confirm | admin`, defined in the `mcp_catalog:` legend in
`config.yaml`.

> The migration also reformats untouched parts of the file — flow collections
> gain inner spaces, aligned trailing comments collapse to one space, long
> quoted strings wrap. That is the YAML round-trip, it is what every migration
> step in this chain has always done, and it changes no values.

### Upgrade note — gateway 1.12.x moves the gateway behind `inbound-proxy`

The 0.1.3 → 0.1.4 migration rewrites `host: 0.0.0.0` → `127.0.0.1` and, in the
same write, adds `managed_services.inbound-proxy` (with `infra: true` and
`public_ports: true`) plus an `inbound_proxy: { cert_dir: null }` block. It runs
once, is idempotent, and never touches an `inbound-proxy` entry an operator
added by hand.

**The addon image must exist before that first boot** — the
`docker compose … --profile build-only build` line above is what builds
`sentient/inbound-proxy:local`. Skip it and the new door has no image to run.
Point `inbound_proxy.cert_dir` at the `acme.sh` directory afterwards; until you
do, 443 is served with the gateway's self-signed cert (the deliberate
fresh-host fallback), not with a browser-trusted one.

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

Home Assistant and Music Assistant are reached directly by native gateway
adapters. The wizard's HA/MA URL fields therefore take the device's LAN IP or
hostname exactly as a normal host application would; credentials remain in the
operator secrets store and are never rendered into profiles.

Find the mini's own LAN IP if a LAN device needs to reach back to it:

```bash
ipconfig getifaddr en0     # ethernet (or en1 for Wi-Fi)
```

---

## Local dev — macOS

`bun run dev` from the repo root is the whole-stack dev launcher: preflight
(docker-daemon wait, webui build, addon-image bake) then gateway (`bun
--watch`, never `--hot` — see `gateway/CLAUDE.md`) plus vite plus every
docker/native addon plus `inbound-proxy`. See the root `CLAUDE.md` for the
full command set (`stack:down`, `stack:status`) and the three-doors URL story.
The real URL is `https://localhost/`; `https://localhost:8888` still answers
directly from the host, for diagnostics only.

To bake the addon images by hand (rarely needed — preflight does this too):

```bash
docker compose -f deploy/mac-prod/docker-compose.yml --profile build-only build
```

The native driver launches whisper-stt/local-tts/deep-memory from repo-local venvs; the
orchestrator creates every addon container — `inbound-proxy` included — from
the images baked above.

### macOS dev wipe

```bash
rm -rf ~/.sentient/     # gateway config/logs/data/certs (incl. the Hermes brain)
docker ps -a --filter "name=sentient-" --format "{{.Names}}" | xargs -r docker rm -f
```

The gateway's orchestrator creates addon containers directly (not via
`docker compose up`), so there is no compose stack to `down` — remove them by
name instead. Restarting the gateway after a wipe recreates them fresh.
