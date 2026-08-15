# Agent Console — Details

## Surface

The debug companion exposes USB-CDC JSON-RPC through `esp32-devtool cmd`. Firmware
verbs live in `esp32/cube/firmware/main/devtool_verbs/`; HTTP handlers live in the
companion under `esp32/devtool/firmware/`. Both use constructor registration and
must be retained with `WHOLE_ARCHIVE`.

Add a verb by following an existing verb file: validate params, write the stable
JSON result/error contract, register with `devtool_register_verb()`, and add it to
the board manifest when appropriate. Do not create a parallel dispatcher or
host serial helper. Keep `--json` output machine-readable.

Current USB-CDC verbs include `state`, `mark`, `restart`, `log_level`,
`button.toggle`, `tts.cancel`, the `wifi.*` controls, `sentient.*` controls,
`audio.*` helpers, and `ui.dump_tree`. Check the source and
`esp32/devtool/boards/cube.yaml` for the authoritative registry/manifest.

There is no `ui.snapshot` USB verb. Screenshots use the HTTP `GET /screenshot`
endpoint and are retrieved with `esp32-devtool screenshot`; see the frozen
[HTTP contract](../../../../esp32/devtool/docs/HTTP-CONTRACT.md).

The daemon owns the USB-CDC port and keeps the per-port socket/ring. Use
`esp32-devtool cmd`, `daemon ring`, and `screenshot`; do not open pyserial or a
second monitor session beside it. Tests that need raw checkpoint matching must
coordinate ownership through their fixtures; `cube_dut` and `serial_dut` must
not compete for the port.
