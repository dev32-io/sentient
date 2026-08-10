---
paths:
  - "esp32/**"
  - "shared/cube-sdk/**"
---
# C / C++ Clean Code Rules

- One class per (.h + .cc) pair. Filename matches primary class.
- Class cohesion is the split test, never a line count. When a class outgrows a single clear responsibility, refactor the responsibilities — don't just carve file boundaries.
- Decompose large functions along logical boundaries the moment one does more than one thing.
- Max nesting 3 levels. Use early returns to flatten.
- Line length 120 chars. 4-space indent. Never tabs.
- No magic numbers in source. Tunables live in Kconfig (`sdkconfig`) or a config struct passed in at construction.
- No commented-out code. Delete it. Git has history.
- No unused includes, parameters, or locals.
- Prefer `enum class` over plain `enum`. Prefer `constexpr` over `#define` for compile-time constants.
- Use RAII for every resource (handles, locks, FreeRTOS primitives, malloc'd buffers). Never bare `new`/`delete` — `std::unique_ptr` / `std::make_unique`.
- Pass non-owning references as pointers (`Foo*`) or `const Foo&`. Pass ownership as `std::unique_ptr<Foo>`. Never raw-pointer ownership transfer.
- Name booleans as questions: `is_ready`, `has_token`, `can_send`. snake_case for variables and methods.
- Name functions as actions: `open_audio_channel`, `parse_server_hello`, `send_audio_frame`.
- Tagged logging via `ESP_LOGx` only. Tag scheme: `sentient.cube.<area>` or `sentient.cube.sdk.<area>`. Never `printf` for log lines — reserved for `<<< RSP` / `<<< EVT` agent-console markers.
- High-frequency log paths (per-audio-frame, per-byte) MUST be gated behind a Kconfig flag (default off). Lifecycle events log at INFO unconditionally.
- Log previews ≤120 chars. Never log raw tokens, full audio payloads, or full transcript text.

> When a rule is unclear, read `agents/docs/esp32/cube/clean-code-details.md`.
