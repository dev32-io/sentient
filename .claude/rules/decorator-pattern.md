# Decorator-Pattern Pipeline Rules

> When a rule is unclear, read `agents/docs/decorator-pattern-details.md`.

Use the decorator-unit pattern wherever a stream of typed items needs sequential transformation — TTS pipelines today; any post-LLM-token pipeline (display formatting, content moderation, translation, transcript redaction, etc.) tomorrow.

- Every stage is a decorator unit: `AsyncGenerator` in, `AsyncGenerator` out. The chunk type is defined by the pipeline's contract.
- Each unit processes only the fields it is responsible for. Pass through everything else unchanged.
- The terminal stage converts the stream to a different output type (e.g., text chunks to audio frames).
- Units compose by chaining. Pipeline shape is always a linear stream chain.
- Units are self-contained black boxes. Internal buffering is the unit's business, not the pipeline's.
- Units NEVER own connection or service lifecycle. Dependencies are injected by the flow manager.
- All service dependencies use abstract interfaces, never concrete implementations.
- Every unit respects `AbortSignal`. On abort: stop consuming, stop yielding, release buffers, do not throw.
- No unit is too small. One responsibility per unit. One file.
- Pre-allocate buffers generously. Double at 50% fill. Reset to initial capacity between pipeline runs.
- Service connections: one per pipeline run, not per item. Pre-warmed by the flow manager.
- Service initialization MUST happen in parallel. Dedicated state machine states track readiness.
- Stream by default. Only buffer when the unit's logic specifically requires full context.
