import { describe, expect, it } from "vitest";
import type { TokenPayload, TokenResult } from "../../user-auth/types.js";
import { type SessionsHttpDeps, createSessionsHttpHandler } from "./sessions.js";

const okToken: TokenResult<TokenPayload> = {
  ok: true,
  value: { userId: "u_1", isAdmin: false, issuedAt: 0, expiresAt: 9999999999 },
};
const deps = (): SessionsHttpDeps => ({
  tokens: { validate: async (_t: string) => okToken },
  resolvePluginClient: async (_userId: string) => ({
    getMessages: async () => [{ role: "assistant", content: "hi", ts: 1 }],
    search: async () => [],
    get: async () => null,
    delete: async () => {},
  }),
  listSessions: async (_userId: string) => [{ sessionId: "s-1", title: "T", lastActiveAt: 5 }],
  titleStore: { getTitlesFor: async () => ({}), setTitle: async () => {}, delete: async () => {} },
});

describe("sessions REST handler — auth + scoping", () => {
  it("401s without a bearer", async () => {
    const h = createSessionsHttpHandler(deps());
    const res = await h(new Request("http://x/api/v1/sessions"));
    expect(res.status).toBe(401);
  });

  it("401s with an invalid token", async () => {
    const d = deps();
    d.tokens = { validate: async (_t: string) => ({ ok: false as const, error: "expired" as const }) };
    const h = createSessionsHttpHandler(d);
    const res = await h(new Request("http://x/api/v1/sessions", { headers: { authorization: "Bearer bad" } }));
    expect(res.status).toBe(401);
  });

  it("405 on unsupported method for /:id", async () => {
    const h = createSessionsHttpHandler(deps());
    const res = await h(
      new Request("http://x/api/v1/sessions/s-1", {
        method: "PUT",
        headers: { authorization: "Bearer t" },
      }),
    );
    expect(res.status).toBe(405);
  });
  it("lists sessions for the token's user", async () => {
    const h = createSessionsHttpHandler(deps());
    const res = await h(new Request("http://x/api/v1/sessions", { headers: { authorization: "Bearer t" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0].sessionId).toBe("s-1");
  });
  it("returns paginated history for a session", async () => {
    const h = createSessionsHttpHandler(deps());
    const res = await h(
      new Request("http://x/api/v1/sessions/s-1/messages?limit=50", {
        headers: { authorization: "Bearer t" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
  });

  // --- ownership ---

  it("404s getMessages for a session not owned by the user", async () => {
    const d = deps();
    // listSessions returns only s-1; requesting s-unknown should 404
    const h = createSessionsHttpHandler(d);
    const res = await h(
      new Request("http://x/api/v1/sessions/s-unknown/messages", {
        headers: { authorization: "Bearer t" },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("404s delete for a session not owned by the user", async () => {
    const d = deps();
    const h = createSessionsHttpHandler(d);
    const res = await h(
      new Request("http://x/api/v1/sessions/s-unknown", {
        method: "DELETE",
        headers: { authorization: "Bearer t" },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("404s rename for a session not owned by the user", async () => {
    const d = deps();
    const h = createSessionsHttpHandler(d);
    const res = await h(
      new Request("http://x/api/v1/sessions/s-unknown", {
        method: "PATCH",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ title: "New title" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  // --- search ---

  it("returns search results", async () => {
    const d = deps();
    const h = createSessionsHttpHandler(d);
    const res = await h(
      new Request("http://x/api/v1/sessions/search?q=hello&limit=10", {
        headers: { authorization: "Bearer t" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
  });

  // --- rename ---

  it("400s rename when title body is missing", async () => {
    const d = deps();
    d.listSessions = async () => [{ sessionId: "s-1", title: "T", lastActiveAt: 5 }];
    const h = createSessionsHttpHandler(d);
    const res = await h(
      new Request("http://x/api/v1/sessions/s-1", {
        method: "PATCH",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("200s rename for an owned session", async () => {
    const d = deps();
    const h = createSessionsHttpHandler(d);
    const res = await h(
      new Request("http://x/api/v1/sessions/s-1", {
        method: "PATCH",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ title: "Renamed" }),
      }),
    );
    expect(res.status).toBe(200);
  });

  // --- delete ---

  it("200s delete for an owned session", async () => {
    const d = deps();
    const h = createSessionsHttpHandler(d);
    const res = await h(
      new Request("http://x/api/v1/sessions/s-1", {
        method: "DELETE",
        headers: { authorization: "Bearer t" },
      }),
    );
    expect(res.status).toBe(200);
  });
});
