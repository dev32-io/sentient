import { describe, expect, it, vi } from "vitest";
import type { DispatchMode, HermesEvent, HermesTurnInput } from "../cerebrum/hermes-event-types.js";
import { createAcpHermesClient } from "./acp-hermes-client.js";
import { type AcpPerProfileConnection, createAcpPerProfileConnection } from "./per-profile-connection.js";

// Contract tests for the ACP HermesClient adapter. We use a real
// AcpPerProfileConnection wired to a controllable in-memory transport so the
// tests exercise the full WS-payload → event-translator → HermesEvent path
// the way ws-session-configure does at runtime.

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
    send: (raw) => {
      sent.push(raw);
      return Promise.resolve();
    },
    onIncoming: (cb) => {
      pump = (raw: string): void => cb(raw);
    },
  });
  return { sent, pump: (raw: string) => pump(raw), conn };
}

const NEVER_BARGED: DispatchMode = { bargedIn: () => false };

function turnInput(overrides: Partial<HermesTurnInput> = {}): HermesTurnInput {
  return {
    userId: "u_1",
    cycleId: "c_1",
    userMessage: "hello",
    conversationId: null,
    maxOutputTokens: 256,
    ...overrides,
  };
}

async function collect(gen: AsyncGenerator<HermesEvent>, max: number): Promise<HermesEvent[]> {
  const out: HermesEvent[] = [];
  for await (const ev of gen) {
    out.push(ev);
    if (out.length >= max) break;
  }
  return out;
}

function lastFrame(sent: string[]): Record<string, unknown> {
  const last = sent[sent.length - 1];
  if (last === undefined) throw new Error("no frame sent");
  return JSON.parse(last) as Record<string, unknown>;
}

describe("AcpHermesClient — dispatch happy path", () => {
  it("yields synthetic created, fans out session/update events as text.delta, terminates with completed", async () => {
    const bed = buildBed();
    const client = createAcpHermesClient({ acpConn: bed.conn });
    const ctrl = new AbortController();

    const gen = client.dispatch(
      turnInput({ forcedSessionId: "sess_42", cycleId: "cycle_a" }),
      ctrl.signal,
      NEVER_BARGED,
    );

    // First yield is the synthetic created event — does NOT require any wire activity.
    const it1 = await gen.next();
    expect(it1.done).toBe(false);
    expect(it1.value).toEqual({ type: "created", responseId: "cycle_a", conversationId: "sess_42" });

    // Drive the wire: the prompt is in flight; pump a session/update notification.
    const id = lastFrame(bed.sent).id as number;
    bed.pump(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_42",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi back" } },
        },
      }),
    );

    const it2 = await gen.next();
    expect(it2.value).toEqual({ type: "text.delta", delta: "hi back\n" });

    // Terminal: reply to the prompt, which fires onCycleDone → completed.
    bed.pump(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));

    const it3 = await gen.next();
    expect(it3.value).toEqual({ type: "completed", usage: { inputTokens: 0, outputTokens: 0 } });
    const it4 = await gen.next();
    expect(it4.done).toBe(true);
  });

  it("uses forcedSessionId for the session/prompt sessionId param", async () => {
    const bed = buildBed();
    const client = createAcpHermesClient({ acpConn: bed.conn });
    const ctrl = new AbortController();
    const gen = client.dispatch(turnInput({ forcedSessionId: "sess_force" }), ctrl.signal, NEVER_BARGED);
    await gen.next(); // synthetic created (also triggers send)

    const sent = lastFrame(bed.sent);
    expect(sent.method).toBe("session/prompt");
    expect((sent.params as { sessionId: string }).sessionId).toBe("sess_force");
  });

  it("uses conversationId as the prompt sessionId when no forced id is given (mid-chain follow-up)", async () => {
    const bed = buildBed();
    const client = createAcpHermesClient({ acpConn: bed.conn });
    const ctrl = new AbortController();
    const gen = client.dispatch(
      turnInput({ conversationId: "sess_chain", cycleId: "cycle_b" }),
      ctrl.signal,
      NEVER_BARGED,
    );
    await gen.next();
    expect((lastFrame(bed.sent).params as { sessionId: string }).sessionId).toBe("sess_chain");

    // Reply to drain the queue cleanly.
    const id = lastFrame(bed.sent).id as number;
    bed.pump(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));
    for await (const _ of gen) {
      /* drain */
    }
  });
});

