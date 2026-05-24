---
paths:
  - "esp32/devtool/**"
  - "esp32/cube/firmware/main/devtool_verbs/**"
---
# ESP32 Devtool Rules

> When a rule is unclear, read `esp32/devtool/CLAUDE.md` (agent-facing) +
> `esp32/devtool/docs/HTTP-CONTRACT.md` + `esp32/devtool/docs/BOARD-MANIFEST.md`.

- `esp32-devtool` is the ONLY agent-facing host-side dev/debug entry point.
  Never call legacy scripts directly — they no longer exist. Per-verb
  transport (USB-CDC vs HTTP) is chosen automatically by `cli/transport/router.py`
  based on the board manifest.

- Auto-detect drives every invocation. Pass `--board <name>` only when there
  are multiple cubes on USB, or when running against a board whose manifest
  is not yet auto-detectable.

- New verbs (USB-CDC) belong under `esp32/cube/firmware/main/devtool_verbs/`,
  one file per verb. Register via `devtool_register_verb()` with a
  `__attribute__((constructor))`. The component MUST keep `WHOLE_ARCHIVE` set
  in its CMakeLists or the constructor is dead-code-eliminated.

- New HTTP endpoints belong under
  `esp32/devtool/firmware/esp32_devtool_companion/src/handlers/`,
  registered via `devtool_register_http()`. Update `docs/HTTP-CONTRACT.md`
  in the same commit — clients depend on the frozen wire spec.

- Every new verb / endpoint MUST get an e2e parity test under
  `esp32/devtool/tests/e2e/`. Group A / B split is retired — every test is
  unattended. The `conftest.py` auto-recovers from wedges via the
  `recovery.py` flow; only AXP2101 PMIC fault requires a physical replug.

- Daemon socket path is per-port-hash:
  `/tmp/esp32-devtool/<sha1(port)[:12]>.sock`. Multiple cubes get distinct
  daemons. Never hardcode `/tmp/cube-daemon.sock`.

- `--json` flag MUST be respected by every command. Tests consume JSON;
  humans read the text form.

- The firmware companion compiles to ~0 bytes in prod via the
  `CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE=n` stub. Verify with
  `esp32-devtool audit-prod-strip` after every prod-build change.

- Manifest extensions live in `esp32/devtool/boards/<name>.yaml#extensions`.
  Set `transient: true` to mark a soon-to-retire hack (e.g. bake-creds);
  the CLI prints a deprecation hint on every invoke.
