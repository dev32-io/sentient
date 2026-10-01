# Agent Console — Details

## Surface and ownership

Debug devtool companion exposes USB-CDC JSON-RPC through `esp32-devtool cmd`. Cube verbs live in `esp32/cube/firmware/main/devtool_verbs/`; companion handlers live in `esp32/devtool/firmware/`. Constructor registration requires `WHOLE_ARCHIVE` retention. Add verbs through existing `devtool_register_verb()` conventions with bounded validation and stable JSON results, not a parallel dispatcher or serial helper.

Project manifest is `esp32/cube/devtool/boards/cube.yaml`, selected by `scripts/env.sh`. Inspect manifest and registration source together; manifest lists are not proof every registered verb is safe. Keep `--json` output machine-readable.

## Content-bearing diagnostics

Use bounded `state` and `cube.hardware.status` for approved local inspection. `UNKNOWN` may be normal during bootstrap; application voice state is not enrollment state.

Do not run `cmd ui.dump_tree` or `ui dump-tree` while pairing proof is populated, including hidden labels. Current tree exporter includes label text and has no matching bootstrap screenshot guard. `sentient.last_transcript` returns transcript content. Neither is a sanitized diagnostic surface: do not place secrets or real-user content into USB replies, daemon rings, terminal output or agent context. These restrictions document an open source boundary gap, not a firmware fix.

No `ui.snapshot` USB verb exists. Screenshots use HTTP `GET /screenshot` through `esp32-devtool screenshot`; consult the [HTTP contract](../../../../esp32/devtool/docs/HTTP-CONTRACT.md). Preserve bootstrap screenshot refusal and do not bypass it. Other screenshots may still contain private UI content and require approved local scope/private handling.

## Transport

The daemon owns USB-CDC and its socket/ring. Use supported `cmd`, `daemon ring` and approved HTTP surfaces; never open a competing pyserial connection or monitor.

Existing HIL `serial_dut` opens raw serial without daemon handoff. Do not combine it with daemon-backed operations or assume fixtures coordinate ownership. Approved checkpoint checks should consume the daemon ring. A command acknowledgement or explicit `mark` is not proof an asynchronous action completed; observe its actual target state.
