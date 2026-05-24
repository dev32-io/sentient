# Signal Device Pairing — Design

**Date**: 2026-05-10
**Branch (to be created)**: `feature/signal-device-pairing`
**Gateway version bump**: `1.4.4` → `1.5.0`
**Status**: design approved, ready for implementation plan

---

## §1. Overview & Scope

### Goal

Let each Sentient user pair their personal Signal account to their Hermes profile so they can text-chat with their family agent from Signal "Note to Self." Let the agent schedule reminders delivered to Signal via Hermes' built-in cron.

### Why this approach

- Hermes ships a Signal adapter, a per-profile `gateway run` runner, and a cron scheduler. We add ~zero protocol code. We add provisioning, lifecycle, and a webui surface.
- "Note to Self" mode (signal-cli linked as a secondary device on the user's own Signal account) sidesteps the need for a second phone number per user — the realistic answer for a family running this on one Pi.

### In scope (v1)

- Settings > **Devices** tab in webui (new tab, one row per supported IM platform; Signal only in v1).
- Per-user pairing/unpairing of Signal via QR linking.
- Hermes `gateway run` per-profile process boots automatically post-pair, attaches to Signal adapter only.
- Hermes cron jobs default delivery target = Signal when paired.
- Same toolset as user's existing voice settings — no per-platform toolset.

### Explicitly out of scope (v1)

- Any IM platform other than Signal (Telegram, Matrix, WhatsApp, Discord, …) — deferred.
- TTS for outbound Signal replies; STT for inbound voice messages. **Text only.**
- Cross-channel session unification / context injection. Hermes' built-in `memory` and `session_search` tools handle cross-channel queries.
- Sentient-side scheduling — Hermes cron is the only scheduler.
- Multiple Signal accounts per user (1:1 user-to-account).
- Group chat support.
- Hermes' DM pairing-code surface (stranger approval flow) — disabled entirely.

### Non-functional contracts

- Existing profiles without pairing: zero behavior change.
- Unpair preserves Hermes session-DB transcripts (Signal conversation history retained).
- Apply / profile-restart orchestrator (already in gateway) is extended to manage signal-cli + gateway programs — no new orchestrator.

---

## §2. Architecture

### Per-user supervisor topology after pair

Inside the single `sentient-hermes` container, supervisord runs **4 programs per paired user** (today: 2):

```
sentient-hermes (container, supervisord PID 1)
└── per user u_X:
    ├── hermes-u_X-acp          existing — acp_ws_server.py wrapping `hermes -p u_X acp`
    ├── hermes-u_X-dashboard    existing — `hermes -p u_X dashboard`
    ├── hermes-u_X-signal-cli   NEW — `signal-cli --config /data/profiles/u_X/signal-cli daemon --http 127.0.0.1:<port>`
    └── hermes-u_X-gateway      NEW — `hermes -p u_X gateway run` (boots Signal adapter; auto-quits if no platform env)
```

Unpaired user: only the first two programs are rendered (today's behavior). Pairing flips the profile flag → next supervisor render emits all four.

### Port allocation

Existing per-user allocator hands out:

- `acp_port = 8650 + offset(userIndex)`
- `dashboard_port = acp_port + 1000`

Extended:

- `signal_cli_port = acp_port + 2000` (user 0 → 10650). Bound to `127.0.0.1` only, never published outside the container.

Hermes Signal adapter env: `SIGNAL_HTTP_URL=http://127.0.0.1:<signal_cli_port>` (in-container loopback).

### Per-user data layout on host

```
~/.sentient/gateway/data/<userId>/
├── config.yaml                  existing
├── SOUL.md                      existing
├── .env                         existing — extended with SIGNAL_* vars when paired
├── sessions.db                  existing (Hermes session DB)
└── signal-cli/                  NEW — signal-cli account state (linked-device keys, msg store)
```

`signal-cli/` is mounted into the hermes container at `/data/profiles/<userId>/signal-cli/`. Mode `0700`, owner = hermes user. Survives container restart, image bump, and apply.

### Network attachment

No compose changes. signal-cli inherits the hermes container's existing network attachments:

- `sentient-internal` (no egress) + `sentient-external` (bridged, NAT to LAN/internet)
- HTTPS/WS to Signal goes through `sentient-egress-proxy:3128` via `JAVA_TOOL_OPTIONS`:
  ```
  -Dhttps.proxyHost=sentient-egress-proxy -Dhttps.proxyPort=3128
  -Dhttp.nonProxyHosts=localhost|127.0.0.1|sentient-*
  ```
- **Audit item before merge:** tinyproxy `Timeout` setting. If low, the long-lived Signal WS dies. Verify; if low, set `Timeout 0` OR add `chat.signal.org` to NO_PROXY (loses audit for Signal traffic, simpler).
- signal-cli is outbound-only; no port forwarding, no static IP, no DDNS required. Same model as Signal mobile app behind NAT.

### Lifecycle relationships

```
Pairing transition (unpaired → paired):
   apply → render supervisor confs (4 programs) → supervisorctl reread + update
        → signal-cli starts → gateway calls signal-cli `startLink` API → URI to webui
        → user scans → signal-cli completes link → gateway reads account
        → write .env with SIGNAL_* → supervisorctl restart hermes-u_X-gateway
        → adapter connects → status returns "Linked"

Unpair (paired → unpaired):
   webui Unlink → gateway calls signal-cli `removeAccount`
        → wipe SIGNAL_* from .env
        → re-render supervisor confs (back to 2 programs)
        → supervisorctl stop hermes-u_X-signal-cli, hermes-u_X-gateway, remove from supervisor
        → rm -rf /data/profiles/<userId>/signal-cli/   (linked-device keys + cached blobs)
        → sessions.db UNTOUCHED — Signal session transcripts preserved
```

Apply orchestrator and profile-restart orchestrator already drive `supervisorctl reread/update/restart`. We extend the renderer's program inventory; orchestrator code path is reused.

### Image impact

`deploy/hermes-overlay/Dockerfile` adds:

- `openjdk-17-jre-headless` (~180 MB)
- signal-cli tarball, pinned (~30 MB)
- `JAVA_TOOL_OPTIONS` ENV

Image total: ~7.76 GB → ~8.0 GB. Rebuild time hit estimated 5-10 min on Pi 5 (not a blocker; ops note).

RAM impact per active signal-cli process: ~120–150 MB resident (one JVM per paired user). Pi 5 / 8 GB easily handles 4–5 paired users. Pi 5 / 4 GB tight at 4+ paired.

---

## §3. Pairing Flow

### Pre-conditions

- User authenticated in webui (existing PASETO session).
- Hermes profile `u_<userId>` exists (true for any signed-up user).
- Phone with Signal app installed nearby; user signed in on that phone.

### Pair sequence

```
1. User clicks "Link Signal" on Devices tab
        webui → POST /api/devices/signal/link

2. Gateway provisions signal-cli supervisor program
        - Render hermes-u_X-signal-cli supervisor conf (if absent) — brings program total to 3
          (acp + dashboard + signal-cli). hermes-u_X-gateway is NOT yet rendered, because Hermes'
          `gateway run` would boot with no SIGNAL_ACCOUNT and either error or idle-loop.
        - supervisorctl reread + update
        - Wait until signal-cli HTTP daemon answers /api/v1/check (poll ≤ 30s)

3. Gateway requests linking URI
        - Call signal-cli JSON-RPC startLink with deviceName="Sentient-<userId>"
        - Receives sgnl://linkdevice?... URI
        - Stash URI + nonce + 5-min TTL keyed by userId in gateway memory
        - Return { uri, expiresAt } to webui

4. Webui renders QR
        - Modal: QR (rendered client-side via qrcode-svg JS lib — no QR bytes over wire)
        - Status text: "Open Signal on your phone → Settings → Linked Devices → Link New Device → scan"
        - Countdown to expiresAt
        - Cancel button (closes modal, calls /api/devices/signal/link/cancel)

5. User scans QR on phone
        - Phone Signal app sends linking acknowledgement
        - signal-cli completes link handshake (~3-10s)
        - signal-cli now has user's account credentials as a linked device

6. Webui polls completion
        - GET /api/devices/signal/link/status every 2s
        - Gateway calls signal-cli listAccounts and checks if the new account appears
        - Once present: gateway reads the discovered phone E.164

7. Gateway finalizes pairing
        - Write .env additions: SIGNAL_HTTP_URL, SIGNAL_ACCOUNT, SIGNAL_ALLOWED_USERS=<own E.164>
        - Render Hermes config.yaml gateway block:
              gateway.platforms.signal.enabled: true
              gateway.platforms.signal.extra.unauthorized_dm_behavior: ignore
              cron.default_deliver: signal
        - Set profile.devices.signal = { paired: true, account_masked, linked_at }
        - apply: render supervisor confs (now 4 programs — adds hermes-u_X-gateway) →
          reread/update → start hermes-u_X-gateway. signal-cli supervisor program already
          running from step 2; not restarted (its config dir + daemon args are unchanged
          by pairing; SIGNAL_* env is consumed by Hermes' adapter, not by signal-cli itself).
        - Poll until hermes-u_X-gateway healthy (boot log emits "Signal adapter connected")

8. Webui flips state
        - Returns { status: "linked", account: "+1•••••<last4>", linkedAt }
        - Modal auto-closes with success toast
        - Devices tab row shows "Linked: +1•••••1234 · May 10, 2026" + red Unlink button
```

### Failure modes

| Failure | Detection | Handling |
|---|---|---|
| signal-cli won't start (Java OOM, port collision) | step 2 timeout | webui shows "Could not start Signal service. Check Pi logs." Cancel cleans up |
| User doesn't scan within 5 min | step 6 expiresAt reached | Modal expires; cancel cleans up; signal-cli supervisor program kept running (idempotent for next attempt) |
| Phone Signal rejects link (account banned, network) | step 5 — no account appears | Same as expiry path; webui surfaces "Linking incomplete — try again" |
| Apply step fails post-link | step 7 healthcheck fails | webui shows "Signal linked but agent service failed to start." Retry button re-runs step 7 only |
| Gateway crashes mid-pair | gateway boot reconciler | On boot, if `profile.devices.signal.paired=true` but `.env` lacks SIGNAL_ACCOUNT, mark inconsistent and force re-pair |

### Unpair sequence

```
1. User clicks red Unlink → confirm dialog:
   "This will disconnect Signal from your Sentient account.
    Past Signal conversation history will be preserved. Continue?"

2. webui → POST /api/devices/signal/unlink

3. Gateway:
   - Call signal-cli removeAccount (drops linked-device keys; user's phone shows the linked device disappear)
   - Remove SIGNAL_* lines from .env (atomic tempfile+rename)
   - Re-render Hermes config.yaml: drop gateway.platforms.signal, drop cron.default_deliver
   - profile.devices.signal = { paired: false }
   - apply: render supervisor confs (2 programs) → reread/update
        → supervisorctl stop + remove hermes-u_X-signal-cli, hermes-u_X-gateway
   - rm -rf /data/profiles/<userId>/signal-cli/   (linked-device key material + cached attachments)
   - sessions.db UNTOUCHED — Signal session transcripts preserved

4. webui returns { status: "unlinked" }; tab row reverts to "Link Signal" button
```

### Concurrency

- Per-user pairing mutex (already exists from 1.4.3 apply work): prevents double-click double-pair.
- Gateway-wide signal-cli supervisor mutation serialized through the supervisor renderer's existing lock.

---

## §4. Webui Surface — Devices Tab

### Tab placement

Settings page already has tabs: Account, Audio, Voice, Memory, Model, Personalities, Secrets, System Prompt, Tools, Members, Advanced. Insert **Devices** between Members and Advanced.

### Tab structure (unpaired)

```
┌─────────────────────────────────────────┐
│ 📱 Signal                               │
│ Text-chat with your agent from Signal.  │
│ Uses "Note to Self" mode — links your   │
│ own Signal account, no second number.   │
│                                         │
│           [ Link Signal ]               │
└─────────────────────────────────────────┘
```

### Tab structure (linked)

```
┌─────────────────────────────────────────┐
│ 📱 Signal                  ● Linked     │
│ Account: +1•••••1234                    │
│ Linked: May 10, 2026 at 3:42 PM         │
│                                         │
│ How to use:                             │
│   1. Open Signal on your phone          │
│   2. Go to "Note to Self" thread        │
│   3. Text the agent like any chat       │
│                                         │
│           [ Unlink ]   ← red, destructive
└─────────────────────────────────────────┘
```

### QR modal (link click)

- Title: "Link your Signal account"
- Step-by-step body:
  1. On your phone, open Signal
  2. Tap your avatar → Linked Devices
  3. Tap "Link New Device"
  4. Scan this QR code
- QR rendered client-side from URI string (`qrcode-svg` JS lib, ~4KB)
- Countdown: "Code expires in 4:58"
- Footer button: `Cancel`
- On link success: modal auto-closes; tab row flips to linked state; toast "Signal linked"

### Unlink confirm dialog

- Title: "Disconnect Signal?"
- Body: "This removes Sentient as a linked device from your Signal account. Past Signal conversation history will be kept in your Sentient memory."
- Buttons: `Cancel` (default) / `Disconnect` (red, destructive)

### Component reuse

- Tab nav chrome: existing settings tab pattern
- Modal: existing modal component
- QR rendering: `qrcode-svg` JS lib (client-only)
- Destructive confirm: existing confirm-dialog pattern (used by member-delete)

---

## §5. Config & State Model

### Profile schema additions (`shared/config/src/schemas/profile.ts`)

```ts
const signalDeviceSchema = z.object({
  paired: z.boolean().default(false),
  // Masked E.164 stored at pair time (e.g. "+1•••••1234").
  // Raw phone number lives ONLY in .env (0600), never in profile yaml.
  account_masked: z.string().optional(),
  linked_at: z.string().datetime().optional(),
});

profileV1.devices = z.object({
  signal: signalDeviceSchema.optional(),
}).optional();
```

### Env file additions (`~/.sentient/gateway/data/<userId>/.env`)

```ini
# Set only when paired; removed on unlink.
SIGNAL_HTTP_URL=http://127.0.0.1:10650
SIGNAL_ACCOUNT=+15551234567
SIGNAL_ALLOWED_USERS=+15551234567
# Groups disabled — group var deliberately not set
SIGNAL_ALLOW_ALL_USERS=false
```

Atomic rewrite (tempfile + rename) using existing `writeFileAtomic` helper.

### Hermes config.yaml additions (rendered by gateway when paired)

```yaml
gateway:
  platforms:
    signal:
      enabled: true
      extra:
        unauthorized_dm_behavior: ignore   # disable Hermes' DM pairing-code surface
  unauthorized_dm_behavior: ignore         # belt + suspenders at top-level

cron:
  default_deliver: signal                  # only when paired
```

When unpaired, the entire `gateway:` block is omitted; `cron.default_deliver` is omitted (Hermes falls back to its built-in default, which is local/voice).

### Port allocator

Existing allocator persisted in `~/.sentient/gateway/data/<userId>/.port-map.json` extended to allocate `signal_cli_port = acp_port + 2000`.

### Single source of truth for "paired"

`profile.devices.signal.paired === true` is authoritative. Renderer checks this flag to decide whether to emit:

- `hermes-<uid>-signal-cli` supervisor program
- `hermes-<uid>-gateway` supervisor program
- `gateway:` block in Hermes config.yaml
- `cron.default_deliver` line
- `SIGNAL_*` lines in .env (lifted from runtime state, never from profile yaml)

Boot reconciler verifies consistency: paired flag + signal-cli/ dir + SIGNAL_ACCOUNT in .env must all match, or the flag is cleared and webui shows "Re-link required."

---

## §6. Hermes Overlay Changes

### Dockerfile (`deploy/hermes-overlay/Dockerfile`)

```Dockerfile
ARG SIGNAL_CLI_VERSION=0.13.21    # pin verified against latest release at branch creation

# Java 17 JRE (headless only) for signal-cli
RUN apt-get update && apt-get install -y --no-install-recommends \
      openjdk-17-jre-headless \
      ca-certificates-java \
    && rm -rf /var/lib/apt/lists/*

# signal-cli — tarball from official GitHub release
RUN curl -fsSL "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz" \
      | tar -xz -C /opt \
    && ln -sf /opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli /usr/local/bin/signal-cli

# JVM proxy + headless config applies to every signal-cli JVM child supervisord spawns
ENV JAVA_TOOL_OPTIONS="-Djava.awt.headless=true \
  -Dhttps.proxyHost=sentient-egress-proxy \
  -Dhttps.proxyPort=3128 \
  -Dhttp.nonProxyHosts=localhost|127.0.0.1|sentient-gateway|sentient-stt-service|sentient-ha-mcp|sentient-ma-mcp|sentient-searxng-mcp|sentient-fetch-mcp"

LABEL org.sentient.signal-cli-version=${SIGNAL_CLI_VERSION}
```

Pinned version verified against `https://github.com/AsamK/signal-cli/releases/latest` per the `verify_pinned_versions` rule.

Sibling pin file `deploy/hermes-overlay/SIGNAL_CLI_VERSION` (parallel to existing `HERMES_VERSION`) for parity and deliberate bump discipline.

### Supervisor program template (rendered by gateway)

Appended to `/data/supervisor/programs/<userId>.conf` when paired:

```ini
[program:hermes-u_X-signal-cli]
command=signal-cli --config /data/profiles/u_X/signal-cli --service-environment LIVE daemon --http 127.0.0.1:10650
autostart=true
autorestart=true
startretries=5
stopwaitsecs=30
stderr_logfile=/data/profiles/u_X/signal-cli.err.log
stdout_logfile=/data/profiles/u_X/signal-cli.out.log
environment=
  TZ="%(ENV_TZ)s",
  XDG_DATA_HOME="/data/profiles/u_X/signal-cli"

[program:hermes-u_X-gateway]
command=hermes -p u_X gateway run
autostart=true
autorestart=true
startretries=5
startsecs=10
stopwaitsecs=10
stderr_logfile=/data/profiles/u_X/gateway.err.log
stdout_logfile=/data/profiles/u_X/gateway.out.log
environment=
  HERMES_HOME="/data/profiles/u_X",
  TZ="%(ENV_TZ)s"
```

supervisord has no ordered start dependencies between programs, but the gateway process's own retry-on-failure loop hitting `SIGNAL_HTTP_URL` handles ordering (it retries until signal-cli responds).

### Untouched

`acp_ws_server.py`, existing `acp` and `dashboard` programs, `HERMES_VERSION` pin.

---

## §7. Gateway Changes

### New module: `gateway/src/devices/signal/`

```
gateway/src/devices/signal/
├── signal-cli-client.ts        HTTP client wrapping signal-cli's JSON-RPC API
├── pairing-coordinator.ts      orchestrates link/poll/finalize FSM
├── pending-links.ts            in-memory pending-link registry (TTL + cancel)
└── port-allocator.ts           extends existing port allocator for signal_cli_port
```

`signal-cli-client.ts` — typed interface: `health()`, `startLink(deviceName)`, `listAccounts()`, `removeAccount(number)`, `getDeviceList(number)`. JSON-RPC over HTTP to `http://127.0.0.1:<port>` (loopback only).

`pairing-coordinator.ts` — FSM:

```
states: idle → provisioning → awaitingHealth → linking → awaitingScan → finalizing → linked
                                                       ↓ timeout / cancel
                                                   → cleaning → idle
                                                       ↓ apply failure
                                                   → failed (retry available)
```

One in-memory FSM per user; coordinator references the existing per-user apply mutex so pair flow cannot interleave with `apply()`.

### New API surface (`/api/devices/signal/*`)

| Method | Path | Body / Response | Auth |
|---|---|---|---|
| POST | `/api/devices/signal/link` | → `{ uri, expiresAt }` | session token |
| POST | `/api/devices/signal/link/cancel` | → `{ ok: true }` | session token |
| GET | `/api/devices/signal/link/status` | → `{ state, account_masked?, error? }` | session token |
| POST | `/api/devices/signal/unlink` | → `{ status: "unlinked" }` | session token |
| GET | `/api/devices` | → list of platforms + per-platform paired state | session token |

All endpoints scoped to the authenticated user's profile.

### Supervisor renderer extensions

`gateway/src/profile-store/profile-renderer.ts` (existing supervisor-program emitter):

- `renderSignalCliBlock(profile, ports)` — emits `[program:hermes-<uid>-signal-cli]` when `profile.devices?.signal?.paired === true`
- `renderGatewayBlock(profile)` — emits `[program:hermes-<uid>-gateway]` under the same condition
- Hermes `config.yaml` renderer: `renderGatewayConfigBlock(profile)` emits `gateway.platforms.signal` + `cron.default_deliver` when paired; omits when unpaired

### .env mutation helper

`gateway/src/profile-store/env-writer.ts` (new, small):

- `mergeSignalEnv(userId, { httpUrl, account, allowedUsers })` — atomic rewrite; adds/overwrites SIGNAL_* keys; preserves all other env lines
- `clearSignalEnv(userId)` — removes SIGNAL_* lines; atomic rewrite
- Uses the existing `writeFileAtomic` tempfile+rename pattern

### Apply orchestrator changes

- `render` step calls the new render functions when `profile.devices.signal.paired`
- `supervisorctl restart` target list expands to include `hermes-<uid>-signal-cli` + `hermes-<uid>-gateway` when present
- `pollHealth` adds: if Signal was paired, verify supervisord reports both new programs `RUNNING`

### Boot reconciler

`gateway/src/system-orchestrator/boot-reconciler.ts`:

- On boot, for each user where `profile.devices.signal.paired === true`:
  - Verify `/data/profiles/<userId>/signal-cli/` exists
  - Verify `.env` has `SIGNAL_HTTP_URL` and `SIGNAL_ACCOUNT`
  - Verify supervisor programs registered
- On any mismatch: log warning, clear `profile.devices.signal.paired`, mark `signal_paired_inconsistent` so the webui Devices tab shows "Re-link required"

### Webui module

`gateway/webui/src/components/settings/panes/devices-pane.tsx` — new file, follows existing pane conventions (`tools-pane.tsx` as reference). Imports `qrcode-svg` (added to webui `package.json`). Calls `/api/devices/*` endpoints. Reuses existing modal + destructive-confirm components.

### Tests

Per `.claude/rules/testing.md`:

- `signal-cli-client.test.ts` — wire-protocol mock against signal-cli's JSON-RPC envelopes for `startLink`, `listAccounts`, `removeAccount`. Guards adapter wire contract.
- `pairing-coordinator.test.ts` — FSM exhaustive transitions, especially timeout-during-link and apply-failure-after-link paths.
- `env-writer.test.ts` — atomic rewrite; preservation of non-SIGNAL lines; removal-only-of-SIGNAL lines.
- `boot-reconciler.test.ts` — extension: paired-but-missing-state detection.
- No tests for webui components, supervisor template strings, or DI wiring (covered by smoke / type-checking).

### E2E smoke (Playwright MCP)

Full Signal QR scan is operator-only (requires real phone). All non-scan paths covered by Playwright MCP smoke before pre-handover gate:

1. Devices tab — unpaired state renders correctly. Both viewports (1280×900 desktop, 390×844 mobile). Screenshot.
2. QR modal opens; QR SVG has non-empty path data; instruction list + countdown render; cancel button visible. Both viewports.
3. Modal cancel: closes modal, fires `/link/cancel`, no lingering `/link/status` polls.
4. Devices tab linked state (via test fixture setting `profile.devices.signal.paired=true` + mock `account_masked`): masked account + linked-at render; raw E.164 absent from DOM (grep with `browser_evaluate`); "How to use" block + red Unlink button visible.
5. Unlink confirm dialog: cancel path leaves linked state.
6. Unlink confirm dialog: confirm path fires `/unlink`, flips tab to unpaired, success toast.
7. Auth/sad paths: unauthenticated request → 401; double-click pair → 429; re-pair after unlink completes.
8. Console hygiene: `browser_console_messages` shows no unexpected WARN/ERROR.
9. Network contract: response shapes match documented schemas; no raw phone number in any response body (regex grep network log).

Evidence in `.playwright-mcp/devices-tab/`. Pre-handover gate = every case green, screenshots captured, console clean, lint/typecheck/unit green.

Operator validation deferred: real QR scan completing full pair → linked transition on Pi.

---

## §8. Security Posture, Cron, Open Items, Migration

### Security mitigations

| Threat | Mitigation |
|---|---|
| Stranger DM-pairing surface (Hermes built-in code-approval) | Disabled via `unauthorized_dm_behavior=ignore` + ALLOWED_USERS = self-only |
| Cross-user signal-cli bleed inside container | Each user has own `--config` dir, own loopback port, own supervisor program |
| signal-cli HTTP API exposed externally | Bound to `127.0.0.1` only, never published outside the container |
| signal-cli session keys at rest | Bind-mounted to host `~/.sentient/gateway/data/<userId>/signal-cli/`, `0700`, hermes user owner |
| Linked-device key during QR scan window | QR shown only inside authenticated webui session over TLS; URI 5-min TTL; cancel clears in-memory state immediately |
| Phone number disclosure via API / logs | E.164 stored only in `.env` (0600), masked in profile yaml, masked in all API responses, redacted in logs via existing Hermes `redact_phone()` |
| Toolset abuse over Signal (terminal-tool RCE from DM) | Toolset = user's voice toolset (per stated decision). User's voice toolset currently includes `terminal` — flagged as a known accepted posture |
| Cron leaking sensitive state to Signal | User must explicitly create cron jobs; `default_deliver=signal` only takes effect when paired |
| Account ban risk (Signal flags bot activity on real account) | Documented in webui Devices tab help text + handover doc; no programmatic mitigation possible |

### Cron behavior post-pair

- `cron.default_deliver: signal` rendered into Hermes config.yaml when paired.
- `cronjob_tools` `deliver` parameter still accepts explicit overrides (`deliver=voice`, etc.).
- Unpair → `default_deliver` removed → cron falls back to its built-in default.
- Cron jobs created before unpair: Hermes' scheduler logs a warning when a paired-only platform vanishes and falls back to `local` (built-in Hermes behavior).

### Open items requiring verification before merge

1. **Tinyproxy `Timeout` setting** in the `kalaksi/tinyproxy` config in use today — confirm `Timeout 0` or sufficiently high (≥ 86400s) for long-lived Signal WS. If too low, set `Timeout 0` OR add `chat.signal.org` to NO_PROXY.
2. **signal-cli pinned version** — verify against `https://github.com/AsamK/signal-cli/releases/latest` at branch creation.
3. **Java `https.proxyHost` honored by signal-cli's WebSocket transport** — verify in container during impl. If signal-cli bypasses JVM proxy for WS, accept direct egress and document it (audit story degrades but functionality is fine).
4. **`unauthorized_dm_behavior=ignore` honored end-to-end by Signal adapter** — confirmed in `_normalize_unauthorized_dm_behavior` source; verify the Signal adapter's allowlist code path respects it.
5. **Image rebuild time on Pi** — adding ~210 MB of Java + signal-cli. Estimate during first pi build; if > 15 min, consider CI prebuild path. Not a blocker.

### Backwards compatibility & migration

- Existing profiles: zero change. Renderer treats absent `profile.devices.signal` as `paired: false` → emits today's 2-program supervisor conf → no behavior change.
- Existing `.env` files: no SIGNAL_* lines today → no collision.
- Boot reconciler tolerates absent `devices` field (zod schema makes it optional).
- Gateway version bump: `1.4.4` → `1.5.0`.
- Hermes overlay version stays at `v2026.4.23` (no Hermes upstream change required).
- First boot after deploy: re-render of supervisor confs via existing boot-migration path. No user data touched.
- Rollback (1.5.0 → 1.4.x): renderer drops the new blocks → supervisor reread removes signal-cli + gateway programs → signal-cli state directory remains on disk untouched. Re-deploy 1.5.0 → users still paired, no re-link required.

### Risks accepted by user (per stated preferences)

- LAN trust; no disk encryption.
- Toolset over Signal = same as voice (terminal tool accessible from DM-to-self).
- Note-to-Self mode: Pi compromise = real Signal account compromise.
- Signal account ban risk from bot activity on real account.

---

## Implementation order (informational — full plan generated by writing-plans skill)

1. `feature/signal-device-pairing` branch from develop; gateway `1.4.4` → `1.5.0`.
2. Hermes overlay Dockerfile changes (Java + signal-cli). Local image build smoke.
3. Profile schema + .env writer + port allocator extensions. Unit tests.
4. signal-cli-client + pairing-coordinator + pending-links. Unit tests.
5. API handlers `/api/devices/signal/*`. Unit tests for handler routing.
6. Supervisor renderer extensions. Render-output snapshot tests.
7. Apply orchestrator + boot reconciler extensions. FSM-extension tests.
8. webui Devices tab + QR modal + unlink confirm. Component-style only; no unit tests.
9. Tinyproxy timeout audit + adjust if needed.
10. Playwright MCP smoke matrix (§7 list). Evidence captured.
11. Local macOS stack smoke per `feedback_local_smoke_before_pi.md`: edit soul + chat "hi" + open Devices tab + run smoke matrix. Verify before any Pi deploy.
12. Merge to develop. Pi deploy is a SEPARATE explicit user approval, per `feedback_never_pi_without_approval.md`.

---

## Glossary

- **Note to Self**: Signal's per-account self-thread. When signal-cli is linked as a secondary device on your own account, messages you send to yourself surface to signal-cli as `syncMessage.sentMessage` envelopes; signal-cli forwards them to Hermes; Hermes replies in the same thread.
- **Linked device**: a non-primary Signal client paired to a primary account via QR. Primary phone retains key ownership; linked device receives a copy of encryption keys for participation. Removable from the primary phone at any time.
- **Hermes gateway**: Hermes' built-in process that boots IM platform adapters per profile. Started by `hermes -p <profile> gateway run`. Not to be confused with the Sentient gateway (the Bun/TypeScript process at the repo root).
