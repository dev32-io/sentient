# Cube Build Reproducibility + Migration Hardening — Handover

**Date:** 2026-06-02
**Branch:** `feature/cube-devtool-adoption` (build-repro work landed here per operator decision, ahead of the paused devtool-adoption)
**Spec:** `docs/superpowers/specs/2026-06-01-cube-build-reproducibility-design.md`
**Plan:** `docs/superpowers/plans/2026-06-01-cube-build-reproducibility.md`
**Status:** ✅ Complete — clean build + real-hardware WSS+IDLE validated.

## Outcome

The cube firmware builds reproducibly from a clean tree with **no patch on any
third-party component**, **no absolute-path deps**, and a **documented lock
policy**. TLS moved to a uniform `esp_crt_bundle` strategy (prod verifies Let's
Encrypt; debug skips verification). Validated end-to-end on real hardware:
cube boots → WiFi → insecure WSS handshake → WS upgrade → PASETO auth → **IDLE,
ws_connected=true**.

## Commit range (on `feature/cube-devtool-adoption`)

| Commit | What |
|---|---|
| `32a1be8` | Kconfig `CUBE_DEV_TLS_INSECURE` + `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE` |
| `a734e79` | WS protocol TLS via `crt_bundle` / insecure-skip; drop `cert_pem` pinning |
| `1c5b6cb` | `application.cc` drives TLS from `CONFIG_CUBE_DEV_TLS_INSECURE`; **always `wss://`** |
| `692c08d` | Remove redundant `EspSsl::SetCacert` dev-cert pin from the board |
| `950571c` | Drop esp-ml307 SetCacert **patch** + dead modem boards; **keep esp-ml307 as a clean dep** |
| `2f02f2f` | bake-creds drops dev-cert extraction (TLS is Kconfig-driven) |
| `b912f87` | Enable `CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY` for the debug insecure path |
| `b163865` | Correct gateway WS path `/api/v1/ws` (drop legacy `xiaozhi` suffix) |
| `21528cf` | Gate marker: W1+W2 green on hardware |
| `a8dd166` | Document lock policy + pin policy + debug-profile sdkconfig discipline |

## Premise corrections (the spec was wrong in two places — both caught by the build/flash gate)

1. **esp-ml307 is NOT dead-code-only — it supplies the cube's live network layer.**
   The spec assumed esp-ml307 was reachable only via the redundant `SetCacert`
   patch + dead modem boards. False: `board.h` / `wifi_board.cc`
   (`GetNetwork() → EspNetwork`) / `assets.cc` (`network->CreateHttp`) depend on
   esp-ml307's network abstraction (`NetworkInterface` / `Http` / `EspNetwork` via
   `network_interface.h` / `http.h` / `esp_network.h`). Dropping it broke the build
   (`http.h: No such file`). **Resolution (operator-approved):** keep esp-ml307 as a
   clean, **unmodified** registry dependency — the `esp_ssl` patch is gone, the dead
   modem boards are gone, but the component stays. Restored: the dep, the
   `78__esp-ml307` PRIV_REQUIRES, and the `${ML307_DIR}/src` include reach-in (with
   corrected comments). The user's actual pain — the *patch* + the migration-fragile
   `.gitignore` exceptions + tracked `managed_components` files — is fully resolved.

2. **The IDF 5.5.2 insecure-WSS mechanism is `CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY`,
   not "leave the CA unset".** The spec flagged this as a plan-time risk. On hardware,
   leaving `crt_bundle_attach`/`cert_pem` unset did NOT skip verification — esp-tls
   errored: `No server verification option set in esp_tls_cfg_t structure`. Fix:
   `sdkconfig.defaults.debug` enables `CONFIG_ESP_TLS_INSECURE=y` +
   `CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY=y` (debug profile ONLY). The WS-protocol
   insecure branch (attach no CA) then relies on esp-tls's skip-by-default. Prod never
   enables that Kconfig and always takes the `crt_bundle` branch.

## Hardware validation (cube-001 @ /dev/cu.usbmodem101, macOS gateway 192.168.0.222:8888)

Final state: `{"state":"IDLE","wifi_connected":true,"ws_connected":true,"ip":"192.168.0.121"}`

Boot sequence proven: esp-ml307 clean-dep build boots → WiFi connects + gets IP →
`tls: INSECURE — server cert verification disabled (debug)` → `ws: connected` →
`status: Connecting -> Authenticating` → `State: connecting -> idle`.

