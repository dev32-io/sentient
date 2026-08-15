# Error handling — details

Use typed results for expected domain failures and exceptions for unexpected failures. Translate errors at process, network, and adapter boundaries; do not make every internal function catch and rethrow.

```typescript
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

function parseFrame(raw: string): Result<ClientMessage, "malformed"> {
  try {
    const value: unknown = JSON.parse(raw);
    const parsed = clientMessageSchema.safeParse(value);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: "malformed" };
  } catch {
    return { ok: false, error: "malformed" };
  }
}
```

At a WebSocket or HTTP boundary, validate first, map known failures to the existing wire error shape, and log only a reason/code plus stable identifiers. Never include the raw frame, prompt, message, transcript, or provider response in the log.

External calls have a bounded timeout and cancellation path:

```typescript
const bounded = AbortSignal.any([callerSignal, AbortSignal.timeout(5_000)]);
const response = await fetch(url, { signal: bounded });
```

Thread the caller's `AbortSignal` when available. Close iterators, sockets, streams, and temporary resources in `finally`. A cancelled turn must settle its turn state and stop TTS without killing unrelated background work.

Provider, MCP, and service adapters report boundary failures; retry/supervisor policy belongs to the owning runtime or system orchestrator. A failed optional dependency must not take down unrelated sessions. Permission and authorization failures fail closed at the tool boundary.
