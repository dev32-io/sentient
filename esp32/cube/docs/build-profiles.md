# Build Profiles: Debug vs Prod

> **WARNING — PRODUCTION CUBES MUST BE FLASHED WITH `--profile prod`**
>
> The debug profile (default) exposes destructive USB-CDC verbs via the
> `esp32_devtool_companion`, ships every DEBUG log to a UDP sink, and uses a
> self-signed dev TLS cert. Flashing a debug build to a cube on a public or
> shared network is a security and privacy risk. Always verify the profile
> before flashing a device that is not under your direct physical control.

---

## Profile matrix

| | Debug (default) | Prod |
|---|---|---|
| Log level | DEBUG (verbose) | INFO |
| Compiler | `-Og` + debug symbols | `-Os` + assertions off |
| `esp32_devtool_companion` (verbs + HTTP + log_relay) | enabled (HIL surface) | fully removed via stub |
| Destructive verbs (`audio.inject_pcm`, `audio.record_pcm`, `button.toggle`, …) | enabled | NOT registered |
| LVGL widget metadata (`ui.dump_tree`) | enabled | stripped |
| Devtool log_relay UDP shipping | enabled (gateway sink) | disabled |
| TLS cert handling | pinned dev cert (self-signed `CN=sentient`) | `esp_crt_bundle` (public CAs) |
| Approx. binary size | ~3.15 MB | ~2.81 MB |

---

## How to switch profiles

```bash
# Debug (default — local dev against Docker stack)
esp32-devtool bake-creds                       # --profile debug implied
esp32-devtool flash --profile debug

# Prod (production deployment)
esp32-devtool bake-creds --profile prod
esp32-devtool flash --profile prod
```

Switching profiles requires **both** steps — re-baking creds AND re-flashing.

`esp32-devtool bake-creds --profile prod` regenerates
`firmware/main/sentient_creds.h` with `SENTIENT_DEV_TLS_PIN` set to `0` and
removes `firmware/main/sentient_dev_gateway.crt` (the dev cert used for
pinning in debug builds). `esp32-devtool flash --profile prod` selects the
prod sdkconfig chain (`sdkconfig.defaults` + `sdkconfig.defaults.prod`) which
strips the `esp32_devtool_companion` (and with it all dev verbs + UDP
log_relay) and adjusts compiler flags.

For sdkconfig discipline and flash count hygiene see
`.claude/rules/esp32/cube/build.md` and `.claude/rules/esp32/cube/flash-discipline.md`.

---

## Prod flash checklist

Run through this list before every prod flash. Do not skip steps.

- [ ] Gateway has a real public-CA cert (LetsEncrypt / managed). The cube's
      mbedtls CA bundle will validate it — self-signed certs will fail TLS
      handshake in prod builds.
- [ ] `.e2e-testing` has the prod gateway host (not `localhost` or a
      `192.168.x.x` dev IP).
- [ ] `esp32-devtool bake-creds --profile prod` ran successfully. Confirm:
      ```bash
      grep SENTIENT_DEV_TLS_PIN esp32/cube/firmware/main/sentient_creds.h
      # must print: #define SENTIENT_DEV_TLS_PIN 0
      ```
- [ ] No `firmware/main/sentient_dev_gateway.crt` present (bake-creds removes it
      on prod):
      ```bash
      test ! -f esp32/cube/firmware/main/sentient_dev_gateway.crt && echo "OK"
      ```
- [ ] `esp32-devtool flash --profile prod` ran. Confirm the flash log shows:
      ```
      profile=prod SDKCONFIG_DEFAULTS=...sdkconfig.defaults.prod
      ```
- [ ] After boot, verify the devtool companion is stripped:
      ```bash
      esp32-devtool cmd state
      # expect: dispatcher disabled / no verbs registered, or command timeout
      esp32-devtool audit-prod-strip
      # expect: companion symbols absent from the prod ELF
      ```
- [ ] Cube voice loop connects and works against the prod gateway.

---

## TLS pinning rationale

The debug build pins `firmware/main/sentient_dev_gateway.crt` — a self-signed
cert for the local Docker gateway (`CN=sentient`). This cert is not valid
against any public CA root, which is intentional: it forces all debug traffic
through the known local stack and makes accidental prod-gateway connections fail
loud.

Prod builds discard the pin and use ESP-IDF's bundled CA root store
(`esp_crt_bundle`). LetsEncrypt and other managed certs are anchored to
publicly-trusted roots, so the bundle validates them without any per-cert
configuration.

Future remote-managed cube fleets (multi-tenant / multi-deployment) may want a
per-tenant cert-pin pipeline where each deployment bakes a different gateway
cert. That is out of scope for the current single-household deployment.

---

## Re-fetch warning: EspSsl override

The TLS override lives at:

```
firmware/managed_components/78__esp-ml307/src/esp/esp_ssl.{h,cc}
```

This file is patched from upstream (see commit `e7db556`). If anyone runs
`idf.py update-dependencies` and the `ml307` component is bumped to a new
version, the override gets clobbered by the fresh download.

After any `update-dependencies` run: diff `esp_ssl.h` / `esp_ssl.cc` against
`e7db556`'s version, re-apply the patch, and confirm TLS handshake smoke
passes before merging. Alternatively, pin the `ml307` component version in
`idf_component.yml` to prevent silent upgrades.

---

## "What if I forget?" recovery

If a debug build is accidentally flashed to a prod cube:

- Anyone on the local network can invoke destructive USB-CDC verbs
  (`audio.inject_pcm`, `audio.record_pcm`, `button.toggle`, …) through the
  `esp32_devtool_companion` dispatcher — no auth required at the USB-CDC level.
- The devtool log_relay ships every `DEBUG`-level log line (including audio
  metadata, session IDs, and timing data) via UDP to the hardcoded gateway IP
  — a privacy and PII risk on any network the cube shares with untrusted devices.

**Resolution:** run `esp32-devtool flash --profile prod` immediately. No other
mitigation is effective — the surface is in the firmware, not the gateway config.

---

## WebSocket lifecycle

The cube holds a single persistent WebSocket to the gateway from boot until
disconnect or shutdown. Per-cycle protocol framing (`SendStartListening` /
`SendStopListening` / audio packets) flows over this one connection. The
upstream xiaozhi pattern of open-per-cycle, close-on-cycle-end was replaced
in Phase 5b because:

- Server can push events at any time (settings, alerts, future activation).
- No connect latency on each utterance.
- `esp32-devtool cmd state` `ws_connected: true` at IDLE is meaningful and truthful.
- Future setting/login UI will need server-pushed state.

### Battery optimization knob (future)

Persistent WS implies continuous ping/pong frames from the underlying TCP
keepalive + WebSocket-layer pong responses. On a mains-powered cube this
is free; on a future battery cube, the idle-time ping interval is the
first lever to dial down (e.g., 30s → 5min during prolonged IDLE).
Track this in `firmware/main/application.cc`'s reconnect supervisor and
the WebSocket client's keepalive_idle config.
