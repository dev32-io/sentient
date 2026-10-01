# esp32/cube/scripts/

Use pinned `esp32-devtool` after sourcing repository `scripts/env.sh`.
Account/device authority, destination and Wi-Fi use [authenticated BLE enrollment](../docs/ble-protocol.md); no account-token or Wi-Fi build helper is needed.

## Flash a cube

Install `uv` and ESP-IDF 5.5.2 once, plug in your cube with a USB data cable, then run:

```sh
uv run esp32/cube/scripts/flash.py
```

No flags, device paths, or separate environment setup. Python dependencies are resolved by `uv`; the wizard works from any directory when launched with its full path. A custom ESP-IDF installation can be selected with `IDF_PATH`.

The wizard guides you through:

1. **Find your cube** — automatically selects a single compatible USB device; multiple devices get a numbered menu. If none appear, plug in a cube and press Enter to rescan.
2. **Choose firmware** — Release for everyday use, or Debug for development. Explanations appear beside each choice.
3. **Confirm** — review the selected device/profile and answer Yes. Default is No; quitting/EOF before confirmation never flashes. USB identity is checked again before starting.
4. **Install** — status spinner while building/flashing; clear success or failure. Release also runs the strip audit.
5. **Check the display** — confirm setup or the companion is visible. A successful write alone is not a verified boot; an unconfirmed display stops the wizard. Then optionally flash another cube, with fresh discovery and confirmation.

USB IDs identify compatible ESP32 devices, not a proven cube model. Connect only cubes, or use the shown serial/USB details to identify the intended one. No path typing is needed. Use one wizard at a time: profiles share build output.

The wizard pins this checkout's cube manifest and delegates hardware operations to `esp32-devtool`, which owns serial-daemon shutdown/restart. It never opens a serial reader, erases all flash, or bakes credentials. Existing Wi-Fi/enrollment storage is preserved; new cubes need Bluetooth enrollment through the app.

Release maps to the existing `prod` profile, excludes the development certificate, and uses public CA trust. Its strip audit runs against the freshly built ELF after flashing. Release has no debug companion: successful transfer/audit is **not** boot verification; check the display. Debug verifies settled application or healthy BLE setup readiness and must use a trusted development network with matching TLS trust (below).

Do not unplug during installation. There is no automatic rollback; a failed/interrupted flash requires inspection and possibly USB recovery, not blind retry. The wizard stops on failure. Never use on production devices without explicit per-device authorization.

### Black screen after flashing

The current IDF profiles already request `hard_reset` after flashing. This resets the ESP32, not necessarily the battery-backed power controller. Release has no USB diagnostic command handler; another software `restart` cannot recover firmware that never started.

First try tapping the screen to wake it. Once our firmware has initialized the PMIC, **hold PWR about four seconds, release, then press PWR briefly** for hardware power-off/on. Use **PWR**, not BOOT (download mode). This is implemented by AXP2101 registers `0x22=0x06` and `0x27=0x10`, independent of application scheduling. See [board button definitions](https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-2.16) and [AXP2101 datasheet pages 30–31](https://files.waveshare.com/wiki/common/X-power-AXP2101_SWcharge_V1.0.pdf). Button recovery has not been physically verified on the reported battery-equipped unit; earlier firmware or boot failure before PMIC initialization can leave different settings.

A USB disconnect alone leaves battery power present. Button power-off/on is not guaranteed to clear every retained PMIC fault; do not infer the black-screen cause from a successful flash. If the screen stays black, stop for hardware-owner diagnosis rather than repeatedly flashing or automatically shutting down the PMIC.

## Development TLS trust

Explicitly supply the trusted PEM certificate for the approved cube-facing TLS endpoint as gitignored `firmware/main/sentient_dev_gateway.crt`. For example, from repository root:

```sh
install -m 0600 /absolute/path/to/approved-trust.pem esp32/cube/firmware/main/sentient_dev_gateway.crt
```

Do not scrape a live endpoint, mint an account token, or overwrite an existing operator file without approval. Existing private `sentient_creds.h` is no longer a build input; preserve it and other operator files.

Debug embeds the supplied certificate when present; otherwise it uses the ESP CA bundle. HTTPS enrollment/renewal and WSS both retain certificate/date/hostname verification. Supply trust appropriate for the endpoint selected through BLE enrollment; a mismatched or invalid certificate fails TLS, never falls back to unverified transport.

Prod sets `CONFIG_SENTIENT_PROD_BUILD=y` and neither embeds nor uses the development certificate, even while the private file remains present. Release retains CA-bundle verification. No TLS bypass exists.

Reconfigure and rebuild after changing trust inputs; file presence is evaluated by CMake. Use separate debug/prod sdkconfig files and audit immediately after prod build; see [build profiles](../docs/build-profiles.md). Build success does not verify device TLS or authorize flashing. Device access/debug LAN HTTP exposure require separate approval.

Offline checks: `python3 -m pytest -q esp32/cube/tests/unit` after sourcing `scripts/env.sh`. `unittest discover` misses pytest-style function tests.
