# ESP32 Cube build — details

[`esp32/cube/firmware/`](../../../../esp32/cube/firmware/) is owned application firmware. [`esp32/devtool/`](../../../../esp32/devtool/) is an external submodule pinned by the repository gitlink; firmware consumes its devtool companion through `main/idf_component.yml`. Project manifest is [`esp32/cube/devtool/boards/cube.yaml`](../../../../esp32/cube/devtool/boards/cube.yaml). Source [`scripts/env.sh`](../../../../scripts/env.sh) before CLI work; it exports `ESP32_DEVTOOL_BOARDS_DIR`. Global CLI flags precede subcommands; command-local options retain their documented placement.

## Build-only checks

Use the reviewed ESP-IDF 5.5.2 source revision and reviewed dependencies. Manifest `>=5.5.2` is a dependency minimum, not unrestricted upgrade compatibility: hash-pinned source corrections fail closed on changed upstream inputs. Do not bypass hashes or edit the installed SDK to force an upgrade. CMake applies reviewed corrections to build-local copies, including TLS/Security2/SRP fixes.

From `esp32/cube/firmware/`, after loading the reviewed ESP-IDF environment:

```sh
SDKCONFIG_DEFAULTS='sdkconfig.defaults;sdkconfig.defaults.debug' \
  idf.py -D SDKCONFIG="$PWD/build/sdkconfig.debug" reconfigure build
SDKCONFIG_DEFAULTS='sdkconfig.defaults;sdkconfig.defaults.prod' \
  idf.py -D SDKCONFIG="$PWD/build/sdkconfig.prod" reconfigure build
esp32-devtool audit-prod-strip
```

Profile sdkconfig files are separate but ELF output is shared in `build/`; audit prod strip immediately after prod build. Compilation and stripping do not prove runtime or hardware behavior. Never flash unreviewed compile-only placeholders. Production provisioning/flash requires separate explicit authorization; these commands authorize neither.

## Provisioning and trust

Current device identity, destination and authority come from [BLE enrollment](../../../../esp32/cube/docs/ble-protocol.md); Wi-Fi comes from authenticated manager commands and durable device storage. No baked account/Wi-Fi header is required. Debug accepts an explicitly supplied private `firmware/main/sentient_dev_gateway.crt` file; follow the [certificate input procedure](../../../../esp32/cube/scripts/README.md). Preserve existing operator files. Prod sets `CONFIG_SENTIENT_PROD_BUILD=y`, excludes the development certificate from embedding/use, and retains CA-bundle trust.

Current source configures HTTPS/WSS certificate trust, date and hostname verification and does not emit the former protocol token preview. Physical TLS behavior remains a separate device gate. No manual SDK/managed-component patch reapply is required. See [build profiles](../../../../esp32/cube/docs/build-profiles.md) and [script contract](../../../../esp32/cube/scripts/README.md).

## Device boundaries

Before an approved action read [flash discipline](flash-discipline-details.md). `esp32-devtool --json info` contacts the device through USB discovery and LAN HTTP; it is not offline selection inspection. Debug HTTP is unauthenticated and requires explicit local-network exposure approval.

Constructor-registered cube verbs live in `firmware/main/devtool_verbs/`; companion handlers live in external `esp32/devtool/firmware/`. Retain `WHOLE_ARCHIVE`; prod disables the devtool companion via stub, which must be verified in ELF. Read [agent console details](agent-console-details.md) before diagnostics: screenshot protection does not cover content-bearing tree/transcript verbs. Preserve [cube hardware guardrails](../../../../esp32/cube/AGENTS.md).
