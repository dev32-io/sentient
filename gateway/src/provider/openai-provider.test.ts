import { describe, expect, it } from "bun:test";
import { createOpenAIProvider } from "./openai-provider.js";

// A unit test asserting the interface shape against a fake `OpenAI` client
// would pin the mock, not the wire contract. This provider gets a gated
// @live test instead — runs only when a real key + model are present, skips
// cleanly in CI. The tool-call accumulation FSM (the actual load-bearing
// logic) is unit-tested directly in tool-call-accumulator.test.ts.
const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.ORCHESTRATOR_MODEL;
const live = KEY && MODEL ? describe : describe.skip;

live("[@live] openai-provider against a real endpoint", () => {
  it("streams text for a trivial prompt", async () => {
    if (!KEY || !MODEL) throw new Error("live test requires OPENROUTER_API_KEY and ORCHESTRATOR_MODEL");
    const provider = createOpenAIProvider(
      {
        base_url: "https://openrouter.ai/api/v1",
        model: MODEL,
        max_output_tokens: 64,
        request_timeout_ms: 60000,
        site_name: "Sentient",
      },
      KEY,
    );
    const ac = new AbortController();
    let text = "";
    let sawDone = false;
    for await (const chunk of provider.stream({
      messages: [{ role: "user", content: "Say the single word: pong" }],
      tools: [],
      signal: ac.signal,
    })) {
      if (chunk.type === "text") text += chunk.content;
      if (chunk.type === "done") sawDone = true;
    }
    expect(sawDone).toBe(true);
    expect(text.toLowerCase()).toContain("pong");
  });
});
