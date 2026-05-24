import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AcpPerProfileConnection, createAcpPerProfileConnection } from "./per-profile-connection.js";

// Defensive contract tests for the ACP per-profile-connection: validates the
// session/* wire payloads, cycle-id synthesis from the session/prompt JSON-RPC
// id, session/cancel notification shape (NOT $/cancelRequest), translator
// fan-out for session/update, schema-validation failure surfacing, and clean
// dispose semantics. Each test injects responses/notifications by piping the
// onIncoming callback we capture during construction.

interface Bed {
  sent: string[];
  pump: (raw: string) => void;
  conn: AcpPerProfileConnection;
}

function buildBed(): Bed {
  const sent: string[] = [];
  let pump: (raw: string) => void = () => {
    throw new Error("pump not registered yet");
  };
  const conn = createAcpPerProfileConnection({
    send: (raw: string): Promise<void> => {
      sent.push(raw);
      return Promise.resolve();
    },
    onIncoming: (cb) => {
      pump = (raw: string): void => cb(raw);
    },
  });
  return { sent, pump: (raw: string) => pump(raw), conn };
}

function lastFrame(sent: string[]): Record<string, unknown> {
  const last = sent[sent.length - 1];
  if (last === undefined) throw new Error("no frame sent");
  return JSON.parse(last) as Record<string, unknown>;
}

function findFrame(sent: string[], method: string): Record<string, unknown> | undefined {
  for (const raw of sent) {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    if (frame.method === method) return frame;
  }
  return undefined;
}

function reply(bed: Bed, result: unknown): number {
  const id = lastFrame(bed.sent).id as number;
  bed.pump(JSON.stringify({ jsonrpc: "2.0", id, result }));
  return id;
}

let bed: Bed;
beforeEach(() => {
  bed = buildBed();
});

describe("AcpPerProfileConnection — initialize", () => {
  it("sends initialize {protocolVersion:1, clientCapabilities} and resolves on response", async () => {
    const promise = bed.conn.initialize();
    const sent = lastFrame(bed.sent);
    expect(sent.method).toBe("initialize");
    expect(sent.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { sessionList: true },
    });
    reply(bed, { protocolVersion: 1 });
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects when initialize response fails schema (negative protocolVersion)", async () => {
    const promise = bed.conn.initialize();
    reply(bed, { protocolVersion: -5 });
    await expect(promise).rejects.toThrow(/initialize.*validation failed/i);
  });
});

describe("AcpPerProfileConnection — newSession", () => {
  it("defaults cwd to / and mcpServers to [] when caller passes empty args", async () => {
    const promise = bed.conn.newSession({});
    expect(lastFrame(bed.sent).method).toBe("session/new");
    expect(lastFrame(bed.sent).params).toEqual({ cwd: "/", mcpServers: [] });
    reply(bed, { sessionId: "sess_42" });
    await expect(promise).resolves.toEqual({ sessionId: "sess_42" });
  });

  it("passes mcpServers through when caller supplies them", async () => {
    const promise = bed.conn.newSession({ mcpServers: [{ name: "ha" }] });
    expect(lastFrame(bed.sent).params).toEqual({ cwd: "/", mcpServers: [{ name: "ha" }] });
    reply(bed, { sessionId: "sess_43" });
    await promise;
  });

  it("throws a descriptive validation error when the response has no sessionId", async () => {
    const promise = bed.conn.newSession({});
    reply(bed, {});
    await expect(promise).rejects.toThrow(/session\/new.*validation failed/i);
  });
});

describe("AcpPerProfileConnection — loadSession", () => {
  it("fills cwd and mcpServers defaults", async () => {
    const promise = bed.conn.loadSession({ sessionId: "sess_1" });
    expect(lastFrame(bed.sent).method).toBe("session/load");
    expect(lastFrame(bed.sent).params).toEqual({
      sessionId: "sess_1",
      cwd: "/",
      mcpServers: [],
    });
    reply(bed, {});
    await expect(promise).resolves.toBeUndefined();
  });
});

describe("AcpPerProfileConnection — listSessions", () => {
  it("issues session/list and returns sessions + nextCursor", async () => {
    const promise = bed.conn.listSessions({});
    expect(lastFrame(bed.sent).method).toBe("session/list");
    reply(bed, {
      sessions: [{ sessionId: "sess_1", cwd: "/", title: null, updatedAt: null }],
      nextCursor: null,
    });
    const r = await promise;
    expect(r.sessions).toHaveLength(1);
    expect(r.nextCursor).toBeNull();
  });

  it("forwards cwd and cursor when supplied", async () => {
    const promise = bed.conn.listSessions({ cwd: "/work", cursor: "abc" });
    expect(lastFrame(bed.sent).params).toEqual({ cwd: "/work", cursor: "abc" });
    reply(bed, { sessions: [], nextCursor: null });
    await promise;
  });
});

