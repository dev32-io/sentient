import { describe, expect, it } from "vitest";
import type { TTSAudioChunk, TTSProvider } from "../providers/tts/tts-types.ts";
import { FLUSH_SIGNAL, type TtsChunk } from "./stages/stage-types.ts";
import { createStreamingTtsSynthesizer } from "./streaming-tts-synthesizer.ts";
import type { AudioFrame } from "./text-stream-synthesizer.ts";

// ---------------------------------------------------------------------------
// FakeTtsProvider — minimal scriptable TTSProvider. Deliberately has NO
// local-tts specifics, to prove the synthesizer is driven entirely by the
// abstract TTSProvider interface (provider-neutral core).
// ---------------------------------------------------------------------------

interface FakeCalls {
  pushed: string[];
  disposeCount: number;
  endInputCount: number;
  warmupCount: number;
}

function chunk(n: number): TTSAudioChunk {
  return { data: new Uint8Array([n]), encoding: "opus", sampleRate: 48000, isFinal: false };
}

function makeFakeProvider(chunks: TTSAudioChunk[]): { provider: TTSProvider; calls: FakeCalls } {
  const calls: FakeCalls = { pushed: [], disposeCount: 0, endInputCount: 0, warmupCount: 0 };
  const provider: TTSProvider = {
    warmup: () => {
      calls.warmupCount += 1;
    },
    ready: async () => {},
    pushText: (text: string) => {
      calls.pushed.push(text);
    },
    endInput: () => {
      calls.endInputCount += 1;
    },
    dispose: () => {
      calls.disposeCount += 1;
    },
    audioFrames: async function* (signal: AbortSignal) {
      for (const c of chunks) {
        if (signal.aborted) return;
        yield c;
      }
    },
  };
  return { provider, calls };
}

async function* textStream(items: TtsChunk[]): AsyncGenerator<TtsChunk> {
  for (const item of items) yield item;
}

async function collectFrames(iter: AsyncIterable<AudioFrame>): Promise<AudioFrame[]> {
  const out: AudioFrame[] = [];
  for await (const frame of iter) out.push(frame);
  return out;
}

describe("createStreamingTtsSynthesizer", () => {
  it("forwards raw text deltas to the provider with no aggregation", async () => {
    const { provider, calls } = makeFakeProvider([chunk(1)]);
    const synth = createStreamingTtsSynthesizer({
      sessionFactory: { createSession: async () => provider },
    });

    const frames = await collectFrames(synth.synthesize(textStream(["Hello there.\n"]), new AbortController().signal));

    expect(frames).toHaveLength(1);
    expect(calls.pushed).toEqual(["Hello there.\n"]);
  });

  it("ignores FLUSH_SIGNAL on the wire — service buffers + splits now", async () => {
    const { provider, calls } = makeFakeProvider([chunk(1)]);
    const synth = createStreamingTtsSynthesizer({
      sessionFactory: { createSession: async () => provider },
    });

    await collectFrames(
      synth.synthesize(textStream(["Let me check.", FLUSH_SIGNAL, "Lights are on."]), new AbortController().signal),
    );

    expect(calls.pushed).toEqual(["Let me check.", "Lights are on."]);
  });

  it("disposes the provider after the drain loop completes NORMALLY (dispose-after-completion contract)", async () => {
    const { provider, calls } = makeFakeProvider([chunk(1), chunk(2)]);
    const synth = createStreamingTtsSynthesizer({
      sessionFactory: { createSession: async () => provider },
    });

    const frames = await collectFrames(synth.synthesize(textStream(["Done."]), new AbortController().signal));

    expect(frames).toHaveLength(2);
    expect(calls.disposeCount).toBe(1);
  });

  it("disposes the provider on abort mid-drain", async () => {
    const ctrl = new AbortController();
    const calls: FakeCalls = { pushed: [], disposeCount: 0, endInputCount: 0, warmupCount: 0 };
    const provider: TTSProvider = {
      warmup: () => {},
      ready: async () => {},
      pushText: () => {},
      endInput: () => {},
      dispose: () => {
        calls.disposeCount += 1;
      },
      audioFrames: async function* (signal: AbortSignal) {
        yield chunk(1);
        // Hang until aborted, mimicking a live provider mid-stream. Check
        // the already-aborted case first — the consumer's abort() call can
        // land before this generator resumes past the first yield, so the
        // event may already have fired by the time we'd register a listener.
        if (signal.aborted) return;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const synth = createStreamingTtsSynthesizer({
      sessionFactory: { createSession: async () => provider },
    });

    const iter = synth.synthesize(textStream(["Hi.\n"]), ctrl.signal)[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);

    ctrl.abort();
    const second = await iter.next();

    expect(second.done).toBe(true);
    expect(calls.disposeCount).toBe(1);
  });
});
