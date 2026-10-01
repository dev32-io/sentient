// Pins the STT → SessionRuntime seam (spec §6, §4.7). Two process-boundary
// contracts live here: an STT `transcript` event MUST land on the SAME
// `runtime.submit({kind:"conversational"})` seam `text.input` uses, and an STT
// `turn_started` (mic onset) MUST call `runtime.bargeIn()` — the only
// production caller that method has. Zero network: a fake STTAdapter.
//
// One containment invariant lives here too: `STTAdapter.events()` may reject
// (the interface admits it — a socket error surfacing as a throw), and that
// rejection must be contained inside the session. Detached work escaping as an
// `unhandledRejection` would take the whole gateway process down over one
// session's STT socket.

import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnMode } from "@sentient/protocol";
import type { Capability } from "../access/capability.js";
import type { STTAdapter, STTAdapterConfig, STTEvent } from "../adapters/stt/stt-adapter-types.js";
import { createGatewayLogger } from "../logging/logger.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import type { Stimulus } from "../runtime/stimulus.js";
import { EMPTY_TURN_STATE } from "../runtime/turn-state-snapshot.js";
import { openSessionStore } from "../store/session-store.js";
import { captureDiagnosticRef } from "./capture-diagnostics.js";
import { createMicEchoGuard } from "./mic-echo-guard.js";
import { admitFirstUserMessage } from "./session-id.js";
import { createSttSession } from "./stt-session.js";

const STORE_ROOT = mkdtempSync(join(tmpdir(), "sentient-stt-session-"));
afterAll(() => rmSync(STORE_ROOT, { recursive: true, force: true }));

const TEST_CONFIG: STTAdapterConfig = {
  url: "ws://localhost:0",
  language: "auto",
  pauseRenderLanguage: "en",
  inputSampleRate: 48000,
  ttsEchoCooldownMs: 2500,
  connectTimeoutMs: 10,
  audioFormat: "opus",
};

interface FakeAdapter {
  adapter: STTAdapter;
  emit(event: STTEvent): void;
  fail(error: Error): void;
  sent: Uint8Array[];
  turnModes: TurnMode[];
  flushes: number;
  suppressions: number[];
  closes: number;
}

function fakeAdapter(openError?: Error, eventsError?: Error, endError?: Error): FakeAdapter {
  const pendingEvents: Array<STTEvent | Error> = [];
  let deliver: ((e: STTEvent | Error | null) => void) | null = null;
  const enqueue = (value: STTEvent | Error): void => {
    const d = deliver;
    if (d) {
      deliver = null;
      d(value);
      return;
    }
    pendingEvents.push(value);
  };
  const f: FakeAdapter = {
    sent: [],
    turnModes: [],
    flushes: 0,
    suppressions: [],
    closes: 0,
    emit: enqueue,
    fail: enqueue,
    adapter: {
      open: async () => {
        if (openError) throw openError;
      },
      send: (pcm) => {
        f.sent.push(pcm);
      },
      endUtterance: () => {
        f.flushes += 1;
        if (endError) throw endError;
      },
      setTurnMode: (mode) => {
        f.turnModes.push(mode);
      },
      suppressInputFor: (ms) => {
        f.suppressions.push(ms);
      },
      close: async () => {
        f.closes += 1;
        deliver?.(null);
        deliver = null;
      },
      async *events() {
        if (eventsError) throw eventsError;
        while (true) {
          const next = pendingEvents.shift();
          if (next !== undefined) {
            if (next instanceof Error) throw next;
            yield next;
            continue;
          }
          const awaited = await new Promise<STTEvent | Error | null>((resolve) => {
            deliver = resolve;
          });
          if (awaited === null) return;
          if (awaited instanceof Error) throw awaited;
          yield awaited;
        }
      },
    },
  };
  return f;
}

interface StubRuntime {
  runtime: SessionRuntime;
  submitted: Stimulus[];
  bargeIns: string[];
}

