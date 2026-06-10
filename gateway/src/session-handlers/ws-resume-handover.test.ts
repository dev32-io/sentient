/**
 * Task 3.8 — WS resume handshake (integration-grade).
 *
 * Pins the resume contract end-to-end against real SessionReplayBuffer +
 * FrameSequencer + DeviceBufferStore objects (no hand-rolled mocks of the
 * units under test):
 *
 *  1) Resume-in-window — buffer holds seq 1..5, client resumes lastSeq=2 +
 *     matching epoch → stream.resumed{recovered:true, fromSeq:3, toSeq:5} +
 *     verbatim replay of frames 3,4,5 (exact bytes + kinds), session.ready
 *     suppressed, a NEW frame continues at seq 6 (seq continuity).
 *  2) Stale/gap — lastSeq older than oldestSeq (evicted) → recovered:false.
 *  3) Epoch mismatch — wrong epoch → fresh buffer + new epoch + recovered:false.
 *  4) Handover/no-leak — a resumable disconnect stashed a deferred teardown;
 *     a matching-epoch resume RUNS it exactly once and the sweep does NOT
 *     re-run it.
 */

import type { ServerWebSocket } from "bun";
import { describe, expect, it, vi } from "vitest";
import { DeviceBufferStore } from "../person-session/device-buffer-store.js";
import { BINARY_TYPE_AUDIO, createFrameSequencer } from "./frame-sequencer.js";
import { type SessionReplayBuffer, createSessionReplayBuffer } from "./session-replay-buffer.js";
import type { ClientData } from "./ws-helpers.js";
import { handleResumeOrFresh, resolveDeviceId } from "./ws-resume-handover.js";

const REPLAY_MAX_BYTES = 64 * 1024;
const TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// Fake WS that records raw text vs binary sends
// ---------------------------------------------------------------------------

interface SentFrame {
  readonly kind: "text" | "binary";
  readonly value: string | Uint8Array;
}

function makeWs(): { ws: ServerWebSocket<ClientData>; sent: SentFrame[] } {
  const sent: SentFrame[] = [];
  const send = (v: string | Uint8Array): void => {
    sent.push({ kind: typeof v === "string" ? "text" : "binary", value: v });
  };
  const ws = { send } as unknown as ServerWebSocket<ClientData>;
  return { ws, sent };
}

/**
 * Journal `count` JSON frames through a FrameSequencer into the buffer (so the
 * stored bytes carry seq+epoch exactly as a live cycle would). Returns the
 * wire-ready text of each stored frame for byte-identical assertions.
 */
function journalJsonFrames(buffer: SessionReplayBuffer, epoch: number, count: number): string[] {
  const stored: string[] = [];
  const seq = createFrameSequencer({
    epoch,
    buffer,
    sendText: (s) => stored.push(s),
    sendBinary: () => {},
  });
  for (let i = 0; i < count; i++) {
    seq.json({ type: "message.delta", delta: `d${i}` });
  }
  return stored;
}

