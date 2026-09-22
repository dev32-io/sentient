# Cube build profiles

Debug/prod builds and the prod-strip audit verify compilation and stripping, not runtime behavior. **Never flash placeholder credentials.** Unauthenticated debug LAN HTTP requires explicit approval before device testing. Firmware prod still selects plain `ws://`, so **prod flash is not approved**. Cube protocol is still old; hold-to-talk is not implemented.

| | Debug | Prod |
|---|---|---|
| Config | `sdkconfig.defaults` + `sdkconfig.defaults.debug` | `sdkconfig.defaults` + `sdkconfig.defaults.prod` |
| Compiler | debug symbols/optimization | size optimization, assertions disabled |
| Devtool companion | USB verbs + HTTP enabled; UDP log relay **off** by default | disabled (stub; no debug HTTP/verbs/relay) |
| LVGL inspector metadata | enabled | disabled |
| Gateway transport in current firmware | `wss://` with supplied TLS leaf; runtime skips hostname check | `ws://` when `SENTIENT_DEV_TLS_PIN=0` — **not secure** |

`esp32-devtool flash --profile debug|prod` builds with `SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.defaults.<profile>` and distinct `build/sdkconfig.debug` / `build/sdkconfig.prod`, but uses shared `build/` ELF output. Debug flash waits for companion `>>> READY` and settled state, **not gateway readiness**; prod reports `verification=flash-only`. Flash does not invoke credential baking. Do not flash from these docs; see [flash discipline](../../../agents/docs/esp32/cube/flash-discipline-details.md) for future approved hardware work.

## Explicit debug provisioning (offline)

From repository root after `source scripts/env.sh`, invoke `esp32-devtool bake-creds --input /absolute/path/to/private.json` explicitly. This project extension routes to [`../scripts/bake-creds.sh`](../scripts/bake-creds.sh); it accepts `--profile debug` only. Input must be operator-owned mode `0600` outside repository. See [script README](../scripts/README.md) for required JSON fields and constraints. Supply an existing authorized **test-user** PASETO token and certificate actually served by cube-facing TLS endpoint; script neither mints tokens nor scrapes services or `.e2e-testing`. Keep input values out of command arguments, logs, and Git. Generated `firmware/main/sentient_creds.h` and `sentient_dev_gateway.crt` are private, gitignored outputs. Reconfigure then rebuild after baking: CMake discovers certificate embedding at configure time. Baking never updates already-built or flashed images.

Debug provisioning validates supplied certificate's validity and SAN offline, but current [`application.cc`](../firmware/main/application.cc) sets `skip_tls_cn_check=true` at runtime; it also connects only when other runtime conditions hold. Do not treat offline validation as end-to-end hostname enforcement. Current firmware also logs token preview in [`sentient_ws_protocol.cc`](../firmware/main/protocols/sentient_ws_protocol.cc). Resolve both security issues and approve LAN HTTP exposure before device smoke. `SENTIENT_DEV_TLS_PIN=0` currently chooses plaintext, not ESP-IDF CA bundle; no safe prod bake/flash procedure exists yet.

For build-only checks, keep profile-specific sdkconfig files separate; `idf.py -D SDKCONFIG=<absolute firmware path>/build/sdkconfig.<profile> reconfigure build` with matching `SDKCONFIG_DEFAULTS` chain. Do not reuse stale shared ELF for audit: after a prod build, run `esp32-devtool audit-prod-strip` against that prod ELF. See [build details](../../../agents/docs/esp32/cube/build-details.md). No managed-component TLS override/reapply step exists in current tree.
