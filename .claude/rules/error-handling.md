<!-- last-distilled: 2026-04-24 branch: feature/hermes-cerebrum-integration -->
# Error Handling Rules

- Failable operations return a Result type or typed error union. Never throw from business logic.
- Catch errors at system boundaries only (HTTP handlers, WebSocket handlers, CLI entry).
- Error messages MUST include: what failed, why, and actionable context.
- Never swallow errors silently. Log or propagate.
- Timeout every external call. No unbounded waits.
- Adapter `start()` resolves without throwing on transient dependency failure (service unreachable, connection refused). The supervisor/retry layer handles reconnects in the background; sessions stay live and accept input from other channels while waiting. A missing service is not a fatal adapter error.

> When a rule is unclear, read `agents/docs/error-handling-details.md`.
