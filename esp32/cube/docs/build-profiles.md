# Cube build profiles

Debug/prod builds and the prod-strip audit verify compilation and stripping, not runtime behavior. **Never flash placeholder credentials.** Unauthenticated debug LAN HTTP requires explicit approval before device testing. Hold-to-talk and current gateway protocol are implemented but device-unverified. **Prod provisioning/flash is not approved**; offline provisioning remains debug-only.

| | Debug | Prod |
|---|---|---|
| Config | `sdkconfig.defaults` + `sdkconfig.defaults.debug` | `sdkconfig.defaults` + `sdkconfig.defaults.prod` |
| Compiler | debug symbols/optimization | size optimization, assertions disabled |
| Devtool companion | USB verbs + HTTP enabled; UDP log relay **off** by default | disabled (stub; no debug HTTP/verbs/relay) |
| LVGL inspector metadata | enabled | disabled |
| Gateway transport | `wss://` with supplied certificate and hostname verification | `wss://` with supplied certificate or ESP-IDF CA bundle and hostname verification |

`esp32-devtool flash --profile debug|prod` builds with `SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.defaults.<profile>` and distinct `build/sdkconfig.debug` / `build/sdkconfig.prod`, but uses shared `build/` ELF output. Debug flash waits for companion `>>> READY` and settled state, **not gateway readiness**; prod reports `verification=flash-only`. Flash does not invoke credential baking. Do not flash from these docs; see [flash discipline](../../../agents/docs/esp32/cube/flash-discipline-details.md) for future approved hardware work.

## Explicit debug provisioning (offline)

From repository root after `source scripts/env.sh`, invoke `esp32-devtool bake-creds --input /absolute/path/to/private.json` explicitly. This project extension routes to [`../scripts/bake-creds.sh`](../scripts/bake-creds.sh); it accepts `--profile debug` only. Input must be operator-owned mode `0600` outside repository. See [script README](../scripts/README.md) for required JSON fields and constraints. Supply an existing authorized **test-user** PASETO token and certificate actually served by cube-facing TLS endpoint; script neither mints tokens nor scrapes services or `.e2e-testing`. Keep input values out of command arguments, logs, and Git. Generated `firmware/main/sentient_creds.h` and `sentient_dev_gateway.crt` are private, gitignored outputs. Reconfigure then rebuild after baking: CMake discovers certificate embedding at configure time. Baking never updates already-built or flashed images.

Offline provisioning validates certificate validity and SAN; runtime also verifies hostname and certificate trust. [`sentient_ws_protocol.cc`](../firmware/main/protocols/sentient_ws_protocol.cc) rejects plaintext URLs. `SENTIENT_DEV_TLS_PIN=0` uses ESP-IDF CA bundle, not plaintext. Device requires a certificate covering its actual LAN hostname/IP; localhost-only certificate is insufficient. Credentials, transcripts, and raw audio are not logged by the new protocol path. Approve LAN companion HTTP exposure and a disposable local test user before device smoke. No approved prod provisioning/flash procedure exists yet.

Capture failures cancel rather than submit known incomplete audio. Playback queues remain bounded; stalled playback fails visibly instead of silently dropping packets. Processor generation fences and output-drain checks cover software ownership, not proof of physical codec DMA drain or full AFE DSP reset. Reconnect requests a fresh snapshot, not journal replay. Pinned WebSocket dependency can wait internally during stop/destroy; lifecycle work stays off timer task and teardown aborts after its bounded wait rather than freeing live callback state. These paths still require device verification.

For build-only checks, keep profile-specific sdkconfig files separate; `idf.py -D SDKCONFIG=<absolute firmware path>/build/sdkconfig.<profile> reconfigure build` with matching `SDKCONFIG_DEFAULTS` chain. Do not reuse stale shared ELF for audit: after a prod build, run `esp32-devtool audit-prod-strip` against that prod ELF. See [build details](../../../agents/docs/esp32/cube/build-details.md). No managed-component TLS override/reapply step exists in current tree.
