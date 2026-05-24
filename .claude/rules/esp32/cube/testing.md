---
paths:
  - "esp32/cube/tests/hil/**"
  - "esp32/cube/firmware/**"
---
# ESP32 Cube Testing Rules

> When a rule is unclear, read `agents/docs/esp32/cube/testing-details.md`.

- Group A is the agent's CI-style default — unattended, no human in the loop.
  Any non-Group-A case requires a runbook entry in `esp32/cube/.e2e-testing` and
  explicit manual confirmation before running.

- New verbs MUST get a Group A smoke test under `esp32/cube/tests/hil/`. A verb
  that has no HIL coverage is not considered done.

- Use the provided pytest fixtures. Do NOT open pyserial directly in a test.
  - `cube_dut` — sends JSON-RPC verbs via `esp32-devtool --json cmd <verb>`.
  - `serial_dut` — tail-and-expect over a persistent serial connection.
  - `gateway_logs` — grep gateway log file by pattern + position.

- `CubeDut.cmd()` shells out to `esp32-devtool --json cmd <verb>`. The
  subprocess-per-call pattern still protects against the rapid-CMD stale-stdin
  glitch. Never open pyserial directly in a test.

- Cross-stack assertions: capture `gateway_logs.position()` BEFORE the action that
  triggers gateway-side side effects, then `gateway_logs.grep(pattern, since_pos=...)`
  after. Never grep from position 0 in a long-running test session.

- HIL tests do NOT mock anything. Real cube, real gateway, real WiFi. Any test that
  substitutes a mock for hardware contact is not a HIL test.

- When a test fails, debug with:
  - `esp32-devtool ui dump-tree` — structural screen inspection
  - `esp32-devtool screenshot --out /tmp/cube.png` — pixel screenshot
  before re-running. A re-run without diagnosis wastes time and may mask the root cause.
