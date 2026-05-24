# Logging Details

Companion to `gateway/.claude/rules/logging.md`. Examples and rationale live here.

## Why extensive DEBUG coverage

Streaming pipelines fail in ways that are invisible from the outside: a
chunk was dropped, a boundary detector fired early, an emotion-tag call
timed out and fell back silently. The only useful post-mortem tool is a
log trail that already captured each chunk consumed, each decision made,
and each fallback taken. "We'll add logs once we see the bug" does not
work for streams — the bug has already happened by the time it's
reported.

Local development runs at `LOG_LEVEL=debug` (see
`deploy/docker/docker-compose.yml`), so verbose logs have zero cost in
the path where they're actually read. Pi / production defaults to INFO,
so the same file is quiet in prod without any conditional code.

## Required entries per stage

For every async generator, state machine, or stream processor:

| Event                     | Level | Example fields                                             |
|---------------------------|-------|-------------------------------------------------------------|
| Stage start               | INFO  | inputs, options, caller id                                  |
| Chunk / event consumed    | DEBUG | size, running totals, truncated preview (≤120 chars)        |
| Emission                  | DEBUG | index, length, preview                                      |
| Boundary / classifier hit | DEBUG | which rule fired, the value (terminator char, score)        |
| Fallback / soft-failure   | WARN  | `reason` tag, the numbers that triggered it                 |
| Abort / cancel            | DEBUG | where detected, what state was dropped                      |
| Stage complete            | INFO  | totals, elapsed ms, terminal status                         |

## Reference implementations

- `gateway/src/effects/utterance-aggregator.ts` — per-chunk intake,
  per-block emission, abort detection, tail-flush logging.
- `gateway/src/effects/emotion-tagger.ts` — batch start/complete,
  LLM response preview, each fallback path tagged by reason,
  per-block overrun / empty guards.

Treat those files as the baseline. New stages in the same layer should
match or exceed that density.

## Preview-truncation pattern

```ts
function preview(s: string, n = 120): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
```

Use structured payloads (object fields) rather than formatted strings.
The sanitizer works on fields, and downstream tooling parses them.

## Anti-patterns

- `log.debug("got chunk")` — no size, no preview. Useless.
- Full-buffer dumps — will blow up memory and log volume in long sessions.
- Logging only on the happy path — the failure path is the one you need.
- Silent fallbacks — every `catch`-and-return-default must log at WARN.
- Console.* calls — bypass the sanitizer and tagged-log hierarchy.
