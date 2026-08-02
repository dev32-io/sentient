import { describe, expect, it, vi } from "vitest";
import { createSessionsRest, deriveRestBaseUrl } from "./sessions-rest.js";

// Helper to build a minimal fetch-compatible mock. vi.fn() returns a Mock
// which does not carry `preconnect` (a non-standard property on the global
// `fetch` in some environments), so we cast via `unknown` to satisfy the
// `typeof globalThis.fetch` param type without polluting test logic.
function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): typeof globalThis.fetch {
  return vi.fn(impl) as unknown as typeof globalThis.fetch;
}

describe("sessions REST client", () => {
  it("GET /sessions maps the gateway's {sessions: SessionMetadata[]} envelope to rows", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchFn = mockFetch(async (url, init) => {
      calls.push([url, init]);
      return new Response(
        JSON.stringify({
          sessions: [
            {
              sessionId: "s-1",
              createdAt: 1,
              updatedAt: 2,
              title: "T",
              titleProvenance: "user",
              version: 1,
            },
          ],
        }),
        { status: 200 },
      );
    });
    const rest = createSessionsRest({ baseUrl: "https://h/api/v1", token: () => "t", fetchFn });
    const result = await rest.list();
    expect(result.items[0]).toMatchObject({ sessionId: "s-1", title: "T", lastActiveAt: 2 });
    expect(result.total).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer t" });
  });

  it("GET /sessions falls back to a placeholder title for an un-generated session", async () => {
    const fetchFn = mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            sessions: [
              { sessionId: "s-2", createdAt: 1, updatedAt: 1, title: null, titleProvenance: null, version: 1 },
            ],
          }),
          { status: 200 },
        ),
    );
    const rest = createSessionsRest({ baseUrl: "https://h/api/v1", token: () => "t", fetchFn });
    const result = await rest.list();
    expect(result.items[0]?.title).toBe("New chat");
  });

  it("GET /sessions passes limit and offset as query params", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchFn = mockFetch(async (url, init) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
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

  it("GET /sessions/:id/messages returns items and sends bearer", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const feedItem = { entryId: "e", kind: "assistant" as const, ts: 1000, content: "hello" };
    const fetchFn = mockFetch(async (url, init) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ items: [feedItem], total: 1, offset: 0, limit: 100 }), { status: 200 });
    });
    const rest = createSessionsRest({ baseUrl: "https://h/api/v1", token: () => "tok", fetchFn });
    const items = await rest.getMessages("s-1");
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item?.kind).toBe("assistant");
    if (item?.kind === "assistant") expect(item.content).toBe("hello");
    const [url, init] = calls[0] ?? [];
    expect(url).toContain("/sessions/s-1/messages");
    expect((init?.headers as Record<string, string>)?.authorization).toBe("Bearer tok");
  });

  it("GET /sessions/:id/messages passes limit and offset as query params", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchFn = mockFetch(async (url, init) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ items: [], total: 0, offset: 10, limit: 5 }), { status: 200 });
    });
    const rest = createSessionsRest({ baseUrl: "https://h/api/v1", token: () => "t", fetchFn });
    await rest.getMessages("s-1", { limit: 5, offset: 10 });
    const url = calls[0]?.[0] ?? "";
    expect(url).toContain("limit=5");
    expect(url).toContain("offset=10");
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

describe("deriveRestBaseUrl", () => {
  it("converts wss URL to https and strips /ws", () => {
    expect(deriveRestBaseUrl("wss://h/api/v1/ws")).toBe("https://h/api/v1");
  });

  it("converts ws URL to http and strips /ws", () => {
    expect(deriveRestBaseUrl("ws://localhost:8080/api/v1/ws")).toBe("http://localhost:8080/api/v1");
  });

  it("strips query string and converts wss→https", () => {
    expect(deriveRestBaseUrl("wss://h/api/v1/ws?token=abc")).toBe("https://h/api/v1");
  });

  it("handles wss URL without a /ws suffix", () => {
    expect(deriveRestBaseUrl("wss://h/api/v1")).toBe("https://h/api/v1");
  });
});
