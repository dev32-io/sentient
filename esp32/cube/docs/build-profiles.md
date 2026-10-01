# Cube build profiles

Debug/prod builds and prod-strip audit verify compilation/stripping, not device behavior. Never flash unreviewed compile-only placeholders. Device access and unauthenticated debug LAN HTTP exposure require explicit approval. No production provisioning/flash is authorized by this document.

| | Debug | Prod |
|---|---|---|
| Config | `sdkconfig.defaults` + `sdkconfig.defaults.debug` | `sdkconfig.defaults` + `sdkconfig.defaults.prod` |
| Compiler | debug symbols/optimization | size optimization, assertions disabled |
| Devtool companion | USB verbs + HTTP; UDP relay off | disabled via stub; verify ELF stripping |
| LVGL inspector metadata | enabled | disabled |
| TLS profile gate | `CONFIG_SENTIENT_PROD_BUILD=n` | `CONFIG_SENTIENT_PROD_BUILD=y` |
| HTTPS/WSS trust | Supplied `sentient_dev_gateway.crt` when present, otherwise ESP CA bundle; date/hostname verification | ESP CA bundle; date/hostname verification; no development cert embedded |

## Build-only workflow

Use reviewed ESP-IDF 5.5.2 sources and dependencies. `>=5.5.2` in the dependency manifest is a minimum, not permission to upgrade blindly: CMake's reviewed source patches are hash-pinned. On mismatch, stop for review; never bypass guards or mutate the installed SDK.

From repository root, source `scripts/env.sh`, load the reviewed ESP-IDF environment, then:

```sh
cd esp32/cube/firmware
SDKCONFIG_DEFAULTS='sdkconfig.defaults;sdkconfig.defaults.debug' \
  idf.py -D SDKCONFIG="$PWD/build/sdkconfig.debug" reconfigure build
SDKCONFIG_DEFAULTS='sdkconfig.defaults;sdkconfig.defaults.prod' \
  idf.py -D SDKCONFIG="$PWD/build/sdkconfig.prod" reconfigure build
esp32-devtool audit-prod-strip
```

Profile configs differ, but ELF output is shared in `build/`. Audit prod strip immediately after the prod build, not against a stale debug ELF. CMake applies reviewed build-local TLS, provisioning and other source corrections automatically; no manual installed-SDK or managed-component patch reapply is required. See [build details](../../../agents/docs/esp32/cube/build-details.md).

## Enrollment and development trust

Current account/device authority and Wi-Fi setup use [authenticated BLE enrollment](ble-protocol.md), not baked account tokens or Wi-Fi strings. No credential-baking helper or generated credential header is required. `/info` uses the existing Wi-Fi MAC as hardware diagnostic identity, not the gateway enrollment UUID or authority.

For development trust, explicitly supply the approved PEM certificate as private `firmware/main/sentient_dev_gateway.crt`; see [certificate input procedure](../scripts/README.md). Preserve existing private headers/certificates and other operator files. Release excludes the development certificate without deleting it. Changes to approved build inputs require reconfigure/rebuild; they do not modify an already-built/flashed image. HTTPS and WSS retain certificate/date/hostname checks; physical TLS behavior remains a separate gate.

## Approved device work only

Managed `flash --profile debug` uses profile-specific sdkconfig but shared build output. It does not run credential baking. Its verifier waits for companion readiness and a settled application state, not authenticated gateway readiness. Fresh BLE bootstrap may report `UNKNOWN`, which the current verifier can reject; timeout is not evidence of bad baked credentials and must not trigger blind reflash. Use bounded `cube.hardware.status` only within approved device scope.

The CLI also supports prod flashing and reports flash-only verification, but that capability is not authorization. Follow [flash discipline](../../../agents/docs/esp32/cube/flash-discipline-details.md).

Read [diagnostic restrictions](../../../agents/docs/esp32/cube/agent-console-details.md) before inspection: screenshot protection does not cover tree-label or transcript exports. Physical BLE/TLS, codec drain, audio continuity, memory headroom and coexistence must be validated on the approved local stack; neither source inspection nor build success establishes them.
