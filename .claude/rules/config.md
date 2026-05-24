# Configuration Rules

- Every tunable constant MUST live in the project's YAML config file (e.g. `gateway/config.yaml`). No magic numbers in source files.
- Source code reads config values at startup. Never hardcode thresholds, timeouts, durations, or limits.
- Constants that control behavior (e.g., debounce timing, confidence thresholds, buffer sizes, debug verbosity) are always configurable. Debug-log toggles live in config too — flipping verbosity must not require a rebuild.
- Internal implementation details (HTTP status codes, protocol strings, log format widths) are NOT config — keep those as code constants.
- Group config by domain (server, session, providers, etc.). Add new sections as the project grows.
- Every config value MUST have an inline comment explaining what it does and valid ranges where applicable.
- Environment variables use `${VAR_NAME}` syntax for secrets only (API keys, tokens). Tunable values are plain YAML.
- Default values live in the YAML file, not in code. Code should fail loudly if a required config value is missing.

> When a rule is unclear, read `agents/docs/config-details.md`.
