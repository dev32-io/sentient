import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPluginBaseUrl, createSentientPluginClient } from "./plugin-client.ts";

// Stand up a Bun.serve fake to assert plugin wire shape end-to-end.
let server: ReturnType<typeof Bun.serve> | null = null;
let lastAuth = "";
let lastUrl = "";

beforeEach(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      lastAuth = req.headers.get("Authorization") ?? "";
      const u = new URL(req.url);
      lastUrl = u.pathname + u.search;

      // /search
      if (req.method === "GET" && u.pathname === "/api/plugins/sentient-plugin/search") {
        return Response.json({
          sessions: [
            {
              sessionId: "s1",
              snippet: ">>>moon<<< rise",
              role: "user",
              source: "sentient",
              model: "gpt",
              sessionStarted: 12345,
            },
            {
              sessionId: "s2",
              snippet: "another moon",
              role: "assistant",
              source: "sentient",
              model: "gpt",
              sessionStarted: 67890,
            },
          ],
          nextCursor: null,
        });
      }

      // /sessions/{id}/messages
      if (
        req.method === "GET" &&
        u.pathname.startsWith("/api/plugins/sentient-plugin/sessions/") &&
        u.pathname.endsWith("/messages")
      ) {
        const id = u.pathname.replace("/api/plugins/sentient-plugin/sessions/", "").replace("/messages", "");
        if (id === "missing") return new Response(JSON.stringify({ detail: "session not found" }), { status: 404 });
        return Response.json({
          sessionId: id,
          messages: [
            { role: "user", ts: 1_700_000_000, content: "hi" },
            { role: "assistant", ts: 1_700_000_001, content: "hello" },
          ],
        });
      }

      // /sessions/{id}
      if (req.method === "GET" && u.pathname.startsWith("/api/plugins/sentient-plugin/sessions/")) {
        const id = u.pathname.replace("/api/plugins/sentient-plugin/sessions/", "");
        if (id === "missing") return new Response(JSON.stringify({ detail: "session not found" }), { status: 404 });
        return Response.json({
          id,
          title: `t-${id}`,
          source: "sentient-user",
          started_at: 1_700_000_000,
          last_active: 1_700_000_500,
          ended_at: null,
          message_count: 4,
          is_active: false,
          parent_session_id: null,
        });
      }

      // DELETE /sessions/{id}
      if (req.method === "DELETE" && u.pathname.startsWith("/api/plugins/sentient-plugin/sessions/")) {
        const id = u.pathname.replace("/api/plugins/sentient-plugin/sessions/", "");
        if (id === "missing") return new Response(JSON.stringify({ detail: "session not found" }), { status: 404 });
        return Response.json({ ok: true, sessionId: id });
      }

      return new Response("not found", { status: 404 });
    },
  });
});

afterEach(() => {
  server?.stop(true);
  server = null;
});

const baseUrl = (): string => {
  if (!server) throw new Error("test server not started");
  return `http://127.0.0.1:${server.port}/api/plugins/sentient-plugin`;
};

describe("createSentientPluginClient", () => {
  it("search composes URL with q + limit and sends bearer", async () => {
    const c = createSentientPluginClient({ baseUrl: baseUrl(), token: "tok-1", timeoutMs: 5000 });
    const hits = await c.search("moon", 10);
    expect(lastUrl).toBe("/api/plugins/sentient-plugin/search?q=moon&limit=10");
    expect(lastAuth).toBe("Bearer tok-1");
    expect(hits).toHaveLength(2);
    // Key remap: camelCase wire → snake_case HermesSearchHit shape.
    expect(hits[0]).toEqual({
      session_id: "s1",
      snippet: ">>>moon<<< rise",
      role: "user",
      source: "sentient",
      model: "gpt",
      session_started: 12345,
    });
  });

  it("get returns null on 404 and the row otherwise", async () => {
    const c = createSentientPluginClient({ baseUrl: baseUrl(), token: "tok-1", timeoutMs: 5000 });
    expect(await c.get("missing")).toBeNull();
    const row = await c.get("s1");
    expect(row?.id).toBe("s1");
    expect(row?.source).toBe("sentient-user");
    expect(lastAuth).toBe("Bearer tok-1");
  });

  it("getMessages returns the messages array", async () => {
    const c = createSentientPluginClient({ baseUrl: baseUrl(), token: "tok-1", timeoutMs: 5000 });
    const msgs = await c.getMessages("s1");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: "user", content: "hi" });
  });

  it("getMessages 404 throws SentientPluginHttpError with status", async () => {
    const c = createSentientPluginClient({ baseUrl: baseUrl(), token: "tok-1", timeoutMs: 5000 });
    await expect(c.getMessages("missing")).rejects.toMatchObject({ status: 404, name: "SentientPluginHttpError" });
  });

  it("delete returns void on 200", async () => {
    const c = createSentientPluginClient({ baseUrl: baseUrl(), token: "tok-1", timeoutMs: 5000 });
    await expect(c.delete("s1")).resolves.toBeUndefined();
  });

  it("delete 404 throws SentientPluginHttpError", async () => {
    const c = createSentientPluginClient({ baseUrl: baseUrl(), token: "tok-1", timeoutMs: 5000 });
    await expect(c.delete("missing")).rejects.toMatchObject({ status: 404 });
  });

  it("401 from server is mapped to plugin auth failed error", async () => {
    server?.stop(true);
    server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("unauthorized", { status: 401 });
      },
    });
    const c = createSentientPluginClient({ baseUrl: baseUrl(), token: "bad", timeoutMs: 5000 });
    await expect(c.search("x", 5)).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining("plugin auth failed"),
    });
  });

  it("timeout aborts the request", async () => {
    server?.stop(true);
    server = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((r) => setTimeout(r, 1000));
        return Response.json({ sessions: [] });
      },
    });
    const c = createSentientPluginClient({ baseUrl: baseUrl(), token: "tok", timeoutMs: 50 });
    // AbortSignal.timeout fires a TimeoutError on abort.
    await expect(c.search("x", 5)).rejects.toThrow();
  });
});

describe("buildPluginBaseUrl", () => {
  it("replaces port with port+offset and appends plugin path", () => {
    expect(buildPluginBaseUrl("http://sentient-hermes:8650", 1000)).toBe(
      "http://sentient-hermes:9650/api/plugins/sentient-plugin",
    );
  });

  it("preserves any existing path on the input host (rare; defensive)", () => {
    // We always overwrite path with PLUGIN_PATH regardless of what came in.
    expect(buildPluginBaseUrl("http://sentient-hermes:8650/foo", 1000)).toBe(
      "http://sentient-hermes:9650/api/plugins/sentient-plugin",
    );
  });

  it("returns null when input URL has no port", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(buildPluginBaseUrl("http://sentient-hermes", 1000)).toBeNull();
    log.mockRestore();
  });

  it("returns null on invalid URL", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(buildPluginBaseUrl("not-a-url", 1000)).toBeNull();
    log.mockRestore();
  });
});
