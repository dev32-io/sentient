# Cube Firmware Build Reproducibility + Migration Hardening — Design

**Date:** 2026-06-01
**Status:** Design approved, awaiting plan
**Context:** Surfaced while executing the esp32-devtool adoption plan (`docs/superpowers/specs/2026-06-01-cube-devtool-adoption-design.md`). The adoption is **paused** until the cube firmware builds reproducibly in the new repo.

## Goal

The cube firmware builds reproducibly from a fresh `git clone` → bake creds → `idf.py build`, with **no patches on third-party components**, **no absolute-path dependencies**, and a **documented lock policy**. Eliminate the migration-fragile artifacts that broke the build when the repo moved from gitlab to the public repo.

## Why now

Building the cube firmware in the new repo (the first time it has been built there) fails. Root cause: the migration tracked a **patch inside a managed component** (esp-ml307's `esp_ssl.{h,cc}`) via `.gitignore` negation exceptions — but only partially. A fresh checkout gets a broken half-component (`78__esp-ml307/` with `esp_ssl.{h,cc}` but no `.component_hash`), so the IDF component manager reports an integrity error. The patch exists **solely** to host a `SetCacert` method the WebSocket client already pins natively — it is pure redundant dead weight.

This is the same class of migration gap as the already-fixed `.e2e-testing` omission: a gitignored-but-required artifact that did not carry over cleanly.

## Non-goals

- The esp32-devtool submodule adoption (separate, paused spec).
- Gateway-side TLS / Let's Encrypt deployment (assumed: prod Pi gateway serves a Let's Encrypt cert; tracked separately if not yet true).
- The cube wifi-flap reconnect bug fix (separate cube-firmware concern; the fix is written in `application.cc` but unbuildable until this lands).
- Broad refactor of the xiaozhi-derived board abstraction beyond removing the dead modem path.

## Key findings (from investigation)

- **The cert patch is redundant.** `application.cc:336-340` already pins the gateway cert via the standard `esp_websocket_client` API (`cfg.cert_pem` + `skip_tls_cn_check`). The `EspSsl::SetCacert` call at `sentient_cube.cc:1124` is a second, redundant cert-pin through the patched modem wrapper.
- **esp-ml307 is only reachable through dead code.** Its only cube usage is that one `SetCacert` line plus the xiaozhi modem-board abstraction (`ml307_board.{cc,h}`, `dual_network_board.{cc,h}`), which is compiled but never instantiated — the cube is `SentientCubeBoard : public WifiBoard` (WiFi-only).
- **Both gateways self-sign on the LAN by default**, but **prod (Pi) is reached via a Let's Encrypt cert** (real domain). The ESP-IDF `esp_crt_bundle` (Mozilla roots) already contains Let's Encrypt's ISRG Root X1 — so prod verifies via the bundle with no baked cert and survives the 90-day leaf rotation with zero re-flash. Dev (macOS localhost) is self-signed and cannot be in any public bundle.
- **The lock regressed in migration.** `dependencies.lock` was committed in gitlab, is gitignored in the new repo. ESP-IDF official guidance: a project with **local-path dependencies** (the cube has `esp32_devtool_companion` via `path:`) should **not** commit the lock, because it "may contain local paths specific to your environment." The new repo's gitignoring is correct; gitlab committing it produced the absolute-path pollution that broke the build.

## Decisions

