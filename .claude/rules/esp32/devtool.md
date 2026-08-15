---
paths:
  - "esp32/devtool/**"
  - "esp32/cube/firmware/main/devtool_verbs/**"
---
# ESP32 devtool guardrails

- `esp32-devtool` is the only agent-facing host debug surface; board-specific behavior belongs in manifests, not Python branches.
- New USB verbs and HTTP handlers use the existing registries and update the frozen HTTP/JSON contract in the same change. Keep `WHOLE_ARCHIVE` for constructor registration.
- Every command honors `--json`; machine output stays stable and separate from human diagnostics.
- Daemon sockets are derived per port. Never reintroduce a single hard-coded cube socket or direct serial ownership in commands/tests.
- The firmware companion must compile out in production; verify the prod-strip audit after changing it.
- Hardware E2E uses the provided unattended fixtures and recovery flow, not mocks or hand-written pyserial access.
