import { describe, expect, it } from "bun:test";
import { createSituationBlockRenderer } from "./situation-block.js";

// The block exists to carry what the transcript cannot: whether the reply is
// spoken, how many windows are listening, and what background work is still
// running. Time is deliberately NOT here — every stimulus is stamped, so the
// model derives "now" and the gap from the history itself.

const deps = (over: Partial<Parameters<typeof createSituationBlockRenderer>[0]> = {}) =>
  createSituationBlockRenderer({
    speech: { spoken: async () => true },
    surfaces: { count: () => 1 },
    work: { backgroundTaskCount: () => 0 },
    sessionId: "s1",
    ...over,
  });

describe("createSituationBlockRenderer", () => {
  it("tells the model its reply is spoken as well as shown", async () => {
    expect(await deps().render()).toContain("spoken aloud");
  });

  it("tells the model its reply is text-only when TTS is off", async () => {
    // The system prompt states flatly that every reply is spoken. That is false
    // whenever the user has TTS off, and without this line the model formats
    // for the wrong medium and never finds out.
    const block = await deps({ speech: { spoken: async () => false } }).render();
    expect(block).toContain("NOT spoken");
  });

  it("reports background work the history does not contain", async () => {
    // A dispatched delegateTask leaves no entry the model can read, so without
    // this it cannot answer "is that still going?" and may re-delegate.
    const block = await deps({ work: { backgroundTaskCount: () => 2 } }).render();
    expect(block).toContain("2 still running");
  });

  it("stays quiet about a single window and about no background work", async () => {
    const block = await deps().render();
    expect(block).not.toContain("windows:");
    expect(block).not.toContain("background tasks:");
  });

  it("renders the rest of the block when the speech read fails", async () => {
    const block = await deps({
      speech: {
        spoken: async () => {
          throw new Error("profile unreadable");
        },
      },
      work: { backgroundTaskCount: () => 1 },
    }).render();

    expect(block).not.toContain("delivery:");
    expect(block).toContain("1 still running");
  });

  it("returns null rather than an empty element when nothing is volatile", async () => {
    // An empty `<situation>` costs tokens and reads as "these facts are
    // unknown" rather than "this harness does not report them".
    const block = await deps({
      speech: {
        spoken: async () => {
          throw new Error("no audio path");
        },
      },
    }).render();

    expect(block).toBeNull();
  });

  const SPARK = "possibly relevant past memories:\n- [private · 2026-08-01] Kevin's dog is Rex";

  it("appends the spark memory section when the closure returns a block", async () => {
    const block = await deps({ memory: () => SPARK }).render();
    expect(block).toContain("spoken aloud"); // volatile lines still there
    expect(block).toContain("possibly relevant past memories:");
    expect(block).toContain("Kevin's dog is Rex");
  });

  it("omits the memory section when the closure returns an empty block", async () => {
    // A withheld spark ("") must add nothing — no dangling header, no blank tail.
    const block = await deps({ memory: () => "" }).render();
    expect(block).not.toContain("possibly relevant past memories:");
  });

  it("omits the memory section when the closure returns null", async () => {
    const block = await deps({ memory: () => null }).render();
    expect(block).not.toContain("possibly relevant past memories:");
  });

  it("renders the memory section even when nothing volatile is worth saying", async () => {
    // Spark alone is enough to render — it is not gated on the volatile lines.
    const block = await deps({
      speech: {
        spoken: async () => {
          throw new Error("no audio path");
        },
      },
      memory: () => SPARK,
    }).render();
    expect(block).not.toBeNull();
    expect(block).not.toContain("<situation>");
    expect(block).toContain("possibly relevant past memories:");
  });
});
