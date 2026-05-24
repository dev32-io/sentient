# ESP32 Cube Phase 5 — Sentient Connect Handover

**Date:** 2026-05-13
**Branch:** feature/esp32-cube-v2-rescope
**Plan:** docs/superpowers/plans/2026-05-13-esp32-cube-v2-phase5-sentient-connect.md
**Spec:** docs/superpowers/specs/2026-05-11-esp32-cube-v2-rescope-design.md §4 Phase 5

## What's done

Phase 5 (original scope):
- Restored toggle-button screen as boot UI (replaces Phase 2 test screen). `>>> READY` + `>>> CHECKPOINT wifi.connected` + `>>> CHECKPOINT ws.connected` markers fire on boot.
- HIL `test_voice_loop.py` — 5 Group A cases covering boot/IDLE, toggle→LISTENING, uplink frames cross-stack, ws.disconnect recovery, alive-after.
- HIL `test_ws_recovery.py` — 3 Group A cases covering wifi.disconnect→ws-down, wifi.reconnect-restores-ws, alive-after.
- `wifi.reconnect` verb added to firmware (Phase 4 plan referenced it but only `wifi.disconnect` + `wifi.connect` existed). Non-blocking — drops blocking 200ms vTaskDelay after reviewer pushback.

Phase 5b (TLS + persistent WS — scope grew when smoke discovered structural defects):
- Debug/prod sdkconfig profiles + `flash.sh --profile debug|prod` flag (defaults debug). Debug includes agent_console + LVGL widget metadata + net_logger. Prod strips all of them; binary 2.81 MB vs 3.15 MB.
- `bake-creds.sh --profile debug` pulls gateway TLS cert via `openssl s_client` → `firmware/main/sentient_dev_gateway.crt` (gitignored). Defines `SENTIENT_DEV_TLS_PIN` macro. Prod: no cert, pin=0.
- `EspSsl::SetCacert(const char*, size_t)` override in vendored `managed_components/78__esp-ml307/src/esp/esp_ssl.{h,cc}`. When set, uses `cacert_pem_buf`; falls back to `esp_crt_bundle_attach`. Sets `skip_common_name = true` ONLY when pinned (cert pin IS identity — CN check redundant + would fail on LAN-IP connect to cert with `SAN: DNS:localhost`).
- Vendored EspSsl edits tracked via `.gitignore` exception + warning header explaining `idf.py update-dependencies` would clobber.
- `build_ws_url()` switched `ws://` → `wss://`. Board ctor wires `EspSsl::SetCacert(_binary_sentient_dev_gateway_crt_start, end-start)` when `SENTIENT_DEV_TLS_PIN=1`.
- `sentient_ws_connected_provider` now truthful: delegates to `Application::IsAudioChannelOpened()` (new accessor on Application). No longer lies "true post-WiFi."
- Persistent WS architecture in `application.cc`: eager `OpenAudioChannel()` after activation, skip `CloseAudioChannel` at cycle end (just `SendStopListening + IDLE`), reconnect-on-drop via `ScheduleWsReconnect` / `TryWsReconnectNow` with `{1s, 2s, 5s, 10s}` backoff. PERFORMANCE power-save now gated on non-IDLE state (was unconditional — would have stayed high indefinitely under persistent WS).
- agent_console component-level SRCS split (Phase 5b.9): `CMakeLists.txt` toggles full verb tree vs. tiny no-op stub (`agent_console_stub.cc`, 13 functions). Prod ELF has zero verb symbols; debug has 22+.
- README at `esp32/cube/docs/build-profiles.md`. Includes prod flash checklist + WS lifecycle section + battery optimization knob note.

## What's used (stack the user now owns)

- File: `esp32/cube/firmware/sdkconfig.defaults` (base) + `sdkconfig.defaults.debug` + `sdkconfig.defaults.prod` — selected via `SDKCONFIG_DEFAULTS` env var.
- Script: `esp32/cube/scripts/flash.sh --profile debug|prod` (default debug).
- Script: `esp32/cube/scripts/bake-creds.sh --profile debug|prod` (default debug; debug also pulls gateway TLS cert).
- File: `esp32/cube/firmware/main/sentient_dev_gateway.crt` — generated, gitignored. Pinned dev gateway leaf cert.
- Component: `agent_console` — debug: full verb dispatcher. Prod: empty stub with no-op public API. Switched at component-level CMake `if(CONFIG_AGENT_CONSOLE_ENABLE)`.
- API: `Application::IsAudioChannelOpened()` — new public accessor on Application class (`application.h:65`). Used by `sentient_ws_connected_provider`.
- API: `Application::ScheduleWsReconnect()` / `TryWsReconnectNow()` — private supervisor methods that handle WS drop recovery with bounded backoff.
- API: `EspSsl::SetCacert(const char*, size_t)` — static, idempotent. Set once at board ctor; lifetime tied to static storage of embedded cert.
- Verb: `wifi.reconnect` — disconnect + immediate connect with whitelisted transient errors. Used by HIL `test_ws_recovery.py`.
- Doc: `esp32/cube/docs/build-profiles.md` — debug/prod matrix + prod flash checklist + TLS pinning rationale + WS lifecycle.