| Topic | Decision |
|---|---|
| Cert verification | Always attach `esp_crt_bundle` (both build profiles, uniform). **Prod** verifies via the bundle (Let's Encrypt). **Debug** skips server-cert verification (localhost self-signed). |
| Cert pinning apparatus | Delete entirely: `EspSsl::SetCacert`, embedded dev cert, `SENTIENT_DEV_TLS_PIN`, the `cfg.cert_pem` dev wiring, the EMBED_TXTFILES cert, and bake-creds' openssl cert-extraction. |
| esp-ml307 | **Drop entirely** — dependency, dead modem-board files, src-include coupling, `.gitignore` patch exceptions, tracked `esp_ssl.{h,cc}`. |
| Dependency lock | **Keep gitignored** (IDF official for local-path-dep projects). Reproducibility via `idf_component.yml` version pins + immutable registry. Document the policy. |
| Migration audit | Bounded sweep for other gitignore-exception / partial-tracked / absolute-path artifacts; fix or log each. |

## Architecture: four workstreams

### W1 — TLS simplification

Replace the embedded-dev-cert + redundant-`SetCacert` apparatus with a uniform CA-bundle path.

- **sdkconfig (both profiles):** `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE=y` — bundle always compiled in.
- **Prod build:** `ws_cfg.crt_bundle_attach = esp_crt_bundle_attach`. Verifies the Let's Encrypt chain via ISRG Root X1 in the bundle. No baked cert; survives leaf rotation.
- **Debug build:** no server-cert verification (one `#if` branch in the WS config builder).
- **`SentientWsProtocolConfig`:** replace `const char* cert_pem` + `bool skip_tls_cn_check` with a `crt_bundle_attach` function pointer + a `bool insecure_skip_verify`.
- **Delete:** `EspSsl::SetCacert` call (`sentient_cube.cc:1124`), the `extern _binary_sentient_dev_gateway_crt_*` symbols, `SENTIENT_DEV_TLS_PIN`, the `cfg.cert_pem` dev-cert wiring (`application.cc:336-340`), the EMBED_TXTFILES dev cert in CMake, and the openssl cert-extraction block in `scripts/bake-creds.sh`.

**Plan-time detail to verify on hardware:** the exact esp-tls "insecure" mechanism for the debug branch (no-CA attach vs an explicit skip flag) and `esp_websocket_client` behavior when no CA is attached. The design intent is fixed; the precise flag is confirmed at implementation against a real debug build.

### W2 — Drop esp-ml307 + dead modem code

- Remove `78/esp-ml307` from `main/idf_component.yml`.
- Delete `main/boards/common/ml307_board.{cc,h}` and `dual_network_board.{cc,h}`; remove their entries from `main/CMakeLists.txt SOURCES`.
- Remove the `idf_component_get_property(ML307_DIR 78__esp-ml307 …)` + `target_include_directories(… ${ML307_DIR}/src)` coupling in `main/CMakeLists.txt`.
- Remove the `.gitignore` negation block (`!firmware/managed_components/78__esp-ml307/…`).
- `git rm --cached` the tracked `firmware/managed_components/78__esp-ml307/src/esp/esp_ssl.{h,cc}`.
- Verify nothing else references `DualNetworkBoard` / `Ml307Board` (board base or sibling boards). The build confirms.

### W3 — Lock & reproducibility

- Keep `dependencies.lock` gitignored. Do not commit.
- Scan `main/idf_component.yml` for `version: '*'` / `^major` wildcards that affect the esp32-s3 build; tighten to `~`/`==`. (The `'*'` deps observed are esp32-p4-target-gated — they do not affect the cube; confirm during implementation.)
- Ensure `.gitignore` ignores `build/`, `managed_components/`, `dependencies.lock` with **no** negation exceptions.
- Document the lock policy in `.claude/rules/esp32/cube/build.md`: gitignored by design; `idf.py reconfigure` regenerates; reproducibility = manifest pins + immutable registry. Cite the IDF guidance.

### W4 — Migration-gap audit

Bounded, not open-ended:
- **Tracked-file diff:** gitlab `develop` (+ `feature/esp32-cube-v2-rescope`, `feature/phase6-cube-sdk`) vs the new repo, scoped to `esp32/cube/**` — surface files tracked there but absent here.
- **Anti-pattern grep:** all `.gitignore` files in the new repo for `!` negation exceptions (force-tracked-despite-ignore). The cube esp-ml307 one dies in W2; check gateway, shared, esp32-devtool for siblings.
- **Absolute-path scan:** grep tracked config/lock/build files for hardcoded `/Users/...` paths.
- **Output:** a findings table; each gap fixed inline (if small) or logged as a follow-up.

Already triaged: `.e2e-testing` (copied ✓), `sentient_creds.h.in` (inlined into bake-creds ✓), esp-ml307 patch (W2 ✓), lock (W3 policy ✓).

## Sequencing

W2 (drop the dep) → W1 (rewire TLS to the bundle) → W4 (audit catches siblings) → W3 (pins + docs) → fresh-clone build + flash validation.

- W1 + W2 land as one firmware-cleanup commit range.
- W3 + W4 land as one build-hygiene commit range.

## Testing / definition of done

- **Fresh-clone build:** from a clean checkout of the new repo (no pre-existing `managed_components`/`build`/`dependencies.lock`), `source scripts/env.sh` → `esp32-devtool bake-creds --profile debug` → `idf.py build` succeeds with **zero** manual fetch or patch steps.
- **No anti-patterns remain:** no `.gitignore` negation exceptions under `esp32/cube/`; no tracked files inside `managed_components/`; no absolute paths in tracked files.
- **Real-hardware TLS validation:** flash debug → cube boots, connects to the macOS gateway over WSS with verification skipped → reaches IDLE + ws_connected. (Prod CA-bundle path validated separately when a Let's Encrypt prod gateway is available; covered by the existing cube HIL once the build is green.)
- **esp-ml307 absent:** the dependency no longer appears in the build's processed-dependencies list.

## Error handling / risks

| Risk | Mitigation |
|---|---|
| esp-tls debug-insecure mechanism differs from assumption | Plan verifies the exact flag on a real debug build before declaring W1 done; design intent (debug=no-verify, prod=bundle) is fixed regardless. |
| Dropping `dual_network_board` ripples into the board base class | W2 builds after each deletion; the cube is WifiBoard-only, so the modem abstraction should be self-contained. Build is the gate. |
| Prod gateway is actually self-signed, not Let's Encrypt | If true, the CA-bundle path won't verify prod. Tracked as a gateway-side prerequisite (Let's Encrypt termination); cube firmware is future-proof either way since the bundle path is standard. |
| Tightening version pins breaks a transitive resolve | Change pins incrementally; `idf.py reconfigure` + build after each. Registry versions are immutable, so pinned resolves are stable. |

## Related artifacts

- Paused adoption spec: `docs/superpowers/specs/2026-06-01-cube-devtool-adoption-design.md`
- IDF lock guidance: https://docs.espressif.com/projects/idf-component-manager/en/latest/reference/dependencies_lock.html
- Cube build rules: `.claude/rules/esp32/cube/build.md`
- Cube C/C++ rules: `.claude/rules/esp32/cube/clean-code.md`
- bake-creds extension: `esp32/cube/scripts/bake-creds.sh`
