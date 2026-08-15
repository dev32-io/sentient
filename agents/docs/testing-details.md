# Testing — details

Keep a test when it protects a wire contract, state-machine invariant, security boundary, or an explicitly gated live integration. Test stable boundaries rather than incidental component markup or private wiring.

## Repository examples

- Protocol schemas and frame fixtures pin exact `turn.*`, session, and permission message shapes.
- Runtime tests pin append-only store behavior, live/replay projection convergence, cancellation, and terminal `turn.completed`/`turn.aborted` behavior.
- Tool-broker tests pin role gates, per-tool permissions, injection scanning, and fail-closed confirmation paths.
- Web UI tests pin the awaiting tracker, turn-audio FIFO, playback drain, and generation invalidation at their public ports.
- `@live` tests may exercise a real provider or addon when credentials are present; keep them separately gated.

```typescript
it("rejects a frame without the required turn id", () => {
  const result = turnStartedSchema.safeParse({ type: "turn.started", trigger: "user" });
  expect(result.success).toBe(false);
});
```

Mock external providers or MCP wire protocols, not the unit's own collaborators. Do not mock away the store, runtime, or authorization boundary that the test is meant to protect. Browser smoke is separate: it runs against the local native gateway and managed services; see `agents/docs/e2e-testing-details.md`.

Avoid tests that only pin copy, CSS classes, TypeScript types, constants, or a trivial pure utility. Name tests by observable behavior: `returns X when Y`, `rejects X when Y`, or `emits X after Y`.
