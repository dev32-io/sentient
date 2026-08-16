import { describe, expect, it } from "bun:test";
import { createHomeAdapter } from "./home-adapter.js";

const state = {
  entity_id: "light.kitchen",
  state: "on",
  last_changed: "2026-01-01T00:00:00Z",
  attributes: { friendly_name: "Kitchen", aliases: ["Cooking light"], area_id: "kitchen" },
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("HomeAdapter REST boundary", () => {
  it("uses only the configured exact origin and validates state envelopes", async () => {
    const seen: Array<{ url: string; auth: string | null; redirect: RequestRedirect | undefined }> = [];
    const adapter = createHomeAdapter({
      baseUrl: "https://ha.example:8123",
      readToken: "secret-read",
      fetch: async (input, init) => {
        seen.push({
          url: String(input),
          auth: new Headers(init?.headers).get("authorization"),
          redirect: init?.redirect,
        });
        return jsonResponse([state]);
      },
    });
    const response = await adapter.entities(new AbortController().signal);
    expect(response).toEqual({
      outcome: "succeeded",
      entities: [
        {
          entityId: "light.kitchen",
          state: "on",
          name: "Kitchen",
          aliases: ["Cooking light"],
          areaId: "kitchen",
          lastChanged: "2026-01-01T00:00:00Z",
        },
      ],
    });
    expect(seen).toEqual([
      { url: "https://ha.example:8123/api/states", auth: "Bearer secret-read", redirect: "manual" },
    ]);
  });

  it("sanitizes malformed and connection failures into unavailable", async () => {
    const malformed = createHomeAdapter({
      baseUrl: "http://ha.local:8123",
      readToken: "never-visible",
      fetch: async () => jsonResponse([{ nope: true }]),
    });
    expect(await malformed.entities(new AbortController().signal)).toEqual({ outcome: "unavailable" });
    const down = createHomeAdapter({
      baseUrl: "http://ha.local:8123",
      readToken: "never-visible",
      fetch: async () => {
        throw new Error("connect ECONNREFUSED token=never-visible");
      },
    });
    expect(await down.entities(new AbortController().signal)).toEqual({ outcome: "unavailable" });
  });

  it("never follows credential-bearing redirects", async () => {
    let calls = 0;
    const adapter = createHomeAdapter({
      baseUrl: "https://ha.example",
      readToken: "secret",
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } });
      },
    });
    expect(await adapter.entities(new AbortController().signal)).toEqual({ outcome: "unavailable" });
    expect(calls).toBe(1);
  });

  it("rejects writes before dispatch when only an observation token is configured", async () => {
    let calls = 0;
    const adapter = createHomeAdapter({
      baseUrl: "http://ha.local:8123",
      readToken: "observe-only",
      fetch: async () => {
        calls += 1;
        return jsonResponse([]);
      },
    });
    expect((await adapter.control("light.kitchen", "on", new AbortController().signal)).outcome).toBe("rejected");
    expect(calls).toBe(0);
  });

  it("does not retry writes and reports a timeout after dispatch as accepted_unverified", async () => {
    let calls = 0;
    const adapter = createHomeAdapter({
      baseUrl: "http://ha.local:8123",
      readToken: "read",
      writeToken: "write",
      requestTimeoutMs: 5,
      fetch: async (_input, init) => {
        calls += 1;
        return await new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          }),
        );
      },
    });
    const response = await adapter.control("light.kitchen", "on", new AbortController().signal);
    expect(response.outcome).toBe("accepted_unverified");
    expect(adapter.operation(response.operationId)).toMatchObject({
      outcome: "accepted_unverified",
      targetId: "light.kitchen",
    });
    expect(calls).toBe(1);
  });

  it("authenticates validated WebSocket registry calls and bounds reconnect attempts", async () => {
    const urls: string[] = [];
    let opens = 0;
    const openWebSocket = (url: string): WebSocket => {
      urls.push(url);
      opens += 1;
      const socket = new EventTarget() as WebSocket;
      Object.assign(socket, {
        close: () => undefined,
        send: (body: string) => {
          const sent = JSON.parse(body) as { type: string; access_token?: string };
          if (sent.type === "auth") {
            expect(sent.access_token).toBe("read-secret");
            queueMicrotask(() =>
              socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "auth_ok" }) })),
            );
          } else {
            const result =
              sent.type === "config/floor_registry/list"
                ? [{ floor_id: "ground", name: "Ground" }]
                : sent.type === "config/area_registry/list"
                  ? [{ area_id: "kitchen", name: "Kitchen", floor_id: "ground" }]
                  : [];
            queueMicrotask(() =>
              socket.dispatchEvent(
                new MessageEvent("message", { data: JSON.stringify({ id: 1, success: true, result }) }),
              ),
            );
          }
        },
      });
      queueMicrotask(() =>
        socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "auth_required" }) })),
      );
      return socket;
    };
    const adapter = createHomeAdapter({
      baseUrl: "https://ha.example:8123",
      readToken: "read-secret",
      openWebSocket,
      fetch: async () => jsonResponse([]),
    });
    expect(await adapter.locations(new AbortController().signal)).toEqual({
      outcome: "succeeded",
      locations: [
        { id: "ground", name: "Ground", kind: "floor" },
        { id: "kitchen", name: "Kitchen", kind: "area", floorId: "ground" },
      ],
    });
    expect(urls).toEqual([
      "wss://ha.example:8123/api/websocket",
      "wss://ha.example:8123/api/websocket",
      "wss://ha.example:8123/api/websocket",
    ]);
    expect(opens).toBe(3);
  });

  it("threads caller cancellation into observational requests", async () => {
    const controller = new AbortController();
    const adapter = createHomeAdapter({
      baseUrl: "http://ha.local:8123",
      readToken: "read",
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          }),
        ),
    });
    const pending = adapter.entities(controller.signal);
    controller.abort();
    expect(await pending).toEqual({ outcome: "unavailable" });
  });
});
