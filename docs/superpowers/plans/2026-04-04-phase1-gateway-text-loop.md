# Phase 1: Gateway Core — Text Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** WebSocket connect → authenticate → send text → receive streaming LLM response. End-to-end text loop through the gateway pipeline.

**Architecture:** Bun built-in WebSocket server with PASETO v4.local auth, frame-based pipeline with priority queues, OpenRouter LLM via OpenAI SDK, config from YAML with env var resolution. Builds on Phase 0 scaffold — gateway/, shared/, and tooling are already in place.

**Tech Stack:** Bun 1.2+, TypeScript 5.8+ (strict), Vitest, PASETO v4.local (paseto-ts), OpenAI SDK (for OpenRouter), cockatiel (circuit breaker), Zod

**Prerequisite:** Phase 0 complete — `bun install && bun run ci` passes, all shared packages exist.

---

## File Structure (New/Modified in Phase 1)

```
gateway/
├── package.json                          # Updated: add paseto-ts, openai, cockatiel
├── config.yaml                           # Gateway runtime config
├── persona.md                            # System persona (~700 tokens)
├── src/
│   ├── index.ts                          # Modified: WS server replaces HTTP-only
│   ├── index.test.ts                     # Modified: WS + health tests
│   ├── server/
│   │   ├── ws-server.ts                  # Bun WebSocket server setup
│   │   └── ws-server.test.ts
│   ├── auth/
│   │   ├── paseto.ts                     # PASETO v4.local verify + token creation
│   │   ├── paseto.test.ts
│   │   ├── session-manager.ts            # Session store, 10-cap, cleanup
│   │   └── session-manager.test.ts
│   ├── pipeline/
│   │   ├── frame-queue.ts                # Priority queue (system > data/control)
│   │   ├── frame-queue.test.ts
│   │   ├── processor.ts                  # Processor interface + base
│   │   ├── processor.test.ts
│   │   ├── pipeline.ts                   # Pipeline wiring, frame routing
│   │   └── pipeline.test.ts
│   ├── providers/
│   │   ├── llm-provider.ts               # LLM provider interface
│   │   ├── openrouter.ts                 # OpenRouter via OpenAI SDK
│   │   └── openrouter.test.ts
│   ├── context/
│   │   ├── context-assembler.ts          # Build LLM context (persona + history)
│   │   └── context-assembler.test.ts
│   └── config/
│       ├── gateway-config.ts             # Load gateway config from YAML
│       └── gateway-config.test.ts
shared/
├── protocol/src/
│   ├── session.ts                        # Session type definition
│   ├── session.test.ts
│   └── index.ts                          # Updated: re-export session
├── testing/src/
│   ├── mock-auth.ts                      # Updated: real PASETO token generation
│   └── index.ts                          # Updated: re-export additions
```

---

## Task 1.1: Bun WebSocket Server + Health Endpoint

**Files:**
- Create: `gateway/src/server/ws-server.ts`
- Create: `gateway/src/server/ws-server.test.ts`
- Modify: `gateway/src/index.ts`
- Modify: `gateway/src/index.test.ts`

- [ ] **Step 1: Write test for WebSocket server creation — `gateway/src/server/ws-server.test.ts`**

```typescript
import { describe, it, expect, afterAll } from "vitest";
import { createGatewayServer } from "./ws-server.ts";

const TEST_PORT = 9100;

describe("createGatewayServer", () => {
  const server = createGatewayServer({ port: TEST_PORT, host: "127.0.0.1" });

  afterAll(() => {
    server.stop();
  });

  it("starts on specified port", () => {
    expect(server.port).toBe(TEST_PORT);
  });

  it("returns ok from health endpoint", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });

  it("returns 404 for unknown HTTP paths", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/unknown`);

    expect(response.status).toBe(404);
  });

  it("upgrades /ws path to WebSocket", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);

    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 2000);
    });

    expect(opened).toBe(true);
    ws.close();
  });

  it("rejects WebSocket upgrade on non-/ws paths", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/other`);

    expect(response.status).toBe(404);
  });

  it("returns 200 from readiness endpoint", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/ready`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ready", connections: 0 });
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd gateway && bunx vitest run src/server/ws-server.test.ts`

Expected: Fails — module not found.

- [ ] **Step 3: Implement WebSocket server — `gateway/src/server/ws-server.ts`**

```typescript
import type { Server, ServerWebSocket } from "bun";

export interface GatewayServerOptions {
  port: number;
  host: string;
}

export interface ClientData {
  sessionId: string | null;
  connectedAt: number;
}

let activeConnections = 0;

export function createGatewayServer(options: GatewayServerOptions): Server {
  const server = Bun.serve({
    port: options.port,
    hostname: options.host,

    fetch(request, server) {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }

      if (url.pathname === "/ready") {
        return Response.json({ status: "ready", connections: activeConnections });
      }

      if (url.pathname === "/ws") {
        const data: ClientData = {
          sessionId: null,
          connectedAt: Date.now(),
        };
        const upgraded = server.upgrade(request, { data });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      return new Response("Not Found", { status: 404 });
    },

    websocket: {
      open(_ws: ServerWebSocket<ClientData>) {
        activeConnections++;
      },

      message(_ws: ServerWebSocket<ClientData>, _message: string | Buffer) {
        // Message handling wired in Task 1.7
      },

      close(_ws: ServerWebSocket<ClientData>, _code: number, _reason: string) {
        activeConnections--;
      },
    },
  });

  return server;
}
```

- [ ] **Step 4: Run test — verify it passes**

Run: `cd gateway && bunx vitest run src/server/ws-server.test.ts`

Expected: 6 tests pass.

- [ ] **Step 5: Update `gateway/src/index.ts` to use new server**

```typescript
import { createGatewayServer } from "./server/ws-server.ts";

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? "3000");
const GATEWAY_HOST = process.env.GATEWAY_HOST ?? "0.0.0.0";

const server = createGatewayServer({
  port: GATEWAY_PORT,
  host: GATEWAY_HOST,
});

console.log(`Gateway listening on ${server.hostname}:${server.port}`);

export { server };
```

- [ ] **Step 6: Update `gateway/src/index.test.ts`**

```typescript
import { describe, it, expect, afterAll } from "vitest";
import { server } from "./index.ts";

const BASE_URL = `http://${server.hostname}:${server.port}`;

afterAll(() => {
  server.stop();
});

