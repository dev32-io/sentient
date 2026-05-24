import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../../apply/router.js";
import { createApplyHandler } from "./apply.js";

// --- Fixtures ----------------------------------------------------------------

function makeRouterDeps(overrides: Partial<RouterDeps> = {}): RouterDeps {
  return {
    isAdmin: vi.fn(async () => true),
    diffSecrets: vi.fn(async () => []),
    perUserApply: vi.fn(async () => ({ ok: true as const, value: { state: "ready" as const, elapsedMs: 10 } })),
    systemOrchestrator: {
      applySubset: vi.fn(async () => ({ state: "idle", services: [], startedAt: null, finishedAt: null }) as never),
    },
    registry: new Map(),
    ...overrides,
  };
}

function makeAuthenticate(userId = "alice", ok = true) {
  return ok ? vi.fn(async () => ({ ok: true as const, userId })) : vi.fn(async () => ({ ok: false as const }));
}

function makeRequest(method: string, body?: unknown): Request {
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("authorization", "Bearer some-token");
  return new Request("http://localhost/api/v1/apply", {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

// --- Tests -------------------------------------------------------------------

describe("POST /api/v1/apply handler", () => {
  it("returns 405 when method is not POST", async () => {
    const handler = createApplyHandler({
      routerDeps: makeRouterDeps(),
      authenticate: makeAuthenticate(),
    });
    const res = await handler(new Request("http://localhost/api/v1/apply", { method: "GET" }));
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe("method-not-allowed");
  });

  it("returns 401 when authentication fails", async () => {
    const handler = createApplyHandler({
      routerDeps: makeRouterDeps(),
      authenticate: makeAuthenticate("alice", false),
    });
    const res = await handler(makeRequest("POST", { profile: null, secrets: null }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
  });

  it("returns 400 when body is not valid JSON", async () => {
    const handler = createApplyHandler({
      routerDeps: makeRouterDeps(),
      authenticate: makeAuthenticate(),
    });
    const req = new Request("http://localhost/api/v1/apply", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json", authorization: "Bearer t" }),
      body: "not-json{{{",
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bad-json");
  });

  it("returns 422 when body fails schema validation", async () => {
    const handler = createApplyHandler({
      routerDeps: makeRouterDeps(),
      authenticate: makeAuthenticate(),
    });
    // profile must be null or object, not a plain string
    const res = await handler(makeRequest("POST", { profile: "bad-type", secrets: null }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("schema");
  });

  it("returns 200 for admin user with both profile and secrets", async () => {
    const perUserApply = vi.fn(async () => ({
      ok: true as const,
      value: { state: "ready" as const, elapsedMs: 42 },
    }));
    const handler = createApplyHandler({
      routerDeps: makeRouterDeps({ isAdmin: vi.fn(async () => true), perUserApply }),
      authenticate: makeAuthenticate("alice"),
    });
    const res = await handler(makeRequest("POST", { profile: { model: { provider: "openrouter" } }, secrets: null }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("perUser");
  });

  it("returns 403 for non-admin user attempting system (secrets) apply", async () => {
    const handler = createApplyHandler({
      routerDeps: makeRouterDeps({ isAdmin: vi.fn(async () => false) }),
      authenticate: makeAuthenticate("bob"),
    });
    const res = await handler(
      makeRequest("POST", {
        profile: null,
        secrets: { llm: { api_key: "new-key" } },
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 200 with nulls when body has no profile or secrets", async () => {
    const handler = createApplyHandler({
      routerDeps: makeRouterDeps(),
      authenticate: makeAuthenticate(),
    });
    const res = await handler(makeRequest("POST", { profile: null, secrets: null }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.perUser).toBeNull();
    expect(body.system).toBeNull();
  });
});