function stubRuntime(): StubRuntime {
  const submitted: Stimulus[] = [];
  const bargeIns: string[] = [];
  const runtime: SessionRuntime = {
    userId: "u_deadbeef" as SessionRuntime["userId"],
    submit: (s) => {
      submitted.push(s);
    },
    get running() {
      return false;
    },
    get hasAuxiliaryTaskInFlight() {
      return false;
    },
    dispose: () => {},
    revokeAuthority: () => {},
    bargeIn: () => {
      bargeIns.push("barge-in");
    },
    interrupt: () => {},
    turnState: EMPTY_TURN_STATE,
    emitConversationSnapshot: () => {},
    emitTaskList: () => {},
    noteDelegationProgress: () => {},
    cutUnheardSpeech: () => {},
  };
  return { runtime, submitted, bargeIns };
}

/**
 * An adapter whose `close()` does NOT end its event stream.
 *
 * `fakeAdapter` terminates the generator inside `close()`, which is convenient
 * and WRONG for the discard cases: a real STT socket keeps yielding whatever it
 * had already decoded until the close round-trips. Testing the discard against
 * the convenient fake would pass without any guard in the production code at
 * all — the fake would be doing the work. This one models the hazard.
 */
function lingeringAdapter(): FakeAdapter {
  const f = fakeAdapter();
  const inner = f.adapter;
  f.adapter = {
    ...inner,
    events: (signal) => inner.events(signal),
    close: async () => {
      f.closes += 1;
    },
  };
  return f;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe("createSttSession", () => {
  it("submits a conversational stimulus on an STT transcript event", async () => {
    const fake = fakeAdapter();
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });

    session.start("cap-1", "semantic");
    await settle();
    fake.emit({ type: "transcript", turnIdx: 1, text: "turn on the lights" });
    await settle();

    expect(stub.submitted).toEqual([{ kind: "conversational", text: "turn on the lights" }]);
    session.close();
  });

  it("submits authoritative preadmitted transcript without a second conversational write", async () => {
    const fake = fakeAdapter();
    const stub = stubRuntime();
    const stimulus: Stimulus = { kind: "preadmitted-conversational", entrySeq: 42, admission: "fresh" };
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => ({ runtime: stub.runtime, stimulus }),
    });

    session.start("cap-1", "semantic");
    await settle();
    fake.emit({ type: "transcript", turnIdx: 1, text: "voice first" });
    await settle();

    expect(stub.submitted).toEqual([stimulus]);
    session.close();
  });

  it("calls runtime.bargeIn() on an STT turn_started (mic onset)", async () => {
    const fake = fakeAdapter();
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });

    session.start("cap-1", "semantic");
    await settle();
    fake.emit({ type: "turn_started", turnIdx: 1 });
    await settle();

    expect(stub.bargeIns).toEqual(["barge-in"]);
    expect(stub.submitted).toEqual([]);
    session.close();
  });

  it("drops a blank transcript instead of firing an empty turn", async () => {
    const fake = fakeAdapter();
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });

    session.start("cap-1", "semantic");
    await settle();
    fake.emit({ type: "transcript", turnIdx: 1, text: "   " });
    await settle();

    expect(stub.submitted).toEqual([]);
    session.close();
  });

  it("relays the audio.start turnMode to the adapter and flushes on end()", async () => {
    const fake = fakeAdapter();
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });

    session.start("cap-1", "manual");
    await settle();
    session.pushFrame("cap-1", new Uint8Array([1, 2, 3]));
    session.end("cap-1");

    expect(fake.turnModes).toEqual(["manual"]);
    expect(fake.sent).toHaveLength(1);
    expect(fake.flushes).toBe(1);
    session.close();
  });

  it("buffers manual transcript until matching end commits it", async () => {
    const fake = fakeAdapter();
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });

    session.start("manual-1", "manual");
    await settle();
    fake.emit({ type: "transcript", turnIdx: 1, text: "send this" });
    await settle();
    expect(stub.submitted).toEqual([]);

    session.end("manual-1");
    fake.emit({ type: "transcript", turnIdx: 1, text: "send this final" });
    await settle();
    expect(stub.submitted).toEqual([{ kind: "conversational", text: "send this final" }]);
    session.close();
  });

  it("submits no turn when manual finalization is empty", async () => {
    const fake = fakeAdapter();
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });

    session.start("manual-empty", "manual");
    await settle();
    fake.emit({ type: "transcript", turnIdx: 1, text: "provisional words" });
    await settle();
    session.end("manual-empty");
    fake.emit({ type: "transcript", turnIdx: 1, text: "   " });
    await settle();

    expect(fake.flushes).toBe(1);
    expect(stub.submitted).toEqual([]);
    expect(session.start("next", "manual")).toBe(true);
    session.close();
  });

  it("submits exactly once when an adapter repeats the finalized callback", async () => {
    const fake = fakeAdapter();
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });

    session.start("manual-duplicate", "manual");
    await settle();
    session.end("manual-duplicate");
    fake.emit({ type: "transcript", turnIdx: 1, text: "final words" });
    fake.emit({ type: "transcript", turnIdx: 1, text: "final words" });
    await settle();

    expect(stub.submitted).toEqual([{ kind: "conversational", text: "final words" }]);
    session.close();
  });

  it("drops manual input when requesting the final flush fails", async () => {
    const fake = fakeAdapter(undefined, undefined, new Error("flush failed"));
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });

    session.start("manual-failure", "manual");
    await settle();
    fake.emit({ type: "transcript", turnIdx: 1, text: "provisional words" });
    await settle();
    session.end("manual-failure");
    fake.emit({ type: "transcript", turnIdx: 1, text: "late final words" });
    await settle();

    expect(stub.submitted).toEqual([]);
    expect(fake.closes).toBe(1);
    expect(session.start("next", "manual")).toBe(true);
    session.close();
  });

  it("keeps the first matching terminal outcome across cancel/end races", async () => {
    const fake = lingeringAdapter();
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });

    session.start("cancel-wins", "manual");
    await settle();
    fake.emit({ type: "transcript", turnIdx: 1, text: "provisional words" });
    await settle();
    session.cancel("cancel-wins");
    session.end("cancel-wins");
    fake.emit({ type: "transcript", turnIdx: 1, text: "late final words" });
    await settle();

    expect(fake.flushes).toBe(0);
    expect(stub.submitted).toEqual([]);
    session.close();
  });

  it("does not let cancel steal a capture after End has won", async () => {
    const fake = fakeAdapter();
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });

    session.start("end-wins", "manual");
    await settle();
    session.end("end-wins");
    session.cancel("end-wins");
    fake.emit({ type: "transcript", turnIdx: 1, text: "final words" });
    await settle();

    expect(fake.flushes).toBe(1);
    expect(stub.submitted).toEqual([{ kind: "conversational", text: "final words" }]);
    session.close();
  });

  it("does not retain credential-shaped capture IDs in STT logs", async () => {
    const lines: string[] = [];
    await createGatewayLogger({ logLevel: "debug", testSink: (line) => lines.push(line) });
    const fake = fakeAdapter();
    const stub = stubRuntime();
    const untrusted = "token=private-content-shaped-capture";
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });

    session.start(untrusted, "manual");
    await settle();
    session.end(untrusted);
    fake.emit({ type: "transcript", turnIdx: 1, text: "synthetic final" });
    await settle();
    session.close();

    const output = lines.join("\n");
    expect(output).not.toContain(untrusted);
    expect(output).toContain(captureDiagnosticRef(untrusted));
    expect(output).not.toContain("captureId=");
  });

  it("drops manual transcript and late adapter callbacks after cancel", async () => {
    const fake = lingeringAdapter();
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });

    session.start("manual-1", "manual");
    await settle();
    fake.emit({ type: "transcript", turnIdx: 1, text: "never submit" });
    await settle();
    session.cancel("manual-1");
    fake.emit({ type: "transcript", turnIdx: 1, text: "also stale" });
    await settle();

    expect(stub.submitted).toEqual([]);
    expect(fake.flushes).toBe(0);
    session.close();
  });

  it("keeps End -> turn_started eligible for one committed semantic transcript", async () => {
    const fake = fakeAdapter();
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });

    expect(session.start("cap-1", "semantic")).toBe(true);
    await settle();
    session.end("cap-1");
    fake.emit({ type: "turn_started", turnIdx: 1 });
    await settle();
    expect(session.start("cap-blocked", "semantic")).toBe(false);

    fake.emit({ type: "transcript", turnIdx: 1, text: "commit this once" });
    await settle();
    fake.emit({ type: "turn_dropped", turnIdx: 1 });
    await settle();

    expect(stub.submitted).toEqual([{ kind: "conversational", text: "commit this once" }]);
    expect(session.start("cap-2", "semantic")).toBe(true);
    session.close();
  });

  it("releases End -> turn_started on a true dropped terminal without submitting", async () => {
    const fake = fakeAdapter();
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });

    expect(session.start("cap-1", "semantic")).toBe(true);
    await settle();
    session.end("cap-1");
    fake.emit({ type: "turn_started", turnIdx: 1 });
    fake.emit({ type: "turn_dropped", turnIdx: 1 });
    await settle();

    expect(stub.submitted).toEqual([]);
    expect(session.start("cap-2", "semantic")).toBe(true);
    session.close();
  });

  it("terminalizes End -> turn_started when its semantic event stream fails", async () => {
    const failing = fakeAdapter();
    const healthy = fakeAdapter();
    const queue = [failing, healthy];
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => (queue.shift() ?? healthy).adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });

    expect(session.start("cap-1", "semantic")).toBe(true);
    await settle();
    session.end("cap-1");
    failing.emit({ type: "turn_started", turnIdx: 1 });
    await settle();
    expect(session.start("cap-blocked", "semantic")).toBe(false);
    failing.fail(new Error("final stream failed"));
    await settle();

    expect(stub.submitted).toEqual([]);
    expect(session.start("cap-2", "semantic")).toBe(true);
    await settle();
    session.pushFrame("cap-2", new Uint8Array([1]));
    expect(healthy.sent).toHaveLength(1);
    session.close();
  });

  it("contains a rejecting event stream and re-dials on the next mic frame", async () => {
    const failing = fakeAdapter(undefined, new Error("stt socket died"));
    const healthy = fakeAdapter();
    const queue = [failing, healthy];
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => (queue.shift() ?? healthy).adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });

    session.start("cap-1", "semantic");
    await settle(); // the first adapter's events() rejects here

    session.pushFrame("cap-1", new Uint8Array([1])); // mic still open → frame-driven re-dial
    await settle();
    healthy.emit({ type: "transcript", turnIdx: 1, text: "still here" });
    await settle();

    expect(stub.submitted).toEqual([{ kind: "conversational", text: "still here" }]);
    session.close();
  });

  it("drops frames without throwing when the adapter never connected", async () => {
    const fake = fakeAdapter(new Error("connect refused"));
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });

    session.start("cap-1", "semantic");
    await settle();

    expect(() => session.pushFrame("cap-1", new Uint8Array([1]))).not.toThrow();
    expect(fake.sent).toEqual([]);
    session.close();
  });

  // ── Discard: the uplink is aimed at a session this connection has left ──
  //
  // These pin the compensating control that makes "binary audio binds to the
  // CONNECTION, not to a stamped header" a sound decision (spec §3.7). The
  // decision only holds if leaving a session provably drops the bytes captured
  // under the old one; without that, an utterance begun in session A finalizes
  // into session B, which is the exact hazard a per-frame stamp would have
  // closed.

  it("INVARIANT: a discarded uplink commits no transcript — the words were spoken into another session", async () => {
    const fake = lingeringAdapter();
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });

    session.start("cap-1", "semantic");
    await settle();
    session.pushFrame("cap-1", new Uint8Array([1, 2, 3, 4]));
    expect(session.buffered).toBe(4);

    session.discard();
    // The abandoned socket can still yield what it had already decoded. Nothing
    // it produces after the discard may reach a runtime — by then that runtime
    // belongs to a DIFFERENT conversation.
    fake.emit({ type: "transcript", turnIdx: 1, text: "meant for the other chat" });
    await settle();

    expect(stub.submitted).toEqual([]);
    expect(session.buffered).toBe(0);
    expect(fake.flushes).toBe(0); // abandoned, never force-finalized
    session.close();
  });

  // THE OTHER HALF OF THAT INVARIANT, and the half the case above cannot reach.
  //
  // It emits AFTER the discard, so the loop's pre-dispatch guard catches it and
  // the transcript never gets as far as resolving a runtime. This one emits
  // BEFORE the discard — the event is already inside `dispatch`, suspended on
  // `getRuntimeForInput`, when the user switches conversations. That await is
  // real work on a voice-first draft (mint the session, then re-resolve this
  // connection's authority against the user record), so the window is wide, and
  // on the far side of it the runtime belongs to the session the user LEFT.
  it("INVARIANT: an uplink discarded WHILE a transcript is resolving a runtime commits nothing", async () => {
    const fake = lingeringAdapter();
    const stub = stubRuntime();
    const capability: Capability = Object.freeze({
      ownerUserId: "u_stt_test",
      resource: "session-store",
      rootPath: `${STORE_ROOT}/u_stt_test`,
      role: "adult",
    });
    const store = openSessionStore(capability);
    let releaseRuntime = (): void => {};
    const runtimeResolving = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      // Suspends on authority/binding work, then linearizes immediately before
      // the same real SQLite admission production uses.
      getRuntimeForInput: async (_text, captureIsCurrent) => {
        await runtimeResolving;
        if (!captureIsCurrent()) return null;
        admitFirstUserMessage(
          store,
          `d_${"ab".repeat(16)}`,
          {
            turnId: "turn-stt",
            replyId: null,
            kind: "user",
            createdAt: Date.now(),
            text: "meant for the other chat",
            toolCallId: null,
            toolName: null,
            toolArgs: null,
            cutoff: null,
            compactedThroughSeq: null,
            pendingId: null,
          },
          [],
          0,
        );
        return stub.runtime;
      },
    });

    session.start("cap-1", "semantic");
    await settle();
    // The transcript enters `dispatch` and parks on the runtime lookup.
    fake.emit({ type: "transcript", turnIdx: 1, text: "meant for the other chat" });
    await settle();
    expect(store.listSessionsWithMetadata()).toEqual([]); // still resolving

    // The user clicks another conversation: conversation.activate → unbind →
    // detachSession → discard(). Only THEN does the runtime lookup land.
    session.discard();
    releaseRuntime();
    await settle();

    expect(store.listSessionsWithMetadata()).toEqual([]);
    expect(store.listSessions()).toEqual([]);
    store.close();
    session.close();
  });

  it("INVARIANT: discard after durable transcript admission cannot strand accepted work", async () => {
    const fake = lingeringAdapter();
    const stub = stubRuntime();
    const store = openSessionStore(
      Object.freeze({
        ownerUserId: "u_stt_accepted",
        resource: "session-store",
        rootPath: `${STORE_ROOT}/u_stt_accepted`,
        role: "adult",
      } satisfies Capability),
    );
    let signalCommitted = (): void => {};
    const committed = new Promise<void>((resolve) => {
      signalCommitted = resolve;
    });
    let releaseResolution = (): void => {};
    const resolution = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    const session = createSttSession({
      sessionId: "sess-accepted",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async (_text, captureIsCurrent) => {
        if (!captureIsCurrent()) return null;
        const admitted = admitFirstUserMessage(
          store,
          `d_${"cd".repeat(16)}`,
          {
            turnId: "turn-accepted",
            replyId: null,
            kind: "user",
            createdAt: Date.now(),
            text: "accepted speech",
            toolCallId: null,
            toolName: null,
            toolArgs: null,
            cutoff: null,
            compactedThroughSeq: null,
            pendingId: null,
          },
          [],
          0,
        );
        signalCommitted();
        await resolution;
        return {
          runtime: stub.runtime,
          authoritative: true,
          stimulus: { kind: "preadmitted-conversational", entrySeq: admitted.admission.entry.seq, admission: "fresh" },
        };
      },
    });

    session.start("cap-accepted", "semantic");
    await settle();
    fake.emit({ type: "transcript", turnIdx: 1, text: "accepted speech" });
    await committed;
    session.discard();
    releaseResolution();
    await settle();

    expect(store.listSessionsWithMetadata()).toHaveLength(1);
    expect(stub.submitted).toEqual([
      expect.objectContaining({ kind: "preadmitted-conversational", admission: "fresh" }),
    ]);
    store.close();
    session.close();
  });

  it("INVARIANT: a discarded uplink barges into nothing — a mic onset in the old session must not abort the new one", async () => {
    const fake = lingeringAdapter();
    const stub = stubRuntime();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => fake.adapter,
      config: TEST_CONFIG,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });

    session.start("cap-1", "semantic");
    await settle();
    session.discard();
    fake.emit({ type: "turn_started", turnIdx: 1 });
    await settle();

    // `bargeIn()` aborts the SHARED turn for every window on the session it
    // reaches. One that leaked from an abandoned uplink would cut off a
    // conversation the speaker is not even in.
    expect(stub.bargeIns).toEqual([]);
    session.close();
  });

  it("requires a fresh capture after discard before speech can continue", async () => {
    let dialled = 0;
    const first = fakeAdapter();
    const second = fakeAdapter();
    const session = createSttSession({
      sessionId: "sess-1",
      factory: () => {
        dialled += 1;
        return dialled === 1 ? first.adapter : second.adapter;
      },
      config: TEST_CONFIG,
      getRuntime: () => null,
      getRuntimeForInput: async () => null,
    });

    session.start("cap-1", "semantic");
    await settle();
    session.discard();
    session.pushFrame("cap-1", new Uint8Array([9]));
    session.start("cap-2", "semantic");
    await settle();
    session.pushFrame("cap-2", new Uint8Array([9]));

    expect(dialled).toBe(2);
    expect(second.sent).toHaveLength(1);
    session.close();
  });
});

