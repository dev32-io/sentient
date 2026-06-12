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

/**
 * Mark a session as attached to the current child (mints the load round-trip)
 * so a following sendUserMessage prompts directly. Mirrors steady state: the
 * child already loaded the session this connection-epoch, so no re-attach fires.
 * Tests that specifically exercise the reconnect re-attach do NOT call this.
 */
async function attach(bed: Bed, sessionId: string): Promise<void> {
  const promise = bed.conn.loadSession({ sessionId });
  reply(bed, {});
  await promise;
}

/**
 * Flush microtasks until a frame with `method` is the most-recent send. The
 * prompt path now awaits ensureSessionAttached (one+ microtask) before sending,
 * so a synchronous `lastFrame` read can still see the preceding load frame.
 */
async function flushUntil(bed: Bed, method: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 20; i++) {
    const last = bed.sent[bed.sent.length - 1];
    if (last !== undefined) {
      const frame = JSON.parse(last) as Record<string, unknown>;
      if (frame.method === method) return frame;
    }
    await Promise.resolve();
  }
  throw new Error(`frame ${method} never landed`);
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
    await attach(bed, "sess_1");
    const promise = bed.conn.sendUserMessage({ sessionId: "sess_1", text: "hi" });
    const sent = await flushUntil(bed, "session/prompt");
    expect(sent.params).toMatchObject({
      sessionId: "sess_1",
      prompt: [{ type: "text", text: "hi" }],
    });
    const id = reply(bed, { stopReason: "end_turn" });
    await expect(promise).resolves.toEqual({ cycleId: String(id), stopReason: "end_turn" });
  });

  it("forwards internal flag via _meta.internal pass-through", async () => {
    await attach(bed, "sess_1");
    const promise = bed.conn.sendUserMessage({
      sessionId: "sess_1",
      text: "/clear",
      internal: true,
    });
    const sent = await flushUntil(bed, "session/prompt");
    const params = sent.params as { _meta?: { internal?: boolean } };
    expect(params._meta?.internal).toBe(true);
    reply(bed, { stopReason: "end_turn" });
    await promise;
  });

  it("rejects when prompt response has invalid stopReason", async () => {
    await attach(bed, "sess_1");
    const promise = bed.conn.sendUserMessage({ sessionId: "sess_1", text: "hi" });
    await flushUntil(bed, "session/prompt");
    reply(bed, { stopReason: "bogus" });
    await expect(promise).rejects.toThrow(/session\/prompt.*validation failed/i);
  });
});

