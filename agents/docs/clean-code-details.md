# Clean Code Rules — Details & Examples

## Early Returns

Flatten nested conditionals with early returns.

### Good

```typescript
export function validateToken(token: string): Result<Claims> {
  if (!token) return { ok: false, error: "Token is empty" };
  if (!token.startsWith("v4.local.")) return { ok: false, error: "Invalid token prefix" };

  const claims = decrypt(token);
  if (isExpired(claims)) return { ok: false, error: "Token expired" };

  return { ok: true, value: claims };
}
```

### Bad — Deeply nested

```typescript
export function validateToken(token: string): Result<Claims> {
  if (token) {
    if (token.startsWith("v4.local.")) {
      const claims = decrypt(token);
      if (!isExpired(claims)) {
        return { ok: true, value: claims };
      } else {
        return { ok: false, error: "Token expired" };
      }
    } else {
      return { ok: false, error: "Invalid token prefix" };
    }
  } else {
    return { ok: false, error: "Token is empty" };
  }
}
```

## Named Constants

```typescript
// Good
const MAX_SESSIONS = 10;
const AUTH_TIMEOUT_MS = 5_000;
const KEEPALIVE_INTERVAL_MS = 30_000;

if (sessions.size >= MAX_SESSIONS) { /* ... */ }

// Bad
if (sessions.size >= 10) { /* ... */ }
```

## Pure Functions

A pure function has no side effects and returns the same output for the same input.

```typescript
// Good — pure
export function buildContext(persona: string, memory: string, history: Message[]): string {
  return [persona, memory, ...history.map(formatMessage)].join("\n\n");
}

// Bad — impure (mutates input)
export function addToHistory(history: Message[], message: Message): void {
  history.push(message); // mutating parameter
}

// Good — immutable update
export function addToHistory(history: Message[], message: Message): Message[] {
  return [...history, message];
}
```
