# Error Handling Rules — Details & Examples

## Result Type Pattern

Use a discriminated union for failable operations instead of try/catch.

```typescript
// shared/protocol/src/result.ts
export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

### Usage

```typescript
export function parseMessage(raw: string): Result<ClientMessage> {
  try {
    const parsed = JSON.parse(raw);
    const validated = clientMessageSchema.safeParse(parsed);
    if (!validated.success) {
      return { ok: false, error: `Invalid message: ${validated.error.message}` };
    }
    return { ok: true, value: validated.data };
  } catch {
    return { ok: false, error: "Malformed JSON" };
  }
}

// Consumer
const result = parseMessage(raw);
if (!result.ok) {
  logger.warn("Bad message", { error: result.error, raw });
  return;
}
// result.value is typed correctly here
processMessage(result.value);
```

## Boundary Error Handling

Catch and translate errors only at system boundaries:

```typescript
// Good — boundary handler catches and logs
server.ws("/ws", {
  message(ws, raw) {
    try {
      handleMessage(ws, raw);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("WebSocket handler failed", { error: message });
      ws.send(JSON.stringify({ type: "error", code: "internal", message }));
    }
  },
});

// Good — business logic returns Result, never throws
function handleMessage(ws: WebSocket, raw: string): Result<void> {
  const parsed = parseMessage(raw);
  if (!parsed.ok) return parsed;
  // ...
}
```

## Timeouts

Every external call MUST have a timeout:

```typescript
const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
```
