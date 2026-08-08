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

import { describe, expect, it } from "bun:test";
import type { TurnMode } from "@sentient/protocol";
import type { STTAdapter, STTAdapterConfig, STTEvent } from "../adapters/stt/stt-adapter-types.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import type { Stimulus } from "../runtime/stimulus.js";
import { EMPTY_TURN_STATE } from "../runtime/turn-state-snapshot.js";
import { createSttSession } from "./stt-session.js";

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
  sent: Uint8Array[];
  turnModes: TurnMode[];
  flushes: number;
  suppressions: number[];
  closes: number;
}

function fakeAdapter(openError?: Error, eventsError?: Error): FakeAdapter {
  const pendingEvents: STTEvent[] = [];
  let deliver: ((e: STTEvent | null) => void) | null = null;
  const f: FakeAdapter = {
    sent: [],
    turnModes: [],
    flushes: 0,
    suppressions: [],
    closes: 0,
    emit(event) {
      const d = deliver;
      if (d) {
        deliver = null;
        d(event);
        return;
      }
      pendingEvents.push(event);
    },
    adapter: {
      open: async () => {
        if (openError) throw openError;
      },
      send: (pcm) => {
        f.sent.push(pcm);
      },
      endUtterance: () => {
        f.flushes += 1;
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
            yield next;
            continue;
          }
          const awaited = await new Promise<STTEvent | null>((resolve) => {
            deliver = resolve;
          });
          if (awaited === null) return;
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

    session.start("semantic");
    await settle();
    fake.emit({ type: "transcript", turnIdx: 1, text: "turn on the lights" });
    await settle();

    expect(stub.submitted).toEqual([{ kind: "conversational", text: "turn on the lights" }]);
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

    session.start("semantic");
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

    session.start("semantic");
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

    session.start("manual");
    await settle();
    session.pushFrame(new Uint8Array([1, 2, 3]));
    session.end();

    expect(fake.turnModes).toEqual(["manual"]);
    expect(fake.sent).toHaveLength(1);
    expect(fake.flushes).toBe(1);
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

    session.start("semantic");
    await settle(); // the first adapter's events() rejects here

    session.pushFrame(new Uint8Array([1])); // mic still open → frame-driven re-dial
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

    session.start("semantic");
    await settle();

    expect(() => session.pushFrame(new Uint8Array([1]))).not.toThrow();
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

    session.start("semantic");
    await settle();
    session.pushFrame(new Uint8Array([1, 2, 3, 4]));
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

    session.start("semantic");
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

  it("keeps the mic live across a discard — the next frame re-dials and speech continues", async () => {
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

    session.start("semantic");
    await settle();
    session.discard();
    session.pushFrame(new Uint8Array([9]));
    await settle();
    session.pushFrame(new Uint8Array([9]));

    expect(dialled).toBe(2);
    expect(second.sent).toHaveLength(1);
    session.close();
  });
});
