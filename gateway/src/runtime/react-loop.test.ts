import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import type { OrchestratorConfig } from "@sentient/config";
import type { Capability } from "../access/capability.js";
import type { ProviderClient, ProviderRequest, ProviderStreamChunk } from "../provider/provider-client.js";
import { projectForClient } from "../store/client-projection.js";
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
    pendingId: null,
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
    setBackgroundCompletionSink: () => {},
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

    expect(result).toMatchObject({ completed: true, iterations: 1 });
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

    expect(result).toMatchObject({ completed: true, iterations: 2 });
    expect(provider.calls).toHaveLength(2);
    expect(broker.dispatchCalls).toEqual([
      { toolCallId: "call_1", name: "get_weather", args: { city: "NYC" }, signal: expect.anything(), turnId: "turn-2" },
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

    // argsPreview is populated from the provider's raw argument JSON so the
    // client's tool tile can show what the call actually did. It is truncated
    // upstream; the emitter sends it verbatim.
    expect(toolUpdates).toEqual([
      { toolCallId: "call_1", toolName: "get_weather", status: "running", argsPreview: '{"city":"NYC"}' },
      { toolCallId: "call_1", toolName: "get_weather", status: "done", argsPreview: '{"city":"NYC"}' },
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

    expect(result).toMatchObject({ completed: true, iterations: 3 });
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
    expect(result).toMatchObject({ completed: false, iterations: 1 });
    expect(store.readSession(sessionId)).toHaveLength(beforeCount); // no assistant entry committed

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Case 5: live/replay convergence — narration that precedes a tool call in
// the same iteration must survive replay (spec §3.2 Invariant B), not just
// stream live via onTextDelta. Regression test for the bug where
// `outcome.text` was discarded whenever an iteration ALSO produced tool
// calls (not forceFinal): the store never got the narration, so a page
// reload dropped text the live client already showed.
// ---------------------------------------------------------------------------

describe("runTurn — narration + tool call in the same iteration (convergence)", () => {
  it("commits the narration as its own assistant entry and keeps the tool round-trip intact", async () => {
    const store = openSessionStore(cap);
    const sessionId = "narration-convergence";
    seedUserMessage(store, sessionId, "what is the weather in NYC?");

    const provider = fakeProvider(async function* (callIndex) {
      if (callIndex === 1) {
        yield { type: "text", content: "Let me check." };
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

    const deltas: string[] = [];
    const result = await runTurn(
      {
        provider,
        broker,
        store,
        systemPrompt: "you are a test assistant",
        sessionId,
        config: loopConfig(10),
        onTextDelta: (_turnId, text) => deltas.push(text),
        onToolUpdate: () => {},
      },
      { turnId: "turn-5", signal: new AbortController().signal },
    );

    expect(result).toMatchObject({ completed: true, iterations: 2 });
    // The narration streamed live, same as before the fix (deltas span both
    // iterations of this turn: narration, then the terminal reply).
    expect(deltas.join("")).toBe("Let me check.It is sunny.");

    // Before this fix, "Let me check." would be ABSENT here — discarded the
    // instant the loop saw toolCalls.length > 0 on a non-forceFinal iteration.
    const entries = store.readSession(sessionId);
    expect(entries.map((e) => e.kind)).toEqual(["user", "assistant", "tool_call", "tool_result", "assistant"]);
    expect(entries[1]?.text).toBe("Let me check.");
    expect(entries[entries.length - 1]?.text).toBe("It is sunny.");

    // The tool round-trip is unaffected: the narration entry sits BEFORE the
    // tool_call, not between the tool_call and its tool_result, so the
    // model's 2nd call still gets a contiguous, valid role:"tool" pairing.
    const secondCallMessages = provider.calls[1]?.messages ?? [];
    const toolMessage = secondCallMessages.find((m) => m.role === "tool");
    expect(toolMessage).toEqual({ role: "tool", content: "sunny", tool_call_id: "call_1" });

    // Replay convergence: projectForClient over the STORED entries shows the
    // same narration the live onTextDelta stream showed — proving
    // render(replay) == render(live) for this turn.
    const feed = projectForClient(store.readSession(sessionId));
    const narrationItem = feed.find((item) => item.kind === "assistant" && item.text === "Let me check.");
    expect(narrationItem).toBeDefined();
    const toolTile = feed.find((item) => item.kind === "tool");
    expect(toolTile?.text).toBe("sunny");

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Case 6 (numbered before background dispatch below, which pre-existed this
// one): an empty completion under budget exhaustion (D17, task 18) must
// never be committed as a completed turn.
//
// THE JUDGEMENT CALL. Retry-with-truncated-tool-result was considered and
// rejected: this branch fires when there are NO tool calls at all in the
// outcome (or the iteration was forced content-only), so there may be no
// "offending tool result" in this request to point at — and an unconditional
// retry against a model that JUST exhausted its budget on the SAME messages
// risks looping. Returning `completed: false` instead routes the turn
// through the EXISTING failure path (session-runtime.ts's
// `commitTurnFailure`, already exercised by every other "runTurn produced no
// answer" exit — provider error, timeout) which durably commits a
// user-visible notice and still terminates the turn with `turn.completed`,
// so the client never spins. No new UI/wire surface needed.
// ---------------------------------------------------------------------------

describe("runTurn — provider exhausts its output budget before any visible text", () => {
  it("INVARIANT: finish_reason 'length' with no text is a failed turn, never a silent success", async () => {
    const store = openSessionStore(cap);
    const sessionId = "budget-exhausted";
    seedUserMessage(store, sessionId, "give me the home assistant history");
    const beforeCount = store.readSession(sessionId).length;

    // The exact D17 shape: a reasoning model spends its whole output budget
    // on the (invisible) reasoning channel and never reaches a visible token.
    const provider = fakeProvider(async function* () {
      yield { type: "done", finishReason: "length" };
    });

    const result = await runTurn(
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
      { turnId: "turn-budget", signal: new AbortController().signal },
    );

    expect(result).toMatchObject({ completed: false, iterations: 1 });
    // No empty assistant entry committed — that record is what made D17
    // invisible in the first place (completed=true failed=false, nothing to
    // show). Leaving the store untouched here is what hands this turn to
    // session-runtime.ts's existing failure-commit path instead.
    expect(store.readSession(sessionId)).toHaveLength(beforeCount);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Case 6b: background tool dispatch (defect D7 — one request spawned TEN real
// hermes subprocesses).
//
// MECHANISM, measured rather than assumed. The reported cause was "the
// tool_result does not tell the model the work is under way". The real cause is
// upstream of the wording: the background branch appended `tool_call` + a
// `system` note and NO `tool_result`, so `projectForModel` — whose rule 3 pairs
// tool_calls with the immediately-following run of tool_results — found the call
// unreplied and DROPPED IT (`projection.dropped-unreplied-tool-calls`, 389
// occurrences in one day of the live log). The model therefore never saw its own
// dispatch at all, so it re-issued it every iteration until the loop converged.
//
// Two invariants, because either alone is insufficient: the round-trip fix keeps
// the provider messages structurally valid, and the dedupe does not depend on
// the model complying with text.
// ---------------------------------------------------------------------------

const delegateDef: ToolDefinition = {
  name: "delegateTask",
  description: "delegates to a sub-agent",
  parameters: { type: "object", properties: {} },
  category: "background",
};

describe("runTurn — background tool dispatch", () => {
  it("CONTRACT: closes the tool round-trip so the model sees its own dispatch as role:tool", async () => {
    const store = openSessionStore(cap);
    const sessionId = "bg-round-trip";
    seedUserMessage(store, sessionId, "ask hermes to summarise my week");

    const provider = fakeProvider(async function* (callIndex) {
      if (callIndex === 1) {
        yield {
          type: "tool_call",
          toolCall: {
            id: "call_bg1",
            type: "function",
            function: { name: "delegateTask", arguments: '{"agent":"hermes","taskPrompt":"summarise"}' },
          },
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text", content: "Started that for you." };
      yield { type: "done", finishReason: "stop" };
    });

    const broker = fakeBroker([delegateDef], async () => ({ taskId: "task-abc" }));

    await runTurn(
      {
        provider,
        broker,
        store,
        systemPrompt: "you are a test assistant",
        sessionId,
        config: loopConfig(10),
        onTextDelta: () => {},
        onToolUpdate: () => {},
      },
      { turnId: "turn-bg", signal: new AbortController().signal },
    );

    // The dispatch is answered in-block, so the projection keeps it.
    const secondCallMessages = provider.calls[1]?.messages ?? [];
    const toolMessage = secondCallMessages.find((m) => m.role === "tool");
    expect(toolMessage?.tool_call_id).toBe("call_bg1");
    expect(toolMessage?.content).toContain("task-abc");

    // USER-SAFETY + LENGTH. The stored tool_result is not model-only text: the
    // client projection folds it into the tool tile as `summary`, which the
    // webui renders as `resultPreview` truncated at 120 chars
    // (webui/hooks/cycle-helpers.ts). So the receipt must read as a fact about
    // the task and must NOT carry agent-directed instructions, or a family
    // member sees "do not call delegateTask again" in their transcript after a
    // reload. Enforcement of no-refire lives in the dedupe guard below, which
    // does not depend on the model reading anything.
    expect(toolMessage?.content?.toLowerCase()).not.toContain("do not call");
    expect(toolMessage?.content?.length ?? 0).toBeLessThanOrEqual(120);

    const kinds = store.readSession(sessionId).map((e) => e.kind);
    expect(kinds).toEqual(["user", "tool_call", "tool_result", "assistant"]);

    store.close();
  });

  it("INVARIANT: the same background tool call is dispatched once per turn, not per iteration", async () => {
    const store = openSessionStore(cap);
    const sessionId = "bg-dedupe";
    seedUserMessage(store, sessionId, "ask hermes to summarise my week");

    // A model that ignores the tool_result and re-asks for the identical
    // delegateTask on iterations 1..3, then answers.
    const provider = fakeProvider(async function* (callIndex) {
      if (callIndex <= 3) {
        yield {
          type: "tool_call",
          toolCall: {
            id: `call_bg${callIndex}`,
            type: "function",
            function: { name: "delegateTask", arguments: '{"agent":"hermes","taskPrompt":"summarise"}' },
          },
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text", content: "Started that for you." };
      yield { type: "done", finishReason: "stop" };
    });

    const dispatched: string[] = [];
    const broker = fakeBroker([delegateDef], async (inv) => {
      dispatched.push(inv.name);
      return { taskId: `task-${dispatched.length}` };
    });

    await runTurn(
      {
        provider,
        broker,
        store,
        systemPrompt: "you are a test assistant",
        sessionId,
        config: loopConfig(10),
        onTextDelta: () => {},
        onToolUpdate: () => {},
      },
      { turnId: "turn-bg-dedupe", signal: new AbortController().signal },
    );

    expect(dispatched).toHaveLength(1);

    // Every repeat still gets a tool_result, or the projection would drop the
    // call and we would be back to the refire we just fixed.
    const entries = store.readSession(sessionId);
    const resultIds = entries.filter((e) => e.kind === "tool_result").map((e) => e.toolCallId);
    expect(resultIds).toEqual(["call_bg1", "call_bg2", "call_bg3"]);

    store.close();
  });
});
