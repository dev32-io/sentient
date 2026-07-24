import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import type { OrchestratorConfig } from "@sentient/config";
import type { Capability } from "../access/capability.js";
import type { ProviderClient, ProviderRequest, ProviderStreamChunk } from "../provider/provider-client.js";
import type { NewSessionEntry } from "../store/entry-types.js";
import { openSessionStore } from "../store/session-store.js";
import type { BackgroundRegistry } from "../tools/background-registry.js";
import type { ToolBroker } from "../tools/tool-broker.js";
import type { ToolDefinition, ToolInvocation, ToolResult } from "../tools/tool-types.js";
import type { ToolUpdate } from "./react-loop.js";
import { runTurn } from "./react-loop.js";

// ---------------------------------------------------------------------------
// Fixtures — a real on-disk store (matches session-store.test.ts's own
// precedent: a plain Capability object over a scratch /tmp root is simpler
// than routing through AccessManager for a unit test) + small hand-rolled
// fakes for ProviderClient / ToolBroker. The brief steers away from bending
// `createMockLLMProvider` (shared/testing) to the real `ProviderStreamChunk`
// shape (it lacks the "done" variant) — an inline fake yielding the real
// shape directly is clearer than adapting it.
// ---------------------------------------------------------------------------

const ROOT = "/tmp/sentient-react-loop-test";
mkdirSync(`${ROOT}/u_bbbbbbbb`, { recursive: true });