**Flash-discipline evidence:** 4 flashes, 0 AXP2101 faults, daemon eager-respawn per flash.
- #1: exposed wrong branch (crt_bundle taken — stale non-debug `sdkconfig`).
- #2: exposed esp-tls "No server verification option set" (insecure-no-CA insufficient).
- #3: esp-tls skip-verify applied → past TLS; exposed WS header overflow (path mismatch).
- #4: path fix → full green.

## Out-of-scope bug found + fixed: stale WS path

The cube dialed the legacy `/api/v1/ws/xiaozhi`; the sentient gateway serves the WS
upgrade at exact `/api/v1/ws` (every other client — web-sdk, webui — uses that). The
gateway rejected the longer path at the router → HTTP error response → header overflow
on the cube's WS buffer (`Header size exceeded buffer size`, `status_code=0`). The cube
had **never** completed a WS connection; the TLS fix surfaced it for the first time.
Stale value re-entered via the gitlab-copied `.e2e-testing` despite a prior correction
(`2026-05-14-phase6-cube-sdk-plan.md`). Fixed: tracked `esp32/cube/docs/README.md`
(`b163865`) + local `.e2e-testing` `GATEWAY_WS_PATH=/api/v1/ws`.

## W4 migration-gap audit findings

| Check | Result |
|---|---|
| `.gitignore` negation exceptions force-tracking inside `managed_components/` | esp-ml307 anti-pattern **removed**; no others in our tree (remaining `!` are legit asset/secret/profile whitelists) |
| Absolute `/Users/...` paths in tracked cube files | **none** |
| gitlab `develop` cube tracked-files vs new repo | delta is the intentional **v1→v2 rescope** (sentient/ tree → firmware/main + esp32_devtool_companion; scripts/*.sh retired). Spot-checked agent_console verbs → migrated. No loss. |
| Stale config from gitlab copy | WS path (fixed); `.e2e-testing` + `sentient_creds.h.in` (inlined into bake-creds, prior); esp-ml307 patch (resolved); lock (policy) |

## Lock & reproducibility policy (documented in `.claude/rules/esp32/cube/build.md`)

`dependencies.lock` is gitignored by design (ESP-IDF guidance for projects with a
local-path dep — the cube has `esp32_devtool_companion` via `path:`). Reproducibility =
manifest pins + immutable registry; regenerate the lock with `idf.py reconfigure`. The
only unbounded `'*'` deps are `esp32p4`-gated and never enter the s3 cube build. Build
the debug profile through the `SDKCONFIG_DEFAULTS` chain (never bare `idf.py build`) or
debug-only Kconfig silently won't apply.

## Fresh-clone reproducibility proof (definition-of-done)

Wiped all generated state (`build/ managed_components/ dependencies.lock sdkconfig
main/sentient_dev_gateway.crt`), then `bake-creds --profile debug` →
`idf.py -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.debug" build`:

- ✅ `Project build complete`, binary generated, **zero** manual `git checkout` of
  managed_components, **zero** patch re-application, **zero** foreign-path errors.
- ✅ 70 deps re-resolved from the immutable registry; `[1/70] 78/esp-ml307 (3.6.5)`
  fetched + built clean (unmodified).
- ✅ Anti-patterns absent: no `^!` negation exceptions under `esp32/cube/.gitignore`;
  no tracked files inside `managed_components/`; `dependencies.lock` not tracked.

## Open items / follow-ups

- **Prod CA-bundle path** is future-proof but unvalidated: the prod gateway (Pi) must
  serve a real Let's Encrypt cert for the `esp_crt_bundle` verify path to succeed. No
  Let's Encrypt prod gateway was available to validate; the cube firmware is correct
  either way (standard bundle path). Validate when a prod gateway exists.
- **xiaozhi vendored-tree cruft** (non-protocol): `Kconfig.projbuild` still has a
  `menu "Xiaozhi Assistant"` + dead camera/OTA options, and a stale TODO in
  `audio_misc.cc`. Not protocol, mostly dead; a separate hygiene pass (out of scope here).
- **Reconnect-fix + HIL baseline** (task #12): the green-baseline reconnect-fix edits
  remain **stashed** (`stash@{0}`, application.cc/.h) — restore + resume that work
  separately. The full cube HIL matrix (the e2e gate) runs once that lands.
- **Paused devtool-adoption** resumes after this; it should branch from this commit range.
