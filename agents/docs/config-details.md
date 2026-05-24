# Configuration Details

## What goes in `config.yaml`

Any constant that:
- Controls timing (timeouts, debounce, intervals, durations)
- Sets thresholds (confidence, energy, probability)
- Defines limits (max sessions, buffer sizes, token counts)
- Selects behavior (model names, voice IDs, formats)
- Toggles debug verbosity (log levels, dump-on-error flags, debug feature gates)
- Could reasonably be tuned without changing logic

## What stays as code constants

- Protocol values: HTTP status codes, WebSocket close codes, message type strings
- Internal implementation: log format widths, regex patterns, type guards
- Derived values: calculated from config (e.g., `bytes_per_frame = sample_rate * frame_duration * 2`)
- Test fixtures: mock data, test ports

## Environment variables vs YAML values

- `${VAR_NAME}` syntax: secrets only (API keys, signing secrets). These come from the environment and are never committed.
- Plain YAML values: everything else. These are committed and version-controlled. Changing a threshold should be a visible git diff.

## Adding a new configurable constant

1. Add the value to the project's YAML config under the appropriate section with an inline comment.
2. Add it to the project's config schema (zod) with validation (min/max/default).
3. Add it to the relevant options interface for the consumer.
4. Wire it through from the project entry point to the consumer via dependency injection.
5. Remove any hardcoded default from the consuming code — the YAML is the single source of truth.

## Example: adding a new timeout

```yaml
# config.yaml
session:
  new_feature_timeout_ms: 3000  # max wait for X before falling back to Y
```

```typescript
// schema (zod)
export const sessionSchema = z.object({
  new_feature_timeout_ms: z.number().int().min(500).max(30000).default(3000),
});
```

```typescript
// consumer — reads from injected config, no hardcoded fallback
const timeout = config.newFeatureTimeoutMs;
```

## Debug verbosity is config too

Logging levels, debug-dump toggles, and per-subsystem trace flags belong in
the YAML — not in env vars, not behind compile-time flags. Operators must
be able to flip verbosity without a rebuild. Pair this with the logging
rule: every event/signal/decision logs at DEBUG by default (see
`logging.md`); the YAML toggles whether DEBUG actually emits.