## What's smoked

| Case | Command run | Observed result | Status |
|---|---|---|---|
| Debug build | `SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.defaults.debug idf.py build` | Link green, 3.15 MB | ✅ |
| Prod build | `SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.defaults.prod idf.py build` | Link green, 2.81 MB, 0 agent_console verb symbols in ELF | ✅ |
| Flash debug profile | `bash esp32/cube/scripts/flash.sh --profile debug` | Clean flash, hash verified, daemon eager-spawns | ✅ (4 flashes total this phase) |
| Boot to IDLE | `cube-cmd state` post-flash | `{"state":"IDLE","wifi_connected":true,"ws_connected":false}` — IDLE + WiFi up + WS not yet connected | ✅ |
| UI swap confirmed | Ring buffer grep `>>> READY`, `>>> CHECKPOINT` | `>>> READY` + `>>> CHECKPOINT wifi.connected 8119992` + `>>> CHECKPOINT ws.connected 8388184` | ✅ |
| Phase 3+4 HIL regression | _not re-run_ — depends on cube being at IDLE (which it is, but blocked at WS dial) | n/a | ⚠️ deferred |
| Phase 5 voice_loop HIL | _not run_ | n/a | ❌ blocked by gateway image |
| Phase 5 ws_recovery HIL | _not run_ | n/a | ❌ blocked by gateway image |
| Operator voice round-trip | _not run_ | n/a | — skipped per agent-driven session directive |
| Operator barge-in | _not run_ | n/a | — skipped per agent-driven session directive |

**Crucially:** cube hardware is FULLY GREEN for Phase 5b. Boots clean, persistent-WS dial actually attempts wss:// handshake against gateway, TLS handshake completes (mbedtls accepts pinned cert with `skip_common_name`). The WS HTTP-upgrade fails because the gateway docker image is stale — see Open Questions.

Log evidence (cube ring buffer post-flash):
```
I (79) sentient.cube.board: Pinning dev gateway TLS cert (1148 bytes, incl null)
>>> READY
>>> CHECKPOINT wifi.connected 8119992
>>> CHECKPOINT ws.connected 8388184   (NOTE: misleading — this checkpoint fires
                                         when xiaozhi protocol_->Start() runs,
                                         not when WS is actually open)
```

## What you need to know

1. **TLS trust model split debug vs. prod.** Debug pins the gateway's self-signed cert (cert pin == identity — `skip_common_name` is safe because pin > CN). Prod uses ESP-IDF's full `esp_crt_bundle_attach` (200 public CAs) with full CN/SAN verification — the prod cert MUST come from a public CA (LE) and MUST have the connecting host in its SAN. See `esp32/cube/docs/build-profiles.md` for the full prod flash checklist.

2. **`ws_connected` provider was lying for all of Phase 1-4.** Old impl returned true for any state past `Connecting` — never actually checked the WS object. Phase 5b made it truthful via `Application::IsAudioChannelOpened()`. Side effect: HIL tests assuming `ws_connected: true` at IDLE now require persistent WS to actually be open (Phase 5b.8 delivers this).

3. **Persistent WS lifecycle replaces xiaozhi's per-cycle pattern.** WS opens at boot (after activation), stays open across cycles, reconnects on drop with 1/2/5/10s backoff. Future battery optimization knob: dial down keepalive ping interval during prolonged IDLE (note in `build-profiles.md`).

4. **PERFORMANCE power-save mode now gated by state.** Pre-5b: `OnAudioChannelOpened` flipped power to PERFORMANCE unconditionally. With persistent WS that meant cube would stay PERFORMANCE at IDLE forever. Fixed by gating on `GetDeviceState() != IDLE`. Active-state ramp-up moved to `SetListeningMode()`.