describe("AcpPerProfileConnection — re-attach on epoch advance (reconnect)", () => {
  interface EpochBed extends Bed {
    setEpoch: (n: number) => void;
  }
  function buildEpochBed(): EpochBed {
    const sent: string[] = [];
    let pump: (raw: string) => void = () => {
      throw new Error("pump not registered yet");
    };
    let epoch = 1;
    const conn = createAcpPerProfileConnection({
      send: (raw: string): Promise<void> => {
        sent.push(raw);
        return Promise.resolve();
      },
      onIncoming: (cb) => {
        pump = (raw: string): void => cb(raw);
      },
      currentEpoch: () => epoch,
    });
    const setEpoch = (n: number): void => {
      epoch = n;
    };
    return { sent, pump: (raw: string) => pump(raw), conn, setEpoch };
  }

  // Flush microtasks until a frame with `method` appears at or after `fromIndex`
  // (so a stale same-method frame from a prior round-trip isn't matched).
  async function flushTo(b: EpochBed, method: string, fromIndex = 0): Promise<Record<string, unknown>> {
    for (let i = 0; i < 20; i++) {
      for (let j = b.sent.length - 1; j >= fromIndex; j--) {
        const frame = JSON.parse(b.sent[j] as string) as Record<string, unknown>;
        if (frame.method === method) return frame;
      }
      await Promise.resolve();
    }
    throw new Error(`frame ${method} never landed`);
  }

  function replyTo(b: EpochBed, frame: Record<string, unknown>, result: unknown): void {
    b.pump(JSON.stringify({ jsonrpc: "2.0", id: frame.id as number, result }));
  }

  it("issues session/load before session/prompt when the epoch advanced since the session was attached", async () => {
    const b = buildEpochBed();
    // Attach conv-1 at epoch 1 (mirrors a load/new on the original child).
    const loadP = b.conn.loadSession({ sessionId: "conv-1" });
    replyTo(b, await flushTo(b, "session/load"), {});
    await loadP;

    // Reconnect bumps the epoch — fresh child, empty session state.
    b.setEpoch(2);
    const fromHere = b.sent.length;

    const promptP = b.conn.sendUserMessage({ sessionId: "conv-1", text: "continue" });
    // First frame after the epoch bump is a re-attach session/load(conv-1).
    const reload = await flushTo(b, "session/load", fromHere);
    expect((reload.params as { sessionId: string }).sessionId).toBe("conv-1");
    replyTo(b, reload, {});

    // Then the prompt fires on the same conversationId and succeeds.
    const prompt = await flushTo(b, "session/prompt", fromHere);
    expect((prompt.params as { sessionId: string }).sessionId).toBe("conv-1");
    replyTo(b, prompt, { stopReason: "end_turn" });
    await expect(promptP).resolves.toMatchObject({ stopReason: "end_turn" });

    // The captured conversation was re-attached then prompted: two loads total
    // (epoch-1 initial attach + epoch-2 re-attach), one prompt.
    const loadCount = b.sent.filter((r) => (JSON.parse(r) as { method?: string }).method === "session/load").length;
    expect(loadCount).toBe(2);
  });

  it("does NOT re-load when the session is already attached at the current epoch", async () => {
    const b = buildEpochBed();
    const loadP = b.conn.loadSession({ sessionId: "conv-1" });
    replyTo(b, await flushTo(b, "session/load"), {});
    await loadP;

    // Same epoch — a prompt must go straight out, no extra session/load.
    const promptP = b.conn.sendUserMessage({ sessionId: "conv-1", text: "hi" });
    const prompt = await flushTo(b, "session/prompt");
    replyTo(b, prompt, { stopReason: "end_turn" });
    await promptP;
    const loadCount = b.sent.filter((r) => (JSON.parse(r) as { method?: string }).method === "session/load").length;
    expect(loadCount).toBe(1);
  });
});

