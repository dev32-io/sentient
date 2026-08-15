# Repository guardrails

- Challenge a materially unsafe or contradictory premise once, explain why, then preserve the user's decision and state the residual risk.
- Operator-tunable behavior belongs in the relevant YAML/config surface; protocol constants and implementation details stay in code.
- Catch failures at process or adapter boundaries. Expected domain failures use typed values; external calls have cancellation and bounded waits.
- Test at stable boundaries: wire contracts, state machines, security controls, and regressions. Avoid tests coupled to internal wiring or incidental presentation.
- Never log secrets or user content. Use sanitized structured fields such as ids, types, sizes, state transitions, and reasons.
- Local E2E uses the real local stack. Production is observational-only without explicit per-action approval.
