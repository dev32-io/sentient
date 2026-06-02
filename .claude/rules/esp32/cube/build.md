---
paths:
  - "esp32/cube/firmware/**"
  - "esp32/cube/scripts/**"
---
# ESP32 Cube Build Rules

> When a rule is unclear, read `agents/docs/esp32/cube/build-details.md`.

- All cube firmware sources live under a single flat `esp32/cube/firmware/` tree.
  Every component is vendored into the repo and edited in place — no external
  source dependency outside ESP-IDF managed components.

- Build with `idf.py` invoked directly from `esp32/cube/firmware/`. ESP-IDF is the
  only required toolchain on PATH — no wrapper script chains.

- Host-side dev/debug entry point is `esp32-devtool` (see
  `.claude/rules/esp32/devtool.md`). Legacy `esp32/cube/scripts/*.sh` helpers
  are retired — only `bake-creds.sh` remains as a transient manifest extension.
  Do not add new shell scripts under `esp32/cube/scripts/`; new capabilities
  belong as `esp32-devtool` verbs / endpoints.

- Cube-wide ESP-IDF sdkconfig defaults belong in `esp32/cube/firmware/sdkconfig.defaults`
  (and target-specific variants like `sdkconfig.defaults.esp32s3` alongside it).
  Per-app overrides live next to each app's `CMakeLists.txt`. Later files in the
  `SDKCONFIG_DEFAULTS` chain override earlier ones — keep the chain shallow.

- Every component under `esp32/cube/firmware/components/` MUST have a `CMakeLists.txt`.
  Components without one are silently skipped by ESP-IDF — add the file before the
  first build of any new component.

- Components that rely on `__attribute__((constructor))` registration (verb files,
  module self-registration, etc.) MUST set `WHOLE_ARCHIVE` in their
  `idf_component_register()` call. Linker dead-code elimination strips constructor
  functions from static libraries that have no explicit symbol references from
  the calling app. Without `WHOLE_ARCHIVE`, the verb dispatcher silently sees an
  empty registry at runtime.

- Build artifacts (`build/`, `managed_components/`, `dependencies.lock`, generated
  `sentient_creds.h`) are gitignored at the repo root. Do not check them in.

- `esp32-devtool flash --profile debug` builds + flashes + eagerly respawns
  the daemon so the cube's boot trace from ROM bootloader through the first
  IDLE state lands in the daemon ring at t=0. Daemon ring inspection via
  `esp32-devtool daemon ring --lines 20000` is the canonical post-flash
  readback path — never re-flash to read boot state.

- Host UI iteration uses `esp32/cube/lvgl-sim/` — see
  `.claude/rules/esp32/cube/lvgl-sim.md` for scope, the device-smoke-always
  guard, and the LVGL-bump lockstep workflow. Edit-build-snapshot iteration
  is ~2 s vs the device's ~30 s build+flash+boot+smoke loop.

- Panic decoding workflow: a single address is decoded with
  `~/.espressif/tools/xtensa-esp-elf/esp-14.2.0_20251107/xtensa-esp-elf/bin/xtensa-esp32s3-elf-addr2line -e esp32/cube/firmware/build/sentient_cube.elf -pfiaC <hex-addr>`.
  Pass multiple `<a1> <a2> ...` to decode a list. Mandatory for
  `LoadProhibited` / `IllegalInstruction` / `StoreProhibited` panic
  backtraces — never guess the source frame from raw addresses.

- `dependencies.lock` is gitignored by design. The cube has a local-path
  dependency (`esp32_devtool_companion` via `path:`), and ESP-IDF guidance is
  to NOT commit the lock for such projects — it embeds environment-specific
  local paths. Reproducibility comes from version pins in `main/idf_component.yml`
  + the immutable component registry, NOT the lock. Regenerate with
  `idf.py reconfigure`. Never commit the lock or force-track any file inside
  `managed_components/` (no `.gitignore` negation exceptions — that was the
  v1→v2 migration break that pulled a broken half-component on fresh clone).

- Manifest pin policy: the cube's hardware-relevant deps are bounded
  (`^x.y.z` / `~` / `==`). The only unbounded `'*'` deps are `target in [esp32p4]`
  gated, so they never enter the esp32-s3 cube build (the manager skips them).
  Do not mass-tighten the vendored xiaozhi caret pins — high risk of transitive
  resolve breakage, low value (the lock pins exact versions locally each build).

- Build/flash the debug profile through the SDKCONFIG_DEFAULTS chain, never a
  bare `idf.py build`. `esp32-devtool flash --profile debug` sets
  `SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.debug"`. A bare
  `idf.py build` generates `sdkconfig` from `sdkconfig.defaults` ONLY — debug-only
  options (`CONFIG_CUBE_DEV_TLS_INSECURE`, `CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY`)
  land as `# ... is not set`, and ESP-IDF will NOT let the `.debug` defaults
  override an already-present value. If a debug-only Kconfig isn't taking effect,
  `rm -f sdkconfig` and reconfigure with the full chain.