it("deadline fences delayed admission and late callbacks while next capture is active", async () => {
  const old = lingeringAdapter();
  const next = fakeAdapter();
  const stub = stubRuntime();
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const adapters = [old, next];
  const session = createSttSession({
    sessionId: "deadline",
    factory: () => (adapters.shift() ?? next).adapter,
    config: { ...TEST_CONFIG, finalizeTimeoutMs: 20 },
    getRuntime: () => stub.runtime,
    getRuntimeForInput: async () => {
      if (++calls === 1) await blocked;
      return stub.runtime;
    },
  });
  session.start("old", "manual");
  await settle();
  session.end("old");
  old.emit({ type: "transcript", turnIdx: 1, text: "stale" });
  await Bun.sleep(40);
  expect(session.start("next", "manual")).toBe(true);
  await settle();
  release();
  old.emit({ type: "turn_started", turnIdx: 2 });
  old.emit({ type: "transcript", turnIdx: 2, text: "stale again" });
  await settle();
  expect(stub.submitted).toEqual([]);
  expect(stub.bargeIns).toEqual([]);
  session.end("next");
  next.emit({ type: "transcript", turnIdx: 1, text: "fresh" });
  await settle();
  expect(stub.submitted).toEqual([{ kind: "conversational", text: "fresh" }]);
  session.close();
});