describe("AcpHermesClient — abort path", () => {
  it("on abort calls cancelInflight and terminates the generator", async () => {
    const bed = buildBed();
    const cancelSpy = vi.spyOn(bed.conn, "cancelInflight");
    const client = createAcpHermesClient({ acpConn: bed.conn });
    const ctrl = new AbortController();

    // Use forcedSessionId to bypass the lazy session/new path — this test
    // exercises abort behavior, not session resolution.
    const gen = client.dispatch(turnInput({ forcedSessionId: "sess_a" }), ctrl.signal, NEVER_BARGED);
    const created = await gen.next();
    expect(created.done).toBe(false);

    ctrl.abort();
    const after = await gen.next();
    expect(after.done).toBe(true);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });
});

describe("AcpHermesClient — translator coverage for tool events", () => {
  it("forwards tool_call and tool_call_update notifications as tool.started / tool.finished", async () => {
    const bed = buildBed();
    const client = createAcpHermesClient({ acpConn: bed.conn });
    const ctrl = new AbortController();
    const gen = client.dispatch(turnInput({ forcedSessionId: "sess_t" }), ctrl.signal, NEVER_BARGED);

    // Drain the synthetic created frame.
    await gen.next();

    bed.pump(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_1",
            title: "weather",
            rawInput: { city: "SF" },
          },
        },
      }),
    );
    bed.pump(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_1",
            status: "completed",
            rawOutput: "sunny",
          },
        },
      }),
    );

    const events = await collect(gen, 2);
    expect(events[0]).toMatchObject({ type: "tool.started", callId: "call_1", toolName: "weather" });
    expect(events[1]).toMatchObject({ type: "tool.finished", callId: "call_1", status: "ok", summary: "sunny" });

    // Wrap up: respond to the in-flight prompt so the generator exits cleanly.
    const id = lastFrame(bed.sent).id as number;
    bed.pump(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));
    for await (const _ of gen) {
      /* drain */
    }
  });
});

describe("AcpHermesClient — error path", () => {
  it("emits an error HermesEvent and terminates when sendUserMessage rejects", async () => {
    const bed = buildBed();
    const client = createAcpHermesClient({ acpConn: bed.conn });
    const ctrl = new AbortController();
    const gen = client.dispatch(turnInput({ forcedSessionId: "sess_e" }), ctrl.signal, NEVER_BARGED);
    await gen.next();
    const id = lastFrame(bed.sent).id as number;
    // Reply with a JSON-RPC error → the in-flight promise rejects.
    bed.pump(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "boom" } }));
    const after = await gen.next();
    expect(after.value).toMatchObject({ type: "error" });
    const term = await gen.next();
    expect(term.done).toBe(true);
  });
});