function parseResumed(sent: SentFrame[]): Record<string, unknown> | null {
  const frame = sent.find(
    (f) => f.kind === "text" && typeof f.value === "string" && f.value.includes("stream.resumed"),
  );
  if (!frame || typeof frame.value !== "string") return null;
  return JSON.parse(frame.value) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// resolveDeviceId
// ---------------------------------------------------------------------------

describe("resolveDeviceId", () => {
  it("returns the configure deviceId when no resume frame", () => {
    expect(resolveDeviceId("dev-A", null)).toBe("dev-A");
  });

  it("returns the configure deviceId when resume frame matches", () => {
    expect(resolveDeviceId("dev-A", { epoch: 1, lastSeq: 0, deviceId: "dev-A" })).toBe("dev-A");
  });

  it("prefers the resume frame deviceId on mismatch", () => {
    expect(resolveDeviceId("dev-A", { epoch: 1, lastSeq: 0, deviceId: "dev-B" })).toBe("dev-B");
  });
});

// ---------------------------------------------------------------------------
// 1) Resume-in-window
// ---------------------------------------------------------------------------

describe("handleResumeOrFresh — resume in window (recovered:true)", () => {
  it("emits recovered:true with fromSeq/toSeq and replays missed frames verbatim", () => {
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    const { buffer, epoch } = store.acquire("dev-A");
    const storedTexts = journalJsonFrames(buffer, epoch, 5); // seq 1..5

    const { ws, sent } = makeWs();
    const suppressFresh = handleResumeOrFresh({
      ws,
      sessionId: "sess-new",
      deviceId: "dev-A",
      buffer,
      epoch,
      resumed: true,
      resumeParams: { epoch, lastSeq: 2, deviceId: "dev-A" },
    });

    expect(suppressFresh).toBe(true);

    const resumed = parseResumed(sent);
    expect(resumed).toMatchObject({ type: "stream.resumed", recovered: true, epoch, fromSeq: 3, toSeq: 5 });

    // The replayed frames follow the ack, in order, byte-identical to storage.
    const replayed = sent.filter((f, i) => i > 0 && f.kind === "text").map((f) => f.value as string);
    expect(replayed).toEqual([storedTexts[2], storedTexts[3], storedTexts[4]]);
  });

  it("preserves seq continuity — a NEW frame after resume continues at seq 6", () => {
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    const { buffer, epoch } = store.acquire("dev-A");
    journalJsonFrames(buffer, epoch, 5); // seq 1..5

    const { ws } = makeWs();
    handleResumeOrFresh({
      ws,
      sessionId: "sess-new",
      deviceId: "dev-A",
      buffer,
      epoch,
      resumed: true,
      resumeParams: { epoch, lastSeq: 2, deviceId: "dev-A" },
    });

    // Going live: the new attachment's sequencer reuses the SAME buffer object.
    const nextSeq = buffer.append(new TextEncoder().encode("{}"), "text");
    expect(nextSeq).toBe(6);
  });

  it("replays a binary frame verbatim (with its 9-byte header)", () => {
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    const { buffer, epoch } = store.acquire("dev-A");
    let storedBinary: Uint8Array | null = null;
    const seq = createFrameSequencer({
      epoch,
      buffer,
      sendText: () => {},
      sendBinary: (b) => {
        storedBinary = b;
      },
    });
    seq.binary(new Uint8Array([0xaa, 0xbb]), BINARY_TYPE_AUDIO); // seq 1

    const { ws, sent } = makeWs();
    handleResumeOrFresh({
      ws,
      sessionId: "sess-new",
      deviceId: "dev-A",
      buffer,
      epoch,
      resumed: true,
      resumeParams: { epoch, lastSeq: 0, deviceId: "dev-A" },
    });

    const binarySent = sent.find((f) => f.kind === "binary");
    expect(binarySent?.value).toEqual(storedBinary);
  });
});

// ---------------------------------------------------------------------------
// 2) Stale / gap (evicted)
// ---------------------------------------------------------------------------

describe("handleResumeOrFresh — stale lastSeq (gap, recovered:false)", () => {
  it("emits recovered:false when lastSeq predates the oldest retained frame", () => {
    // Tiny cap forces eviction: each frame ~ >12 bytes; cap 40 keeps ~2 frames.
    const buffer = createSessionReplayBuffer({ maxBytes: 40 });
    journalJsonFrames(buffer, 7, 5); // seq 1..5, oldest evicted

    // oldestSeq should be > 1 now (some frames evicted).
    expect(buffer.oldestSeq).toBeGreaterThan(1);

    const { ws, sent } = makeWs();
    const suppressFresh = handleResumeOrFresh({
      ws,
      sessionId: "sess-new",
      deviceId: "dev-A",
      buffer,
      epoch: 7,
      resumed: true,
      resumeParams: { epoch: 7, lastSeq: 1, deviceId: "dev-A" }, // seq1 evicted
    });

    expect(suppressFresh).toBe(false);
    expect(parseResumed(sent)).toMatchObject({ type: "stream.resumed", recovered: false, epoch: 7 });
    // No replayed frames after the ack.
    expect(sent.filter((f) => f.kind === "binary")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3) Epoch mismatch
// ---------------------------------------------------------------------------

describe("handleResumeOrFresh — epoch mismatch (fresh buffer, recovered:false)", () => {
  it("a wrong resumeEpoch produces a fresh buffer + new epoch; recovered:false", () => {
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    const first = store.acquire("dev-A"); // epoch 1
    journalJsonFrames(first.buffer, first.epoch, 3);
    store.release("dev-A");

    // Reconnect with a STALE epoch → acquire returns a fresh buffer + new epoch.
    const second = store.acquire("dev-A", { resumeEpoch: 999 });
    expect(second.resumed).toBe(false);
    expect(second.epoch).not.toBe(first.epoch);

    const { ws, sent } = makeWs();
    const suppressFresh = handleResumeOrFresh({
      ws,
      sessionId: "sess-new",
      deviceId: "dev-A",
      buffer: second.buffer,
      epoch: second.epoch,
      resumed: second.resumed,
      resumeParams: { epoch: 999, lastSeq: 2, deviceId: "dev-A" },
    });

    expect(suppressFresh).toBe(false);
    expect(parseResumed(sent)).toMatchObject({ type: "stream.resumed", recovered: false, epoch: second.epoch });
  });

  it("a client that never asked to resume gets NO stream.resumed ack (plain fresh)", () => {
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    const { buffer, epoch, resumed } = store.acquire("dev-A");

    const { ws, sent } = makeWs();
    const suppressFresh = handleResumeOrFresh({
      ws,
      sessionId: "sess-new",
      deviceId: "dev-A",
      buffer,
      epoch,
      resumed,
      resumeParams: null,
    });

    expect(suppressFresh).toBe(false);
    expect(parseResumed(sent)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4) Handover / no-leak — acquire returns the prior deferred teardown
// ---------------------------------------------------------------------------

describe("DeviceBufferStore.acquire — handover of the prior deferred teardown", () => {
  it("returns the stashed deferredTeardown on a matching-epoch resume, then detaches it", () => {
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    const first = store.acquire("dev-A");
    const teardown = vi.fn();
    store.release("dev-A", teardown);

    // Reconnect with the matching epoch → handover hands the teardown back.
    const resumed = store.acquire("dev-A", { resumeEpoch: first.epoch });
    expect(resumed.resumed).toBe(true);
    expect(resumed.priorDeferredTeardown).toBe(teardown);

    // The caller (ws-session-configure) runs it.
    resumed.priorDeferredTeardown?.();
    expect(teardown).toHaveBeenCalledTimes(1);

    // The sweep must NOT re-run it (acquire detached it from the entry).
    store.release("dev-A");
    const future = Date.now() + TTL_MS + 1000;
    store.sweepExpired(future, TTL_MS);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("returns null priorDeferredTeardown when nothing was stashed", () => {
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    const first = store.acquire("dev-A");
    store.release("dev-A"); // no teardown
    const resumed = store.acquire("dev-A", { resumeEpoch: first.epoch });
    expect(resumed.priorDeferredTeardown).toBeNull();
  });

  it("a fresh (non-resumed) acquire returns null priorDeferredTeardown", () => {
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    const result = store.acquire("dev-A");
    expect(result.priorDeferredTeardown).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5) Prefs seed double-send prevention
//
// On recovered:true, handleResumeOrFresh returns true → the caller's
// fresh-only block (which sends session.ready + the prefs seed) is SUPPRESSED.
// The prefs frame reaches the client only via the replay window — exactly once.
//
// On a fresh connect (recovered:false or no resume frame), handleResumeOrFresh
// returns false → the fresh-only block runs and sends the prefs seed once.
// ---------------------------------------------------------------------------

describe("handleResumeOrFresh — prefs seed double-send prevention", () => {
  it("returns true (suppress fresh) on recovered:true — prefs seed must NOT be sent live", () => {
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    const { buffer, epoch } = store.acquire("dev-A");
    journalJsonFrames(buffer, epoch, 3); // seq 1..3

    const { ws } = makeWs();
    const suppressFresh = handleResumeOrFresh({
      ws,
      sessionId: "sess-prefs",
      deviceId: "dev-A",
      buffer,
      epoch,
      resumed: true,
      resumeParams: { epoch, lastSeq: 0, deviceId: "dev-A" },
    });

    // Caller MUST NOT send prefs seed when suppressFresh is true.
    expect(suppressFresh).toBe(true);
  });

  it("returns false (run fresh) on fresh connect — prefs seed fires exactly once", () => {
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    const { buffer, epoch, resumed } = store.acquire("dev-A"); // fresh, no prior buffer

    const { ws } = makeWs();
    const suppressFresh = handleResumeOrFresh({
      ws,
      sessionId: "sess-prefs-fresh",
      deviceId: "dev-A",
      buffer,
      epoch,
      resumed,
      resumeParams: null,
    });

    // Caller MUST send prefs seed once when suppressFresh is false.
    expect(suppressFresh).toBe(false);
  });

  it("returns false on epoch mismatch — prefs seed fires exactly once (no replay)", () => {
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    const first = store.acquire("dev-A");
    journalJsonFrames(first.buffer, first.epoch, 2);
    store.release("dev-A");

    // Stale epoch → fresh buffer, recovered:false.
    const second = store.acquire("dev-A", { resumeEpoch: 999 });
    const { ws } = makeWs();
    const suppressFresh = handleResumeOrFresh({
      ws,
      sessionId: "sess-prefs-mismatch",
      deviceId: "dev-A",
      buffer: second.buffer,
      epoch: second.epoch,
      resumed: second.resumed,
      resumeParams: { epoch: 999, lastSeq: 1, deviceId: "dev-A" },
    });

    // Caller MUST send prefs seed once when suppressFresh is false.
    expect(suppressFresh).toBe(false);
  });
});
