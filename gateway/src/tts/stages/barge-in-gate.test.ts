import { describe, expect, it } from "vitest";
import { createBargeInGate } from "./barge-in-gate.ts";

async function pipe(chunks: string[], bargedInWhen: (index: number) => boolean): Promise<string> {
  const ctrl = new AbortController();
  let i = 0;
  const gate = createBargeInGate({ bargedIn: () => bargedInWhen(i) });
  async function* gen() {
    for (const c of chunks) {
      yield c;
      i++;
    }
  }
  const out: string[] = [];
  for await (const chunk of gate(gen(), ctrl.signal)) {
    if (typeof chunk === "string") out.push(chunk);
  }
  return out.join("");
}

describe("BargeInGate", () => {
  it("passes through when never barged in", async () => {
    const out = await pipe(["hi ", "there"], () => false);
    expect(out).toBe("hi there");
  });

  it("drops chunks when barged in", async () => {
    const out = await pipe(["hi ", "there", "!"], () => true);
    expect(out).toBe("");
  });

  it("partial drop — barges in mid-stream", async () => {
    const out = await pipe(["first ", "second ", "third"], (i) => i >= 1);
    expect(out).toBe("first ");
  });
});
