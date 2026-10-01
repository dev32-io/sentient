# Cube BLE hardware protocol v1

Firmware/native integration contract. Gateway HTTP authority remains
`gateway/src/user-auth/device-registry.md`. No BLE agent traffic or custom crypto.

## Transport

ESP-IDF Protocomm Security2 **patch 1**, SRP-6a + AES-GCM. ESPProvision pinned at
`78e58f010f8539f800bce063a26d3e4c4ac596b9`. No security downgrade.
BLE service UUID `b4df5a1c-3f6b-f4bf-ea4a-82030490d71a` (Espressif provisioning
service); characteristics `ff51` = `prov-session`, `ff52` = `proto-ver`,
`ff53` = `cube-control`. Descriptors carry endpoint names. `proto-ver` exposes
only `{"prov":{"ver":"v1.0","sec_ver":2,"sec_patch_ver":1,"cap":[]}}`.
All control commands, including status, require authenticated encryption.
One connection/command at a time. Maximum plaintext request **496 bytes** (512-byte
CoreBluetooth write minus 16-byte GCM tag); maximum decoded response 2048 bytes.
Per-field limits do not waive the aggregate request limit. Reject oversized
serialized commands before sending; no custom fragmentation. Transport uses
standard long writes/reads. Handshake budget is 20 seconds; authenticated sessions
expire after `CONFIG_CUBE_BLE_SESSION_SECONDS` (default 300). Worker checks can be
delayed by one bounded HTTP request. Reconnect and re-read status after expiry.

Discovery name: `SC_` + first 12 UUID hex digits without hyphens. Names/UUIDs are
locators, not authority. QR is exact JSON:
`{version:1,deviceId:<lowercase UUID>,name:<locator>,transport:"ble",security:2,username:"cube-bootstrap",pop:<secret>}`.
Secrets are independent random 32 bytes, canonical unpadded base64url (43 chars).
Bootstrap SRP username is `cube-bootstrap`; manager username is `cube-manager`.

## Commands on cube-control

JSON objects; unknown/duplicate keys, unsupported version, invalid sizes/types
are rejected. Every command includes `version:1` and `op`.

| op | Additional fields | Authority / result |
|---|---|---|
| `status` | none | Bootstrap or manager; protected snapshot below |
| `install` | `deviceId,attemptId,generation,enrollmentSecret,managerSecret,gatewayOrigin,gatewayWsPath` | Bootstrap only; install reserved gateway attempt, independent manager verifier and device-generated renewal proof atomically. Reply `reconnect:true`; disconnect and reconnect as manager. |
| `enroll` | `deviceId,attemptId,generation,enrollmentSecret,gatewayOrigin,gatewayWsPath` | Manager only; same-attempt retry or strictly newer generation; existing gateway destination and manager verifier retained. Requires owner-side disable/enroll first. |
| `wifi.set` | `ssid,password` | Manager only. Durable network write then asynchronous join. Re-read status; acknowledgement is NOT connection success. |
| `wifi.clear` | none | Manager only. Clear network only; enrollment/manager authority retained. |
| `retry` | none | Manager only. Retry same durable enrollment/renewal proofs after transient failure; cannot reactivate disabled gateway authority. |

`gatewayOrigin`: DNS/IPv4 HTTPS origin only, no path/query/fragment/userinfo; max 192 bytes.
`gatewayWsPath`: absolute path, no query/fragment, max 96 bytes. TLS hostname and
CA validation mandatory; no trust material accepted over BLE. Debug can use
existing compiled development CA; production uses ESP certificate bundle.
SSID: 1–32 UTF-8 bytes, no embedded NUL. Password: empty (open), 8–63 UTF-8 bytes,
or 64 hexadecimal characters. Neither password nor credentials are returned.

Success: `{version:1,ok:true,...}`. Failure:
`{version:1,ok:false,error:"invalid-request"|"denied"|"conflict"|"storage"|"busy"}`.
Install/enroll acknowledgement includes `attemptId,generation,reconnect`.
Status fields: `deviceId,attemptId,generation,phase` (`bootstrap`,`pending`,
`committed`,`active`), `wifiConnected,wifiState,ssid,gatewayConnected,accountAttention,
lastError,firmware,batteryPercent,charging`. `wifiState` is `offline`, `joining`,
`connected`, or `failed`; firmware owns bounded connection attempts and reports
failure explicitly. Do not infer Wi-Fi success from acknowledgement or elapsed
time. Battery may be null when unavailable.
Gateway connected means authenticated WSS ready, not BLE connection or registry
status. No timers claim successful setup. Only active phase + authenticated WSS
indicate complete usable setup; BLE management works with Wi-Fi/gateway offline.

## Durable order / recovery

Phone saves manager secret before owner-authenticated `/enroll`, preserves stable
attempt/enrollmentSecret across interruption, then sends `install`. Firmware
persists pending attempt, renewal secret and manager SRP verifier **before** any
HTTP redemption. Installing immediately retires bootstrap authority (stricter
than retiring immediately before activation). Existing bootstrap session cannot
issue more commands after install; reconnect with manager secret even when reply
was lost. Old QR never works again. Native must not overwrite a retained manager
secret with a newly generated one when resuming.

