---
paths:
  - "gateway/src/**/*.ts"
---
# Cerebrum Rules

> When a rule is unclear, read `agents/docs/gateway/architecture-details.md` and `agents/docs/gateway/decorator-pattern-details.md`.

The cerebrum (`gateway/src/cerebrum/`) is a Hermes-event router, not an LLM runner. Hermes (separate process) owns the LLM call, agent loop, and tool execution. The gateway-side cerebrum decides WHEN to dispatch cycles, mirrors what Hermes does back to the SDK protocol, and orchestrates audio I/O.

- A **cognitive cycle** is one Hermes round-trip: gateway sends `user.message`, Hermes streams `assistant.message` per cycle iteration, terminates with `cycle.done`. Identified by `cycleId`.
- **Cycles are atomic.** At most one active cycle per session. `AttentionGate` is the only code path that dispatches a cycle to Hermes.
- External stimuli arriving during an active cycle accumulate in `ShortTermContext`; the gate fires the next cycle when the current one ends, projecting events since `lastCycleEndSeq`.
- ReAct continuations run back-to-back (no debounce, no salience threshold) bounded by `AttentionGateConfig.maxIterations`. Any external stimulus resets the chain.
- `TaskMirror` is read-only — it mirrors Hermes-owned tool execution for session awareness (display, cancel routing). The gateway does NOT own tool lifecycle; Hermes does.
- Session-level cancellation is split across two controllers:
  - `bargeInController` — aborts the cycle's stream **and** TTS. Tasks untouched. Fired by mic-onset in speech mode.
  - `interruptController` — aborts the cycle's stream, aborts TTS, **and** routes a cancellation request to Hermes for any interruptable tasks. Fired by the client `{ type: "interrupt" }` wire message (UI Stop button / Esc).
- Compose cancel primitives explicitly at call sites. Never add a "do-everything" method that fans out silently.
- Cutoff kinds on committed assistant entries are exactly `interrupt | barge-in`. No other kinds.
- Tool definitions live in `gateway/config.yaml#mcp_catalog` (operator-managed YAML) and the gateway-hosted MCP server (`gateway/src/mcp-host/`). The gateway never invokes tools directly — Hermes calls them via the standard MCP transport.
- `AttentionGate`, `bargeInController`, and `interruptController` are the only three components that know about cycle / cancellation lifecycle. `TaskMirror` is read-only. Cerebrum modules and pipeline stages must not reach across into each other's responsibilities.
- Frame-based processors, `SentenceAggregator`, `InterruptionFrame`, `UninterruptibleFrame` are pre-cerebrum legacy. The gateway-internal effects pipeline (`gateway/src/effects/`, `effect-wrapper`, `EffectDispatchResult`) and the OLD custom-WS Hermes platform-adapter shape (`sentient_gateway.py`, `ConnectionPool`, `PerProfileConnection`, `WsHermesClient`, custom WS frames) were retired in successive pivots. Do not reintroduce any of these. (The current ACP client legitimately has its own `hermes-adapter-client/per-profile-connection.ts` + a ref-counted per-user `AcpWireRegistry` pool — live, not the retired custom-WS ones.)
