import { describe, expect, it } from "vitest";
import { BINARY_TYPE_AUDIO, createFrameSequencer } from "./frame-sequencer.js";
import { createSessionReplayBuffer } from "./session-replay-buffer.js";

describe("FrameSequencer", () => {
  it("stamps seq+epoch on JSON, buffers it as text", () => {
    const buf = createSessionReplayBuffer({ maxBytes: 10_000 });
    const sentText: string[] = [];
    const seq = createFrameSequencer({
      epoch: 7,
      buffer: buf,
      sendText: (s) => sentText.push(s),
      sendBinary: () => {},
    });
    seq.json({ type: "message.delta", cycleId: "c1", delta: "hi" });
    const rawText = sentText[0];
    if (rawText === undefined) throw new Error("no text sent");
    const out = JSON.parse(rawText) as Record<string, unknown>;
    expect(out.seq).toBe(1);
    expect(out.epoch).toBe(7);
    expect(out.delta).toBe("hi");
    expect(buf.newestSeq).toBe(1);
    const frames = buf.since(0);
    if (!frames || frames.length === 0) throw new Error("no frames");
    expect(frames[0]?.kind).toBe("text");
  });

  it("prepends [u64 seq][type] header on binary, buffers it as binary", () => {
    const buf = createSessionReplayBuffer({ maxBytes: 10_000 });
    const sentBin: Uint8Array[] = [];
    const seq = createFrameSequencer({
      epoch: 7,
      buffer: buf,
      sendText: () => {},
      sendBinary: (b) => sentBin.push(b),
    });
    seq.binary(new Uint8Array([0xaa, 0xbb]), BINARY_TYPE_AUDIO);
    const framed = sentBin[0];
    if (framed === undefined) throw new Error("no binary sent");
    const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
    expect(Number(view.getBigUint64(0))).toBe(1); // seq
    expect(framed[8]).toBe(BINARY_TYPE_AUDIO); // type byte
    expect(framed[9]).toBe(0xaa);
    expect(framed[10]).toBe(0xbb);
    const frames = buf.since(0);
    if (!frames || frames.length === 0) throw new Error("no frames");
    expect(frames[0]?.kind).toBe("binary");
    // buffered bytes are the FULL framed bytes (for byte-identical replay)
    expect(frames[0]?.bytes.byteLength).toBe(11);
  });

  it("seq is monotonic across mixed json/binary", () => {
    const buf = createSessionReplayBuffer({ maxBytes: 10_000 });
    const seq = createFrameSequencer({
      epoch: 1,
      buffer: buf,
      sendText: () => {},
      sendBinary: () => {},
    });
    seq.json({ type: "a" });
    seq.binary(new Uint8Array([1]), BINARY_TYPE_AUDIO);
    seq.json({ type: "b" });
    expect(buf.newestSeq).toBe(3);
  });
});
