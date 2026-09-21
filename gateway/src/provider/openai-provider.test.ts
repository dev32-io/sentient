import { describe, expect, it } from "bun:test";
import { ProviderFailure, createOpenAIProvider } from "./openai-provider.js";
import { type ProviderRequest, type TransientProviderRequest, streamTransient } from "./provider-client.js";

const CONFIG = {
  model: "test-model",
  max_output_tokens: 64,
  request_timeout_ms: 1_000,
  site_name: "Sentient",
  reasoning_effort: "none" as const,
};

async function captureRequest(
  messages: ProviderRequest["messages"] | TransientProviderRequest["messages"],
  transient = false,
) {
  let body: unknown;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      body = await request.json();
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  try {
    const provider = createOpenAIProvider({ ...CONFIG, base_url: `${server.url}v1` }, "test-key");
    const request = {
      messages,
      tools: [],
      signal: new AbortController().signal,
    };
    const chunks = transient
      ? streamTransient(provider, request as TransientProviderRequest)
      : provider.stream(request as ProviderRequest);
    for await (const _ of chunks) {
      // drain
    }
    return body;
  } finally {
    server.stop(true);
  }
}

async function rejectedBy(provider: ReturnType<typeof createOpenAIProvider>, signal = new AbortController().signal) {
  try {
    for await (const _ of provider.stream({ messages: [{ role: "user", content: "safe" }], tools: [], signal })) {
      // drain
    }
    return null;
  } catch (err) {
    return err;
  }
}

describe("openai-provider safe failures", () => {
  it("normalizes initial HTTP failures without retaining provider content", async () => {
    const secret = ["VISION", "SENTINEL", "9xQ"].join("_");
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          { error: { message: `invalid data:image/png;base64,${secret}`, api_key: `sk-${secret}` } },
          { status: 400 },
        ),
    });
    try {
      const err = await rejectedBy(createOpenAIProvider({ ...CONFIG, base_url: `${server.url}v1` }, "test-key"));
      expect(err).toBeInstanceOf(ProviderFailure);
      expect(err).toMatchObject({ kind: "http", status: 400 });
      const safe = JSON.stringify(err);
      expect(safe).not.toContain(secret);
      expect(safe).not.toContain("data:image");
      expect(safe).not.toContain("base64");
      expect(safe).not.toContain("api_key");
    } finally {
      server.stop(true);
    }
  });

  it("normalizes stream iteration failures and keeps cancellation silent", async () => {
    const secret = ["STREAM", "SENTINEL", "7yR"].join("_");
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        requests++;
        return new Response(`data: {"choices":[${secret}]}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      const provider = createOpenAIProvider({ ...CONFIG, base_url: `${server.url}v1` }, "test-key");
      const err = await rejectedBy(provider);
      expect(err).toBeInstanceOf(ProviderFailure);
      expect(err).toMatchObject({ kind: "unknown" });
      expect(JSON.stringify(err)).not.toContain(secret);

      const controller = new AbortController();
      controller.abort();
      expect(await rejectedBy(provider, controller.signal)).toBeNull();
      expect(requests).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});

describe("openai-provider serialization", () => {
  it("keeps text-only request payload unchanged", async () => {
    expect(await captureRequest([{ role: "user", content: "hello" }])).toEqual({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 64,
      reasoning_effort: "none",
    });
  });

  it("serializes transient multimodal content parts", async () => {
    const content = [
      { type: "text" as const, text: "What is shown?" },
      {
        type: "image_url" as const,
        image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
      },
    ];
    expect(await captureRequest([{ role: "user", content }], true)).toEqual({
      model: "test-model",
      messages: [{ role: "user", content }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 64,
      reasoning_effort: "none",
    });
  });
});

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
        reasoning_effort: "low",
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
