# Gateway architecture — details

The gateway is a native TypeScript host with a native orchestrator runtime. The composition root in `gateway/src/bootstrap/phase-services.ts` wires provider, access manager, append-only store, MCP client/catalog, tool broker, delegation guard, Hermes runner, and per-session runtime. These are live wiring, not future placeholders.

## Authority and storage

`UserPrincipal` is minted at authentication. `AccessManager` is the only authority boundary and grants attenuated capabilities. Resource handles carry capabilities, not ambient users. `ToolBroker` applies role and per-tool permission mediation; model intent is never authorization.

`gateway/src/store/` is the durable source of truth: one append-only SQLite database per user. Model and client projections read that store. The model projection forms provider messages; the client projection renders full history. Live and replay paths must converge. Late background results are appended as a `trigger` or `system` entry rather than being forged into an old tool-result pair.

## Turn/runtime boundary

A session runtime owns one server-minted `sessionId` and emits the native `turn.*` protocol; multiple client connections may attach to that session. A turn may stream text, invoke foreground tools, or register background work. Cancellation ends the turn and TTS; background work remains independent and later returns as a session stimulus. Every turn reaches one terminal frame.

Hermes is an intentionally narrow escape hatch: `delegateTask` launches one bounded Hermes child as a one-shot delegated tool. It is not the gateway brain, a session store, or a managed service. The native provider/runtime/store remain authoritative.

When changing this architecture, inspect `phase-services.ts`, `runtime/session-runtime.ts`, `store/`, `tools/tool-broker.ts`, and the protocol schemas together. Preserve explicit identity, exact frames, append-only persistence, and bounded cancellation.
