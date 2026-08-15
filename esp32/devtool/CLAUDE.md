# esp32-devtool

Board-agnostic host CLI for cube flashing, diagnostics, screenshots, logs, and registered firmware verbs. Board behavior comes from `boards/*.yaml`; transport routing chooses USB-CDC or HTTP from the manifest.

- New commands live in `cli/commands/`; new board differences live in manifests.
- Keep machine-readable `--json` output stable and diagnostics on stderr.
- Catch `DevtoolError` only at the Click boundary, where its typed exit code is applied.
- Never import cube implementation code or hard-code one daemon socket/serial port.
- Unit tests require no hardware. Hardware tests use the existing fixtures and recovery flow.
- Update `docs/HTTP-CONTRACT.md` with HTTP handler changes and run the prod-strip audit after companion changes.