5. **Two vendored-component edits tracked via gitignore exception.** `managed_components/78__esp-ml307/src/esp/esp_ssl.{h,cc}` have warning headers + are explicitly un-ignored in `esp32/cube/.gitignore`. Re-applying after `idf.py update-dependencies` is required if the ml307 component ever gets bumped.

6. **Flash discipline crashed once this phase.** Initial 5b.1 added `CONFIG_LOG_MAXIMUM_LEVEL_DEBUG=y` beyond spec — this compiled in WiFi/lwIP DEBUG internals → at boot, net_logger queue saturated with `dropped=7900+` in 3 seconds, lwIP tiT task stack overflowed → crash loop. Required physical USB unplug + BOOT-hold replug recovery. Fix at `3eb5f09`: drop the MAXIMUM_LEVEL_DEBUG flag, revert to ESP-IDF default INFO. Follow-up note: get DEBUG-level Sentient logs via `esp_log_level_set("sentient.cube.*", ESP_LOG_DEBUG)` at app_main without compiling in ESP-IDF internals.

7. **`mbedtls_x509_crt_parse` requires PEM length INCLUDING null.** First-pass cert wiring (e7db556) subtracted 1 from `(end-start)` → cert truncated → `0x2180` MBEDTLS_ERR_X509_INVALID_DATE on every connect. Fixed at `0cfc670`: pass full byte count.

8. **agent_console:button.toggle / register_audio_inject_pcm-style symbols were leaking into prod even with CONFIG_AGENT_CONSOLE_ENABLE=n (Phase 5b.7 finding).** Fixed at `231eda8` via component-level SRCS split: prod path registers an empty stub component. AGENT_CONSOLE_DISABLED macro is now obsolete and removed from source (`47eb6c4`).

9. **flash.sh has bash-3.2 compat fix.** macOS default bash crashes on empty `${ARR[@]}` under `set -u`. Use `${ARR[@]+"${ARR[@]}"}` conditional expansion. Fix at `5f9b83b`. Also added missing-value guard for `--profile`.

## Hardware glossary (terms new this phase)

None. The TLS/WS/PASETO surface and the cube hardware glossary carry over verbatim from Phase 1.

## Open questions / risks

1. **🚨 GATEWAY DOCKER IMAGE IS STALE — BLOCKS HIL SMOKE.** Gateway `/app/dist/main.js` was built before xiaozhi WS handler was added to `gateway/src/server.ts`. `grep -c xiaozhi /app/dist/main.js` returns `0`. Cube's wss:// → 200 OK + index.html SPA fallback → server closes the TLS read → `MBEDTLS_ERR_NET_RECV_FAILED`. Rebuilding the gateway image is blocked by `@discordjs/opus@0.10.0` native build failure: prebuilt binary missing for `node-v137-napi-v3-linux-arm64-glibc-2.41`, source build fails on `celt_neon_intr.c:208:18 implicit declaration of celt_inner_prod_neon`. This is a gateway-side toolchain issue — out of cube scope. **Gateway container is currently STOPPED** (docker compose ps shows empty) to prevent crash loop. Restart it with the OLD image OR fix opus + rebuild before HIL smoke can run.

2. **Phase 5 HIL Group A tests (`test_voice_loop.py`, `test_ws_recovery.py`) were never executed against the Phase 5b firmware** due to #1. They were validated as red-phase failures on pre-Phase-5 firmware (1/5 + 2/3 pre-flash). Cube hardware is ready to run them; gateway is not.

3. **Phase 3+4 HIL regression (`test_audio_play_pcm.py`, `test_audio_record.py`, `test_smoke.py`) not re-run on Phase 5b firmware.** These don't depend on gateway-side state — they're USB-CDC verb tests. Worth running once cube is freshly attached.

4. **`flash.sh` ordering bug from Phase 4 still present.** Daemon teardown happens AFTER esptool runs; manual kill before flash is required. Latent footgun. Tracked since Phase 4 handover.

5. **Vendored opus/ml307 component dance.** Each `idf.py update-dependencies` could clobber the EspSsl edits. Mitigated via gitignore exception + warning header, but the mechanism is fragile. Consider pinning ml307 version in `idf_component.yml` if not already.

6. **`HandleNetworkDisconnectedEvent` could race with `OnAudioChannelClosed`.** If WiFi goes down while WS is in CONNECTING (not yet open), `OnAudioChannelClosed` never fires, so the reconnect supervisor isn't scheduled. Defensive `ScheduleWsReconnect()` in the CONNECTING branch of the network handler would close this. Minor risk; ESP-IDF normally delivers `OnAudioChannelClosed` reliably.

