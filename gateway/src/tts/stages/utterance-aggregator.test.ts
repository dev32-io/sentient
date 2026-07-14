import { describe, expect, it } from "vitest";
import { FLUSH_SIGNAL, type TtsChunk } from "./stage-types.ts";
import { type UtteranceAggregatorOptions, aggregateUtterances } from "./utterance-aggregator.ts";

const DEFAULT_OPTS: UtteranceAggregatorOptions = { maxBlockChars: 600 };

function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

async function collect(source: TtsChunk[], opts: UtteranceAggregatorOptions, signal = neverAbort()): Promise<string[]> {
  async function* iter() {
    for (const s of source) yield s;
  }
  const out: string[] = [];
  for await (const block of aggregateUtterances(iter(), opts, signal)) out.push(block);
  return out;
}

describe("aggregateUtterances", () => {
  it("does NOT split on sentence terminators within a paragraph", async () => {
    const out = await collect(["The fox jumps. The dog sleeps! Does the cat care? Probably not."], DEFAULT_OPTS);
    expect(out).toEqual(["The fox jumps. The dog sleeps! Does the cat care? Probably not."]);
  });

  it("does NOT split on Chinese terminators within a paragraph", async () => {
    const out = await collect(["你好。今天天气不错！明天呢？"], DEFAULT_OPTS);
    expect(out).toEqual(["你好。今天天气不错！明天呢？"]);
  });

  it("splits on newline (paragraph break)", async () => {
    const out = await collect(["First paragraph here.\nSecond paragraph here."], DEFAULT_OPTS);
    expect(out).toEqual(["First paragraph here.", "Second paragraph here."]);
  });

  it("collapses consecutive newlines into a single boundary", async () => {
    const out = await collect(["First.\n\nSecond.\n\n\nThird."], DEFAULT_OPTS);
    expect(out).toEqual(["First.", "Second.", "Third."]);
  });

  it("splits across chunks that straddle a newline", async () => {
    const out = await collect(["Paragraph one is", " complete.\nParagraph two ", "follows."], DEFAULT_OPTS);
    expect(out).toEqual(["Paragraph one is complete.", "Paragraph two follows."]);
  });

  it("flushes the remaining buffer on stream end", async () => {
    const out = await collect(["Sure."], DEFAULT_OPTS);
    expect(out).toEqual(["Sure."]);
  });

  it("does not flush buffer on abort", async () => {
    const ctrl = new AbortController();
    async function* iter() {
      yield "Beginning of a thought that will not be";
      ctrl.abort();
      yield " finished.";
    }
    const out: string[] = [];
    for await (const block of aggregateUtterances(iter(), DEFAULT_OPTS, ctrl.signal)) out.push(block);
    expect(out).toEqual([]);
  });

  it("force-flushes at maxBlockChars on a word boundary when no newline hits", async () => {
    const longText = "word ".repeat(200).trim(); // ~1000 chars, no newlines
    const out = await collect([longText], { maxBlockChars: 150 });
    expect(out.length).toBeGreaterThan(1);
    for (let i = 0; i < out.length - 1; i++) {
      const block = out[i] ?? "";
      expect(block.length).toBeLessThanOrEqual(150);
      expect(block.endsWith("word")).toBe(true);
    }
  });

  it("keeps multi-sentence paragraphs intact so the TTS provider's prosody spans them", async () => {
    const paragraph =
      "I'll tell you a joke. Why did the scarecrow win an award? Because he was outstanding in his field! Ha ha.";
    const out = await collect([paragraph], DEFAULT_OPTS);
    expect(out).toEqual([paragraph]);
  });

  it("flushes buffered text on FLUSH_SIGNAL — pre-tool-call acknowledgement", async () => {
    const out = await collect(["Let me check.", FLUSH_SIGNAL, " Lights are on now."], DEFAULT_OPTS);
    expect(out).toEqual(["Let me check.", "Lights are on now."]);
  });

  it("FLUSH_SIGNAL on empty buffer is a no-op (no leading newline pollutes next block)", async () => {
    const out = await collect([FLUSH_SIGNAL, "After tool only."], DEFAULT_OPTS);
    expect(out).toEqual(["After tool only."]);
  });

  it("multiple consecutive FLUSH_SIGNALs flush once and stay no-op after", async () => {
    const out = await collect(["First.", FLUSH_SIGNAL, FLUSH_SIGNAL, "Second."], DEFAULT_OPTS);
    expect(out).toEqual(["First.", "Second."]);
  });
});
