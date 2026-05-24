import { describe, expect, it } from "vitest";
import { runTtsPipeline } from "./pipeline.js";
import type { AudioFrame, TextStreamSynthesizer } from "./text-stream-synthesizer.js";

function fakeSynth(_frameCount: number): TextStreamSynthesizer {
  return {
    synthesize(input: AsyncIterable<string>, signal: AbortSignal): AsyncIterable<AudioFrame> {
      return (async function* () {
        for await (const _ of input) {
          if (signal.aborted) return;
          const frame: AudioFrame = {
            data: new Uint8Array([1, 2, 3]),
            encoding: "pcm",
            sampleRate: 24000,
          };
          yield frame;
        }
      })();
    },
  };
}

function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

describe("runTtsPipeline", () => {
  it("processes plain text through stripping to audio frames", async () => {
    const synth = fakeSynth(10);
    async function* input() {
      yield "Hello world.";
    }

    const run = runTtsPipeline(
      input(),
      { bargedIn: () => false },
      {
        synthesizer: synth,
        emotionTaggerDeps: null,
        aggregator: { maxBlockChars: 600 },
        markdownStripping: true,
        emojiStripping: true,
      },
      "c1",
      neverAbort(),
    );

    await run.done;
  });

  it("drops all text when bargedIn is true", async () => {
    let synthReceivedChunks = 0;
    const synth: TextStreamSynthesizer = {
      synthesize(input: AsyncIterable<string>, signal: AbortSignal): AsyncIterable<AudioFrame> {
        // biome-ignore lint/correctness/useYield: test double consumes input but doesn't yield frames
        return (async function* () {
          for await (const _ of input) {
            if (signal.aborted) return;
            synthReceivedChunks++;
          }
        })();
      },
    };

    async function* input() {
      yield "chunk 1 ";
      yield "chunk 2";
    }

    const run = runTtsPipeline(
      input(),
      { bargedIn: () => true },
      {
        synthesizer: synth,
        emotionTaggerDeps: null,
        aggregator: { maxBlockChars: 600 },
        markdownStripping: false,
        emojiStripping: false,
      },
      "c2",
      neverAbort(),
    );

    await run.done;
    expect(synthReceivedChunks).toBe(0);
  });

  it("strips markdown when enabled", async () => {
    const received: string[] = [];
    const synth: TextStreamSynthesizer = {
      synthesize(input: AsyncIterable<string>, signal: AbortSignal): AsyncIterable<AudioFrame> {
        // biome-ignore lint/correctness/useYield: test double consumes input but doesn't yield frames
        return (async function* () {
          for await (const chunk of input) {
            if (signal.aborted) return;
            received.push(chunk);
          }
        })();
      },
    };

    async function* input() {
      yield "**bold text** here.";
    }

    const run = runTtsPipeline(
      input(),
      { bargedIn: () => false },
      {
        synthesizer: synth,
        emotionTaggerDeps: null,
        aggregator: { maxBlockChars: 600 },
        markdownStripping: true,
        emojiStripping: false,
      },
      "c3",
      neverAbort(),
    );

    await run.done;
    const joined = received.join("");
    expect(joined).not.toContain("**");
    expect(joined).toContain("bold text");
  });
});
