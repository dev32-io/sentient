import { describe, expect, it } from "bun:test";
import { createOpenAIProvider } from "../provider/openai-provider.js";
import type {
  ProviderClient,
  ProviderRequest,
  ProviderStreamChunk,
  ReasoningEffort,
  TransientProviderRequest,
} from "../provider/provider-client.js";
import { type ResolvedVisionProvider, createVisionAdapter } from "./vision.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const OPTIONS = {
  deadlineMs: 50,
  maxOutputTokens: 77,
  maxOutputChars: 20,
  maxInputBytes: 32,
  maxImages: 2,
  maxQuestionChars: 100,
};

function resolved(client: ProviderClient, overrides: Partial<ResolvedVisionProvider> = {}): ResolvedVisionProvider {
  return {
    client,
    configuredProvider: "ollama-cloud",
    model: { provider: "ollama-cloud", id: "vision-model" },
    supportsVision: true,
    ...overrides,
  };
}

function provider(run: (request: TransientProviderRequest) => AsyncGenerator<ProviderStreamChunk>): ProviderClient {
  return {
    stream: run as unknown as (request: ProviderRequest) => AsyncGenerator<ProviderStreamChunk>,
  };
}

function request(signal?: AbortSignal) {
  return {
    question: "What is shown?",
    pages: [
      {
        pageRef: "att_123#page=2",
        mediaType: "image/png" as const,
        bytes: PNG,
        provenance: { seq: 9 },
      },
    ],
    ...(signal ? { signal } : {}),
  };
}

describe("vision adapter", () => {
  it("sends bounded transient images with no tools and returns opaque provenance", async () => {
    let captured: TransientProviderRequest | undefined;
    const client = provider(async function* (input) {
      captured = input;
      yield { type: "text", content: "A chart." };
      yield { type: "done", finishReason: "stop" };
    });

    const result = await createVisionAdapter(resolved(client), OPTIONS).inspect(request());

    expect(result).toEqual({
      ok: true,
      value: { text: "A chart.", provenance: [{ seq: 9 }] },
    });
    expect(captured).toMatchObject({
      tools: [],
      maxOutputTokens: 77,
      reasoningEffort: "none",
      model: "vision-model",
      messages: [
        {
          role: "user",
          content: [
            { type: "text" },
            { type: "text", text: "Page reference: att_123#page=2" },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
              },
            },
          ],
        },
      ],
    });
  });

  it("serializes configured effort while provider unset still suppresses it", async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(input) {
        bodies.push((await input.json()) as Record<string, unknown>);
        return new Response(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });
    const inspect = async (providerEffort: ReasoningEffort) => {
      const client = createOpenAIProvider(
        {
          base_url: `${server.url}v1`,
          model: "vision-model",
          max_output_tokens: 100,
          request_timeout_ms: 1_000,
          site_name: "Sentient",
          reasoning_effort: providerEffort,
        },
        "test-key",
      );
      expect(
        await createVisionAdapter(resolved(client), { ...OPTIONS, reasoningEffort: "high" }).inspect(request()),
      ).toMatchObject({ ok: true });
    };
    try {
      await inspect("none");
      await inspect("unset");
    } finally {
      server.stop(true);
    }

    expect(bodies[0]?.reasoning_effort).toBe("high");
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
  });

  it("fails closed on mismatched or unsupported configured resolution", async () => {
    const unused = provider(async function* () {});
    expect(
      await createVisionAdapter(resolved(unused, { model: { provider: "openrouter", id: "vision" } }), OPTIONS).inspect(
        request(),
      ),
    ).toEqual({ ok: false, error: { code: "provider_mismatch" } });
    expect(await createVisionAdapter(resolved(unused, { supportsVision: false }), OPTIONS).inspect(request())).toEqual({
      ok: false,
      error: { code: "vision_unsupported" },
    });
  });

  it("rejects unsupported, mislabeled, and oversized image input before provider call", async () => {
    let calls = 0;
    const unused = provider(async function* () {
      calls++;
      yield* [];
    });
    const page = request().pages[0];
    if (!page) throw new Error("missing fixture page");
    const adapter = createVisionAdapter(resolved(unused), {
      ...OPTIONS,
      maxInputBytes: 8,
    });
    expect(
      await adapter.inspect({
        ...request(),
        pages: [{ ...page, mediaType: "image/gif" as "image/png" }],
      }),
    ).toEqual({ ok: false, error: { code: "unsupported_media_type" } });
    expect(
      await createVisionAdapter(resolved(unused), OPTIONS).inspect({
        ...request(),
        pages: [{ ...page, mediaType: "image/jpeg", bytes: PNG }],
      }),
    ).toEqual({ ok: false, error: { code: "invalid_request" } });
    expect(await adapter.inspect(request())).toEqual({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(calls).toBe(0);
  });

  it("returns typed cancellation, deadline, provider, and output-bound errors", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const waitsForAbort = provider(async function* (input) {
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    expect(await createVisionAdapter(resolved(waitsForAbort), OPTIONS).inspect(request(cancelled.signal))).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(
      await createVisionAdapter(resolved(waitsForAbort), {
        ...OPTIONS,
        deadlineMs: 1,
      }).inspect(request()),
    ).toEqual({ ok: false, error: { code: "timeout" } });

    const throws = provider(async function* () {
      yield await Promise.reject(new Error("secret provider response"));
    });
    expect(await createVisionAdapter(resolved(throws), OPTIONS).inspect(request())).toEqual({
      ok: false,
      error: { code: "provider_error" },
    });

    const tooMuch = provider(async function* () {
      yield { type: "text", content: "x".repeat(21) };
    });
    expect(await createVisionAdapter(resolved(tooMuch), OPTIONS).inspect(request())).toEqual({
      ok: false,
      error: { code: "output_too_large" },
    });
  });
});