it.each(["manual", "semantic"] as const)(
  "%s rotation preserves B's pre-ready bytes and End after A commits",
  async (mode) => {
    const first = fakeAdapter();
    const second = fakeAdapter();
    const stub = stubRuntime();
    let ready = () => {};
    second.adapter.open = () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      });
    const operations: unknown[] = [];
    second.adapter.send = (bytes) => operations.push([...bytes]);
    second.adapter.endUtterance = () => operations.push("flush");
    const adapters = [first, second];
    const session = createSttSession({
      sessionId: "rotation",
      config: TEST_CONFIG,
      factory: () => (adapters.shift() ?? second).adapter,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });
    try {
      expect(session.start("A", mode)).toBe(true);
      await settle();
      session.end("A");
      first.emit({ type: "transcript", turnIdx: 1, text: "first" });
      await settle();
      expect(session.start("B", mode)).toBe(true);
      const frame = new Uint8Array([1, 2]);
      session.pushFrame("B", frame);
      frame.fill(9); // caller cannot mutate queued audio
      session.pushFrame("B", new Uint8Array([3, 4]));
      expect(session.buffered).toBe(4);
      session.end("B");
      session.cancel("B"); // End still wins
      session.pushFrame("B", new Uint8Array([5]));
      expect(session.start("overlap", mode)).toBe(false);
      expect(operations).toEqual([]);
      ready();
      await settle();
      expect(second.turnModes).toEqual([mode]);
      expect(operations).toEqual([[1, 2], [3, 4], "flush"]);
      second.emit({ type: "transcript", turnIdx: 1, text: "second" });
      second.emit({ type: "transcript", turnIdx: 1, text: "duplicate" });
      await settle();
      expect(stub.submitted).toEqual([
        { kind: "conversational", text: "first" },
        { kind: "conversational", text: "second" },
      ]);
    } finally {
      session.close();
    }
  },
);

