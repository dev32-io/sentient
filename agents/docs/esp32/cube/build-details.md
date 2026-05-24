> **STALE — pending v2 rewrite.** This document still describes the v1 overlay + submodule + numbered-patches build flow. v2 uses a flat, owned `esp32/cube/firmware/` tree (no submodule, no patches). Until this file is rewritten, **prefer `.claude/rules/esp32/cube/build.md` as the authoritative source**.


# ESP32 Cube Build — Details & Examples

## Patch chain

Three patches under `esp32/cube/sentient/patches/`, applied in order by `build.sh`:

- **0001-add-sentient-cube-board.patch** — adds `CONFIG_BOARD_TYPE_SENTIENT_CUBE` to
  Kconfig, adds `sentient-cube` to `main/CMakeLists.txt` board dispatch,
  adds `agent_console` and `net_logger` to `MAIN_PRIV_REQUIRES_EXTRA`, and skips
  xiaozhi's own activation flow under `CONFIG_BOARD_TYPE_SENTIENT_CUBE` (uses a
  `DECLARE_BOARD(SentientCubeBoard)` guard).

- **0002-virtualize-board-late-init.patch** — promotes `display_` and `backlight_`
  to `protected` in `WaveshareEsp32S3TouchAmoled216` (upstream base class), makes
  `InitializeLcd()`, `InitializeBacklight()`, and `SetupUI()` virtual with a
  `LateInit()` hook. Required so `SentientCubeBoard` can override `SetupUI()` and
  swap in the toggle-button screen without fighting upstream layout code.

- **0003-disable-power-save-for-sentient-cube.patch** — passes `-1 / -1` to
  `PowerSaveTimer` under `CONFIG_BOARD_TYPE_SENTIENT_CUBE` so the display never
  dims or blanks during development.

Order matters: 0002 makes `display_` protected; 0001 references `SentientCubeBoard`
which calls the `LateInit()` hook that 0002 introduces.

---

## Submodule SHA bump workflow

1. Check what bumping to: `cd esp32/cube/upstream && git log --oneline -10`
2. Checkout the new SHA: `git checkout <new-sha>`
3. Return to repo root and update the submodule record:
   `git add esp32/cube/upstream && git commit -m "chore(esp32-cube): bump submodule to <sha>"`
4. Run `bash esp32/cube/scripts/build.sh`.
5. If a patch fails forward-apply AND reverse-check: the upstream context lines drifted.

### Regenerating a drifted patch

1. In `esp32/cube/upstream` (clean, at new SHA), apply only the patches BEFORE the
   failing one: `git apply sentient/patches/0001-...patch`
2. Copy the file you need to modify: `cp <file> <file>.before`
3. Apply the downstream patch manually or edit the file.
4. Regenerate: `git diff <file>.before <file> > sentient/patches/0003-...patch`
   (adjust the unified diff header to match the `a/` `b/` format expected by
   `git apply`; use `git diff HEAD -- <file>` against the staged change for a clean
   diff header).
5. Verify: `git apply --check sentient/patches/0003-...patch` and
   `git apply --reverse --check sentient/patches/0003-...patch`.

---

## Common build failures

### Symlink missing → CMakeLists not found
```
CMake Error: The source ... does not appear to contain a CMakeLists.txt
```
Run `bash esp32/cube/scripts/build.sh` once — the symlink step is the first thing it does.

### MINIMAL_BUILD strips component → undefined reference at link time
```
undefined reference to `agent_console_init`
```
The component was compiled but not linked. Add it to the `MAIN_PRIV_REQUIRES_EXTRA`
list in `main/CMakeLists.txt` via patch 0001. It's already there for `agent_console`
and `net_logger`; extend for new components.

### WHOLE_ARCHIVE missing → verb constructors stripped
```
W (1234) agent_console: method not found: state
```
Verb files self-register via `__attribute__((constructor))` static initializers.
Without `WHOLE_ARCHIVE`, the linker dead-code-eliminates the `.o` file because
`main` has no direct symbol reference to the verb function. Fix: add
`WHOLE_ARCHIVE` to the component's `idf_component_register()` call.

### Display class swap not effective → upstream SetupUI runs instead of SentientCubeBoard
```
// Symptom: original xiaozhi chat UI appears, not the toggle-button screen.
```
Cause A: patch 0002 not applied — `SetupUI()` is not virtual.
Cause B: `LateInit()` is called from the base-class constructor body, not from
`SentientCubeBoard`'s constructor body. C++ virtual dispatch from a base-class
constructor does not see the derived vtable. The `LateInit()` call MUST live
in `SentientCubeBoard::SentientCubeBoard()` after `super()` returns.

### net_logger socket assert on early boot
```
assert failed: tcpip_send_msg_wait_sem ...
```
`socket()` was called before `net_logger_init()` returned — or `net_logger_init()`
was called too early. The lazy-socket design avoids this: `net_logger.cc` defers
`socket(AF_INET, SOCK_DGRAM, 0)` until `sta_associated()` returns true inside the
sender task loop. Do not pre-create the socket in the init path.