Firmware redeems identical persisted proof. Lost successful reply repeats redeem;
committed/active retries remain valid after attempt expiry. Commit is persisted
before activate; active persisted after validated activation reply. Lost activate
reply repeats activate. Active boots renew; bearer never persists in flash.
Authorization failures stop automatic retries; manager retry does not bypass
registry checks. Re-enrollment requires same manager, same gateway, fresh attempt
and a generation above the last **gateway-confirmed** generation. An uncommitted
bogus high generation cannot permanently poison recovery. Network reset/outage
never enables bootstrap or an AP. Five bounded HTTP attempts use backoff;
`Retry-After` is honored within a 1–300 second bound. Verified TLS requires network
time (`CONFIG_CUBE_NTP_SERVER`); unavailable time is a reported failure, never a
certificate-validation bypass. Proactive renewal uses
`CONFIG_CUBE_RENEW_INTERVAL_SECONDS`, which must stay below gateway access TTL.

## Storage/install boundary

No existing offsets move. Gap allocation: `cube_auth` NVS at `0x10000`, size
`0xf000`; `cube_seal` initialization marker at `0x1f000`, size `0x1000`.
Separate marker prevents NVS recovery from interpreting a missing/corrupt enrolled
record as fresh hardware. Marker is not a credential or a physical activation lock.
No automatic erase of either partition. Fresh initialization accepts only erased
storage; interrupted unpublished initialization may resume. Once publication marker
is written, absent/invalid enrollment is fatal recovery state, never new identity.
Default NVS resets (main boot repair, WifiManager repair, SystemReset) do not touch
these partitions. Network credentials live in default NVS separately. Cube factory
reset does not select an older OTA slot that might predate enrollment enforcement.
Debug LAN snapshots refuse bootstrap-display capture. At-rest flash encryption and
physical anti-rollback are not claimed; physical flash access remains outside this
software-only enrollment boundary.

### DEBUG USB diagnostics (restricted status surfaces)

`esp32-devtool --json cmd cube.hardware.status` uses existing USB-CDC command
transport in DEBUG firmware. Result contains only phase, fixed error category,
BLE transport/connection/auth readiness, Wi-Fi/gateway flags, heap and task
counters. `state` may still say `UNKNOWN` during bootstrap; it is application
voice state, not hardware enrollment state. Neither verb returns QR/PoP.

This restriction does not cover all registered diagnostics: current `ui.dump_tree`/`ui dump-tree` exports label text, including populated hidden pairing-proof labels, and `sentient.last_transcript` exports transcript text. Do not invoke these with protected or real-user content. Screenshot refusal does not protect tree dumps. This is an open firmware export-boundary gap, not a claim that all debug output is sanitized.

Do **not** add a `cube.bootstrap.export` verb: devtool replies are printed on
USB stdout and may enter daemon rings, terminal scrollback, or agent transcripts;
USB possession alone does not protect secret transport or storage. If a camera-free test is explicitly approved by the hardware owner, only that operator may use a local debugger on the physically held development Cube to inspect `CubeHardware::Presentation().qr`
**only while `setup` is true**, compare its exact JSON against the visible QR,
and hand it directly to the authorized debug phone in a private channel. Keep
capture outside the repository, mode 0600; never print it to a terminal, daemon
ring, HTTP endpoint, or agent transcript. Delete capture after use. If a
protected end-to-end USB transfer becomes available, design and review that
transport before exporting the proof. Existing LAN screenshot refusal remains.

**No flash authorized.** Parent must approve disposable target and confirm/backup
its actual layout before staged installation. Existing-layout upgrades need explicit
inspection of gap contents; nonblank unknown data fails closed, never gets erased
implicitly. No erase-all, eFuse, OTA or production operations. Hardware power-loss,
QR legibility, BLE interoperability, heap/audio coexistence remain physical gates.

## SDK compatibility and build evidence

IDF 5.5.2's `esp_srp_gen_salt_verifier` returns a minimal-width MPI salt without
reporting its actual length. `firmware/scripts/patch_srp_salt.py` generates a
build-local copy of upstream SRP source that left-pads salt **before hashing and
exporting**, preventing short allocation reads and mismatched proofs. No SRP or
AES algorithm is replaced; installed SDK is untouched. Changed upstream source
fails configuration until this narrow patch is reviewed. Short verifiers are
left-padded on storage. Upstream SRP/key DEBUG dumps are compiled out, including
when runtime logging is increased; HTTP header DEBUG dumps are also removed.

Historical isolated debug-build evidence (revision/configuration provenance must be re-established before reuse; not current-tree validation): Security2/NimBLE enabled, binary `0x3a6e00`,
`0x49200` app-slot headroom (7%); static DIRAM remaining 135,977 bytes. These are
build measurements, **not runtime free-heap evidence**. Host checks execute
publication/commit fault cases, role retirement, gateway lost-reply/revocation and
late-response fences, callback lifetime, and salt-width handling under ASan.
Native setup/hub orchestration and physical interoperability are separate gates.