it.each(["cancel", "discard", "close"] as const)(
  "%s releases pre-ready audio and fences late ready",
  async (terminal) => {
    const first = lingeringAdapter();
    const second = fakeAdapter();
    const stub = stubRuntime();
    let releaseFirst = () => {};
    let releaseSecond = () => {};
    let oldSignal: AbortSignal | undefined;
    first.adapter.open = (signal) => {
      oldSignal = signal;
      return new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    };
    second.adapter.open = () =>
      new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
    let dialled = 0;
    const session = createSttSession({
      sessionId: "pending",
      config: TEST_CONFIG,
      factory: () => (++dialled === 1 ? first : second).adapter,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });
    try {
      session.start("old", "manual");
      session.pushFrame("old", new Uint8Array([1, 2]));
      expect(session.buffered).toBe(2);
      if (terminal === "cancel") session.cancel("old");
      else session[terminal]();
      expect(session.buffered).toBe(0);
      expect(oldSignal?.aborted).toBe(true);
      expect(session.start("new", "manual")).toBe(terminal !== "close");
      releaseFirst();
      first.emit({ type: "transcript", turnIdx: 1, text: "stale" });
      await settle();
      expect(first.sent).toEqual([]);
      expect(first.flushes).toBe(0);
      expect(first.closes).toBe(1);
      expect(stub.submitted).toEqual([]);
      if (terminal === "close") return;
      session.pushFrame("new", new Uint8Array([3, 4]));
      session.end("new");
      expect(dialled).toBe(2); // old ready did not clear newer connect ownership
      releaseSecond();
      await settle();
      expect(second.sent.map((bytes) => [...bytes])).toEqual([[3, 4]]);
      expect(second.flushes).toBe(1);
      second.emit({ type: "transcript", turnIdx: 1, text: "fresh" });
      await settle();
      expect(stub.submitted).toEqual([{ kind: "conversational", text: "fresh" }]);
    } finally {
      session.close();
    }
  },
);

