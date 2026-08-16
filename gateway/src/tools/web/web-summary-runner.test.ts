import { describe, expect, test } from "bun:test";
import type { ProviderClient, ProviderRequest, ProviderStreamChunk } from "../../provider/provider-client.js";
import { WebSummaryRunner } from "./web-summary-runner.js";

function provider(outputs: Array<string | Error>, requests: ProviderRequest[]): ProviderClient {
  return {
    async *stream(req): AsyncGenerator<ProviderStreamChunk> {
      requests.push(req);
      const next = outputs.shift();
      if (next instanceof Error) throw next;
      if (next) yield { type: "text", content: next };
      yield { type: "done", finishReason: "stop" };
    },
  };
}
const config = {
  fallbackModel: "deepseek-v4-flash:cloud",
  deadlineMs: 1000,
  maxInputChars: 500,
  maxOutputTokens: 100,
  maxAnswerChars: 100,
};
const sources = [{ id: 1, title: "One", url: "https://one.test/", passage: "Grounded fact." }];

describe("WebSummaryRunner", () => {
  test("uses a no-tools selected-model request and validates structured output", async () => {
    const requests: ProviderRequest[] = [];
    const runner = new WebSummaryRunner({
      provider: provider(['{"answer":"Fact [1]","citations":[1]}'], requests),
      config,
      prompt: "PROMPT",
      screen: (s) => s,
    });
    expect(await runner.run("question", sources, new AbortController().signal)).toEqual({
      answer: "Fact [1]",
      citations: [1],
      mode: "selected_model",
    });
    expect(requests[0]?.tools).toEqual([]);
    expect(requests[0]?.model).toBeUndefined();
    expect(requests[0]?.messages[0]?.content?.length).toBeLessThanOrEqual(config.maxInputChars);
  });

  test("falls back once to configured model, then deterministically on schema/provider failure", async () => {
    const requests: ProviderRequest[] = [];
    const fallback = new WebSummaryRunner({
      provider: provider([new Error("selected failed"), '{"answer":"Fallback [1]","citations":[1]}'], requests),
      config,
      prompt: "PROMPT",
      screen: (s) => s,
    });
    expect((await fallback.run("question", sources, new AbortController().signal)).mode).toBe("fallback_model");
    expect(requests.map((r) => r.model)).toEqual([undefined, "deepseek-v4-flash:cloud"]);

    const terminal = new WebSummaryRunner({
      provider: provider(["not json", new Error("fallback failed")], []),
      config,
      prompt: "PROMPT",
      screen: (s) => s.replace("Grounded", "Screened"),
    });
    const result = await terminal.run("question", sources, new AbortController().signal);
    expect(result.mode).toBe("deterministic");
    expect(result.answer).toContain("Screened fact");
    expect(result.citations).toEqual([1]);
  });

  test("cancellation prevents provider activity and returns no late synthesis", async () => {
    const requests: ProviderRequest[] = [];
    const controller = new AbortController();
    controller.abort();
    const runner = new WebSummaryRunner({
      provider: provider([], requests),
      config,
      prompt: "PROMPT",
      screen: (s) => s,
    });
    expect((await runner.run("question", sources, controller.signal)).answer).toBe("Web search was cancelled.");
    expect(requests).toHaveLength(0);
  });
});