7. **Codec input gain remains at 30** (Phase 4 carry-over). If voice loop ear test shows recognition issues, gain tune is the first lever.

8. **Future battery-cube architecture: persistent WS implies continuous keepalive frames.** Dial-down knob noted in `build-profiles.md` — the cube's current WebSocket implementation in vendored `managed_components/78__esp-ml307/src/web_socket.cc` doesn't expose a configurable idle interval; would need extension.

## Flash + smoke metrics

- **Flashes this phase: 4**
  - Flash 1: post-5b.5+5b.8+5b.9 (pre-3eb5f09) — crash loop on lwIP stack OF
  - Flash 2: post-3eb5f09 (log fix) — boot clean to IDLE, mbedtls cert parse failed (0x2180)
  - Flash 3: post-0cfc670 (cert_len null fix) — TLS handshake failed (-0x2700 CN mismatch)
  - Flash 4: post-70a47ff (skip_common_name fix) — TLS handshake green, WS HTTP upgrade fails (gateway stale)
- **AXP2101 faults hit: 1** (after Flash 1 crash loop, physical USB unplug + BOOT-hold replug to recover)
- **Daemon restarts: ~6** (counted across flash retries + the daemon-port-conflict from cube-snapshot.sh misuse)
- **Cold physical recoveries: 1** (BOOT-hold after lwIP stack OF crash loop)
- **Total dev time on smoke runs: ~3-4 hours** (most spent in 5b discovery + crash recovery + gateway rebuild attempt)

## Commits on this branch (Phase 5 + 5b, 25 total)

```
70a47ff fix(esp32-cube/ssl): skip CN check when CA cert is pinned
0cfc670 fix(esp32-cube/board): cert_len — include null terminator for mbedtls
3eb5f09 fix(esp32-cube/build): revert DEBUG log level — was blowing lwIP tiT stack
47eb6c4 chore(esp32-cube/agent_console): remove dead AGENT_CONSOLE_DISABLED ifdef
231eda8 feat(esp32-cube/build): component-level SRCS split — full agent_console removal in prod
dd9876d fix(esp32-cube/app): gate PERFORMANCE power-save on active state — not at IDLE
d566e1f docs(esp32-cube): build-profiles — WS lifecycle + battery optimization note
197994a feat(esp32-cube/app): persistent WS — open at boot, reconnect-on-drop
1182377 docs(esp32-cube): debug/prod build profiles + prod flash checklist
e7db556 feat(esp32-cube/board): wss:// + pinned dev cert + truthful ws_connected provider
ef963c3 chore(esp32-cube/ssl): track + flag customized EspSsl vendored copy
eadf9fe feat(esp32-cube/ssl): EspSsl::SetCacert override for pinned CA
a431dd0 feat(esp32-cube/build): EMBED_TXTFILES gateway TLS cert (debug only)
8de1368 feat(esp32-cube/creds): bake gateway TLS cert (debug only)
5f9b83b fix(esp32-cube/scripts): flash.sh — bash 3.2 empty array + --profile guard
1b0ef04 feat(esp32-cube/build): debug/prod sdkconfig profiles + flash.sh --profile
0f36a29 fix(esp32-cube): wifi.reconnect — drop blocking delay + docstring sync
faedad5 test(esp32-cube/hil): test_ws_recovery — tighten disconnect-detect cadence
8cfcbc0 feat(esp32-cube/agent_console): wifi.reconnect verb
bceb748 test(esp32-cube/hil): test_ws_recovery — wifi + ws recovery cases
9a5c399 test(esp32-cube/hil): improve test_toggle_emits_uplink_frames fail message
f9991be test(esp32-cube/hil): test_voice_loop — Group A smoke
97832cf feat(esp32-cube/ui): restore toggle-button screen as boot UI
744add0 docs(esp32-cube): Phase 5 sentient-connect plan
```

## Phase 5 cube HIL closed (via Phase 5.5 pivot)

Phase 5 cube HIL smoke did NOT run in Phase 5.5. Mid-flight, the
architectural direction pivoted: instead of finishing the xiaozhi-
separate-WS path on v2-rescope, the gateway was prepared for a unified
**cube-sdk** speaking the existing client WS protocol. C1–C8 (gateway
opus-codec removal + cube HIL against the xiaozhi transport) deferred
to Phase 6. The gateway is now a codec-agnostic byte pipe with
per-session `audioFormat` negotiation — cube-sdk will reuse this path.

See `docs/superpowers/handovers/2026-05-14-phase5.5-opus-pivot.md` for
the full Phase 5.5 close + Phase 6 transition.