it.each(["overflow", "timeout", "connect-failure"] as const)(
  "pre-ready %s fails closed and next capture recovers",
  async (failure) => {
    const first = lingeringAdapter();
    const second = fakeAdapter();
    const stub = stubRuntime();
    let ready = () => {};
    let reject = (_err: Error) => {};
    let signal: AbortSignal | undefined;
    first.adapter.open = (s) => {
      signal = s;
      return new Promise<void>((resolve, fail) => {
        ready = resolve;
        reject = fail;
      });
    };
    const adapters = [first, second];
    const config = { ...TEST_CONFIG, finalizeTimeoutMs: 20 };
    const session = createSttSession({
      sessionId: "bounded",
      config,
      factory: () => (adapters.shift() ?? second).adapter,
      getRuntime: () => stub.runtime,
      getRuntimeForInput: async () => stub.runtime,
    });
    try {
      session.start("old", "manual");
      const bound = Math.ceil((config.inputSampleRate * 2 * config.connectTimeoutMs) / 1000);
      session.pushFrame("old", new Uint8Array(bound));
      expect(session.buffered).toBe(bound);
      if (failure === "overflow") session.pushFrame("old", new Uint8Array(1));
      else if (failure === "timeout") {
        session.end("old");
        await Bun.sleep(40);
      } else {
        reject(new Error("synthetic connect failure"));
        await settle();
      }
      expect(session.buffered).toBe(0);
      expect(signal?.aborted).toBe(true);
      expect(session.start("new", "manual")).toBe(true);
      ready();
      first.emit({ type: "transcript", turnIdx: 1, text: "stale" });
      await settle();
      expect(first.sent).toEqual([]);
      expect(first.flushes).toBe(0);
      expect(stub.submitted).toEqual([]);
      session.pushFrame("new", new Uint8Array([1, 2]));
      session.end("new");
      second.emit({ type: "transcript", turnIdx: 1, text: "fresh" });
      await settle();
      expect(second.sent).toHaveLength(1);
      expect(stub.submitted).toEqual([{ kind: "conversational", text: "fresh" }]);
    } finally {
      session.close();
    }
  },
);

