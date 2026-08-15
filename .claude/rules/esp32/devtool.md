---
paths:
  - "esp32/devtool/**"
  - "esp32/cube/firmware/main/devtool_verbs/**"
---
# ESP32 devtool guardrails

- `esp32-devtool` is the only agent-facing host debug surface; board-specific behavior belongs in manifests, not Python branches.
- New USB verbs and HTTP handlers use the existing companion registries and update the frozen HTTP/JSON contract in the same change. Keep `WHOLE_ARCHIVE` for constructor registration.
- Every command honors `--json`; machine output stays stable and separate from human diagnostics.
- Daemon sockets are derived per port. The daemon owns serial; never reintroduce a single hard-coded cube socket or direct serial ownership in commands/tests.
- The firmware companion must compile out in production; verify the prod-strip audit after changing it.
- Hardware E2E uses the provided unattended fixtures and recovery flow, not mocks or hand-written pyserial access.

Current references: [devtool README](../../../esp32/devtool/README.md), [HTTP contract](../../../esp32/devtool/docs/HTTP-CONTRACT.md), and [board manifest](../../../esp32/devtool/docs/BOARD-MANIFEST.md).

When a rule is unclear, read `agents/docs/esp32/cube/agent-console-details.md` for verb/registry details and `agents/docs/esp32/cube/testing-details.md` for test transport ownership.
