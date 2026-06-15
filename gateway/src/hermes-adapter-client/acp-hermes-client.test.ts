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

/**
 * Pre-attach a session to the (single, static-epoch) child so a following
 * dispatch prompts directly instead of issuing the reconnect re-attach
 * `session/load`. Mirrors steady state: the child already loaded this session.
 * Tests exercising the post-reconnect re-attach do NOT call this.
 */
async function attach(bed: Bed, sessionId: string): Promise<void> {
  const promise = bed.conn.loadSession({ sessionId });
  const id = lastFrame(bed.sent).id as number;
  bed.pump(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
  await promise;
}

describe("AcpHermesClient — dispatch happy path", () => {
  it("yields synthetic created, fans out session/update events as text.delta, terminates with completed", async () => {
    const bed = buildBed();
    await attach(bed, "sess_42");
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
    await attach(bed, "sess_force");
    const client = createAcpHermesClient({ acpConn: bed.conn });
    const ctrl = new AbortController();
    const gen = client.dispatch(turnInput({ forcedSessionId: "sess_force" }), ctrl.signal, NEVER_BARGED);
    await gen.next(); // synthetic created (also triggers send)
    // ensureSessionAttached resolves immediately (pre-attached); flush so the
    // prompt frame lands before the assertion.
    await Promise.resolve();

    const sent = lastFrame(bed.sent);
    expect(sent.method).toBe("session/prompt");
    expect((sent.params as { sessionId: string }).sessionId).toBe("sess_force");
  });

  it("uses conversationId as the prompt sessionId when no forced id is given (mid-chain follow-up)", async () => {
    const bed = buildBed();
    await attach(bed, "sess_chain");
    const client = createAcpHermesClient({ acpConn: bed.conn });
    const ctrl = new AbortController();
    const gen = client.dispatch(
      turnInput({ conversationId: "sess_chain", cycleId: "cycle_b" }),
      ctrl.signal,
      NEVER_BARGED,
    );
    await gen.next();
    await Promise.resolve();
    expect((lastFrame(bed.sent).params as { sessionId: string }).sessionId).toBe("sess_chain");

    // Reply to drain the queue cleanly.
    const id = lastFrame(bed.sent).id as number;
    bed.pump(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));
    for await (const _ of gen) {
      /* drain */
    }
  });
});

describe("AcpHermesClient — real session id divergence", () => {
  it("emits a corrective created with the REAL session id when session/update diverges from the forced id", async () => {
    const bed = buildBed();
    await attach(bed, "forced_id");
    const client = createAcpHermesClient({ acpConn: bed.conn });
    const ctrl = new AbortController();

    const gen = client.dispatch(
      turnInput({ forcedSessionId: "forced_id", cycleId: "cycle_div" }),
      ctrl.signal,
      NEVER_BARGED,
    );

    // 1. Provisional created from the forced id (no wire activity required).
    const provisional = await gen.next();
    expect(provisional.value).toEqual({ type: "created", responseId: "cycle_div", conversationId: "forced_id" });

    // 2. Hermes forks: the first session/update carries a DIFFERENT real id.
    const id = lastFrame(bed.sent).id as number;
    bed.pump(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "real_fork_id",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "forked reply" } },
        },
      }),
    );

    // 3. Next yield is the corrective created carrying the REAL id.
    const corrective = await gen.next();
    expect(corrective.value).toEqual({ type: "created", responseId: "cycle_div", conversationId: "real_fork_id" });

    // 4. Then the buffered text delta from the same update.
    const delta = await gen.next();
    expect(delta.value).toEqual({ type: "text.delta", delta: "forked reply\n" });

    // Drain.
    bed.pump(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));
    for await (const _ of gen) {
      /* drain */
    }
  });

  it("does NOT emit a second created when the session/update id matches the forced id", async () => {
    const bed = buildBed();
    await attach(bed, "forced_id");
    const client = createAcpHermesClient({ acpConn: bed.conn });
    const ctrl = new AbortController();

    const gen = client.dispatch(
      turnInput({ forcedSessionId: "forced_id", cycleId: "cycle_match" }),
      ctrl.signal,
      NEVER_BARGED,
    );

    const provisional = await gen.next();
    expect(provisional.value).toEqual({ type: "created", responseId: "cycle_match", conversationId: "forced_id" });

    const id = lastFrame(bed.sent).id as number;
    bed.pump(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "forced_id",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "same reply" } },
        },
      }),
    );

    // Ids match — the next yield is the text delta, NOT a second created.
    const next = await gen.next();
    expect(next.value).toEqual({ type: "text.delta", delta: "same reply\n" });

    // Drain.
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
          // Match the forced id so no spurious corrective `created` (real-id
          // divergence) fires — this case is about tool-event translation.
          sessionId: "sess_t",
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
          sessionId: "sess_t",
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
    await attach(bed, "sess_force");
    const client = createAcpHermesClient({ acpConn: bed.conn });
    const ctrl = new AbortController();
    const gen = client.dispatch(turnInput({ forcedSessionId: "sess_force" }), ctrl.signal, NEVER_BARGED);
    await gen.next();
    await Promise.resolve();
    // No session/new frame should appear in the wire — only session/prompt
    // (session/load was the pre-attach round-trip, already settled).
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
    await attach(bed, "sess_chain");
    const client = createAcpHermesClient({ acpConn: bed.conn });
    const ctrl = new AbortController();
    const gen = client.dispatch(turnInput({ conversationId: "sess_chain" }), ctrl.signal, NEVER_BARGED);
    await gen.next();
    await Promise.resolve();
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

describe("AcpHermesClient — activity clock touches", () => {
  it("touches acp.out on prompt send and acp.in on each update", async () => {
    const bed = buildBed();
    await attach(bed, "sess_activity");
    const sources: string[] = [];
    const client = createAcpHermesClient({
      acpConn: bed.conn,
      onActivity: (s) => sources.push(s),
    });
    const ctrl = new AbortController();
    const gen = client.dispatch(
      turnInput({ forcedSessionId: "sess_activity", cycleId: "cycle_act" }),
      ctrl.signal,
      NEVER_BARGED,
    );

    // Drain the synthetic created event (no wire activity yet).
    await gen.next();

    // Flush so the prompt send (acp.out touch) lands.
    await Promise.resolve();

    // Pump a session/update notification to trigger the acp.in touch.
    bed.pump(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_activity",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
        },
      }),
    );

    // Drain the text.delta event so the acp.in callback fires.
    await gen.next();

    // Reply to the in-flight prompt to close the generator cleanly.
    const id = lastFrame(bed.sent).id as number;
    bed.pump(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));
    for await (const _ of gen) {
      /* drain */
    }

    expect(sources).toContain("acp.out");
    expect(sources).toContain("acp.in");
  });
});