describe("AcpPerProfileConnection — sendUserMessage", () => {
  it("issues session/prompt with one text content part and resolves with cycleId + stopReason", async () => {
    const promise = bed.conn.sendUserMessage({ sessionId: "sess_1", text: "hi" });
    const sent = lastFrame(bed.sent);
    expect(sent.method).toBe("session/prompt");
    expect(sent.params).toMatchObject({
      sessionId: "sess_1",
      prompt: [{ type: "text", text: "hi" }],
    });
    const id = reply(bed, { stopReason: "end_turn" });
    await expect(promise).resolves.toEqual({ cycleId: String(id), stopReason: "end_turn" });
  });

  it("forwards internal flag via _meta.internal pass-through", async () => {
    const promise = bed.conn.sendUserMessage({
      sessionId: "sess_1",
      text: "/clear",
      internal: true,
    });
    const params = lastFrame(bed.sent).params as { _meta?: { internal?: boolean } };
    expect(params._meta?.internal).toBe(true);
    reply(bed, { stopReason: "end_turn" });
    await promise;
  });

  it("rejects when prompt response has invalid stopReason", async () => {
    const promise = bed.conn.sendUserMessage({ sessionId: "sess_1", text: "hi" });
    reply(bed, { stopReason: "bogus" });
    await expect(promise).rejects.toThrow(/session\/prompt.*validation failed/i);
  });
});

describe("AcpPerProfileConnection — cancelInflight", () => {
  it("sends session/cancel notification with sessionId (NOT $/cancelRequest)", async () => {
    void bed.conn.sendUserMessage({ sessionId: "sess_1", text: "hi" });
    expect(lastFrame(bed.sent).method).toBe("session/prompt");

    await bed.conn.cancelInflight();
    const cancel = findFrame(bed.sent, "session/cancel");
    expect(cancel).toBeDefined();
    expect(cancel?.params).toEqual({ sessionId: "sess_1" });
    expect(cancel).not.toHaveProperty("id");
    expect(findFrame(bed.sent, "$/cancelRequest")).toBeUndefined();
  });

  it("is a no-op when no prompt is in flight", async () => {
    await bed.conn.cancelInflight();
    expect(bed.sent).toHaveLength(0);
  });
});

describe("AcpPerProfileConnection — onEvent / session/update fan-out", () => {
  const updateNotif = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello" },
      },
    },
  });

  it("translates session/update notifications and forwards to subscribers", () => {
    const events: unknown[] = [];
    bed.conn.onEvent((e) => events.push(e));
    bed.pump(updateNotif);
    expect(events).toEqual([{ type: "assistant.message", text: "Hello" }]);
  });

  it("unsubscribe stops further dispatch", () => {
    const handler = vi.fn();
    const unsub = bed.conn.onEvent(handler);
    bed.pump(updateNotif);
    expect(handler).toHaveBeenCalledTimes(1);
    unsub();
    bed.pump(updateNotif);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("AcpPerProfileConnection — onCycleDone", () => {
  it("fires when session/prompt response lands, with synthesized cycleId + stopReason", async () => {
    const cycleDone = vi.fn();
    bed.conn.onCycleDone(cycleDone);
    const promise = bed.conn.sendUserMessage({ sessionId: "sess_1", text: "hi" });
    const id = reply(bed, { stopReason: "end_turn" });
    await promise;
    expect(cycleDone).toHaveBeenCalledTimes(1);
    expect(cycleDone).toHaveBeenCalledWith({ cycleId: String(id), stopReason: "end_turn" });
  });

  it("unsubscribe stops further dispatch", async () => {
    const cycleDone = vi.fn();
    const unsub = bed.conn.onCycleDone(cycleDone);
    unsub();
    const promise = bed.conn.sendUserMessage({ sessionId: "sess_1", text: "hi" });
    reply(bed, { stopReason: "end_turn" });
    await promise;
    expect(cycleDone).not.toHaveBeenCalled();
  });
});

describe("AcpPerProfileConnection — dispose", () => {
  it("rejects pending requests with connection-disposed", async () => {
    const promise = bed.conn.sendUserMessage({ sessionId: "sess_1", text: "hi" });
    bed.conn.dispose();
    await expect(promise).rejects.toThrow(/connection-disposed/);
  });
});
