# Cube registry HTTP contract — version 1

Device-purpose tokens are admitted to native WebSocket agent sessions only after
registry validation. Human tokens never acquire Cube authority from client
metadata. BLE setup and physical interoperability remain deferred.

All routes require the gateway's TLS listener (including behind inbound-proxy,
which uses HTTPS upstream). Forwarded headers cannot enable plaintext access.
Responses use `Cache-Control: no-store`. POST bodies require `application/json`;
unknown fields, versions, invalid UUIDs and noncanonical secrets are rejected.
Secrets are independently generated random 32-byte values, encoded base64url
without padding. Never log bodies, authorization headers or recovered secrets.

## Routes

Prefix: `/api/v1/devices`. Success bodies are registry values, not envelopes.
Owner routes require a human session bearer, resolve current owner role, then
mint `device-registry` capability. Static admin and device tokens cannot use them.

| Route | Body / authority | Response |
| --- | --- | --- |
| `GET /` (no trailing slash) | Human owner | Array of owned status records |
| `POST /enroll` | Human owner; `{version:1, deviceId, attemptId, enrollmentSecret, managerSecret}` | Status |
| `POST /recover` | Human owner; `{version:1, deviceId}` | Status + `managerSecret` |
| `POST /disable` | Human owner; `{version:1, deviceId}` | Disabled status |
| `POST /redeem` | `{version:1, deviceId, attemptId, generation, enrollmentSecret, renewalSecret}` | Committed status |
| `POST /activate` | `{version:1, deviceId, attemptId, generation, renewalSecret}` | Active status + `token` |
| `POST /renew` | Same proof as activate; no bearer exchange | Status, with `token` only if active |

Status: `{version:1, deviceId, attemptId, generation, deviceClass:"cube",
status:"pending"|"committed"|"active"|"disabled", expiresAt}`.
`expiresAt` is the enrollment-attempt deadline in Unix **milliseconds**, not token
expiry. Access tokens expire per `devices.access_ttl_seconds` from issuance.

## Durable order and retry

1. Phone durably saves manager secret, calls enroll with one stable attempt.
   Retry identical enroll on lost response; only one owner can reserve hardware.
2. Install matching attempt/generation and manager state on Cube. Cube generates
   and durably saves renewal secret **before** redeem. Gateway stores verifier only.
3. Redeem atomically commits verifier. A lost response is recovered by repeating
   identical redeem or renewing with persisted proof. Committed renew has no token.
4. Cube durably retires bootstrap and confirms matching manager state before
   activate. Repeated activate returns active status and fresh device token.
   Gateway cannot independently prove local flash writes; firmware must uphold order.
5. Attempt expiry blocks first redemption, not already committed retries/activation.
   An expired pending reservation retains ownership. Owner disables it and begins
   a new attempt, preserving manager secret and incrementing generation.

Disable is idempotent, denies credentials, retains ownership and encrypted BLE
recovery. Recover never reactivates. Re-enrollment requires explicit disable and
fresh attempt; manager rotation/ownership transfer are not offered. PIN changes
preserve pairing; role changes suspend it until explicit re-enrollment. Deletion
purges escrow/verifiers but retains nontransferable tombstone. Startup reconciles
missed deletion hooks; unreadable owner storage fails reconciliation closed.

Errors: `{error, retryable}`. `invalid-request` 400; `denied` 403; `conflict` 409;
`expired` 410; `escrow-unavailable` 503 (operator repair, not automatic retry).
Transport errors include `unauthorized` 401, `tls-required` 403, `body-too-large`
413, `json-required` 415, `request-timeout` 408, `rate-limited` 429, `unavailable`
503. Only 408, 429 and unexpected 503 are retryable. Honor `Retry-After` on 429;
use capped backoff and finite retries, preserving the same attempt/proofs. No
server-side retry loops. Authorization failure must not cause endless renewal.

## Operator state

`gateway/config.yaml#devices` controls TTLs, byte/deadline limits, global
requests/minute and concurrency. Global limits include invalid requests and do
not trust forwarded IP/device IDs. This bounded budget can throttle legitimate
clients during abuse; it is not per-client fairness or distributed DoS protection.

