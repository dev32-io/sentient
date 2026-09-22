# esp32/cube/scripts/

Legacy device-side scripts retired in feature/esp32-devtool-foundation.
Use `esp32-devtool` for everything:

| Old                                   | New                                            |
|---------------------------------------|------------------------------------------------|
| `bash cube-cmd.sh state`              | `esp32-devtool cmd state`                      |
| `bash cube-snapshot.sh /tmp/x.png`    | `esp32-devtool screenshot --out /tmp/x.png`    |
| `bash flash.sh`                       | `esp32-devtool flash --profile debug`          |
| `bash find-port.sh`                   | `esp32-devtool --json info | jq -r .ip`        |
| `bash gdb-batch.sh`                   | `esp32-devtool gdb --batch ...`                |
| `bash setup-hil.sh`                   | `esp32-devtool setup --hil`                    |
| `bash monitor.sh`                     | `esp32-devtool logs --follow`                  |

`bake-creds.sh` is an **offline, explicit** debug-only provisioning extension.
It retires when device pairing lands. No arguments fails closed; generic
`esp32-devtool flash` currently invokes it without arguments, so flash is
blocked until manifest/flash integration is reviewed. Do not bypass this by
flashing an old compile-only placeholder image.

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

Fields are examples, not usable credentials. Supply existing authorized local
fixture-user token from approved provisioning flow; script never mints tokens,
reads `.e2e-testing`, contacts services, or chooses an IP. Host must be LAN
RFC1918 IPv4 or `.local` DNS; certificate must be valid now and cover host in
SAN. Supply certificate **actually served by cube-facing TLS proxy**, not
upstream loopback cert. Secure WebSocket URL uses `wss://` in debug profile;
prod rejected because current firmware selects `ws://` for `PIN=0`.

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
image. Firmware currently
skips TLS hostname verification at runtime despite offline SAN check; firmware
fix required before treating this as end-to-end hostname enforcement. Firmware
also logs token preview; no device access until separately approved security
review. Offline tests: `python3 -m unittest discover -s esp32/cube/tests/unit`.
