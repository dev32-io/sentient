# ESP32 Cube Build — Details

## Source and authority

The firmware is a flat, owned tree at `esp32/cube/firmware/`. There is no
upstream submodule, overlay, or numbered-patch chain. Edit the tree in place and
keep unrelated firmware changes out of the build.

Use these references narrowly:

- [`esp32/cube/docs/README.md`](../../../../esp32/cube/docs/README.md) for the
  build commands and firmware layout only; its older command examples are not authority over the current devtool registries.
- [`esp32/cube/docs/build-profiles.md`](../../../../esp32/cube/docs/build-profiles.md)
  for debug/prod profile and companion stripping.
- [`esp32/devtool/README.md`](../../../../esp32/devtool/README.md) plus current source/manifest for the host command surface.

For verb and screenshot behavior, `agents/docs/esp32/cube/agent-console-details.md` and current firmware/devtool source take precedence: there is no `ui.snapshot` USB verb.

Build from `esp32/cube/firmware` with the configured ESP-IDF toolchain. Use
`esp32-devtool flash --profile debug|prod` for managed flashing; do not revive
`monitor.sh`, `flash.sh`, patch application, or submodule bump workflows.

## Registries and linking

Devtool verbs are in `firmware/main/devtool_verbs/`; companion HTTP handlers and
registries are in `esp32/devtool/firmware/`. Constructor-registered objects need
`WHOLE_ARCHIVE` in their component linkage. If a verb disappears at runtime,
inspect registration and link retention before changing the handler.

The debug companion (USB verbs, HTTP, and `log_relay`) is removed from prod via
the prod profile. Run the prod-strip audit after companion changes.