State lives under `SENTIENT_GATEWAY_ROOT` (default `~/.sentient/gateway`):
`devices.db` and separate `device-escrow.key`. First startup provisions 32 random
key bytes with exclusive creation, mode 0600 and fsync, only if registry is absent.
Existing key must be a restricted regular file, not a symlink. Missing key with
existing registry, bad length or permissions fails startup. Restore original key;
never delete registry or generate replacement as a repair. Back up key separately
from ciphertext and preserve permissions. Account access-key loading retains
existing `auth-secret.key` / `SENTIENT_AUTH_SECRET_KEY_BASE64` conventions; escrow
never uses that key. Host compromise remains outside at-rest encryption protection.

## Native WS/runtime contract

The auth gate validates device-purpose tokens through the registry and retains
its frozen credential and principal. Initial origin is
`{kind:"cube", deviceId, generation}`; it is copied into the initial capability.
Current registry membership, generation, owner role/revision and credential
lifetime are checked at input, provider continuation and tool dispatch, including
a synchronous fence after async policy reads. Ordinary PIN changes preserve
pairing; role changes suspend existing devices until explicit re-enrollment.

Cube configure is a lazy draft: request anchors, surface IDs and client class do
not choose execution provenance or daily association. Text and STT capture a
store fence before current authorization, then atomically admit into the daily
association using gateway receipt time and configured dreaming hour. An active
turn retains its session across the boundary; next idle input rolls. The runtime
consumes the committed entry, never appends it twice. Retry receipts never start
a second execution, including after restart; provider exactly-once execution
across crashes is not promised. Cube TTS ignores human text/mute preferences,
while voice selection still comes from the profile. STT retains the native wire.

Human history uses owner-scoped REST only. Cube history cannot acquire human WS
runtime authority, including through configure/activate, pipelined input, voice,
interrupt, approval or draft recovery. Owned deletion remains available via REST.

Disable and pre-write role/deletion hooks close **all** of that user's open Cube
stores, including inactive periods, before registry/user mutation. User writes
are fenced again after file replacement to reject queued enrollment snapshots.
A failed mutation can conservatively leave devices suspended; no automatic
reactivation occurs. Stores and admission fences are durable; sockets lose
admission and runtimes request cooperative turn/voice abort. Old dispatch,
continuations, completion stimuli and writers cannot reopen retired history.
Startup reconciles registry records with owner state before admitting sockets.
Shared grants across physical Cubes use conservative closure. Already-started
external/delegated effects are not claimed cancelled.

Access expiry retires the immutable runtime credential, not open daily history.
Fresh valid credentials may replace that expired runtime over the still-open
store; old runtime writers remain locally fenced. This path never replaces a
runtime over a durably closed/deleted store. A subsequent newly authorized input
alone creates a fresh association after disable or history deletion.

Integrated synthetic WS tests cover real registry/store/runtime/broker routing,
STT/TTS adapters, concurrency/retry/restart, rollover, expiry/renewal, role/delete/
disable, queued admission and dispatch races, and late results. No live provider,
hardware, BLE or production validation is implied; independent review remains.

## Tool-policy and client contract

Cube-derived capabilities cannot manage owner registry resources. Per-tool
policy remains independent of ordinary surface settings.

Per-user choices reuse `profile.tools.permissions.cube`, a tool-name map:

```json
{"tools":{"permissions":{"cube":{"search_web":"allow","delegateTask":"off"}}}}
```

This is the permissions fragment of the existing full profile PUT body, not a
new partial-body endpoint. Existing `GET/PUT /api/v1/profile/me` schemas/merge
rules apply: omitted keys preserve values; `null` clears an override. Within
Cube execution, explicit tool wins `"*"`, then absent means `off` (never normal
surface defaults). Thus clearing falls to a configured wildcard, otherwise off.
Values remain `allow`, `ask`, `deny`, `off`; existing role/risk gates still apply.
Unreadable profiles discard cached Cube choices, without changing ordinary
surface cached permissions. The catalog cannot use server/group name `cube`,
preventing ordinary role-default seeding from enabling Cube tools.

`delegateTask` is configurable in this same map. Enabling it permits delegated
execution under existing broader per-user authority, NOT Cube attenuation.
Disabling it blocks future parent dispatch, not external work already started.
No downstream attenuation or cancellation guarantee is added.

REST session projections now carry authoritative `provenance`, `readOnly`,
`currentPin` and `executionClosed` fields. Clients must retain those fields and
use REST-only history for Cube rows, never infer authority from surface names.
Client UI integration and independent E2E validation remain separate work.
Existing catalog projections still describe ordinary effective permissions;
clients must not label those as Cube effective permissions.