it("echo cooldown survives terminal rotation and delayed ready without extending on retries", async () => {
  let now = 1000;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const first = fakeAdapter();
  const second = fakeAdapter();
  const third = fakeAdapter();
  let ready = () => {};
  second.adapter.open = () =>
    new Promise<void>((resolve) => {
      ready = resolve;
    });
  const adapters = [first, second, third];
  const session = createSttSession({
    sessionId: "echo-rotation",
    config: TEST_CONFIG,
    factory: () => (adapters.shift() ?? third).adapter,
    getRuntime: () => null,
    getRuntimeForInput: async () => null,
  });
  const guard = createMicEchoGuard(() => [session], 2500, "echo-rotation");
  try {
    session.start("first", "manual");
    await settle();
    session.end("first");
    first.emit({ type: "turn_dropped", turnIdx: 1 });
    await settle();
    expect(first.closes).toBe(1);
    guard.onTtsStart("tts"); // no adapter: expiry is 3500
    now = 1500;
    expect(session.start("second", "semantic")).toBe(true);
    now = 2000;
    ready();
    await settle();
    expect(second.suppressions).toEqual([1500]);
    session.pushFrame("second", new Uint8Array(2));
    expect(second.sent).toHaveLength(0);
    expect(session.buffered).toBe(0);
    // Semantic reconnect within the same cooldown must not restart 2500 ms.
    second.fail(new Error("synthetic_disconnect"));
    await settle();
    now = 3000;
    session.pushFrame("second", new Uint8Array(2));
    await settle();
    expect(third.suppressions).toEqual([500]);
    now = 3499;
    session.pushFrame("second", new Uint8Array(2));
    expect(third.sent).toHaveLength(0);
    now = 3500;
    session.pushFrame("second", new Uint8Array(2));
    expect(third.sent).toHaveLength(1);
    guard.onTtsStart("tts-next");
    session.pushFrame("second", new Uint8Array(2));
    expect(third.sent).toHaveLength(1);
    guard.onTtsCancel("tts-next");
    session.pushFrame("second", new Uint8Array(2));
    expect(third.suppressions.at(-1)).toBe(0);
    expect(third.sent).toHaveLength(2);
  } finally {
    session.close();
    clock.mockRestore();
  }
});