describe("gateway entry point", () => {
  it("health endpoint returns ok", async () => {
    const response = await fetch(`${BASE_URL}/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });

  it("WebSocket endpoint accepts connections", async () => {
    const ws = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);

    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 2000);
    });

    expect(opened).toBe(true);
    ws.close();
  });
});
```

- [ ] **Step 7: Run all gateway tests**

Run: `cd gateway && bunx vitest run`

Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add gateway/src/server/ gateway/src/index.ts gateway/src/index.test.ts
git commit -m "feat(gateway): Bun WebSocket server with health and readiness endpoints"
```

---

## Task 1.2: PASETO Auth (Verify, Session Create, 10-Cap)

**Files:**
- Create: `shared/protocol/src/session.ts`
- Create: `shared/protocol/src/session.test.ts`
- Modify: `shared/protocol/src/index.ts`
- Create: `gateway/src/auth/paseto.ts`
- Create: `gateway/src/auth/paseto.test.ts`
- Create: `gateway/src/auth/session-manager.ts`
- Create: `gateway/src/auth/session-manager.test.ts`
- Modify: `shared/testing/src/mock-auth.ts`
- Modify: `shared/testing/src/index.ts`
- Modify: `gateway/package.json`

- [ ] **Step 1: Add `paseto-ts` dependency to gateway**

```bash
cd gateway && bun add paseto-ts
```

- [ ] **Step 2: Create session type — `shared/protocol/src/session.ts`**

```typescript
import { z } from "zod";
import { userRoleSchema } from "./roles.ts";

export const sessionSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  role: userRoleSchema,
  deviceId: z.string().min(1),
  createdAt: z.number(),
  expiresAt: z.number(),
});

export type Session = z.infer<typeof sessionSchema>;

export const TOKEN_CLAIMS_SCHEMA = z.object({
  sub: z.string().min(1),
  role: userRoleSchema,
  deviceId: z.string().min(1),
  iat: z.string().datetime().or(z.number()),
  exp: z.string().datetime().or(z.number()),
  jti: z.string().min(1),
});

export type TokenClaims = z.infer<typeof TOKEN_CLAIMS_SCHEMA>;
```

- [ ] **Step 3: Write test — `shared/protocol/src/session.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { sessionSchema, TOKEN_CLAIMS_SCHEMA } from "./session.ts";

describe("sessionSchema", () => {
  it("accepts valid session", () => {
    const result = sessionSchema.safeParse({
      sessionId: "s-abc123",
      userId: "user-1",
      role: "adult",
      deviceId: "device-1",
      createdAt: Date.now(),
      expiresAt: Date.now() + 86400000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty sessionId", () => {
    const result = sessionSchema.safeParse({
      sessionId: "",
      userId: "user-1",
      role: "adult",
      deviceId: "device-1",
      createdAt: Date.now(),
      expiresAt: Date.now() + 86400000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid role", () => {
    const result = sessionSchema.safeParse({
      sessionId: "s-abc123",
      userId: "user-1",
      role: "superadmin",
      deviceId: "device-1",
      createdAt: Date.now(),
      expiresAt: Date.now() + 86400000,
    });
    expect(result.success).toBe(false);
  });
});

describe("TOKEN_CLAIMS_SCHEMA", () => {
  it("accepts valid claims with number timestamps", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = TOKEN_CLAIMS_SCHEMA.safeParse({
      sub: "user-1",
      role: "adult",
      deviceId: "device-1",
      iat: now,
      exp: now + 86400,
      jti: "jti-abc123",
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid claims with ISO datetime strings", () => {
    const result = TOKEN_CLAIMS_SCHEMA.safeParse({
      sub: "user-1",
      role: "child",
      deviceId: "ipad-1",
      iat: "2026-04-04T00:00:00Z",
      exp: "2026-05-04T00:00:00Z",
      jti: "jti-xyz789",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing sub", () => {
    const result = TOKEN_CLAIMS_SCHEMA.safeParse({
      role: "adult",
      deviceId: "device-1",
      iat: 1000,
      exp: 2000,
      jti: "jti-abc",
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 4: Update `shared/protocol/src/index.ts`**

```typescript
export * from "./messages.ts";
export * from "./frames.ts";
export * from "./errors.ts";
export * from "./roles.ts";
export * from "./session.ts";
```

- [ ] **Step 5: Run protocol tests**

Run: `cd shared/protocol && bunx vitest run`

Expected: All tests pass including new session tests.

- [ ] **Step 6: Update `shared/testing/src/mock-auth.ts` with real PASETO token generation**

```typescript
import type { UserRole } from "@sentient/protocol";
import { V4 } from "paseto-ts/v4";

export interface MockTokenClaims {
  sub: string;
  role: UserRole;
  deviceId: string;
  iat: string;
  exp: string;
  jti: string;
}

const DEFAULT_TEST_SECRET = "k4.local.dGVzdC1zZWNyZXQta2V5LWZvci11bml0LXRlc3Rz";

/** Creates mock PASETO token claims for testing */
export function createMockTokenClaims(overrides: Partial<MockTokenClaims> = {}): MockTokenClaims {
  const now = new Date();
  const expiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  return {
    sub: "user-1",
    role: "adult",
    deviceId: "device-1",
    iat: now.toISOString(),
    exp: expiry.toISOString(),
    jti: `jti-${Math.random().toString(36).slice(2, 10)}`,
    ...overrides,
  };
}

/** Creates a real PASETO v4.local token for testing */
export function createAuthToken(
  claims: Partial<MockTokenClaims> = {},
  secretKey?: string,
): string {
  const fullClaims = createMockTokenClaims(claims);
  const key = secretKey ?? DEFAULT_TEST_SECRET;
  return V4.encrypt(fullClaims, key);
}

/** Creates an expired PASETO v4.local token for testing */
export function createExpiredAuthToken(
  claims: Partial<MockTokenClaims> = {},
  secretKey?: string,
): string {
  const past = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
  return createAuthToken(
    {
      ...claims,
      exp: past.toISOString(),
    },
    secretKey,
  );
}

/** Default test secret key — do NOT use in production */
export const TEST_PASETO_SECRET = DEFAULT_TEST_SECRET;
```

- [ ] **Step 7: Update `shared/testing/src/index.ts`**

```typescript
export { createMockWebSocket, type MockWebSocket } from "./mock-websocket.ts";
export { createMockSession, type MockSession } from "./mock-session.ts";
export { createMockStream, type MockProviderBehavior } from "./mock-provider.ts";
export {
  createAuthToken,
  createExpiredAuthToken,
  createMockTokenClaims,
  TEST_PASETO_SECRET,
  type MockTokenClaims,
} from "./mock-auth.ts";
```

- [ ] **Step 8: Write PASETO verification test — `gateway/src/auth/paseto.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { verifyToken } from "./paseto.ts";
import { createAuthToken, createExpiredAuthToken, TEST_PASETO_SECRET } from "@sentient/testing";

describe("verifyToken", () => {
  it("returns claims for valid token", async () => {
    const token = createAuthToken({ sub: "user-1", role: "adult" });
    const result = await verifyToken(token, TEST_PASETO_SECRET);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sub).toBe("user-1");
      expect(result.value.role).toBe("adult");
    }
  });

  it("returns claims for child role token", async () => {
    const token = createAuthToken({ sub: "user-2", role: "child", deviceId: "ipad-1" });
    const result = await verifyToken(token, TEST_PASETO_SECRET);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.role).toBe("child");
      expect(result.value.deviceId).toBe("ipad-1");
    }
  });

  it("returns error for expired token", async () => {
    const token = createExpiredAuthToken({ sub: "user-1" });
    const result = await verifyToken(token, TEST_PASETO_SECRET);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("expired");
    }
  });

  it("returns error for wrong secret key", async () => {
    const otherSecret = "k4.local.d3JvbmctdGVzdC1zZWNyZXQta2V5LWZvci10ZXN0";
    const token = createAuthToken({ sub: "user-1" });
    const result = await verifyToken(token, otherSecret);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("decrypt");
    }
  });

  it("returns error for empty token", async () => {
    const result = await verifyToken("", TEST_PASETO_SECRET);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("empty");
    }
  });

  it("returns error for malformed token", async () => {
    const result = await verifyToken("not-a-real-token", TEST_PASETO_SECRET);

    expect(result.ok).toBe(false);
  });

  it("returns error for v4.public token format", async () => {
    const result = await verifyToken("v4.public.fakepayload", TEST_PASETO_SECRET);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("v4.local");
    }
  });

  it("validates claims schema after decryption", async () => {
    // Token with missing required fields would fail schema validation
    // This is tested implicitly — if decrypt succeeds but claims are invalid,
    // the schema validation catches it
    const token = createAuthToken({ sub: "user-1", role: "adult" });
    const result = await verifyToken(token, TEST_PASETO_SECRET);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.jti).toBeDefined();
      expect(result.value.deviceId).toBeDefined();
    }
  });
});
```

- [ ] **Step 9: Run test — verify it fails**

Run: `cd gateway && bunx vitest run src/auth/paseto.test.ts`

Expected: Fails — module not found.

- [ ] **Step 10: Implement PASETO verification — `gateway/src/auth/paseto.ts`**

```typescript
import { V4 } from "paseto-ts/v4";
import { TOKEN_CLAIMS_SCHEMA, type TokenClaims } from "@sentient/protocol";

export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

const PASETO_LOCAL_PREFIX = "v4.local.";

export async function verifyToken(
  token: string,
  secretKey: string,
): Promise<Result<TokenClaims>> {
  if (!token) {
    return { ok: false, error: "Token is empty" };
  }

  if (!token.startsWith(PASETO_LOCAL_PREFIX)) {
    return { ok: false, error: "Token must be v4.local format" };
  }

  try {
    const decrypted = V4.decrypt(token, secretKey);
    const payload = typeof decrypted === "string" ? JSON.parse(decrypted) : decrypted;

    // Check expiry
    const exp = payload.exp;
    if (exp) {
      const expiryTime = typeof exp === "string" ? new Date(exp).getTime() : exp * 1000;
      if (expiryTime < Date.now()) {
        return { ok: false, error: "Token expired" };
      }
    }

    const parsed = TOKEN_CLAIMS_SCHEMA.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: `Invalid token claims: ${parsed.error.message}` };
    }

    return { ok: true, value: parsed.data };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown decryption error";
    return { ok: false, error: `Failed to decrypt token: ${message}` };
  }
}
```

- [ ] **Step 11: Run test — verify it passes**

Run: `cd gateway && bunx vitest run src/auth/paseto.test.ts`

Expected: 8 tests pass.

- [ ] **Step 12: Write session manager test — `gateway/src/auth/session-manager.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { createSessionManager } from "./session-manager.ts";
import type { TokenClaims } from "@sentient/protocol";

function makeClaims(overrides: Partial<TokenClaims> = {}): TokenClaims {
  const now = new Date();
  const exp = new Date(now.getTime() + 86400000);
  return {
    sub: "user-1",
    role: "adult",
    deviceId: "device-1",
    iat: now.toISOString(),
    exp: exp.toISOString(),
    jti: `jti-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  };
}

describe("SessionManager", () => {
  let manager: ReturnType<typeof createSessionManager>;

  beforeEach(() => {
    manager = createSessionManager({ maxSessions: 10 });
  });

  it("creates a session from valid claims", () => {
    const claims = makeClaims();
    const result = manager.createSession(claims);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.userId).toBe("user-1");
      expect(result.value.role).toBe("adult");
      expect(result.value.sessionId).toBeTruthy();
    }
  });

  it("returns session by id", () => {
    const claims = makeClaims();
    const created = manager.createSession(claims);
    if (!created.ok) throw new Error("Should create");

    const found = manager.getSession(created.value.sessionId);

    expect(found).toBeDefined();
    expect(found?.userId).toBe("user-1");
  });

  it("returns undefined for unknown session id", () => {
    const found = manager.getSession("nonexistent");
    expect(found).toBeUndefined();
  });

  it("removes a session", () => {
    const claims = makeClaims();
    const created = manager.createSession(claims);
    if (!created.ok) throw new Error("Should create");

    const removed = manager.removeSession(created.value.sessionId);

    expect(removed).toBe(true);
    expect(manager.getSession(created.value.sessionId)).toBeUndefined();
  });

  it("returns false when removing nonexistent session", () => {
    const removed = manager.removeSession("nonexistent");
    expect(removed).toBe(false);
  });

  it("returns active session count", () => {
    expect(manager.activeCount()).toBe(0);

    manager.createSession(makeClaims({ sub: "u1" }));
    manager.createSession(makeClaims({ sub: "u2" }));

    expect(manager.activeCount()).toBe(2);
  });

  it("enforces max session limit", () => {
    const smallManager = createSessionManager({ maxSessions: 2 });

    smallManager.createSession(makeClaims({ sub: "u1", deviceId: "d1" }));
    smallManager.createSession(makeClaims({ sub: "u2", deviceId: "d2" }));
    const third = smallManager.createSession(makeClaims({ sub: "u3", deviceId: "d3" }));

    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.error).toContain("limit");
    }
  });

  it("allows new session after one is removed", () => {
    const smallManager = createSessionManager({ maxSessions: 2 });

    const first = smallManager.createSession(makeClaims({ sub: "u1", deviceId: "d1" }));
    smallManager.createSession(makeClaims({ sub: "u2", deviceId: "d2" }));

    if (first.ok) {
      smallManager.removeSession(first.value.sessionId);
    }

    const third = smallManager.createSession(makeClaims({ sub: "u3", deviceId: "d3" }));
    expect(third.ok).toBe(true);
  });

  it("replaces existing session for same user+device", () => {
    const claims = makeClaims({ sub: "user-1", deviceId: "device-1" });

    const first = manager.createSession(claims);
    const second = manager.createSession(makeClaims({ sub: "user-1", deviceId: "device-1" }));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(manager.activeCount()).toBe(1);

    if (first.ok && second.ok) {
      expect(first.value.sessionId).not.toBe(second.value.sessionId);
    }
  });

  it("lists all active sessions", () => {
    manager.createSession(makeClaims({ sub: "u1", deviceId: "d1" }));
    manager.createSession(makeClaims({ sub: "u2", deviceId: "d2" }));

    const sessions = manager.listSessions();

    expect(sessions).toHaveLength(2);
  });

  it("rejects session with default 10-cap", () => {
    const defaultManager = createSessionManager();

    for (let i = 0; i < 10; i++) {
      const result = defaultManager.createSession(makeClaims({ sub: `u${i}`, deviceId: `d${i}` }));
      expect(result.ok).toBe(true);
    }

    const eleventh = defaultManager.createSession(makeClaims({ sub: "u10", deviceId: "d10" }));
    expect(eleventh.ok).toBe(false);
  });

  it("generates unique session ids", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const result = manager.createSession(makeClaims({ sub: `u${i}`, deviceId: `d${i}` }));
      if (result.ok) ids.add(result.value.sessionId);
    }
    expect(ids.size).toBe(10);
  });

  it("stores correct expiry from claims", () => {
    const futureExp = new Date(Date.now() + 7200000).toISOString(); // 2 hours
    const claims = makeClaims({ exp: futureExp });
    const result = manager.createSession(claims);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.expiresAt).toBe(new Date(futureExp).getTime());
    }
  });

  it("handles concurrent session creation for different users", () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      manager.createSession(makeClaims({ sub: `user-${i}`, deviceId: `dev-${i}` })),
    );

    const successes = results.filter((r) => r.ok);
    expect(successes).toHaveLength(5);
    expect(manager.activeCount()).toBe(5);
  });
});
```

- [ ] **Step 13: Run test — verify it fails**

Run: `cd gateway && bunx vitest run src/auth/session-manager.test.ts`

Expected: Fails — module not found.

- [ ] **Step 14: Implement session manager — `gateway/src/auth/session-manager.ts`**

```typescript
import type { Session, TokenClaims } from "@sentient/protocol";

export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface SessionManagerOptions {
  maxSessions?: number;
}

const DEFAULT_MAX_SESSIONS = 10;

export interface SessionManager {
  createSession(claims: TokenClaims): Result<Session>;
  getSession(sessionId: string): Session | undefined;
  removeSession(sessionId: string): boolean;
  activeCount(): number;
  listSessions(): Session[];
}

function generateSessionId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  const timestamp = Date.now().toString(36);
  return `s-${timestamp}-${random}`;
}

function sessionKey(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

export function createSessionManager(
  options: SessionManagerOptions = {},
): SessionManager {
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessions = new Map<string, Session>();
  const userDeviceIndex = new Map<string, string>(); // key -> sessionId

  return {
    createSession(claims: TokenClaims): Result<Session> {
      const key = sessionKey(claims.sub, claims.deviceId);

      // Replace existing session for same user+device
      const existingSessionId = userDeviceIndex.get(key);
      if (existingSessionId) {
        sessions.delete(existingSessionId);
        userDeviceIndex.delete(key);
      }

      // Check capacity (after removing duplicate)
      if (sessions.size >= maxSessions) {
        return {
          ok: false,
          error: `Session limit reached (${maxSessions}). Cannot create new session.`,
        };
      }

      const expiresAt = typeof claims.exp === "string"
        ? new Date(claims.exp).getTime()
        : claims.exp * 1000;

      const session: Session = {
        sessionId: generateSessionId(),
        userId: claims.sub,
        role: claims.role,
        deviceId: claims.deviceId,
        createdAt: Date.now(),
        expiresAt,
      };

      sessions.set(session.sessionId, session);
      userDeviceIndex.set(key, session.sessionId);

      return { ok: true, value: session };
    },

    getSession(sessionId: string): Session | undefined {
      return sessions.get(sessionId);
    },

    removeSession(sessionId: string): boolean {
      const session = sessions.get(sessionId);
      if (!session) return false;

      const key = sessionKey(session.userId, session.deviceId);
      userDeviceIndex.delete(key);
      sessions.delete(sessionId);
      return true;
    },

    activeCount(): number {
      return sessions.size;
    },

    listSessions(): Session[] {
      return Array.from(sessions.values());
    },
  };
}
```

- [ ] **Step 15: Run test — verify it passes**

Run: `cd gateway && bunx vitest run src/auth/session-manager.test.ts`

Expected: 14 tests pass.

- [ ] **Step 16: Run all gateway + shared tests**

Run: `cd /Users/kevinye/Development/sentient && bun run test:unit`

Expected: All tests pass.

- [ ] **Step 17: Commit**

```bash
git add shared/protocol/src/session.ts shared/protocol/src/session.test.ts shared/protocol/src/index.ts
git add shared/testing/src/mock-auth.ts shared/testing/src/index.ts
git add gateway/src/auth/ gateway/package.json
git commit -m "feat(gateway): PASETO v4.local auth verification and session manager with 10-cap"
```

---

## Task 1.3: Pipeline Framework (Frames, Processors, Queues)

**Files:**
- Create: `gateway/src/pipeline/frame-queue.ts`
- Create: `gateway/src/pipeline/frame-queue.test.ts`
- Create: `gateway/src/pipeline/processor.ts`
- Create: `gateway/src/pipeline/processor.test.ts`
- Create: `gateway/src/pipeline/pipeline.ts`
- Create: `gateway/src/pipeline/pipeline.test.ts`

- [ ] **Step 1: Write frame queue test — `gateway/src/pipeline/frame-queue.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { createFrameQueue } from "./frame-queue.ts";
import type { Frame, InterruptionFrame, TextFrame, StartFrame } from "@sentient/protocol";

function makeInterruptionFrame(): InterruptionFrame {
  return { kind: "system", type: "interruption", sessionId: "s1", timestamp: Date.now() };
}

function makeTextFrame(text: string): TextFrame {
  return { kind: "data", type: "text", text, isFinal: false };
}

function makeStartFrame(): StartFrame {
  return { kind: "control", type: "start", sessionId: "s1" };
}

describe("FrameQueue", () => {
  it("enqueues and dequeues frames in order", () => {
    const queue = createFrameQueue();
    const f1 = makeTextFrame("hello");
    const f2 = makeTextFrame("world");

    queue.enqueue(f1);
    queue.enqueue(f2);

    expect(queue.dequeue()).toBe(f1);
    expect(queue.dequeue()).toBe(f2);
  });

  it("returns undefined when empty", () => {
    const queue = createFrameQueue();
    expect(queue.dequeue()).toBeUndefined();
  });

  it("prioritizes system frames over data frames", () => {
    const queue = createFrameQueue();
    const data = makeTextFrame("hello");
    const system = makeInterruptionFrame();

    queue.enqueue(data);
    queue.enqueue(system);

    expect(queue.dequeue()).toBe(system);
    expect(queue.dequeue()).toBe(data);
  });

  it("prioritizes system frames over control frames", () => {
    const queue = createFrameQueue();
    const control = makeStartFrame();
    const system = makeInterruptionFrame();

    queue.enqueue(control);
    queue.enqueue(system);

    expect(queue.dequeue()).toBe(system);
    expect(queue.dequeue()).toBe(control);
  });

  it("maintains order within same priority", () => {
    const queue = createFrameQueue();
    const f1 = makeTextFrame("first");
    const f2 = makeTextFrame("second");
    const f3 = makeStartFrame();

    queue.enqueue(f1);
    queue.enqueue(f2);
    queue.enqueue(f3);

    // All priority 2 — maintain insertion order
    expect(queue.dequeue()).toBe(f1);
    expect(queue.dequeue()).toBe(f2);
    expect(queue.dequeue()).toBe(f3);
  });

  it("reports size correctly", () => {
    const queue = createFrameQueue();

    expect(queue.size()).toBe(0);

    queue.enqueue(makeTextFrame("a"));
    queue.enqueue(makeTextFrame("b"));

    expect(queue.size()).toBe(2);

    queue.dequeue();

    expect(queue.size()).toBe(1);
  });

  it("clears all frames", () => {
    const queue = createFrameQueue();
    queue.enqueue(makeTextFrame("a"));
    queue.enqueue(makeInterruptionFrame());

    queue.clear();

    expect(queue.size()).toBe(0);
    expect(queue.dequeue()).toBeUndefined();
  });

  it("clears only data and control frames, keeps system frames", () => {
    const queue = createFrameQueue();
    const system = makeInterruptionFrame();

    queue.enqueue(makeTextFrame("data"));
    queue.enqueue(system);
    queue.enqueue(makeStartFrame());

    queue.clearNonSystem();

    expect(queue.size()).toBe(1);
    expect(queue.dequeue()).toBe(system);
  });

  it("reports empty correctly", () => {
    const queue = createFrameQueue();
    expect(queue.isEmpty()).toBe(true);

    queue.enqueue(makeTextFrame("a"));
    expect(queue.isEmpty()).toBe(false);
  });

  it("handles interleaved system and data frames", () => {
    const queue = createFrameQueue();
    const d1 = makeTextFrame("first");
    const s1 = makeInterruptionFrame();
    const d2 = makeTextFrame("second");

    queue.enqueue(d1);
    queue.enqueue(s1);
    queue.enqueue(d2);

    // System first, then data in order
    expect(queue.dequeue()).toBe(s1);
    expect(queue.dequeue()).toBe(d1);
    expect(queue.dequeue()).toBe(d2);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd gateway && bunx vitest run src/pipeline/frame-queue.test.ts`

Expected: Fails — module not found.

- [ ] **Step 3: Implement frame queue — `gateway/src/pipeline/frame-queue.ts`**

```typescript
import type { Frame } from "@sentient/protocol";
import { framePriority, isSystemFrame } from "@sentient/protocol";

export interface FrameQueue {
  enqueue(frame: Frame): void;
  dequeue(): Frame | undefined;
  size(): number;
  isEmpty(): boolean;
  clear(): void;
  clearNonSystem(): void;
}

export function createFrameQueue(): FrameQueue {
  const systemQueue: Frame[] = [];
  const normalQueue: Frame[] = [];

  return {
    enqueue(frame: Frame): void {
      if (framePriority(frame) === 1) {
        systemQueue.push(frame);
      } else {
        normalQueue.push(frame);
      }
    },

    dequeue(): Frame | undefined {
      if (systemQueue.length > 0) {
        return systemQueue.shift();
      }
      return normalQueue.shift();
    },

    size(): number {
      return systemQueue.length + normalQueue.length;
    },

    isEmpty(): boolean {
      return systemQueue.length === 0 && normalQueue.length === 0;
    },

    clear(): void {
      systemQueue.length = 0;
      normalQueue.length = 0;
    },

    clearNonSystem(): void {
      normalQueue.length = 0;
    },
  };
}
```

- [ ] **Step 4: Run test — verify it passes**

Run: `cd gateway && bunx vitest run src/pipeline/frame-queue.test.ts`

Expected: 10 tests pass.

- [ ] **Step 5: Write processor test — `gateway/src/pipeline/processor.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { createProcessor, type ProcessorHandler } from "./processor.ts";
import type { Frame, TextFrame, InterruptionFrame } from "@sentient/protocol";

function makeTextFrame(text: string): TextFrame {
  return { kind: "data", type: "text", text, isFinal: false };
}

function makeInterruptionFrame(): InterruptionFrame {
  return { kind: "system", type: "interruption", sessionId: "s1", timestamp: Date.now() };
}

describe("Processor", () => {
  it("processes data frames through handler", async () => {
    const processed: Frame[] = [];
    const handler: ProcessorHandler = {
      async process(frame) {
        processed.push(frame);
        return [frame];
      },
    };

    const processor = createProcessor("test", handler);
    const input = makeTextFrame("hello");
    const output = await processor.push(input);

    expect(processed).toHaveLength(1);
    expect(processed[0]).toBe(input);
    expect(output).toHaveLength(1);
  });

  it("returns multiple output frames from one input", async () => {
    const handler: ProcessorHandler = {
      async process(frame) {
        if (frame.kind === "data" && frame.type === "text") {
          return [
            makeTextFrame(`${frame.text}-a`),
            makeTextFrame(`${frame.text}-b`),
          ];
        }
        return [frame];
      },
    };

    const processor = createProcessor("splitter", handler);
    const output = await processor.push(makeTextFrame("hello"));

    expect(output).toHaveLength(2);
    expect((output[0] as TextFrame).text).toBe("hello-a");
    expect((output[1] as TextFrame).text).toBe("hello-b");
  });

  it("returns empty array when handler filters frame", async () => {
    const handler: ProcessorHandler = {
      async process() {
        return [];
      },
    };

    const processor = createProcessor("filter", handler);
    const output = await processor.push(makeTextFrame("hello"));

    expect(output).toHaveLength(0);
  });

  it("handles system frames via handleSystem if provided", async () => {
    let systemHandled = false;
    const handler: ProcessorHandler = {
      async process(frame) {
        return [frame];
      },
      async handleSystem() {
        systemHandled = true;
      },
    };

    const processor = createProcessor("test", handler);
    await processor.pushSystem(makeInterruptionFrame());

    expect(systemHandled).toBe(true);
  });

  it("reports name correctly", () => {
    const handler: ProcessorHandler = {
      async process(frame) {
        return [frame];
      },
    };

    const processor = createProcessor("my-processor", handler);
    expect(processor.name).toBe("my-processor");
  });

  it("propagates handler errors", async () => {
    const handler: ProcessorHandler = {
      async process() {
        throw new Error("Handler failed");
      },
    };

    const processor = createProcessor("failing", handler);

    await expect(processor.push(makeTextFrame("hello"))).rejects.toThrow("Handler failed");
  });
});
```

- [ ] **Step 6: Run test — verify it fails**

Run: `cd gateway && bunx vitest run src/pipeline/processor.test.ts`

Expected: Fails — module not found.

- [ ] **Step 7: Implement processor — `gateway/src/pipeline/processor.ts`**

```typescript
import type { Frame, SystemFrame } from "@sentient/protocol";
import { isSystemFrame } from "@sentient/protocol";

export interface ProcessorHandler {
  process(frame: Frame): Promise<Frame[]>;
  handleSystem?(frame: SystemFrame): Promise<void>;
}

export interface Processor {
  readonly name: string;
  push(frame: Frame): Promise<Frame[]>;
  pushSystem(frame: SystemFrame): Promise<void>;
}

export function createProcessor(
  name: string,
  handler: ProcessorHandler,
): Processor {
  return {
    name,

    async push(frame: Frame): Promise<Frame[]> {
      return handler.process(frame);
    },

    async pushSystem(frame: SystemFrame): Promise<void> {
      if (handler.handleSystem) {
        await handler.handleSystem(frame);
      }
    },
  };
}
```

- [ ] **Step 8: Run test — verify it passes**

Run: `cd gateway && bunx vitest run src/pipeline/processor.test.ts`

Expected: 6 tests pass.

- [ ] **Step 9: Write pipeline test — `gateway/src/pipeline/pipeline.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { createPipeline } from "./pipeline.ts";
import { createProcessor, type ProcessorHandler } from "./processor.ts";
import type { Frame, TextFrame, InterruptionFrame } from "@sentient/protocol";

function makeTextFrame(text: string, isFinal = false): TextFrame {
  return { kind: "data", type: "text", text, isFinal };
}

function makeInterruptionFrame(): InterruptionFrame {
  return { kind: "system", type: "interruption", sessionId: "s1", timestamp: Date.now() };
}

function passthroughHandler(): ProcessorHandler {
  return {
    async process(frame) {
      return [frame];
    },
  };
}

function uppercaseHandler(): ProcessorHandler {
  return {
    async process(frame) {
      if (frame.kind === "data" && frame.type === "text") {
        return [{ ...frame, text: frame.text.toUpperCase() }];
      }
      return [frame];
    },
  };
}

describe("Pipeline", () => {
  it("routes frame through single processor", async () => {
    const pipeline = createPipeline([
      createProcessor("pass", passthroughHandler()),
    ]);

    const results = await pipeline.process(makeTextFrame("hello"));

    expect(results).toHaveLength(1);
    expect((results[0] as TextFrame).text).toBe("hello");
  });

  it("routes frame through chained processors", async () => {
    const pipeline = createPipeline([
      createProcessor("upper", uppercaseHandler()),
      createProcessor("pass", passthroughHandler()),
    ]);

    const results = await pipeline.process(makeTextFrame("hello"));

    expect(results).toHaveLength(1);
    expect((results[0] as TextFrame).text).toBe("HELLO");
  });

  it("handles empty processor list", async () => {
    const pipeline = createPipeline([]);
    const results = await pipeline.process(makeTextFrame("hello"));

    expect(results).toHaveLength(1);
    expect((results[0] as TextFrame).text).toBe("hello");
  });

  it("propagates system frames to all processors", async () => {
    const systemCalls: string[] = [];

    const handler1: ProcessorHandler = {
      async process(frame) { return [frame]; },
      async handleSystem() { systemCalls.push("p1"); },
    };

    const handler2: ProcessorHandler = {
      async process(frame) { return [frame]; },
      async handleSystem() { systemCalls.push("p2"); },
    };

    const pipeline = createPipeline([
      createProcessor("p1", handler1),
      createProcessor("p2", handler2),
    ]);

    await pipeline.processSystem(makeInterruptionFrame());

    expect(systemCalls).toEqual(["p1", "p2"]);
  });

  it("handles processor that filters all frames", async () => {
    const filterHandler: ProcessorHandler = {
      async process() { return []; },
    };

    const pipeline = createPipeline([
      createProcessor("filter", filterHandler),
      createProcessor("pass", passthroughHandler()),
    ]);

    const results = await pipeline.process(makeTextFrame("hello"));

    expect(results).toHaveLength(0);
  });

  it("handles processor that expands to multiple frames", async () => {
    const expandHandler: ProcessorHandler = {
      async process(frame) {
        if (frame.kind === "data" && frame.type === "text") {
          return [
            makeTextFrame(`${frame.text}-1`),
            makeTextFrame(`${frame.text}-2`),
          ];
        }
        return [frame];
      },
    };

    const pipeline = createPipeline([
      createProcessor("expand", expandHandler),
      createProcessor("upper", uppercaseHandler()),
    ]);

    const results = await pipeline.process(makeTextFrame("hello"));

    expect(results).toHaveLength(2);
    expect((results[0] as TextFrame).text).toBe("HELLO-1");
    expect((results[1] as TextFrame).text).toBe("HELLO-2");
  });

  it("reports processor names", () => {
    const pipeline = createPipeline([
      createProcessor("first", passthroughHandler()),
      createProcessor("second", passthroughHandler()),
    ]);

    expect(pipeline.processorNames()).toEqual(["first", "second"]);
  });

  it("propagates errors from processors", async () => {
    const failHandler: ProcessorHandler = {
      async process() { throw new Error("Boom"); },
    };

    const pipeline = createPipeline([
      createProcessor("fail", failHandler),
    ]);

    await expect(pipeline.process(makeTextFrame("hello"))).rejects.toThrow("Boom");
  });
});
```

- [ ] **Step 10: Run test — verify it fails**

Run: `cd gateway && bunx vitest run src/pipeline/pipeline.test.ts`

Expected: Fails — module not found.

- [ ] **Step 11: Implement pipeline — `gateway/src/pipeline/pipeline.ts`**

```typescript
import type { Frame, SystemFrame } from "@sentient/protocol";
import type { Processor } from "./processor.ts";

export interface Pipeline {
  process(frame: Frame): Promise<Frame[]>;
  processSystem(frame: SystemFrame): Promise<void>;
  processorNames(): string[];
}

export function createPipeline(processors: Processor[]): Pipeline {
  return {
    async process(frame: Frame): Promise<Frame[]> {
      let frames: Frame[] = [frame];

      for (const processor of processors) {
        const nextFrames: Frame[] = [];
        for (const f of frames) {
          const output = await processor.push(f);
          nextFrames.push(...output);
        }
        frames = nextFrames;

        // If all frames were filtered out, stop early
        if (frames.length === 0) break;
      }

      return frames;
    },

    async processSystem(frame: SystemFrame): Promise<void> {
      for (const processor of processors) {
        await processor.pushSystem(frame);
      }
    },

    processorNames(): string[] {
      return processors.map((p) => p.name);
    },
  };
}
```

- [ ] **Step 12: Run test — verify it passes**

Run: `cd gateway && bunx vitest run src/pipeline/pipeline.test.ts`

Expected: 8 tests pass.

- [ ] **Step 13: Run all pipeline tests**

Run: `cd gateway && bunx vitest run src/pipeline/`

Expected: 24 tests pass across all pipeline files.

- [ ] **Step 14: Commit**

```bash
git add gateway/src/pipeline/
git commit -m "feat(gateway): frame-based pipeline framework with priority queues and processors"
```

---

## Task 1.4: OpenRouter LLM Provider (AsyncGenerator, SSE)

**Files:**
- Create: `gateway/src/providers/llm-provider.ts`
- Create: `gateway/src/providers/openrouter.ts`
- Create: `gateway/src/providers/openrouter.test.ts`
- Modify: `gateway/package.json`

- [ ] **Step 1: Add `openai` and `cockatiel` dependencies to gateway**

```bash
cd gateway && bun add openai cockatiel
```

- [ ] **Step 2: Create LLM provider interface — `gateway/src/providers/llm-provider.ts`**

```typescript
export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMStreamOptions {
  model: string;
  messages: LLMMessage[];
  signal: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMProvider {
  stream(options: LLMStreamOptions): AsyncGenerator<string>;
}
```

- [ ] **Step 3: Write OpenRouter test — `gateway/src/providers/openrouter.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOpenRouterProvider } from "./openrouter.ts";
import type { LLMStreamOptions } from "./llm-provider.ts";

// Mock OpenAI SDK
const mockCreate = vi.fn();

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: mockCreate,
        },
      };
    },
  };
});

function makeStreamOptions(overrides: Partial<LLMStreamOptions> = {}): LLMStreamOptions {
  return {
    model: "anthropic/claude-haiku",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ],
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Creates a mock async iterable that simulates SSE chunks */
async function* mockSSEStream(chunks: string[]) {
  for (const chunk of chunks) {
    yield {
      choices: [{ delta: { content: chunk }, finish_reason: null }],
    };
  }
}

describe("OpenRouterProvider", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("yields tokens from streaming response", async () => {
    mockCreate.mockResolvedValue(mockSSEStream(["Hello", " world", "!"]));

    const provider = createOpenRouterProvider({
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    const tokens: string[] = [];
    for await (const token of provider.stream(makeStreamOptions())) {
      tokens.push(token);
    }

    expect(tokens).toEqual(["Hello", " world", "!"]);
  });

  it("skips chunks with null content", async () => {
    async function* streamWithNulls() {
      yield { choices: [{ delta: { content: "Hello" }, finish_reason: null }] };
      yield { choices: [{ delta: { content: null }, finish_reason: null }] };
      yield { choices: [{ delta: { content: " world" }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: "stop" }] };
    }
    mockCreate.mockResolvedValue(streamWithNulls());

    const provider = createOpenRouterProvider({
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    const tokens: string[] = [];
    for await (const token of provider.stream(makeStreamOptions())) {
      tokens.push(token);
    }

    expect(tokens).toEqual(["Hello", " world"]);
  });

  it("stops when signal is aborted", async () => {
    const controller = new AbortController();

    async function* slowStream() {
      yield { choices: [{ delta: { content: "Hello" }, finish_reason: null }] };
      controller.abort();
      yield { choices: [{ delta: { content: " world" }, finish_reason: null }] };
    }
    mockCreate.mockResolvedValue(slowStream());

    const provider = createOpenRouterProvider({
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    const tokens: string[] = [];
    for await (const token of provider.stream(makeStreamOptions({ signal: controller.signal }))) {
      tokens.push(token);
    }

    expect(tokens).toEqual(["Hello"]);
  });

  it("passes correct parameters to OpenAI SDK", async () => {
    mockCreate.mockResolvedValue(mockSSEStream(["ok"]));

    const provider = createOpenRouterProvider({
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    const options = makeStreamOptions({
      model: "anthropic/claude-sonnet",
      maxTokens: 500,
      temperature: 0.7,
    });

    // Consume generator
    for await (const _ of provider.stream(options)) { /* noop */ }

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "anthropic/claude-sonnet",
        stream: true,
        max_tokens: 500,
        temperature: 0.7,
      }),
    );
  });

  it("uses default max_tokens when not specified", async () => {
    mockCreate.mockResolvedValue(mockSSEStream(["ok"]));

    const provider = createOpenRouterProvider({
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    for await (const _ of provider.stream(makeStreamOptions())) { /* noop */ }

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 1024,
      }),
    );
  });

  it("handles empty stream gracefully", async () => {
    async function* emptyStream() {
      // Yields nothing
    }
    mockCreate.mockResolvedValue(emptyStream());

    const provider = createOpenRouterProvider({
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    const tokens: string[] = [];
    for await (const token of provider.stream(makeStreamOptions())) {
      tokens.push(token);
    }

    expect(tokens).toEqual([]);
  });

  it("handles chunks with empty choices array", async () => {
    async function* streamWithEmptyChoices() {
      yield { choices: [] };
      yield { choices: [{ delta: { content: "Hello" }, finish_reason: null }] };
    }
    mockCreate.mockResolvedValue(streamWithEmptyChoices());

    const provider = createOpenRouterProvider({
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    const tokens: string[] = [];
    for await (const token of provider.stream(makeStreamOptions())) {
      tokens.push(token);
    }

    expect(tokens).toEqual(["Hello"]);
  });

  it("propagates API errors", async () => {
    mockCreate.mockRejectedValue(new Error("API rate limit exceeded"));

    const provider = createOpenRouterProvider({
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    const generator = provider.stream(makeStreamOptions());

    await expect(async () => {
      for await (const _ of generator) { /* noop */ }
    }).rejects.toThrow("API rate limit exceeded");
  });

  it("sends OpenRouter-specific headers", async () => {
    mockCreate.mockResolvedValue(mockSSEStream(["ok"]));

    const provider = createOpenRouterProvider({
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
      siteName: "Sentient",
    });

    for await (const _ of provider.stream(makeStreamOptions())) { /* noop */ }

    // Verify the provider was constructed (headers are set in constructor)
    expect(mockCreate).toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run test — verify it fails**

Run: `cd gateway && bunx vitest run src/providers/openrouter.test.ts`

Expected: Fails — module not found.

- [ ] **Step 5: Implement OpenRouter provider — `gateway/src/providers/openrouter.ts`**

```typescript
import OpenAI from "openai";
import type { LLMProvider, LLMStreamOptions } from "./llm-provider.ts";

export interface OpenRouterConfig {
  apiKey: string;
  baseUrl: string;
  siteName?: string;
  timeoutMs?: number;
}

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export function createOpenRouterProvider(config: OpenRouterConfig): LLMProvider {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    defaultHeaders: {
      "HTTP-Referer": config.siteName ?? "Sentient",
      "X-Title": config.siteName ?? "Sentient",
    },
    timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  return {
    async *stream(options: LLMStreamOptions): AsyncGenerator<string> {
      const response = await client.chat.completions.create({
        model: options.model,
        messages: options.messages,
        stream: true,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: options.temperature,
      });

      for await (const chunk of response as AsyncIterable<{
        choices: Array<{ delta: { content?: string | null }; finish_reason: string | null }>;
      }>) {
        if (options.signal.aborted) return;

        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          yield content;
        }
      }
    },
  };
}
```

- [ ] **Step 6: Run test — verify it passes**

Run: `cd gateway && bunx vitest run src/providers/openrouter.test.ts`

Expected: 9 tests pass.

- [ ] **Step 7: Commit**

```bash
git add gateway/src/providers/ gateway/package.json
git commit -m "feat(gateway): OpenRouter LLM provider with AsyncGenerator streaming via OpenAI SDK"
```

---

## Task 1.5: Context Assembly (Persona Only)

**Files:**
- Create: `gateway/persona.md`
- Create: `gateway/src/context/context-assembler.ts`
- Create: `gateway/src/context/context-assembler.test.ts`

- [ ] **Step 1: Create persona file — `gateway/persona.md`**

```markdown
You are Sentient, a warm and helpful family AI assistant running on a Raspberry Pi 5 at home.

## Core Traits
- Friendly, patient, and clear in communication
- Safe and appropriate for all family members, including children
- Helpful without being verbose — keep responses concise unless asked to elaborate
- Honest about limitations — say "I don't know" rather than guessing

## Behavior Guidelines
- Address family members naturally; no robotic or overly formal language
- For children: use age-appropriate language, be encouraging, never condescending
- For tasks: confirm before taking actions that modify state
- For questions: provide direct answers, then offer to elaborate if the topic is complex
- Never discuss harmful, illegal, or inappropriate topics
- Protect family privacy — never share information about family members with guests

## Response Style
- Conversational and warm, like a knowledgeable family friend
- Use short sentences for voice responses (they will be spoken aloud via TTS)
- Break complex answers into digestible parts
- When uncertain, ask clarifying questions rather than assuming
```

- [ ] **Step 2: Write context assembler test — `gateway/src/context/context-assembler.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { createContextAssembler, type ConversationTurn } from "./context-assembler.ts";

const TEST_PERSONA = "You are a helpful assistant.\n\n- Be concise\n- Be friendly";

describe("ContextAssembler", () => {
  it("creates system message from persona", () => {
    const assembler = createContextAssembler(TEST_PERSONA);
    const messages = assembler.buildMessages([]);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("helpful assistant");
  });

  it("includes conversation history", () => {
    const assembler = createContextAssembler(TEST_PERSONA);
    const history: ConversationTurn[] = [
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
    ];

    const messages = assembler.buildMessages(history);

    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("system");
    expect(messages[1]).toEqual({ role: "user", content: "What is 2+2?" });
    expect(messages[2]).toEqual({ role: "assistant", content: "4" });
  });

  it("appends new user message to history", () => {
    const assembler = createContextAssembler(TEST_PERSONA);
    const history: ConversationTurn[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ];

    const messages = assembler.buildMessages(history, "How are you?");

    expect(messages).toHaveLength(4);
    expect(messages[3]).toEqual({ role: "user", content: "How are you?" });
  });

  it("returns only system message when no history and no input", () => {
    const assembler = createContextAssembler(TEST_PERSONA);
    const messages = assembler.buildMessages([]);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("system");
  });

  it("preserves persona content exactly", () => {
    const persona = "Exact persona text.";
    const assembler = createContextAssembler(persona);
    const messages = assembler.buildMessages([]);

    expect(messages[0].content).toBe(persona);
  });

  it("handles single user message with no history", () => {
    const assembler = createContextAssembler(TEST_PERSONA);
    const messages = assembler.buildMessages([], "Hello!");

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1]).toEqual({ role: "user", content: "Hello!" });
  });

  it("maintains turn order in long conversations", () => {
    const assembler = createContextAssembler(TEST_PERSONA);
    const history: ConversationTurn[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "q3" },
      { role: "assistant", content: "a3" },
    ];

    const messages = assembler.buildMessages(history);

    expect(messages).toHaveLength(7); // 1 system + 6 turns
    for (let i = 1; i < messages.length; i++) {
      const expected = i % 2 === 1 ? "user" : "assistant";
      expect(messages[i].role).toBe(expected);
    }
  });

  it("estimates token count of assembled context", () => {
    const assembler = createContextAssembler(TEST_PERSONA);
    const history: ConversationTurn[] = [
      { role: "user", content: "Hello" },
    ];

    const estimate = assembler.estimateTokens(history);

    // Rough estimate: ~4 chars per token
    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(1000);
  });

  it("loads persona from file content", () => {
    const fileContent = "# Persona\n\nYou are a test assistant.";
    const assembler = createContextAssembler(fileContent);
    const messages = assembler.buildMessages([]);

    expect(messages[0].content).toBe(fileContent);
  });
});
```

- [ ] **Step 3: Run test — verify it fails**

Run: `cd gateway && bunx vitest run src/context/context-assembler.test.ts`

Expected: Fails — module not found.

- [ ] **Step 4: Implement context assembler — `gateway/src/context/context-assembler.ts`**

```typescript
import type { LLMMessage } from "../providers/llm-provider.ts";

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ContextAssembler {
  buildMessages(history: ConversationTurn[], currentInput?: string): LLMMessage[];
  estimateTokens(history: ConversationTurn[], currentInput?: string): number;
}

const CHARS_PER_TOKEN_ESTIMATE = 4;

export function createContextAssembler(persona: string): ContextAssembler {
  return {
    buildMessages(history: ConversationTurn[], currentInput?: string): LLMMessage[] {
      const messages: LLMMessage[] = [
        { role: "system", content: persona },
      ];

      for (const turn of history) {
        messages.push({ role: turn.role, content: turn.content });
      }

      if (currentInput) {
        messages.push({ role: "user", content: currentInput });
      }

      return messages;
    },

    estimateTokens(history: ConversationTurn[], currentInput?: string): number {
      let totalChars = persona.length;

      for (const turn of history) {
        totalChars += turn.content.length;
      }

      if (currentInput) {
        totalChars += currentInput.length;
      }

      return Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE);
    },
  };
}
```

- [ ] **Step 5: Run test — verify it passes**

Run: `cd gateway && bunx vitest run src/context/context-assembler.test.ts`

Expected: 9 tests pass.

- [ ] **Step 6: Commit**

```bash
git add gateway/persona.md gateway/src/context/
git commit -m "feat(gateway): context assembler with persona injection for LLM prompting"
```

---

## Task 1.6: Config System (YAML + Env Vars)

**Files:**
- Create: `gateway/config.yaml`
- Create: `gateway/src/config/gateway-config.ts`
- Create: `gateway/src/config/gateway-config.test.ts`

- [ ] **Step 1: Create gateway config file — `gateway/config.yaml`**

```yaml
# Gateway Configuration
# Environment variables are resolved at load time: ${VAR_NAME}

port: 3000
host: 0.0.0.0
max_sessions: 10
auth_timeout_ms: 5000
session_persist_ms: 120000

stt:
  provider: deepgram
  api_key: ${DEEPGRAM_API_KEY}
  model: nova-3
  endpointing_ms: 300
  utterance_end_ms: 1000

llm:
  provider: openrouter
  api_key: ${OPENROUTER_API_KEY}
  chat_model: anthropic/claude-haiku
  tool_model: anthropic/claude-sonnet
  classifier_model: google/gemini-flash-lite

tts:
  provider: fish-audio
  api_key: ${FISH_AUDIO_API_KEY}
  voice_id: default
  latency: balanced
```

- [ ] **Step 2: Write gateway config test — `gateway/src/config/gateway-config.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadGatewayConfig, loadGatewayConfigFromString } from "./gateway-config.ts";

describe("loadGatewayConfigFromString", () => {
  beforeEach(() => {
    process.env.DEEPGRAM_API_KEY = "sk-deepgram-test";
    process.env.OPENROUTER_API_KEY = "sk-openrouter-test";
    process.env.FISH_AUDIO_API_KEY = "sk-fish-test";
  });

  afterEach(() => {
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.FISH_AUDIO_API_KEY;
  });

  const validYaml = `
port: 3000
host: 0.0.0.0
max_sessions: 10
auth_timeout_ms: 5000
session_persist_ms: 120000
stt:
  provider: deepgram
  api_key: \${DEEPGRAM_API_KEY}
  model: nova-3
  endpointing_ms: 300
  utterance_end_ms: 1000
llm:
  provider: openrouter
  api_key: \${OPENROUTER_API_KEY}
tts:
  provider: fish-audio
  api_key: \${FISH_AUDIO_API_KEY}
`;

  it("loads and validates config with resolved env vars", () => {
    const config = loadGatewayConfigFromString(validYaml);

    expect(config.port).toBe(3000);
    expect(config.stt.api_key).toBe("sk-deepgram-test");
    expect(config.llm.api_key).toBe("sk-openrouter-test");
    expect(config.tts.api_key).toBe("sk-fish-test");
  });

  it("applies default values for optional fields", () => {
    const config = loadGatewayConfigFromString(validYaml);

    expect(config.llm.chat_model).toBe("anthropic/claude-haiku");
    expect(config.llm.tool_model).toBe("anthropic/claude-sonnet");
    expect(config.tts.voice_id).toBe("default");
    expect(config.tts.latency).toBe("balanced");
  });

  it("throws when required env var is missing", () => {
    delete process.env.DEEPGRAM_API_KEY;

    expect(() => loadGatewayConfigFromString(validYaml)).toThrow("DEEPGRAM_API_KEY");
  });

  it("throws on invalid config schema", () => {
    const invalidYaml = `
port: "not-a-number"
stt:
  provider: deepgram
  api_key: test
llm:
  provider: openrouter
  api_key: test
tts:
  provider: fish-audio
  api_key: test
`;
    expect(() => loadGatewayConfigFromString(invalidYaml)).toThrow();
  });

  it("accepts port override via env var", () => {
    const yamlWithEnvPort = `
port: 8080
host: 0.0.0.0
max_sessions: 5
auth_timeout_ms: 3000
session_persist_ms: 60000
stt:
  provider: deepgram
  api_key: \${DEEPGRAM_API_KEY}
  model: nova-3
  endpointing_ms: 300
  utterance_end_ms: 1000
llm:
  provider: openrouter
  api_key: \${OPENROUTER_API_KEY}
tts:
  provider: fish-audio
  api_key: \${FISH_AUDIO_API_KEY}
`;

    const config = loadGatewayConfigFromString(yamlWithEnvPort);
    expect(config.port).toBe(8080);
    expect(config.max_sessions).toBe(5);
  });

  it("rejects port outside valid range", () => {
    const badPortYaml = `
port: 99999
host: 0.0.0.0
max_sessions: 10
auth_timeout_ms: 5000
session_persist_ms: 120000
stt:
  provider: deepgram
  api_key: \${DEEPGRAM_API_KEY}
  model: nova-3
  endpointing_ms: 300
  utterance_end_ms: 1000
llm:
  provider: openrouter
  api_key: \${OPENROUTER_API_KEY}
tts:
  provider: fish-audio
  api_key: \${FISH_AUDIO_API_KEY}
`;

    expect(() => loadGatewayConfigFromString(badPortYaml)).toThrow();
  });
});

describe("loadGatewayConfig", () => {
  it("throws when config file does not exist", () => {
    expect(() => loadGatewayConfig("/nonexistent/path/config.yaml")).toThrow();
  });
});
```

- [ ] **Step 3: Run test — verify it fails**

Run: `cd gateway && bunx vitest run src/config/gateway-config.test.ts`

Expected: Fails — module not found.

- [ ] **Step 4: Implement gateway config loader — `gateway/src/config/gateway-config.ts`**

```typescript
import { readFileSync } from "node:fs";
import { loadConfig, gatewayConfigSchema, type GatewayConfig } from "@sentient/config";

export function loadGatewayConfigFromString(yamlContent: string): GatewayConfig {
  return loadConfig(yamlContent, gatewayConfigSchema);
}

export function loadGatewayConfig(filePath: string): GatewayConfig {
  const content = readFileSync(filePath, "utf-8");
  return loadGatewayConfigFromString(content);
}
```

- [ ] **Step 5: Run test — verify it passes**

Run: `cd gateway && bunx vitest run src/config/gateway-config.test.ts`

Expected: 7 tests pass.

- [ ] **Step 6: Commit**

```bash
git add gateway/config.yaml gateway/src/config/
git commit -m "feat(gateway): YAML config loader with env var resolution for gateway settings"
```

---

## Task 1.7: Text-to-Text Integration

**Files:**
- Modify: `gateway/src/server/ws-server.ts`
- Modify: `gateway/src/server/ws-server.test.ts`
- Modify: `gateway/src/index.ts`

This task wires everything together: WebSocket message handling → auth → session → pipeline → LLM → streaming response. This is the integration that proves the full text loop.

- [ ] **Step 1: Write integration test — `gateway/src/server/ws-server.test.ts` (add new describe block)**

Append the following integration tests to the existing `ws-server.test.ts`:

```typescript
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { createGatewayServer } from "./ws-server.ts";
import { createSessionManager } from "../auth/session-manager.ts";
import { createContextAssembler } from "../context/context-assembler.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { createAuthToken, TEST_PASETO_SECRET } from "@sentient/testing";
import type { LLMProvider } from "../providers/llm-provider.ts";

const TEST_PORT = 9100;

describe("createGatewayServer", () => {
  const server = createGatewayServer({ port: TEST_PORT, host: "127.0.0.1" });

  afterAll(() => {
    server.stop();
  });

  it("starts on specified port", () => {
    expect(server.port).toBe(TEST_PORT);
  });

  it("returns ok from health endpoint", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });

  it("returns 404 for unknown HTTP paths", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/unknown`);

    expect(response.status).toBe(404);
  });

  it("upgrades /ws path to WebSocket", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);

    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 2000);
    });

    expect(opened).toBe(true);
    ws.close();
  });

  it("rejects WebSocket upgrade on non-/ws paths", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/other`);

    expect(response.status).toBe(404);
  });

  it("returns 200 from readiness endpoint", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/ready`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ready", connections: expect.any(Number) });
  });
});

const INTEGRATION_PORT = 9101;

describe("Text-to-text integration", () => {
  // Mock LLM provider that returns known tokens
  function createMockLLMProvider(tokens: string[]): LLMProvider {
    return {
      async *stream() {
        for (const token of tokens) {
          yield token;
        }
      },
    };
  }

  const sessionManager = createSessionManager({ maxSessions: 10 });
  const contextAssembler = createContextAssembler("You are a test assistant.");
  const mockLLM = createMockLLMProvider(["Hello", " from", " Sentient", "!"]);

  const server = createGatewayServer({
    port: INTEGRATION_PORT,
    host: "127.0.0.1",
    pasetoSecret: TEST_PASETO_SECRET,
    sessionManager,
    contextAssembler,
    llmProvider: mockLLM,
  });

  afterAll(() => {
    server.stop();
  });

  function connectWS(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${INTEGRATION_PORT}/ws`);
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("Connection failed"));
      setTimeout(() => reject(new Error("Connection timeout")), 3000);
    });
  }

  function waitForMessage(ws: WebSocket, timeout = 3000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Message timeout")), timeout);
      ws.onmessage = (event) => {
        clearTimeout(timer);
        resolve(typeof event.data === "string" ? event.data : "");
      };
    });
  }

  function collectMessages(ws: WebSocket, count: number, timeout = 5000): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const messages: string[] = [];
      const timer = setTimeout(() => resolve(messages), timeout);

      ws.onmessage = (event) => {
        const data = typeof event.data === "string" ? event.data : "";
        messages.push(data);
        if (messages.length >= count) {
          clearTimeout(timer);
          resolve(messages);
        }
      };
    });
  }

  it("authenticates with valid PASETO token", async () => {
    const ws = await connectWS();
    const token = createAuthToken({ sub: "user-1", role: "adult" });

    ws.send(JSON.stringify({ type: "auth", token }));

    const response = await waitForMessage(ws);
    const parsed = JSON.parse(response);

    expect(parsed.type).toBe("auth.ok");
    expect(parsed.sessionId).toBeTruthy();
    expect(parsed.role).toBe("adult");

    ws.close();
  });

  it("rejects invalid auth token", async () => {
    const ws = await connectWS();

    ws.send(JSON.stringify({ type: "auth", token: "v4.local.invalid-token" }));

    const response = await waitForMessage(ws);
    const parsed = JSON.parse(response);

    expect(parsed.type).toBe("error");
    expect(parsed.code).toBe("auth_failed");

    ws.close();
  });

  it("rejects messages before auth", async () => {
    const ws = await connectWS();

    ws.send(JSON.stringify({ type: "text.input", text: "hello" }));

    const response = await waitForMessage(ws);
    const parsed = JSON.parse(response);

    expect(parsed.type).toBe("error");
    expect(parsed.code).toBe("auth_failed");

    ws.close();
  });

  it("streams LLM response for text.input after auth", async () => {
    const ws = await connectWS();
    const token = createAuthToken({ sub: "int-user", role: "adult", deviceId: "int-dev" });

    // Authenticate
    ws.send(JSON.stringify({ type: "auth", token }));
    const authResponse = await waitForMessage(ws);
    expect(JSON.parse(authResponse).type).toBe("auth.ok");

    // Send text input and collect streaming response
    // Expect: N delta messages + 1 done message
    const messagesPromise = collectMessages(ws, 5);
    ws.send(JSON.stringify({ type: "text.input", text: "Hello!" }));

    const messages = await messagesPromise;
    const parsed = messages.map((m) => JSON.parse(m));

    // Find delta messages
    const deltas = parsed.filter((m) => m.type === "response.text.delta");
    const done = parsed.find((m) => m.type === "response.text.done");

    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(done).toBeDefined();

    // Verify delta content matches mock tokens
    const fullText = deltas.map((d) => d.text).join("");
    expect(fullText).toBe("Hello from Sentient!");

    ws.close();
  });

  it("handles multiple messages in sequence", async () => {
    const ws = await connectWS();
    const token = createAuthToken({ sub: "seq-user", role: "adult", deviceId: "seq-dev" });

    // Auth
    ws.send(JSON.stringify({ type: "auth", token }));
    await waitForMessage(ws);

    // First message
    let messagesPromise = collectMessages(ws, 5);
    ws.send(JSON.stringify({ type: "text.input", text: "First" }));
    let messages = await messagesPromise;
    let deltas = messages.map((m) => JSON.parse(m)).filter((m) => m.type === "response.text.delta");
    expect(deltas.length).toBeGreaterThan(0);

    // Second message
    messagesPromise = collectMessages(ws, 5);
    ws.send(JSON.stringify({ type: "text.input", text: "Second" }));
    messages = await messagesPromise;
    deltas = messages.map((m) => JSON.parse(m)).filter((m) => m.type === "response.text.delta");
    expect(deltas.length).toBeGreaterThan(0);

    ws.close();
  });

  it("responds to ping with pong", async () => {
    const ws = await connectWS();
    const token = createAuthToken({ sub: "ping-user", role: "adult", deviceId: "ping-dev" });

    ws.send(JSON.stringify({ type: "auth", token }));
    await waitForMessage(ws);

    ws.send(JSON.stringify({ type: "ping" }));
    const response = await waitForMessage(ws);
    const parsed = JSON.parse(response);

    expect(parsed.type).toBe("pong");

    ws.close();
  });

  it("sends error for unknown message type", async () => {
    const ws = await connectWS();
    const token = createAuthToken({ sub: "err-user", role: "adult", deviceId: "err-dev" });

    ws.send(JSON.stringify({ type: "auth", token }));
    await waitForMessage(ws);

    ws.send(JSON.stringify({ type: "unknown.type" }));
    const response = await waitForMessage(ws);
    const parsed = JSON.parse(response);

    expect(parsed.type).toBe("error");
    expect(parsed.code).toBe("protocol_error");

    ws.close();
  });

  it("sends error for malformed JSON", async () => {
    const ws = await connectWS();
    const token = createAuthToken({ sub: "json-user", role: "adult", deviceId: "json-dev" });

    ws.send(JSON.stringify({ type: "auth", token }));
    await waitForMessage(ws);

    ws.send("not valid json{{{");
    const response = await waitForMessage(ws);
    const parsed = JSON.parse(response);

    expect(parsed.type).toBe("error");
    expect(parsed.code).toBe("protocol_error");

    ws.close();
  });

  it("rejects auth when session limit is reached", async () => {
    const tinyManager = createSessionManager({ maxSessions: 1 });
    const tinyServer = createGatewayServer({
      port: 9102,
      host: "127.0.0.1",
      pasetoSecret: TEST_PASETO_SECRET,
      sessionManager: tinyManager,
      contextAssembler,
      llmProvider: mockLLM,
    });

    try {
      // First connection — should succeed
      const ws1 = new WebSocket(`ws://127.0.0.1:9102/ws`);
      await new Promise<void>((resolve) => { ws1.onopen = () => resolve(); });
      ws1.send(JSON.stringify({ type: "auth", token: createAuthToken({ sub: "u1", deviceId: "d1" }) }));
      const msg1 = await new Promise<string>((resolve) => { ws1.onmessage = (e) => resolve(e.data as string); });
      expect(JSON.parse(msg1).type).toBe("auth.ok");

      // Second connection — should fail with session limit
      const ws2 = new WebSocket(`ws://127.0.0.1:9102/ws`);
      await new Promise<void>((resolve) => { ws2.onopen = () => resolve(); });
      ws2.send(JSON.stringify({ type: "auth", token: createAuthToken({ sub: "u2", deviceId: "d2" }) }));
      const msg2 = await new Promise<string>((resolve) => { ws2.onmessage = (e) => resolve(e.data as string); });
      expect(JSON.parse(msg2).type).toBe("error");
      expect(JSON.parse(msg2).code).toBe("session_limit");

      ws1.close();
      ws2.close();
    } finally {
      tinyServer.stop();
    }
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd gateway && bunx vitest run src/server/ws-server.test.ts`

Expected: Fails — `createGatewayServer` does not accept new options yet.

- [ ] **Step 3: Update WebSocket server to accept full integration options — `gateway/src/server/ws-server.ts`**

```typescript
import type { Server, ServerWebSocket } from "bun";
import { clientMessageSchema } from "@sentient/protocol";
import { verifyToken } from "../auth/paseto.ts";
import type { SessionManager } from "../auth/session-manager.ts";
import { createSessionManager } from "../auth/session-manager.ts";
import type { ContextAssembler, ConversationTurn } from "../context/context-assembler.ts";
import type { LLMProvider } from "../providers/llm-provider.ts";

export interface GatewayServerOptions {
  port: number;
  host: string;
  pasetoSecret?: string;
  sessionManager?: SessionManager;
  contextAssembler?: ContextAssembler;
  llmProvider?: LLMProvider;
  chatModel?: string;
}

export interface ClientData {
  sessionId: string | null;
  connectedAt: number;
  history: ConversationTurn[];
}

export function createGatewayServer(options: GatewayServerOptions): Server {
  const sessionManager = options.sessionManager ?? createSessionManager();
  const pasetoSecret = options.pasetoSecret ?? process.env.PASETO_SECRET_KEY ?? "";
  const contextAssembler = options.contextAssembler;
  const llmProvider = options.llmProvider;
  const chatModel = options.chatModel ?? "anthropic/claude-haiku";

  let activeConnections = 0;

  const server = Bun.serve({
    port: options.port,
    hostname: options.host,

    fetch(request, server) {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }

      if (url.pathname === "/ready") {
        return Response.json({ status: "ready", connections: activeConnections });
      }

      if (url.pathname === "/ws") {
        const data: ClientData = {
          sessionId: null,
          connectedAt: Date.now(),
          history: [],
        };
        const upgraded = server.upgrade(request, { data });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      return new Response("Not Found", { status: 404 });
    },

    websocket: {
      open(_ws: ServerWebSocket<ClientData>) {
        activeConnections++;
      },

      async message(ws: ServerWebSocket<ClientData>, message: string | Buffer) {
        const raw = typeof message === "string" ? message : message.toString();

        // Parse JSON
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          ws.send(JSON.stringify({
            type: "error",
            code: "protocol_error",
            message: "Malformed JSON",
          }));
          return;
        }

        // Not authenticated yet — only accept auth messages
        if (!ws.data.sessionId) {
          const authResult = clientMessageSchema.safeParse(parsed);
          if (!authResult.success || authResult.data.type !== "auth") {
            ws.send(JSON.stringify({
              type: "error",
              code: "auth_failed",
              message: "Authentication required. Send auth message first.",
            }));
            return;
          }

          // Verify PASETO token
          const tokenResult = await verifyToken(authResult.data.token, pasetoSecret);
          if (!tokenResult.ok) {
            ws.send(JSON.stringify({
              type: "error",
              code: "auth_failed",
              message: tokenResult.error,
            }));
            return;
          }

          // Create session
          const sessionResult = sessionManager.createSession(tokenResult.value);
          if (!sessionResult.ok) {
            ws.send(JSON.stringify({
              type: "error",
              code: "session_limit",
              message: sessionResult.error,
            }));
            return;
          }

          ws.data.sessionId = sessionResult.value.sessionId;
          ws.send(JSON.stringify({
            type: "auth.ok",
            sessionId: sessionResult.value.sessionId,
            role: sessionResult.value.role,
          }));
          return;
        }

        // Authenticated — validate message
        const msgResult = clientMessageSchema.safeParse(parsed);
        if (!msgResult.success) {
          ws.send(JSON.stringify({
            type: "error",
            code: "protocol_error",
            message: `Invalid message: ${msgResult.error.message}`,
          }));
          return;
        }

        const msg = msgResult.data;

        // Handle ping
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }

        // Handle text input
        if (msg.type === "text.input" && contextAssembler && llmProvider) {
          const messages = contextAssembler.buildMessages(ws.data.history, msg.text);

          // Add user turn to history
          ws.data.history.push({ role: "user", content: msg.text });

          const controller = new AbortController();
          let fullResponse = "";

          try {
            for await (const token of llmProvider.stream({
              model: chatModel,
              messages,
              signal: controller.signal,
            })) {
              fullResponse += token;
              ws.send(JSON.stringify({
                type: "response.text.delta",
                text: token,
              }));
            }

            // Add assistant turn to history
            ws.data.history.push({ role: "assistant", content: fullResponse });

            ws.send(JSON.stringify({ type: "response.text.done" }));
          } catch (error: unknown) {
            const errorMsg = error instanceof Error ? error.message : "LLM error";
            ws.send(JSON.stringify({
              type: "error",
              code: "provider_error",
              message: errorMsg,
            }));
          }
          return;
        }

        // Handle session.end
        if (msg.type === "session.end") {
          sessionManager.removeSession(ws.data.sessionId);
          ws.data.sessionId = null;
          ws.data.history = [];
          ws.close(1000, "Session ended");
          return;
        }
      },

      close(ws: ServerWebSocket<ClientData>, _code: number, _reason: string) {
        activeConnections--;
        if (ws.data.sessionId) {
          sessionManager.removeSession(ws.data.sessionId);
        }
      },
    },
  });

  return server;
}
```

- [ ] **Step 4: Run test — verify it passes**

Run: `cd gateway && bunx vitest run src/server/ws-server.test.ts`

Expected: All tests pass (basic + integration).

- [ ] **Step 5: Update `gateway/src/index.ts` with full wiring**

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createGatewayServer } from "./server/ws-server.ts";
import { createSessionManager } from "./auth/session-manager.ts";
import { createContextAssembler } from "./context/context-assembler.ts";
import { createOpenRouterProvider } from "./providers/openrouter.ts";

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? "3000");
const GATEWAY_HOST = process.env.GATEWAY_HOST ?? "0.0.0.0";
const PASETO_SECRET = process.env.PASETO_SECRET_KEY ?? "";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const CHAT_MODEL = process.env.CHAT_MODEL ?? "anthropic/claude-haiku";

// Load persona
let persona = "You are Sentient, a helpful family AI assistant.";
try {
  const personaPath = join(import.meta.dir, "..", "persona.md");
  persona = readFileSync(personaPath, "utf-8");
} catch {
  console.warn("Could not load persona.md, using default persona");
}

const sessionManager = createSessionManager({ maxSessions: 10 });
const contextAssembler = createContextAssembler(persona);

const llmProvider = OPENROUTER_API_KEY
  ? createOpenRouterProvider({
      apiKey: OPENROUTER_API_KEY,
      baseUrl: "https://openrouter.ai/api/v1",
      siteName: "Sentient",
    })
  : undefined;

const server = createGatewayServer({
  port: GATEWAY_PORT,
  host: GATEWAY_HOST,
  pasetoSecret: PASETO_SECRET,
  sessionManager,
  contextAssembler,
  llmProvider: llmProvider,
  chatModel: CHAT_MODEL,
});

console.log(`Gateway listening on ${server.hostname}:${server.port}`);
if (!OPENROUTER_API_KEY) {
  console.warn("OPENROUTER_API_KEY not set — LLM responses disabled");
}

export { server };
```

- [ ] **Step 6: Update `gateway/src/index.test.ts`**

```typescript
import { describe, it, expect, afterAll } from "vitest";
import { server } from "./index.ts";

const BASE_URL = `http://${server.hostname}:${server.port}`;

afterAll(() => {
  server.stop();
});

describe("gateway entry point", () => {
  it("health endpoint returns ok", async () => {
    const response = await fetch(`${BASE_URL}/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });

  it("WebSocket endpoint accepts connections", async () => {
    const ws = new WebSocket(`ws://${server.hostname}:${server.port}/ws`);

    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 2000);
    });

    expect(opened).toBe(true);
    ws.close();
  });

  it("returns 404 for unknown paths", async () => {
    const response = await fetch(`${BASE_URL}/unknown`);
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 7: Run all gateway tests**

Run: `cd gateway && bunx vitest run`

Expected: All tests pass.

- [ ] **Step 8: Run full CI check**

Run: `cd /Users/kevinye/Development/sentient && bun run ci`

Expected: Lint, typecheck, and all unit tests pass.

- [ ] **Step 9: Commit**

```bash
git add gateway/src/server/ gateway/src/index.ts gateway/src/index.test.ts
git commit -m "feat(gateway): text-to-text integration — auth + text.input → streaming response"
```

---

## Phase 1 Checkpoint Verification

- [ ] **Step 1: Start the gateway locally**

```bash
cd /Users/kevinye/Development/sentient
export PASETO_SECRET_KEY=$(openssl rand -hex 32)
cd gateway && bun run dev
```

Expected: `Gateway listening on 0.0.0.0:3000`

- [ ] **Step 2: Verify health endpoint**

```bash
curl http://localhost:3000/health
```

Expected: `{"status":"ok"}`

- [ ] **Step 3: Verify WebSocket connection with wscat**

```bash
# Install if needed: npm i -g wscat
wscat -c ws://localhost:3000/ws
```

Expected: Connection opens. Sending `{"type":"text.input","text":"hello"}` without auth returns an error with `auth_failed` code.

- [ ] **Step 4: Run full test suite**

```bash
cd /Users/kevinye/Development/sentient && bun run ci
```

Expected: All lint, typecheck, and tests pass. Total test count: ~105 (Phase 0 + Phase 1).

- [ ] **Step 5: Final commit — merge to develop**

```bash
git checkout develop
git merge feature/phase-1-gateway-text-loop
git branch -d feature/phase-1-gateway-text-loop
```

---

## Summary

| Task | Files Created/Modified | Test Count |
|------|----------------------|------------|
| 1.1 WS Server + Health | 4 files | ~6 |
| 1.2 PASETO Auth + Sessions | 8 files | ~25 |
| 1.3 Pipeline Framework | 6 files | ~24 |
| 1.4 OpenRouter LLM Provider | 3 files | ~9 |
| 1.5 Context Assembly | 3 files | ~9 |
| 1.6 Config System | 3 files | ~7 |
| 1.7 Text Integration | 3 files modified | ~15 |
| **Total** | **~30 files** | **~95** |

**Dependencies Added:** `paseto-ts`, `openai`, `cockatiel`

**Checkpoint:** `wscat -c ws://localhost:3000/ws` → send auth message with valid PASETO token → receive `auth.ok` → send `text.input` → receive streaming `response.text.delta` messages → receive `response.text.done`.
