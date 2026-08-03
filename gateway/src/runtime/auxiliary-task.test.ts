// The auxiliary-task seam (session-model spec §6) — the shared runner every
// out-of-band model call goes through: titles today, tags / follow-up
// suggestions / summarisation next. Four facts are pinned here, and each one
// exists because getting it wrong is invisible until production:
//
//   - a failure NEVER reaches the caller. The seam is fired from a turn's
//     settle continuation, which is detached: a throw there is an
//     `unhandledRejection` and Bun exits the process.
//   - the input is BOUNDED at the seam, not in each caller. A pasted document
//     in the first message otherwise rides straight into the prompt — the same
//     class as wave 1's tool-result cap.
//   - the answer is SCHEMA-VALIDATED. A model that answers in prose must fail
//     closed, not have its prose used as a title.
//   - an auxiliary call is given NO TOOLS. A model call that can act is a
//     side-effecting surface nobody mediates (spec §2.2) — the same reason
//     compaction.ts sends `tools: []`.

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { ProviderClient, ProviderRequest, ProviderStreamChunk } from "../provider/provider-client.js";
import type { AuxiliaryTaskConfig } from "./auxiliary-task.js";
import { runAuxiliaryTask } from "./auxiliary-task.js";

const TRUNCATION_LIMIT = 500;
/** The template below, with every placeholder emptied — the fixed cost that
 *  rides along with any rendered prompt. */
const TEMPLATE = "Read this:\n{{conversation}}\n{{extra}}\nAnswer with JSON only.";
const TEMPLATE_SLACK = TEMPLATE.length;
/** The template's trailing instruction. A truncation that slices the RENDERED
 *  prompt instead of the substituted VALUES would cut this off. */
const TRAILING_INSTRUCTION = "Answer with JSON only.";

function testConfig(): AuxiliaryTaskConfig {
  return {
    enabled: true,
    template_dir: "system_prompts/auxiliary",
    override_dir: "config/auxiliary",
    max_output_tokens: 200,
    input_truncation_chars: TRUNCATION_LIMIT,
    reasoning_effort: "none",
    title_word_target: 5,
    title_max_chars: 60,
  };
}

const answerSchema = z.object({ title: z.string().min(1) });

function providerYielding(chunks: ProviderStreamChunk[]): ProviderClient & { calls: ProviderRequest[] } {
  const calls: ProviderRequest[] = [];
  return {
    calls,
    async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamChunk> {
      calls.push(req);
      for (const chunk of chunks) yield chunk;
    },
  };
}

function providerAnswering(text: string): ProviderClient & { calls: ProviderRequest[] } {
  return providerYielding([
    { type: "text", content: text },
    { type: "done", finishReason: "stop" },
  ]);
}

/** Fails on the FIRST pull, the way a real provider fails: the request is
 *  built, then the HTTP round trip rejects. */
const alwaysFails: ProviderClient = {
  async *stream(): AsyncGenerator<ProviderStreamChunk> {
    yield await Promise.reject(new Error("provider exploded"));
  },
};

/** A client that throws when the stream is CONSTRUCTED, not when it is
 *  consumed — `user-model-provider.ts` resolves a per-user client on call, so
 *  this is a real shape, and it escapes any try/catch placed after the
 *  `provider.stream(...)` expression. */
const throwsOnConstruction: ProviderClient = {
  stream(): AsyncGenerator<ProviderStreamChunk> {
    throw new Error("no provider configured for this user");
  },
};

function deps(provider: ProviderClient, template: string | null = TEMPLATE) {
  return {
    provider,
    config: testConfig(),
    loadTemplate: () => template,
    signal: new AbortController().signal,
    taskName: "test-task",
    sessionId: "s_00000000000000000000000000000001",
    userId: "u_deadbeef",
  };
}

function request() {
  return {
    templatePath: "title.md",
    variables: { conversation: "hello", extra: "" },
    schema: answerSchema,
    maxOutputTokens: 200,
  };
}

/** The prompt the provider actually received — the only honest place to
 *  measure truncation, since the seam owns rendering. */
function capturedPrompt(provider: { calls: ProviderRequest[] }): string {
  const first = provider.calls[0];
  if (first === undefined) throw new Error("provider was never called");
  return first.messages.map((m) => m.content ?? "").join("");
}

describe("runAuxiliaryTask", () => {
  it("INVARIANT: an auxiliary task that fails returns null rather than throwing into the caller", async () => {
    const result = await runAuxiliaryTask(request(), deps(alwaysFails));
    expect(result).toBeNull();
  });

  it("INVARIANT: a provider that throws while the stream is being CONSTRUCTED also returns null", async () => {
    const result = await runAuxiliaryTask(request(), deps(throwsOnConstruction));
    expect(result).toBeNull();
  });

  it("INVARIANT: a long conversation slice is truncated to the configured budget", async () => {
    const provider = providerAnswering('{"title":"ok"}');
    await runAuxiliaryTask(
      { ...request(), variables: { conversation: "x".repeat(50_000), extra: "" } },
      deps(provider),
    );
    expect(capturedPrompt(provider).length).toBeLessThanOrEqual(TRUNCATION_LIMIT + TEMPLATE_SLACK);
  });

  it("shares one budget across every variable rather than granting each the full limit", async () => {
    // The tempting wrong form: truncate each value to `input_truncation_chars`
    // independently. Two oversized variables then cost 2x the budget, and N
    // callers-worth of variables cost Nx — the bound stops being a bound.
    const provider = providerAnswering('{"title":"ok"}');
    await runAuxiliaryTask(
      { ...request(), variables: { conversation: "x".repeat(50_000), extra: "y".repeat(50_000) } },
      deps(provider),
    );
    expect(capturedPrompt(provider).length).toBeLessThanOrEqual(TRUNCATION_LIMIT + TEMPLATE_SLACK);
  });

  it("truncates the substituted values, never the template's own instructions", async () => {
    // The other tempting wrong form: slice the RENDERED prompt. That bounds
    // the length just as well and silently amputates the instruction that
    // tells the model what to answer with.
    const provider = providerAnswering('{"title":"ok"}');
    await runAuxiliaryTask(
      { ...request(), variables: { conversation: "x".repeat(50_000), extra: "" } },
      deps(provider),
    );
    expect(capturedPrompt(provider)).toContain(TRAILING_INSTRUCTION);
  });

  it("returns null when the answer does not match the schema", async () => {
    const result = await runAuxiliaryTask(request(), deps(providerAnswering("Sure! Here is a nice title.")));
    expect(result).toBeNull();
  });

  it("SECURITY: an auxiliary call is offered no tools", async () => {
    const provider = providerAnswering('{"title":"ok"}');
    await runAuxiliaryTask(request(), deps(provider));
    expect(provider.calls[0]?.tools).toEqual([]);
  });

  it("sends the configured auxiliary reasoning effort, not the loop's", async () => {
    const provider = providerAnswering('{"title":"ok"}');
    await runAuxiliaryTask(request(), deps(provider));
    expect(provider.calls[0]?.reasoningEffort).toBe("none");
  });

  it("returns null when neither the operator override nor the baked-in template exists", async () => {
    const result = await runAuxiliaryTask(request(), deps(providerAnswering('{"title":"ok"}'), null));
    expect(result).toBeNull();
  });

  it("parses a fenced JSON answer, which is what models actually emit", async () => {
    const result = await runAuxiliaryTask(
      request(),
      deps(providerAnswering('```json\n{"title":"Kitchen lights"}\n```')),
    );
    expect(result).toEqual({ title: "Kitchen lights" });
  });
});