it("TTS cancel clears cooldown while ready is pending", async () => {
  const fake = fakeAdapter();
  let ready = () => {};
  fake.adapter.open = () =>
    new Promise<void>((resolve) => {
      ready = resolve;
    });
  const session = createSttSession({
    sessionId: "echo-cancel",
    config: TEST_CONFIG,
    factory: () => fake.adapter,
    getRuntime: () => null,
    getRuntimeForInput: async () => null,
  });
  const guard = createMicEchoGuard(() => [session], 2500, "echo-cancel");
  try {
    session.start("capture", "manual");
    guard.onTtsStart("tts");
    guard.onTtsCancel("tts");
    ready();
    await settle();
    expect(fake.suppressions).toEqual([0]);
    session.pushFrame("capture", new Uint8Array(2));
    expect(fake.sent).toHaveLength(1);
  } finally {
    session.close();
  }
});

it("pending READY preserves pre-TTS speech without replaying suppressed echo after expiry", async () => {
  let now = 1000;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const fake = fakeAdapter();
  let ready = () => {};
  fake.adapter.open = () =>
    new Promise<void>((resolve) => {
      ready = resolve;
    });
  let adapterSuppressedUntil = 0;
  fake.adapter.suppressInputFor = (ms) => {
    fake.suppressions.push(ms);
    adapterSuppressedUntil = now + ms;
  };
  fake.adapter.send = (bytes) => {
    if (now >= adapterSuppressedUntil) fake.sent.push(bytes);
  };
  const session = createSttSession({
    sessionId: "echo-buffer",
    config: TEST_CONFIG,
    factory: () => fake.adapter,
    getRuntime: () => null,
    getRuntimeForInput: async () => null,
  });
  try {
    session.start("capture", "semantic");
    session.pushFrame("capture", new Uint8Array([1, 2]));
    now = 1500;
    session.suppressInputFor(2500);
    session.pushFrame("capture", new Uint8Array([9, 9]));
    expect(session.buffered).toBe(2);
    now = 2000;
    ready();
    await settle();
    expect(fake.sent.map((bytes) => [...bytes])).toEqual([[1, 2]]);
    expect(fake.suppressions).toEqual([2000]);
    now = 3999;
    session.pushFrame("capture", new Uint8Array([9, 9]));
    now = 4000;
    session.pushFrame("capture", new Uint8Array([3, 4]));
    expect(fake.sent.map((bytes) => [...bytes])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  } finally {
    session.close();
    clock.mockRestore();
  }
});
