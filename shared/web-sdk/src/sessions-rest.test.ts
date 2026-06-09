import { describe, expect, it, vi } from "vitest";
import { createSessionsRest } from "./sessions-rest.js";

// Helper to build a minimal fetch-compatible mock. vi.fn() returns a Mock
// which does not carry `preconnect` (a non-standard property on the global
// `fetch` in some environments), so we cast via `unknown` to satisfy the
// `typeof globalThis.fetch` param type without polluting test logic.
function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): typeof globalThis.fetch {
  return vi.fn(impl) as unknown as typeof globalThis.fetch;
}

describe("sessions REST client", () => {
  it("GET /sessions returns items with bearer", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchFn = mockFetch(async (url, init) => {
      calls.push([url, init]);
      return new Response(
        JSON.stringify({
          items: [
            {
              sessionId: "s-1",
              rootId: "r-1",
              title: "T",
              startedAt: 1,
              lastActiveAt: 1,
              messageCount: 0,
              isActive: true,
            },
          ],
          total: 1,
          hasMore: false,
        }),
        { status: 200 },
      );
    });
    const rest = createSessionsRest({ baseUrl: "https://h/api/v1", token: () => "t", fetchFn });
    const result = await rest.list();
    expect(result.items[0]?.sessionId).toBe("s-1");
    expect(calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer t" });
  });

  it("GET /sessions passes limit and offset as query params", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchFn = mockFetch(async (url, init) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ items: [], total: 0, hasMore: false }), { status: 200 });
    });
    const rest = createSessionsRest({ baseUrl: "https://h/api/v1", token: () => "t", fetchFn });
    await rest.list({ limit: 10, offset: 5 });
    const url = calls[0]?.[0] ?? "";
    expect(url).toContain("limit=10");
    expect(url).toContain("offset=5");
  });

  it("GET /sessions/search passes q and limit", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchFn = mockFetch(async (url, init) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    const rest = createSessionsRest({ baseUrl: "https://h/api/v1", token: () => "tok", fetchFn });
    const items = await rest.search("hello", 20);
    expect(items).toEqual([]);
    const url = calls[0]?.[0] ?? "";
    expect(url).toContain("q=hello");
    expect(url).toContain("limit=20");
  });

  it("PATCH /sessions/:id sends title in body with json headers", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchFn = mockFetch(async (url, init) => {
      calls.push([url, init]);
      return new Response(null, { status: 204 });
    });
    const rest = createSessionsRest({ baseUrl: "https://h/api/v1", token: () => "t", fetchFn });
    await rest.rename("s-1", "New Title");
    const [url, init] = calls[0] ?? [];
    expect(url).toBe("https://h/api/v1/sessions/s-1");
    expect(init?.method?.toUpperCase()).toBe("PATCH");
    expect(init?.body).toBe(JSON.stringify({ title: "New Title" }));
    expect((init?.headers as Record<string, string>)?.["content-type"]).toContain("application/json");
  });

  it("DELETE /sessions/:id sends bearer and resolves on 204", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchFn = mockFetch(async (url, init) => {
      calls.push([url, init]);
      return new Response(null, { status: 204 });
    });
    const rest = createSessionsRest({ baseUrl: "https://h/api/v1", token: () => "t", fetchFn });
    await rest.delete("s-1");
    const [url, init] = calls[0] ?? [];
    expect(url).toBe("https://h/api/v1/sessions/s-1");
    expect(init?.method?.toUpperCase()).toBe("DELETE");
    expect((init?.headers as Record<string, string>)?.authorization).toBe("Bearer t");
  });

  it("throws SessionsRestError with status on HTTP error", async () => {
    const fetchFn = mockFetch(async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
    const rest = createSessionsRest({ baseUrl: "https://h/api/v1", token: () => "t", fetchFn });
    await expect(rest.delete("s-missing")).rejects.toMatchObject({ status: 404 });
  });

  it("throws SessionsRestError with status=0 on network failure", async () => {
    const fetchFn = mockFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    const rest = createSessionsRest({ baseUrl: "https://h/api/v1", token: () => "t", fetchFn });
    await expect(rest.list()).rejects.toMatchObject({ status: 0 });
  });
});