describe("AcpHermesClient — lazy session/new fallback", () => {
  it("calls acpConn.newSession before sendUserMessage when neither forcedSessionId nor conversationId is set", async () => {
    const bed = buildBed();
    const client = createAcpHermesClient({ acpConn: bed.conn });
    const ctrl = new AbortController();

    // No forced id, no conversationId — the lazy path must run.
    const gen = client.dispatch(turnInput(), ctrl.signal, NEVER_BARGED);

    // First yield should still be the synthetic created — but it has to wait
    // for newSession to resolve so the conversationId reflects the ACP-minted
    // value (rather than the cycleId fallback). Drive the wire: first frame is
    // session/new; respond, then session/prompt fires.
    const nextPromise = gen.next();
    // Wait a microtask so the dispatch has a chance to send session/new.
    await Promise.resolve();
    await Promise.resolve();
    const newFrame = lastFrame(bed.sent);
    expect(newFrame.method).toBe("session/new");
    bed.pump(JSON.stringify({ jsonrpc: "2.0", id: newFrame.id, result: { sessionId: "sess_minted" } }));

    const it1 = await nextPromise;
    expect(it1.done).toBe(false);
    expect(it1.value).toEqual({ type: "created", responseId: "c_1", conversationId: "sess_minted" });

    // Then the prompt fires with the minted id.
    await Promise.resolve();
    const promptFrame = lastFrame(bed.sent);
    expect(promptFrame.method).toBe("session/prompt");
    expect((promptFrame.params as { sessionId: string }).sessionId).toBe("sess_minted");

    // Drain.
    bed.pump(JSON.stringify({ jsonrpc: "2.0", id: promptFrame.id, result: { stopReason: "end_turn" } }));
    for await (const _ of gen) {
      /* drain */
    }
  });

  it("does NOT call newSession when forcedSessionId is supplied", async () => {
    const bed = buildBed();
    const client = createAcpHermesClient({ acpConn: bed.conn });
    const ctrl = new AbortController();
    const gen = client.dispatch(turnInput({ forcedSessionId: "sess_force" }), ctrl.signal, NEVER_BARGED);
    await gen.next();
    // No session/new frame should appear in the wire — only session/prompt.
    const methods = bed.sent.map((raw) => (JSON.parse(raw) as { method?: string }).method);
    expect(methods).not.toContain("session/new");
    expect(methods).toContain("session/prompt");
    // Drain.
    const id = lastFrame(bed.sent).id as number;
    bed.pump(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));
    for await (const _ of gen) {
      /* drain */
    }
  });

  it("does NOT call newSession when conversationId is set (mid-chain follow-up)", async () => {
    const bed = buildBed();
    const client = createAcpHermesClient({ acpConn: bed.conn });
    const ctrl = new AbortController();
    const gen = client.dispatch(turnInput({ conversationId: "sess_chain" }), ctrl.signal, NEVER_BARGED);
    await gen.next();
    const methods = bed.sent.map((raw) => (JSON.parse(raw) as { method?: string }).method);
    expect(methods).not.toContain("session/new");
    expect(methods).toContain("session/prompt");
    const id = lastFrame(bed.sent).id as number;
    bed.pump(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));
    for await (const _ of gen) {
      /* drain */
    }
  });

  it("emits the synthetic created event with the minted ACP sessionId so cerebrum binds it", async () => {
    const bed = buildBed();
    const client = createAcpHermesClient({ acpConn: bed.conn });
    const ctrl = new AbortController();
    const gen = client.dispatch(turnInput({ cycleId: "cycle_lazy" }), ctrl.signal, NEVER_BARGED);

    const nextPromise = gen.next();
    await Promise.resolve();
    await Promise.resolve();
    const newFrame = lastFrame(bed.sent);
    expect(newFrame.method).toBe("session/new");
    bed.pump(JSON.stringify({ jsonrpc: "2.0", id: newFrame.id, result: { sessionId: "sess_bound" } }));

    const it1 = await nextPromise;
    // The created event MUST carry the ACP-minted id (not the cycleId fallback)
    // so the cerebrum's hermes-event-translator routes it to
    // sessionRouter.updateConversationId.
    expect(it1.value).toEqual({ type: "created", responseId: "cycle_lazy", conversationId: "sess_bound" });

    const promptFrame = lastFrame(bed.sent);
    bed.pump(JSON.stringify({ jsonrpc: "2.0", id: promptFrame.id, result: { stopReason: "end_turn" } }));
    for await (const _ of gen) {
      /* drain */
    }
  });

  it("emits an error and terminates if newSession itself fails", async () => {
    const bed = buildBed();
    const client = createAcpHermesClient({ acpConn: bed.conn });
    const ctrl = new AbortController();
    const gen = client.dispatch(turnInput(), ctrl.signal, NEVER_BARGED);

    const nextPromise = gen.next();
    await Promise.resolve();
    await Promise.resolve();
    const newFrame = lastFrame(bed.sent);
    expect(newFrame.method).toBe("session/new");
    // Reply with JSON-RPC error → newSession promise rejects.
    bed.pump(JSON.stringify({ jsonrpc: "2.0", id: newFrame.id, error: { code: -32000, message: "no can do" } }));

    const it1 = await nextPromise;
    expect(it1.value).toMatchObject({ type: "error" });
    const term = await gen.next();
    expect(term.done).toBe(true);
  });
});