describe("AcpPerProfileConnection — cancelInflight", () => {
  it("sends session/cancel notification with sessionId (NOT $/cancelRequest)", async () => {
    await attach(bed, "sess_1");
    // cancelInflight now also calls cancelPending which rejects the promise —
    // swallow it here so the unhandled rejection does not fail the test runner.
    const sendPromise = bed.conn.sendUserMessage({ sessionId: "sess_1", text: "hi" });
    sendPromise.catch(() => {});
    await flushUntil(bed, "session/prompt");

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

  it("resolves cancelInflight and rejects sendUserMessage even when the cancel notify send throws (dead/hung wire)", async () => {
    // Build a connection where the transport-level send rejects for
    // "session/cancel" frames, simulating a dead wire. cancelPending must still
    // run (the try/finally in cancelInflight) so the in-flight session/prompt
    // promise settles and does not leak. cancelInflight itself must RESOLVE
    // (best-effort: the send failure is logged and swallowed).
    const sent: string[] = [];
    let pump: (raw: string) => void = () => {
      throw new Error("pump not registered yet");
    };

    const conn = createAcpPerProfileConnection({
      send: (raw: string): Promise<void> => {
        const frame = JSON.parse(raw) as { method?: string };
        if (frame.method === "session/cancel") {
          // Dead wire — the cancel notification can't be sent.
          return Promise.reject(new Error("write EPIPE"));
        }
        sent.push(raw);
        return Promise.resolve();
      },
      onIncoming: (cb) => {
        pump = (raw: string): void => cb(raw);
      },
    });

    // Pre-attach the session so sendUserMessage goes straight to the prompt.
    const loadPromise = conn.loadSession({ sessionId: "sess_dead" });
    await flushUntil({ sent, pump, conn }, "session/load");
    const loadId = (JSON.parse(sent[sent.length - 1] as string) as { id: number }).id;
    pump(JSON.stringify({ jsonrpc: "2.0", id: loadId, result: {} }));
    await loadPromise;

    // Start a sendUserMessage — the prompt will never receive a reply (dead wire).
    const sendPromise = conn.sendUserMessage({ sessionId: "sess_dead", text: "hello" });
    // Attach a rejection handler immediately so the "cycle aborted" rejection
    // is never unhandled when cancelPending fires.
    let sendError: unknown;
    const sendSettled = sendPromise.catch((err: unknown) => {
      sendError = err;
    });

    await flushUntil({ sent, pump, conn }, "session/prompt");

    // cancelInflight: the session/cancel send throws (write EPIPE) but the catch
    // block logs + swallows it so cancelInflight resolves. cancelPending still
    // runs in the finally block and settles the in-flight session/prompt promise.
    await conn.cancelInflight();

    // Wait for the sendPromise to settle now that cancelPending ran.
    await sendSettled;

    // sendUserMessage must have rejected with "cycle aborted" — proving
    // cancelPending ran despite the notify send throwing.
    expect(sendError).toBeInstanceOf(Error);
    expect((sendError as Error).message).toBe("cycle aborted");
  });

  it("rejects the sendUserMessage promise when Hermes never answers the prompt (dead wire)", async () => {
    // Simulate a dead wire: session/cancel notification is sent but Hermes
    // never answers the in-flight session/prompt (no reply pumped in).
    await attach(bed, "sess_1");
    const sendPromise = bed.conn.sendUserMessage({ sessionId: "sess_1", text: "hi" });
    await flushUntil(bed, "session/prompt");

    // cancelInflight: sends session/cancel + calls cancelPending(id, "cycle aborted")
    // which rejects the pending Map entry so the promise settles immediately.
    await bed.conn.cancelInflight();

    // sendUserMessage must reject — not hang — when the wire never answers.
    await expect(sendPromise).rejects.toThrow("cycle aborted");

    // No pending entry leaked: a subsequent sendUserMessage on the same session
    // works correctly (the connection is still alive, not disposed).
    const sendPromise2 = bed.conn.sendUserMessage({ sessionId: "sess_1", text: "next" });
    await flushUntil(bed, "session/prompt");
    const id2 = reply(bed, { stopReason: "end_turn" });
    await expect(sendPromise2).resolves.toEqual({ cycleId: String(id2), stopReason: "end_turn" });
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
    await attach(bed, "sess_1");
    const cycleDone = vi.fn();
    bed.conn.onCycleDone(cycleDone);
    const promise = bed.conn.sendUserMessage({ sessionId: "sess_1", text: "hi" });
    await flushUntil(bed, "session/prompt");
    const id = reply(bed, { stopReason: "end_turn" });
    await promise;
    expect(cycleDone).toHaveBeenCalledTimes(1);
    expect(cycleDone).toHaveBeenCalledWith({ cycleId: String(id), stopReason: "end_turn" });
  });

  it("unsubscribe stops further dispatch", async () => {
    await attach(bed, "sess_1");
    const cycleDone = vi.fn();
    const unsub = bed.conn.onCycleDone(cycleDone);
    unsub();
    const promise = bed.conn.sendUserMessage({ sessionId: "sess_1", text: "hi" });
    await flushUntil(bed, "session/prompt");
    reply(bed, { stopReason: "end_turn" });
    await promise;
    expect(cycleDone).not.toHaveBeenCalled();
  });
});

describe("AcpPerProfileConnection — rejectInflight", () => {
  it("rejects an in-flight prompt without disposing the connection", async () => {
    await attach(bed, "sess_1");
    const promise = bed.conn.sendUserMessage({ sessionId: "sess_1", text: "hi" });
    await flushUntil(bed, "session/prompt");
    bed.conn.rejectInflight(new Error("acp-wire-flap: connection lost"));
    await expect(promise).rejects.toThrow(/acp-wire-flap/);
    // The connection survives — a subsequent prompt still works. Reply to the
    // NEW prompt id (the first one is still in `sent` but has no pending entry).
    const before = bed.sent.length;
    const promise2 = bed.conn.sendUserMessage({ sessionId: "sess_1", text: "again" });
    for (let i = 0; i < 20 && bed.sent.length === before; i++) await Promise.resolve();
    const id = reply(bed, { stopReason: "end_turn" });
    await expect(promise2).resolves.toEqual({ cycleId: String(id), stopReason: "end_turn" });
  });
});

describe("AcpPerProfileConnection — dispose", () => {
  it("rejects pending requests with connection-disposed", async () => {
    const promise = bed.conn.sendUserMessage({ sessionId: "sess_1", text: "hi" });
    bed.conn.dispose();
    await expect(promise).rejects.toThrow(/connection-disposed/);
  });
});
