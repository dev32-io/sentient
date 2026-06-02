import { describe, expect, it, vi } from "vitest";
import { createAcpClient } from "./client.js";

// Tests pin the public contract of AcpClient: id correlation, error
// rejection, notification dispatch, multi-handler semantics, parse-failure
// resilience, concurrent correlation, and clean-shutdown rejection.
//
// Wire shape per JSON-RPC 2.0 (https://www.jsonrpc.org/specification);
// confirmed against the upstream Python `acp/schema.py` envelope.

interface CapturedSend {
  sent: string[];
  send: (raw: string) => Promise<void>;
}

function captureSend(): CapturedSend {
  const sent: string[] = [];
  return {
    sent,
    send: (raw: string): Promise<void> => {
      sent.push(raw);
      return Promise.resolve();
    },
  };
}

describe("AcpClient — request/response correlation", () => {
  it("sends a properly-formed JSON-RPC request and resolves on matching response", async () => {
    const cap = captureSend();
    const client = createAcpClient({ send: cap.send });

    const promise = client.request("session/new", { cwd: "/tmp" });

    expect(cap.sent).toHaveLength(1);
    const sentReq = JSON.parse(cap.sent[0] as string);
    expect(sentReq.jsonrpc).toBe("2.0");
    expect(sentReq.method).toBe("session/new");
    expect(sentReq.id).toBe(1);
    expect(sentReq.params).toEqual({ cwd: "/tmp" });

    client.handleIncoming(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "s1" } }));

    await expect(promise).resolves.toEqual({ sessionId: "s1" });
  });

  it("rejects with a descriptive error when the response carries error", async () => {
    const cap = captureSend();
    const client = createAcpClient({ send: cap.send });

    const promise = client.request("session/new", {});
    client.handleIncoming(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "method not found" },
      }),
    );

    await expect(promise).rejects.toThrow(/-32601/);
    await expect(promise).rejects.toThrow(/method not found/);
  });

  it("correlates concurrent requests by id when responses arrive out of order", async () => {
    const cap = captureSend();
    const client = createAcpClient({ send: cap.send });

    const p1 = client.request("a", {});
    const p2 = client.request("b", {});
    const p3 = client.request("c", {});

    expect(cap.sent).toHaveLength(3);
    const ids = cap.sent.map((s) => (JSON.parse(s) as { id: number }).id);
    expect(ids).toEqual([1, 2, 3]);

    client.handleIncoming(JSON.stringify({ jsonrpc: "2.0", id: 3, result: "third" }));
    client.handleIncoming(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "first" }));
    client.handleIncoming(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "second" }));

    await expect(p1).resolves.toBe("first");
    await expect(p2).resolves.toBe("second");
    await expect(p3).resolves.toBe("third");
  });
});

describe("AcpClient — notify", () => {
  it("sends a notification with no id field", async () => {
    const cap = captureSend();
    const client = createAcpClient({ send: cap.send });

    await client.notify("session/cancel", { sessionId: "s1" });

    expect(cap.sent).toHaveLength(1);
    const sent = JSON.parse(cap.sent[0] as string) as Record<string, unknown>;
    expect(sent.jsonrpc).toBe("2.0");
    expect(sent.method).toBe("session/cancel");
    expect(sent.params).toEqual({ sessionId: "s1" });
    expect(sent).not.toHaveProperty("id");
  });
});

describe("AcpClient — onNotification dispatch", () => {
  it("fires the handler when a matching notification arrives and unsubscribes via the returned fn", () => {
    const cap = captureSend();
    const client = createAcpClient({ send: cap.send });
    const handler = vi.fn();

    const unsub = client.onNotification("session/update", handler);
    client.handleIncoming(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: "hi" } },
      }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: "hi" },
    });

    unsub();
    client.handleIncoming(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1" } }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing handler so other handlers for the same method still receive the notification", () => {
    const cap = captureSend();
    const client = createAcpClient({ send: cap.send });
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();

    client.onNotification("session/update", bad);
    client.onNotification("session/update", good);

    client.handleIncoming(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1" } }));

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe("AcpClient — handleIncoming resilience", () => {
  it("does not throw on malformed JSON and remains usable", async () => {
    const cap = captureSend();
    const client = createAcpClient({ send: cap.send });

    expect(() => client.handleIncoming("{not json")).not.toThrow();
    expect(() => client.handleIncoming("")).not.toThrow();

    // Still works after garbage input.
    const promise = client.request("session/new", {});
    client.handleIncoming(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
    await expect(promise).resolves.toEqual({ ok: true });
  });
});

describe("AcpClient — onRequestSent hook", () => {
  it("fires synchronously with the allocated id and method before the request promise settles", async () => {
    const cap = captureSend();
    const seen: Array<{ id: number | string; method: string }> = [];
    const client = createAcpClient({
      send: cap.send,
      onRequestSent: (id, method) => {
        seen.push({ id, method });
      },
    });

    const promise = client.request("session/prompt", { sessionId: "s1", prompt: [] });
    expect(seen).toEqual([{ id: 1, method: "session/prompt" }]);

    client.handleIncoming(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }));
    await promise;
  });

  it("isolates a throwing onRequestSent so the request still completes", async () => {
    const cap = captureSend();
    const client = createAcpClient({
      send: cap.send,
      onRequestSent: () => {
        throw new Error("boom");
      },
    });

    const promise = client.request("session/new", { cwd: "/", mcpServers: [] });
    expect(cap.sent).toHaveLength(1);
    client.handleIncoming(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "s1" } }));
    await expect(promise).resolves.toEqual({ sessionId: "s1" });
  });
});

describe("AcpClient — requestTimeoutMs backstop", () => {
  it("rejects a request whose response never lands within the deadline", async () => {
    vi.useFakeTimers();
    try {
      const cap = captureSend();
      const client = createAcpClient({ send: cap.send, requestTimeoutMs: 50 });
      const promise = client.request("session/prompt", { sessionId: "s1" });
      const expectation = expect(promise).rejects.toThrow(/timeout.*session\/prompt.*50ms/i);
      await vi.advanceTimersByTimeAsync(60);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT reject when the response arrives before the deadline", async () => {
    vi.useFakeTimers();
    try {
      const cap = captureSend();
      const client = createAcpClient({ send: cap.send, requestTimeoutMs: 50 });
      const promise = client.request("session/new", {});
      client.handleIncoming(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "s1" } }));
      await expect(promise).resolves.toEqual({ sessionId: "s1" });
      // Advancing past the deadline must not double-settle or throw.
      await vi.advanceTimersByTimeAsync(100);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AcpClient — rejectAllPending", () => {
  it("rejects every pending request with the given error and clears the registry", async () => {
    const cap = captureSend();
    const client = createAcpClient({ send: cap.send });

    const p1 = client.request("a", {});
    const p2 = client.request("b", {});
    const shutdownErr = new Error("connection closed");

    client.rejectAllPending(shutdownErr);

    await expect(p1).rejects.toBe(shutdownErr);
    await expect(p2).rejects.toBe(shutdownErr);

    // After clear: a stray response for an old id must not double-reject.
    expect(() => client.handleIncoming(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }))).not.toThrow();
  });
});
