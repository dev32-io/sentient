# esp32/cube/scripts/

Use pinned `esp32-devtool` after sourcing repository `scripts/env.sh`; legacy device-side scripts and HIL runbooks are not current authority.

`bake-creds.sh` is an **offline, explicit** debug-only provisioning extension.
It retires when device pairing lands. No arguments fails closed. Generic
`esp32-devtool flash` does **not** invoke provisioning; run
`esp32-devtool bake-creds --input /absolute/path/to/private.json` separately.
Never flash compile-only placeholder image. Device access and temporary debug
LAN HTTP exposure need explicit approval.

Create an operator-owned JSON file outside repo, mode `0600`, with exactly:

```json
{
  "WIFI_SSID": "test-network",
  "WIFI_PSK": "synthetic-password",
  "PASETO_TOKEN": "v4.local.<fixture-user-session-token>",
  "DEVICE_ID": "cube-test-1",
  "GATEWAY_HOST": "cube-gateway.local",
  "GATEWAY_WS_PORT": 443,
  "GATEWAY_WS_PATH": "/api/v1/ws",
  "TRUSTED_CERT_PATH": "/absolute/path/to/outward-public-leaf.pem"
}
```

Alternatively, for a device already configured with WiFi in NVS, replace **both**
`WIFI_SSID` and `WIFI_PSK` with `"PRESERVE_WIFI": true`. Exactly one mode is
required: WiFi pair or literal `true`; mixed, missing, or false modes fail.
Preserve mode emits `SENTIENT_PRESERVE_WIFI 1` and no WiFi strings in header;
board does not call `AddSsid`, so existing WiFi settings remain untouched.
Explicit WiFi mode emits `SENTIENT_PRESERVE_WIFI 0` and seeds WiFi as before.
Preserve mode cannot supply WiFi if device lacks stored credentials; existing
WiFi config flow applies then.

Fields are examples, not usable credentials. Supply existing authorized local
fixture-user token from approved provisioning flow; script never mints tokens,
reads `.e2e-testing`, contacts services, or chooses an IP. Host must be LAN
RFC1918 IPv4 or `.local` DNS; certificate must be valid now and cover host in
SAN. Supply certificate **actually served by cube-facing TLS proxy**, not
upstream loopback cert. Firmware accepts only `wss://` and verifies hostname. This provisioning script
remains debug-only; no approved prod provisioning flow exists.

Run `bash esp32/cube/scripts/bake-creds.sh --input /absolute/path/to/private.json`
(or append `--profile debug`). Input values never belong in CLI arguments.
Success replaces gitignored `firmware/main/sentient_creds.h` and
`sentient_dev_gateway.crt`, each mode `0600`; only then is compile-only
placeholder header replaced. If header publication fails, script restores prior
certificate (or removes newly created one). If rollback itself fails, inspect
both outputs before building. **Reconfigure then rebuild after baking**
(`idf.py reconfigure && idf.py build` from firmware dir): CMake discovers
certificate embedding at configure time. Verify rebuilt image before any
approved flash. Baking alone does not change any previously built or flashed
image. Runtime certificate trust and hostname verification are enabled; device
verification still requires approved LAN exposure and disposable local user.
Offline tests: `python3 -m unittest discover -s esp32/cube/tests/unit`.
