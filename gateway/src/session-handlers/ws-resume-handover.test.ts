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
import { handleResumeOrFresh } from "./ws-resume-handover.js";

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
 * Minimal session.ready payload. On recovered:true the handover sends THIS
 * object RAW (seq-less) onto the same ordered `sent` list, so a test can assert
 * session.ready lands at the right INDEX relative to stream.resumed.
 */
const READY_FRAME: Record<string, unknown> = { type: "session.ready", sessionId: "sess-new" };

/** Index of the first text frame whose JSON `type` equals `type`, or -1. */
function indexOfType(sent: SentFrame[], type: string): number {
  return sent.findIndex((f) => f.kind === "text" && typeof f.value === "string" && f.value.includes(`"${type}"`));
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
// 1) Resume-in-window
// ---------------------------------------------------------------------------

describe("handleResumeOrFresh — resume in window (recovered:true)", () => {
  it("emits recovered:true with fromSeq/toSeq and replays missed frames verbatim", () => {
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    const { buffer, epoch } = store.acquire("dev-A");
    const storedTexts = journalJsonFrames(buffer, epoch, 5); // seq 1..5

    const { ws, sent } = makeWs();
    const goLive = vi.fn();
    const suppressFresh = handleResumeOrFresh({
      ws,
      sessionId: "sess-new",
      deviceId: "dev-A",
      buffer,
      epoch,
      resumed: true,
      resumeParams: { epoch, lastSeq: 2, deviceId: "dev-A" },
      readyFrame: READY_FRAME,
      goLive,
    });

    expect(suppressFresh).toBe(true);

    const resumed = parseResumed(sent);
    expect(resumed).toMatchObject({ type: "stream.resumed", recovered: true, epoch, fromSeq: 3, toSeq: 5 });

    // ORDER (load-bearing): RAW session.ready BEFORE stream.resumed. The client's
    // handshake ready-gate only completes on session.ready; sending it first
    // (seq-less so it can't poison the resume cursor) lets the client run
    // DEFER_TO_RESUME, then PRESERVE on the resume ack.
    const readyIdx = indexOfType(sent, "session.ready");
    const resumedIdx = indexOfType(sent, "stream.resumed");
    expect(readyIdx).toBeGreaterThanOrEqual(0);
    expect(readyIdx).toBeLessThan(resumedIdx);

    // The replayed frames follow the ack, in order, byte-identical to storage.
    const replayed = sent.filter((f, i) => i > resumedIdx && f.kind === "text").map((f) => f.value as string);
    expect(replayed).toEqual([storedTexts[2], storedTexts[3], storedTexts[4]]);

    // goLive() fires AFTER the replay so the live continuation follows behind it.
    expect(goLive).toHaveBeenCalledTimes(1);
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
      readyFrame: READY_FRAME,
      goLive: vi.fn(),
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
      readyFrame: READY_FRAME,
      goLive: vi.fn(),
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
    const goLive = vi.fn();
    const suppressFresh = handleResumeOrFresh({
      ws,
      sessionId: "sess-new",
      deviceId: "dev-A",
      buffer,
      epoch: 7,
      resumed: true,
      resumeParams: { epoch: 7, lastSeq: 1, deviceId: "dev-A" }, // seq1 evicted
      readyFrame: READY_FRAME,
      goLive,
    });

    expect(suppressFresh).toBe(false);
    expect(parseResumed(sent)).toMatchObject({ type: "stream.resumed", recovered: false, epoch: 7 });
    // No replayed frames after the ack.
    expect(sent.filter((f) => f.kind === "binary")).toHaveLength(0);
    // session.ready is the CALLER's job on recovered:false — not sent here; and
    // the caller (not the handover) goes live on this path.
    expect(indexOfType(sent, "session.ready")).toBe(-1);
    expect(goLive).not.toHaveBeenCalled();
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
    const goLive = vi.fn();
    const suppressFresh = handleResumeOrFresh({
      ws,
      sessionId: "sess-new",
      deviceId: "dev-A",
      buffer: second.buffer,
      epoch: second.epoch,
      resumed: second.resumed,
      resumeParams: { epoch: 999, lastSeq: 2, deviceId: "dev-A" },
      readyFrame: READY_FRAME,
      goLive,
    });

    expect(suppressFresh).toBe(false);
    expect(parseResumed(sent)).toMatchObject({ type: "stream.resumed", recovered: false, epoch: second.epoch });
    expect(indexOfType(sent, "session.ready")).toBe(-1);
    expect(goLive).not.toHaveBeenCalled();
  });

  it("a client that never asked to resume gets NO stream.resumed ack (plain fresh)", () => {
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    const { buffer, epoch, resumed } = store.acquire("dev-A");

    const { ws, sent } = makeWs();
    const goLive = vi.fn();
    const suppressFresh = handleResumeOrFresh({
      ws,
      sessionId: "sess-new",
      deviceId: "dev-A",
      buffer,
      epoch,
      resumed,
      resumeParams: null,
      readyFrame: READY_FRAME,
      goLive,
    });

    expect(suppressFresh).toBe(false);
    expect(parseResumed(sent)).toBeNull();
    expect(indexOfType(sent, "session.ready")).toBe(-1);
    expect(goLive).not.toHaveBeenCalled();
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
// 5) Prefs seed double-send prevention + session.ready emission
//
// On recovered:true, handleResumeOrFresh sends session.ready ITSELF — RAW
// (seq-less) FIRST so the client handshake completes WITHOUT advancing the
// resume cursor past the replay window — and returns true → the caller's
// fresh-only block (which would send the prefs seed + a SECOND session.ready)
// is SUPPRESSED. The prefs frame reaches the client only via the replay window
// — exactly once. session.ready reaches it exactly once. goLive() fires after
// the replay so the live continuation follows behind it.
//
// On a fresh connect (recovered:false or no resume frame), handleResumeOrFresh
// does NOT send session.ready and returns false → the caller's fresh block
// sends session.ready (seq-stamped) + the prefs seed once, and goes live.
// ---------------------------------------------------------------------------

describe("handleResumeOrFresh — session.ready + prefs seed contract", () => {
  it("on recovered:true sends RAW session.ready FIRST (before stream.resumed), suppresses fresh, goes live", () => {
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    const { buffer, epoch } = store.acquire("dev-A");
    journalJsonFrames(buffer, epoch, 3); // seq 1..3

    const { ws, sent } = makeWs();
    const goLive = vi.fn();
    const suppressFresh = handleResumeOrFresh({
      ws,
      sessionId: "sess-prefs",
      deviceId: "dev-A",
      buffer,
      epoch,
      resumed: true,
      resumeParams: { epoch, lastSeq: 0, deviceId: "dev-A" },
      readyFrame: { type: "session.ready", sessionId: "sess-prefs" },
      goLive,
    });

    // session.ready was sent here EXACTLY once; caller then suppresses the
    // fresh block (no second session.ready, no prefs seed).
    expect(suppressFresh).toBe(true);
    // It is the FIRST frame and lands BEFORE stream.resumed (load-bearing order).
    expect(indexOfType(sent, "session.ready")).toBe(0);
    expect(indexOfType(sent, "session.ready")).toBeLessThan(indexOfType(sent, "stream.resumed"));
    // RAW: the session.ready frame carries NO seq (would poison the client cursor).
    const readyFrame = JSON.parse(sent[0]?.value as string) as Record<string, unknown>;
    expect(readyFrame.seq).toBeUndefined();
    // Live only after the replay flush.
    expect(goLive).toHaveBeenCalledTimes(1);
  });

  it("does NOT send session.ready (caller's job) on fresh connect; returns false; does not go live", () => {
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    const { buffer, epoch, resumed } = store.acquire("dev-A"); // fresh, no prior buffer

    const { ws, sent } = makeWs();
    const goLive = vi.fn();
    const suppressFresh = handleResumeOrFresh({
      ws,
      sessionId: "sess-prefs-fresh",
      deviceId: "dev-A",
      buffer,
      epoch,
      resumed,
      resumeParams: null,
      readyFrame: READY_FRAME,
      goLive,
    });

    // Caller MUST send session.ready + prefs seed + go live when suppressFresh is false.
    expect(suppressFresh).toBe(false);
    expect(indexOfType(sent, "session.ready")).toBe(-1);
    expect(goLive).not.toHaveBeenCalled();
  });

  it("does NOT send session.ready on epoch mismatch (recovered:false); returns false; does not go live", () => {
    const store = new DeviceBufferStore(REPLAY_MAX_BYTES);
    const first = store.acquire("dev-A");
    journalJsonFrames(first.buffer, first.epoch, 2);
    store.release("dev-A");

    // Stale epoch → fresh buffer, recovered:false.
    const second = store.acquire("dev-A", { resumeEpoch: 999 });
    const { ws, sent } = makeWs();
    const goLive = vi.fn();
    const suppressFresh = handleResumeOrFresh({
      ws,
      sessionId: "sess-prefs-mismatch",
      deviceId: "dev-A",
      buffer: second.buffer,
      epoch: second.epoch,
      resumed: second.resumed,
      resumeParams: { epoch: 999, lastSeq: 1, deviceId: "dev-A" },
      readyFrame: READY_FRAME,
      goLive,
    });

    // Caller MUST send session.ready + prefs seed + go live when suppressFresh is false.
    expect(suppressFresh).toBe(false);
    expect(indexOfType(sent, "session.ready")).toBe(-1);
    expect(goLive).not.toHaveBeenCalled();
  });
});