const cap: Capability = Object.freeze({
  ownerUserId: "u_bbbbbbbb",
  resource: "session-store",
  rootPath: `${ROOT}/u_bbbbbbbb`,
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const loopConfig = (maxIterations: number): OrchestratorConfig["loop"] => ({ max_iterations: maxIterations });

function seedUserMessage(store: ReturnType<typeof openSessionStore>, sessionId: string, text: string): void {
  const entry: NewSessionEntry = {
    sessionId,
    turnId: "seed-turn",
    kind: "user",
    createdAt: Date.now(),
    text,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
  };
  store.append(entry);
}

interface FakeProvider extends ProviderClient {
  calls: ProviderRequest[];
}

function fakeProvider(
  behavior: (callIndex: number, req: ProviderRequest) => AsyncGenerator<ProviderStreamChunk>,
): FakeProvider {
  const calls: ProviderRequest[] = [];
  return {
    calls,
    stream(req) {
      calls.push(req);
      return behavior(calls.length, req);
    },
  };
}

interface FakeBroker extends ToolBroker {
  dispatchCalls: ToolInvocation[];
}

function fakeBroker(
  defs: ToolDefinition[],
  dispatch: (inv: ToolInvocation) => Promise<ToolResult | { taskId: string }>,
): FakeBroker {
  const dispatchCalls: ToolInvocation[] = [];
  const background: BackgroundRegistry = {
    count: () => 0,
    register: () => {},
    complete: () => {},
    cancelAll: () => {},
  };
  return {
    dispatchCalls,
    definitions: () => defs,
    async dispatch(inv) {
      dispatchCalls.push(inv);
      return dispatch(inv);
    },
    background,
  };
}

function noopBroker(): FakeBroker {
  return fakeBroker([], async () => {
    throw new Error("dispatch should never be called for a text-only response");
  });
}

// ---------------------------------------------------------------------------
// Case 1: text-only response — one iteration, one assistant entry.
// ---------------------------------------------------------------------------

describe("runTurn — text-only response", () => {
  it("appends one assistant entry, forwards deltas via onTextDelta, ends in 1 iteration", async () => {
    const store = openSessionStore(cap);
    const sessionId = "text-only";
    seedUserMessage(store, sessionId, "hello there");

    const provider = fakeProvider(async function* () {
      yield { type: "text", content: "Hello" };
      yield { type: "text", content: ", world" };
      yield { type: "done", finishReason: "stop" };
    });

    const deltas: string[] = [];
    const result = await runTurn(
      {
        provider,
        broker: noopBroker(),
        store,
        systemPrompt: "you are a test assistant",
        sessionId,
        config: loopConfig(10),
        onTextDelta: (_turnId, text) => deltas.push(text),
        onToolUpdate: () => {},
      },
      { turnId: "turn-1", signal: new AbortController().signal },
    );

    expect(result).toEqual({ completed: true, iterations: 1 });
    expect(deltas.join("")).toBe("Hello, world");
    expect(provider.calls).toHaveLength(1);

    const entries = store.readSession(sessionId);
    expect(entries).toHaveLength(2); // seeded user + committed assistant
    const last = entries[entries.length - 1];
    expect(last?.kind).toBe("assistant");
    expect(last?.text).toBe("Hello, world");

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Case 2: one tool call — full round-trip, model sees its own tool result.
// ---------------------------------------------------------------------------

describe("runTurn — one tool call", () => {
  it("dispatches, appends tool_call+tool_result, and the 2nd call's messages include role:tool (2 iterations)", async () => {
    const store = openSessionStore(cap);
    const sessionId = "tool-round-trip";
    seedUserMessage(store, sessionId, "what is the weather in NYC?");

    const provider = fakeProvider(async function* (callIndex) {
      if (callIndex === 1) {
        yield {
          type: "tool_call",
          toolCall: {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"NYC"}' },
          },
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text", content: "It is sunny." };
      yield { type: "done", finishReason: "stop" };
    });

    const weatherDef: ToolDefinition = {
      name: "get_weather",
      description: "gets the weather",
      parameters: { type: "object", properties: {} },
      category: "foreground",
    };
    const broker = fakeBroker([weatherDef], async () => ({ content: "sunny", isError: false }));

    const toolUpdates: ToolUpdate[] = [];
    const result = await runTurn(
      {
        provider,
        broker,
        store,
        systemPrompt: "you are a test assistant",
        sessionId,
        config: loopConfig(10),
        onTextDelta: () => {},
        onToolUpdate: (_turnId, u) => toolUpdates.push(u),
      },
      { turnId: "turn-2", signal: new AbortController().signal },
    );

    expect(result).toEqual({ completed: true, iterations: 2 });
    expect(provider.calls).toHaveLength(2);
    expect(broker.dispatchCalls).toEqual([
      { toolCallId: "call_1", name: "get_weather", args: { city: "NYC" }, signal: expect.anything() },
    ]);

    // The round-trip: the SECOND provider call's messages must include the
    // tool's own result as a role:"tool" message — this is what stops the
    // model from re-issuing the same call.
    const secondCallMessages = provider.calls[1]?.messages ?? [];
    const toolMessage = secondCallMessages.find((m) => m.role === "tool");
    expect(toolMessage).toEqual({ role: "tool", content: "sunny", tool_call_id: "call_1" });

    const entries = store.readSession(sessionId);
    expect(entries.map((e) => e.kind)).toEqual(["user", "tool_call", "tool_result", "assistant"]);
    expect(entries[entries.length - 1]?.text).toBe("It is sunny.");

    expect(toolUpdates).toEqual([
      { toolCallId: "call_1", toolName: "get_weather", status: "running" },
      { toolCallId: "call_1", toolName: "get_weather", status: "done" },
    ]);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Case 3: runaway tool-calling model — stops at max_iterations, still
// commits a final content entry (forceFinal).
// ---------------------------------------------------------------------------

describe("runTurn — runaway tool-calling model", () => {
  it("forces a content-only final iteration at max_iterations instead of silence", async () => {
    const store = openSessionStore(cap);
    const sessionId = "runaway";
    seedUserMessage(store, sessionId, "do something complicated");

    const provider = fakeProvider(async function* (callIndex, req) {
      if (req.tools.length === 0) {
        // forceFinal iteration: no tools offered, so a real provider could
        // never emit a tool_call here either.
        yield { type: "text", content: "Out of turns." };
        yield { type: "done", finishReason: "stop" };
        return;
      }
      yield {
        type: "tool_call",
        toolCall: { id: `call_${callIndex}`, type: "function", function: { name: "noop_tool", arguments: "{}" } },
      };
      yield { type: "done", finishReason: "tool_calls" };
    });

    const noopDef: ToolDefinition = {
      name: "noop_tool",
      description: "does nothing",
      parameters: { type: "object", properties: {} },
      category: "foreground",
    };
    const broker = fakeBroker([noopDef], async () => ({ content: "ok", isError: false }));

    const result = await runTurn(
      {
        provider,
        broker,
        store,
        systemPrompt: "you are a test assistant",
        sessionId,
        config: loopConfig(3),
        onTextDelta: () => {},
        onToolUpdate: () => {},
      },
      { turnId: "turn-3", signal: new AbortController().signal },
    );

    expect(result).toEqual({ completed: true, iterations: 3 });
    expect(provider.calls).toHaveLength(3);
    // The 3rd (forced-final) call must have been offered NO tools.
    expect(provider.calls[2]?.tools).toEqual([]);

    const entries = store.readSession(sessionId);
    expect(entries.map((e) => e.kind)).toEqual([
      "user",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "assistant",
    ]);
    const last = entries[entries.length - 1];
    expect(last?.kind).toBe("assistant");
    expect(last?.text).toBe("Out of turns.");

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Case 4: abort mid-stream — stops without throwing, appends nothing.
// ---------------------------------------------------------------------------

describe("runTurn — abort mid-stream", () => {
  it("stops cleanly without throwing and appends no further entries", async () => {
    const store = openSessionStore(cap);
    const sessionId = "aborted";
    seedUserMessage(store, sessionId, "tell me a long story");
    const beforeCount = store.readSession(sessionId).length;

    const provider = fakeProvider(async function* (_callIndex, req) {
      yield { type: "text", content: "Once upon a time" };
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      if (req.signal.aborted) return; // real providers don't throw on abort; neither does this fake
      yield { type: "text", content: " ...the end." };
      yield { type: "done", finishReason: "stop" };
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1);

    let threw = false;
    let result: { completed: boolean; iterations: number } | undefined;
    try {
      result = await runTurn(
        {
          provider,
          broker: noopBroker(),
          store,
          systemPrompt: "you are a test assistant",
          sessionId,
          config: loopConfig(10),
          onTextDelta: () => {},
          onToolUpdate: () => {},
        },
        { turnId: "turn-4", signal: controller.signal },
      );
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).toEqual({ completed: false, iterations: 1 });
    expect(store.readSession(sessionId)).toHaveLength(beforeCount); // no assistant entry committed

    store.close();
  });
});
