import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { attachmentsConfigSchema } from "@sentient/config";
import type { Capability } from "../access/capability.js";
import { createGatewayLogger } from "../logging/logger.js";
import type { ProviderClient, ProviderRequest, ProviderStreamChunk } from "../provider/provider-client.js";
import { projectForClient } from "../store/client-projection.js";
import type { NewSessionEntry, SessionEntry } from "../store/entry-types.js";
import { type SessionStore, openSessionStore } from "../store/session-store.js";
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
  role: "adult",
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const NORMALIZED_PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
);

function normalizedImageResponse() {
  return {
    requestId: "r",
    status: 200,
    headers: {
      "X-Sentient-Visual-Metadata": JSON.stringify({
        source: {
          kind: "image",
          mediaType: "image/png",
          sizeBytes: 9,
          originalAvailable: true,
          width: 1,
          height: 1,
          storedWidth: 1,
          storedHeight: 1,
        },
        view: {
          kind: "overview",
          width: 1,
          height: 1,
          sourceWidth: 1,
          sourceHeight: 1,
          downsampled: false,
          partialCoverage: false,
        },
      }),
    },
    contentType: "image/png" as const,
    body: NORMALIZED_PNG,
  };
}

function seedUserMessage(store: ReturnType<typeof openSessionStore>, sessionId: string, text: string): void {
  const entry: NewSessionEntry = {
    sessionId,
    turnId: "seed-turn",
    replyId: null,
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
    newestStartedAtMs: () => null,
    register: () => {},
    complete: () => {},
  };
  return {
    dispatchCalls,
    ownerUserId: cap.ownerUserId,
    foregroundInFlight: 0,
    ready: async () => {},
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
// Case 0: the tool vocabulary is resolved BEFORE the first provider call.
// ---------------------------------------------------------------------------

describe("runTurn — tool vocabulary", () => {
  it("INVARIANT: waits for the broker before sending the first request", async () => {
    // Listing MCP tools is I/O and lands ~100ms after a session binds, while
    // the first turn of a fresh session starts in the SAME TICK as
    // `session.configure` (which carries the first message on mobile). Reading
    // `definitions()` without awaiting `ready()` therefore sent the model a
    // vocabulary of one — the background `delegateTask` — and a model holding
    // exactly one tool uses it. What looked like eagerness to delegate was an
    // empty tool list.
    const store = openSessionStore(cap);
    const sessionId = "vocabulary-race";
    seedUserMessage(store, sessionId, "what is the news today");

    const mcpTool: ToolDefinition = {
      name: "search_web",
      description: "search the web",
      parameters: { type: "object", properties: {} },
      category: "foreground",
      tier: "read",
    };
    const backgroundTool: ToolDefinition = {
      name: "delegateTask",
      description: "delegate",
      parameters: { type: "object", properties: {} },
      category: "background",
      tier: "confirm",
    };

    // Mirrors the real broker: `definitions()` reports only what has resolved
    // so far, and `ready()` is what makes the rest of it appear.
    let resolved = [backgroundTool];
    const broker = fakeBroker([], async () => {
      throw new Error("dispatch should never be called");
    });
    broker.ready = async () => {
      await Promise.resolve();
      resolved = [mcpTool, backgroundTool];
    };
    broker.definitions = () => resolved;

    const provider = fakeProvider(async function* () {
      yield { type: "text", content: "let me look" };
      yield { type: "done", finishReason: "stop" };
    });

    await runTurn(
      {
        provider,
        broker,
        store,
        timeZone: { zone: () => "UTC" },
        systemPrompt: "you are a test assistant",
        sessionId,
        requestTimeoutMs: 120000,
        onTextDelta: () => {},
        onToolUpdate: () => {},
      },
      { turnId: "turn-1", signal: new AbortController().signal },
    );

    expect(provider.calls[0]?.tools.map((t) => t.function.name).sort()).toEqual(["delegateTask", "search_web"]);
  });
});

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
        timeZone: { zone: () => "UTC" },
        systemPrompt: "you are a test assistant",
        sessionId,
        requestTimeoutMs: 120000,
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
  it("logs malformed tool arguments as bounded metadata only", async () => {
    const logs: string[] = [];
    await createGatewayLogger({ testSink: (line) => logs.push(line), logLevel: "debug" });
    const secret = ["TOOL", "SENTINEL", "4zP"].join("_");
    const malformed = `{${secret}`;
    const nonObject = JSON.stringify(`data:image/png;base64,${secret}`);
    const store = openSessionStore(cap);
    const sessionId = "tool-args-safe-log";
    seedUserMessage(store, sessionId, "safe");
    const provider = fakeProvider(async function* (call) {
      if (call === 1) {
        yield {
          type: "tool_call",
          toolCall: { id: "bad-json", type: "function", function: { name: "safe-tool", arguments: malformed } },
        };
        yield {
          type: "tool_call",
          toolCall: { id: "not-object", type: "function", function: { name: "safe-tool", arguments: nonObject } },
        };
      } else {
        yield { type: "text", content: "done" };
      }
      yield { type: "done", finishReason: call === 1 ? "tool_calls" : "stop" };
    });

    await runTurn(
      {
        provider,
        broker: fakeBroker(
          [{ name: "safe-tool", description: "safe", parameters: {}, category: "foreground", tier: "read" }],
          async () => ({ content: "ok", isError: false }),
        ),
        store,
        timeZone: { zone: () => "UTC" },
        systemPrompt: "system",
        sessionId,
        requestTimeoutMs: 1000,
        onTextDelta: () => {},
        onToolUpdate: () => {},
      },
      { turnId: "safe-log-turn", signal: new AbortController().signal },
    );

    const output = logs.join("\n");
    expect(output).toContain("react-loop.tool-args.parse-failed");
    expect(output).toContain('reason="invalid_json"');
    expect(output).toContain("react-loop.tool-args.not-an-object");
    expect(output).toContain('reason="not_object"');
    expect(output).toContain("rawLength=");
    expect(output).toContain('toolCallId="bad-json"');
    expect(output).not.toContain(secret);
    expect(output).not.toContain("data:image");
    expect(output).not.toContain("base64");
    store.close();
  });

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
      tier: "read",
    };
    const broker = fakeBroker([weatherDef], async () => ({ content: "sunny", isError: false }));

    const toolUpdates: ToolUpdate[] = [];
    const result = await runTurn(
      {
        provider,
        broker,
        store,
        timeZone: { zone: () => "UTC" },
        systemPrompt: "you are a test assistant",
        sessionId,
        requestTimeoutMs: 120000,
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
// Case 3: tool-calling models run until they answer or the turn is cancelled.
// ---------------------------------------------------------------------------

describe("runTurn — unbounded tool rounds", () => {
  const noopDef: ToolDefinition = {
    name: "noop_tool",
    description: "does nothing",
    parameters: { type: "object", properties: {} },
    category: "foreground",
    tier: "read",
  };

  it("keeps the mediated tool set past the former 50-round ceiling before a genuine answer", async () => {
    const rounds = 51;
    const store = openSessionStore(cap);
    const sessionId = "unbounded-rounds";
    seedUserMessage(store, sessionId, "do something complicated");

    const provider = fakeProvider(async function* (callIndex, req) {
      expect(req.tools.map((tool) => tool.function.name)).toEqual(["noop_tool"]);
      if (callIndex <= rounds) {
        yield {
          type: "tool_call",
          toolCall: { id: `call_${callIndex}`, type: "function", function: { name: "noop_tool", arguments: "{}" } },
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text", content: "The genuine answer." };
      yield { type: "done", finishReason: "stop" };
    });
    const broker = fakeBroker([noopDef], async () => ({ content: "ok", isError: false }));

    const result = await runTurn(
      {
        provider,
        broker,
        store,
        timeZone: { zone: () => "UTC" },
        systemPrompt: "you are a test assistant",
        sessionId,
        requestTimeoutMs: 120000,
        onTextDelta: () => {},
        onToolUpdate: () => {},
      },
      { turnId: "turn-unbounded", signal: new AbortController().signal },
    );

    expect(result).toMatchObject({ completed: true, iterations: rounds + 1 });
    expect(provider.calls).toHaveLength(rounds + 1);
    expect(provider.calls.every((request) => request.tools.length === 1)).toBe(true);
    expect(broker.dispatchCalls).toHaveLength(rounds);

    const entries = store.readSession(sessionId);
    expect(entries).toHaveLength(1 + rounds * 2 + 1);
    expect(entries[entries.length - 1]).toMatchObject({ kind: "assistant", text: "The genuine answer." });

    store.close();
  });

  it("cancels cleanly after the former ceiling without dispatching another tool round", async () => {
    const rounds = 51;
    const store = openSessionStore(cap);
    const sessionId = "unbounded-cancel";
    seedUserMessage(store, sessionId, "keep working until I stop you");

    let markBeyondCeilingStarted: (() => void) | undefined;
    const beyondCeilingStarted = new Promise<void>((resolve) => {
      markBeyondCeilingStarted = resolve;
    });
    const provider = fakeProvider(async function* (callIndex, req) {
      if (callIndex <= rounds) {
        yield {
          type: "tool_call",
          toolCall: { id: `call_${callIndex}`, type: "function", function: { name: "noop_tool", arguments: "{}" } },
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }

      markBeyondCeilingStarted?.();
      await new Promise<void>((resolve) => {
        if (req.signal.aborted) {
          resolve();
        } else {
          req.signal.addEventListener("abort", () => resolve(), { once: true });
        }
      });
    });
    const broker = fakeBroker([noopDef], async () => ({ content: "ok", isError: false }));
    const controller = new AbortController();

    const resultPromise = runTurn(
      {
        provider,
        broker,
        store,
        timeZone: { zone: () => "UTC" },
        systemPrompt: "you are a test assistant",
        sessionId,
        requestTimeoutMs: 120000,
        onTextDelta: () => {},
        onToolUpdate: () => {},
      },
      { turnId: "turn-unbounded-cancel", signal: controller.signal },
    );
    await beyondCeilingStarted;
    controller.abort();
    const result = await resultPromise;

    expect(result).toMatchObject({ completed: false, iterations: rounds + 1 });
    expect(provider.calls).toHaveLength(rounds + 1);
    expect(broker.dispatchCalls).toHaveLength(rounds);
    expect(store.readSession(sessionId)).toHaveLength(1 + rounds * 2);

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
          timeZone: { zone: () => "UTC" },
          systemPrompt: "you are a test assistant",
          sessionId,
          requestTimeoutMs: 120000,
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
// calls: the store never got the narration, so a page
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
      tier: "read",
    };
    const broker = fakeBroker([weatherDef], async () => ({ content: "sunny", isError: false }));

    const deltas: string[] = [];
    const result = await runTurn(
      {
        provider,
        broker,
        store,
        timeZone: { zone: () => "UTC" },
        systemPrompt: "you are a test assistant",
        sessionId,
        requestTimeoutMs: 120000,
        onTextDelta: (_turnId, text) => deltas.push(text),
        onToolUpdate: () => {},
      },
      { turnId: "turn-5", signal: new AbortController().signal },
    );

    expect(result).toMatchObject({ completed: true, iterations: 2 });
    // The narration streamed live, and its segment is TERMINATED before the
    // final answer follows it. Both halves land in one bubble on the client, so
    // without the break the reply read "Let me check.It is sunny." — the
    // gateway owns what a well-formed segment is, not the clients.
    expect(deltas.join("")).toBe("Let me check.\n\nIt is sunny.");

    // Before this fix, "Let me check." would be ABSENT here — discarded the
    // instant the loop saw toolCalls.length > 0 on a non-terminal iteration.
    const entries = store.readSession(sessionId);
    expect(entries.map((e) => e.kind)).toEqual(["user", "assistant", "tool_call", "tool_result", "assistant"]);
    // Stored WITH its terminator, byte-identical to what the live stream sent.
    expect(entries[1]?.text).toBe("Let me check.\n\n");
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
    const narrationItem = feed.find((item) => item.kind === "assistant" && item.text === "Let me check.\n\n");
    expect(narrationItem).toBeDefined();
    // The tool round trip is durable in the store (asserted above) and is
    // deliberately absent from the CLIENT feed — the strip owns tool activity.
    expect(feed.map((item) => item.kind)).toEqual(["user", "assistant", "assistant"]);

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
        timeZone: { zone: () => "UTC" },
        systemPrompt: "you are a test assistant",
        sessionId,
        requestTimeoutMs: 120000,
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

  // Finding 1 (task-18 code review): the guard above must not be scoped to
  // `finishReason === "length"`. finishReason is a free-form `string` off the
  // wire (provider-client.ts) — a provider returning empty/whitespace-only
  // text under "stop" (or "content_filter", or anything else) must hit the
  // exact same failure path, not fall through to a `completed: true` commit
  // of an empty entry.
  it("INVARIANT: empty text under finish_reason 'stop' is ALSO a failed turn, never a silent success", async () => {
    const store = openSessionStore(cap);
    const sessionId = "empty-stop";
    seedUserMessage(store, sessionId, "hello?");
    const beforeCount = store.readSession(sessionId).length;

    // Whitespace-only, not just "", to prove the guard trims before judging —
    // and finish_reason "stop", the ordinary/successful reason, to prove the
    // guard does not key off finishReason at all.
    const provider = fakeProvider(async function* () {
      yield { type: "text", content: "   " };
      yield { type: "done", finishReason: "stop" };
    });

    const result = await runTurn(
      {
        provider,
        broker: noopBroker(),
        store,
        timeZone: { zone: () => "UTC" },
        systemPrompt: "you are a test assistant",
        sessionId,
        requestTimeoutMs: 120000,
        onTextDelta: () => {},
        onToolUpdate: () => {},
      },
      { turnId: "turn-empty-stop", signal: new AbortController().signal },
    );

    expect(result).toMatchObject({ completed: false, iterations: 1 });
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
  tier: "confirm",
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
        timeZone: { zone: () => "UTC" },
        systemPrompt: "you are a test assistant",
        sessionId,
        requestTimeoutMs: 120000,
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
        timeZone: { zone: () => "UTC" },
        systemPrompt: "you are a test assistant",
        sessionId,
        requestTimeoutMs: 120000,
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

// ---------------------------------------------------------------------------
// I2: a provider that goes silent MID-STREAM must not hold the one-turn lock
// forever. The stall watchdog (re-armed on every chunk) aborts the provider
// call when the inter-chunk gap exceeds `requestTimeoutMs`, and the turn FAILS
// (completed:false) rather than a cutoff — with no partial pre-stall text
// committed as a completed reply.
// ---------------------------------------------------------------------------

describe("runTurn — direct main vision", () => {
  it("assembles current image bytes on first request even when model advertises tools=false", async () => {
    const attachmentId = `att_${"d".repeat(32)}`;
    const entries: SessionEntry[] = [
      {
        seq: 10,
        sessionId: "vision-first",
        turnId: "different-admitted-id",
        replyId: null,
        kind: "user",
        createdAt: 1,
        text: "What is this?",
        toolCallId: null,
        toolName: null,
        toolArgs: null,
        cutoff: null,
        compactedThroughSeq: null,
        pendingId: "pending",
        attachments: [
          { attachmentId, displayName: "hidden.png", contentType: "image/png", mediaKind: "image", size: 9 },
        ],
      },
    ];
    const store = {
      readSession: () => entries,
      append: (value: NewSessionEntry) => {
        const saved = { ...value, seq: entries.length + 11, attachments: [] } as SessionEntry;
        entries.push(saved);
        return saved;
      },
    } as unknown as SessionStore;
    const provider = fakeProvider(async function* (call) {
      if (call === 1) {
        yield {
          type: "tool_call",
          toolCall: {
            id: "call-after-image",
            type: "function",
            function: { name: "unused", arguments: "{}" },
          },
        };
      } else {
        yield { type: "text", content: "seen" };
      }
      yield { type: "done", finishReason: call === 1 ? "tool_calls" : "stop" };
    });
    const fallback = fakeProvider(async function* () {
      yield { type: "done", finishReason: "unexpected" };
    });
    const definition: ToolDefinition = {
      name: "unused",
      description: "unused",
      parameters: {},
      category: "foreground",
      tier: "read",
    };
    const ref = {
      attachmentId,
      ownerUserId: cap.ownerUserId,
      sessionId: "vision-first",
      entrySeq: 10,
      status: "ready" as const,
      mediaKind: "image" as const,
      contentType: "image/png",
      displayName: "hidden.png",
      size: 9,
      sha256: "a".repeat(64),
      sendAttemptId: "attempt",
      fileIdentity: "file",
      stagedAt: 1,
      expiresAt: 2,
    };
    let parserCalls = 0;

    await runTurn(
      {
        provider: fallback,
        resolveMainModel: async () => ({
          client: provider,
          provider: "ollama-cloud",
          catalogModelId: "vision:cloud",
          outboundModel: "vision",
          supportsVision: true,
          supportsTools: false,
          contextLength: 8192,
        }),
        directVision: {
          capability: Object.freeze({
            ownerUserId: cap.ownerUserId,
            resource: "attachment-store",
            rootPath: ROOT,
            role: "adult",
          }),
          sessionId: "vision-first",
          store: { findAttachment: () => ref },
          storage: {
            async *read() {
              yield Uint8Array.from([1]);
            },
          },
          parser: {
            parse: async () => {
              parserCalls++;
              return {
                ok: true,
                value: normalizedImageResponse(),
              };
            },
          },
          limits: { maxPages: 8, maxTextBytes: 1024, maxTextChars: 1000, maxQuestionChars: 2000, maxEdge: 1600 },
          config: attachmentsConfigSchema.parse({}),
        },
        broker: fakeBroker([definition], async () => ({ content: "unused", isError: false })),
        store,
        timeZone: { zone: () => "UTC" },
        systemPrompt: "system",
        sessionId: "vision-first",
        requestTimeoutMs: 1000,
        onTextDelta: () => {},
        onToolUpdate: () => {},
      },
      { turnId: "active-turn", signal: new AbortController().signal, inputAfterSeq: 9 },
    );

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]?.tools).toEqual([]);
    expect(provider.calls[0]?.model).toBe("vision");
    expect(JSON.stringify(provider.calls[0]?.messages).match(/"type":"image_url"/g)).toHaveLength(1);
    expect(JSON.stringify(provider.calls[1]?.messages).match(/"type":"image_url"/g)).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain("base64");
    expect(parserCalls).toBe(1);
    expect(fallback.calls).toHaveLength(0);
  });

  it("prepares auxiliary overview before first request for false and unknown vision without a model tool", async () => {
    for (const supportsVision of [false, "unknown"] as const) {
      const attachmentId = `att_${supportsVision === false ? "a".repeat(32) : "b".repeat(32)}`;
      const sessionId = `automatic-aux-${supportsVision}`;
      const entries: SessionEntry[] = [
        {
          seq: 1,
          sessionId,
          turnId: "turn",
          replyId: null,
          kind: "user",
          createdAt: 1,
          text: "What is this?",
          toolCallId: null,
          toolName: null,
          toolArgs: null,
          cutoff: null,
          compactedThroughSeq: null,
          pendingId: null,
          attachments: [
            { attachmentId, displayName: "hidden.png", contentType: "image/png", mediaKind: "image", size: 9 },
          ],
        },
      ];
      const store = {
        readSession: () => entries,
        append: (value: NewSessionEntry) => {
          const saved = { ...value, seq: entries.length + 1, attachments: [] } as SessionEntry;
          entries.push(saved);
          return saved;
        },
      } as unknown as SessionStore;
      const provider = fakeProvider(async function* () {
        yield { type: "text", content: "answered from overview" };
        yield { type: "done", finishReason: "stop" };
      });
      const ref = {
        attachmentId,
        ownerUserId: cap.ownerUserId,
        sessionId,
        entrySeq: 1,
        status: "ready" as const,
        mediaKind: "image" as const,
        contentType: "image/png",
        displayName: "hidden.png",
        size: 9,
        sha256: "a".repeat(64),
        sendAttemptId: "attempt",
        fileIdentity: "file",
        stagedAt: 1,
        expiresAt: 2,
      };
      let auxiliaryCalls = 0;
      let dispatches = 0;

      await runTurn(
        {
          provider,
          resolveMainModel: async () => ({
            client: provider,
            provider: "ollama-cloud",
            catalogModelId: "main:cloud",
            outboundModel: "main",
            supportsVision,
            supportsTools: true,
            contextLength: 8192,
          }),
          directVision: {
            capability: Object.freeze({
              ownerUserId: cap.ownerUserId,
              resource: "attachment-store",
              rootPath: ROOT,
              role: "adult",
            }),
            sessionId,
            store: { findAttachment: () => ref },
            storage: {
              async *read() {
                yield Uint8Array.from([1]);
              },
            },
            parser: {
              parse: async () => ({
                ok: true,
                value: normalizedImageResponse(),
              }),
            },
            limits: { maxPages: 8, maxTextBytes: 1024, maxTextChars: 1000, maxQuestionChars: 2000, maxEdge: 1600 },
            config: attachmentsConfigSchema.parse({}),
            auxiliary: {
              resolveVision: async () => ({
                ok: true,
                value: {
                  inspect: async (request) => {
                    auxiliaryCalls += 1;
                    return {
                      ok: true,
                      value: {
                        text: "screened automatic overview",
                        provenance: request.pages.map((p) => p.provenance),
                      },
                    };
                  },
                },
              }),
              gate: {
                screen: (text) => ({ text, flagged: false, maxSeverity: null }),
                getRiskLevel: () => "none",
              },
            },
          },
          broker: fakeBroker(
            [
              {
                name: "inspect_attachment",
                description: "inspect",
                parameters: {},
                category: "foreground",
                tier: "read",
              },
            ],
            async () => {
              dispatches += 1;
              return { content: "unexpected", isError: false };
            },
          ),
          store,
          timeZone: { zone: () => "UTC" },
          systemPrompt: "system",
          sessionId,
          requestTimeoutMs: 1000,
          onTextDelta: () => {},
          onToolUpdate: () => {},
        },
        { turnId: "turn", signal: new AbortController().signal },
      );

      expect(auxiliaryCalls).toBe(1);
      expect(dispatches).toBe(0);
      expect(JSON.stringify(provider.calls[0]?.messages)).toContain("screened automatic overview");
      expect(JSON.stringify(provider.calls[0]?.messages)).not.toContain("image_url");
    }
  });

  it("tracks latest inspection response by store call seq across reused model ids and mixed outcomes", async () => {
    const store = openSessionStore(cap);
    const sessionId = "vision-batches";
    seedUserMessage(store, sessionId, "inspect");
    const image = `att_${"1".repeat(32)}`;
    const old = `att_${"2".repeat(32)}`;
    const imageCount = (messages: readonly unknown[]) =>
      JSON.stringify(messages).match(/"type":"image_url"/g)?.length ?? 0;
    const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
      type: "tool_call" as const,
      toolCall: { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } },
    });
    const provider = fakeProvider(async function* (call, req) {
      expect(imageCount(req.messages)).toBe([0, 2, 2, 1, 0][call - 1] ?? -1);
      if (call === 1) {
        yield toolCall("reused", "inspect_attachment", { attachmentId: image, question: "first", mode: "visual" });
        yield toolCall("second", "inspect_attachment", { attachmentId: old, question: "second", mode: "visual" });
      } else if (call === 2) {
        yield toolCall("reused", "unrelated", {});
      } else if (call === 3) {
        yield toolCall("mixed-ok", "inspect_attachment", { attachmentId: image, question: "ok", mode: "visual" });
        yield toolCall("mixed-deny", "inspect_attachment", { attachmentId: old, question: "deny", mode: "visual" });
      } else if (call === 4) {
        yield toolCall("mixed-ok", "inspect_attachment", { attachmentId: old, question: "fail", mode: "visual" });
      } else {
        yield { type: "text", content: "done" };
      }
      yield { type: "done", finishReason: call < 5 ? "tool_calls" : "stop" };
    });
    const marker = (attachmentId: string) =>
      JSON.stringify({
        kind: "sentient.visual-evidence",
        version: 1,
        status: "prepared",
        attachmentId,
        pages: [1],
        totalPages: 1,
        partial: false,
      });
    const broker = fakeBroker(
      [
        { name: "inspect_attachment", description: "inspect", parameters: {}, category: "foreground", tier: "read" },
        { name: "unrelated", description: "other", parameters: {}, category: "foreground", tier: "read" },
      ],
      async (inv) => {
        if (inv.name === "unrelated") return { content: "ok", isError: false };
        const attachmentId = String(inv.args.attachmentId);
        return {
          content: marker(attachmentId),
          isError: inv.args.question === "deny" || inv.args.question === "fail",
        };
      },
    );
    const refs = new Map(
      [image, old].map((attachmentId) => [
        attachmentId,
        {
          attachmentId,
          ownerUserId: cap.ownerUserId,
          sessionId,
          entrySeq: 1,
          status: "ready" as const,
          mediaKind: "image" as const,
          contentType: "image/png",
          displayName: "hidden.png",
          size: 9,
          sha256: "a".repeat(64),
          sendAttemptId: "attempt",
          fileIdentity: attachmentId,
          stagedAt: 1,
          expiresAt: 2,
        },
      ]),
    );

    const result = await runTurn(
      {
        provider,
        resolveMainModel: async () => ({
          client: provider,
          provider: "ollama-cloud",
          catalogModelId: "vision:cloud",
          outboundModel: "vision",
          supportsVision: true,
          supportsTools: true,
          contextLength: 8192,
        }),
        directVision: {
          capability: Object.freeze({
            ownerUserId: cap.ownerUserId,
            resource: "attachment-store",
            rootPath: ROOT,
            role: "adult",
          }),
          sessionId,
          store: { findAttachment: (id) => refs.get(id) ?? null },
          storage: {
            async *read() {
              yield Uint8Array.from([1]);
            },
          },
          parser: {
            parse: async () => ({
              ok: true,
              value: normalizedImageResponse(),
            }),
          },
          limits: { maxPages: 8, maxTextBytes: 1024, maxTextChars: 1000, maxQuestionChars: 2000, maxEdge: 1600 },
          config: attachmentsConfigSchema.parse({ inspection_max_pages: 3, vision_max_input_bytes: 1024 }),
        },
        broker,
        store,
        timeZone: { zone: () => "UTC" },
        systemPrompt: "system",
        sessionId,
        requestTimeoutMs: 1000,
        onTextDelta: () => {},
        onToolUpdate: () => {},
      },
      { turnId: "batch-turn", signal: new AbortController().signal },
    );

    expect(result.completed).toBe(true);
    expect(provider.calls).toHaveLength(5);
    store.close();
  });
});

describe("runTurn — main model changes between iterations", () => {
  it("keeps emitted tool routing on producing snapshot and falls back to auxiliary after capability becomes unknown", async () => {
    const store = openSessionStore(cap);
    const sessionId = "vision-model-switch";
    seedUserMessage(store, sessionId, "inspect prior attachment");
    const attachmentId = `att_${"e".repeat(32)}`;
    const marker = JSON.stringify({
      kind: "sentient.visual-evidence",
      version: 1,
      status: "prepared",
      attachmentId,
      pages: [1],
      totalPages: 1,
      partial: false,
    });
    const provider = fakeProvider(async function* (call) {
      if (call === 1) {
        yield {
          type: "tool_call",
          toolCall: {
            id: "inspect-1",
            type: "function",
            function: {
              name: "inspect_attachment",
              arguments: JSON.stringify({ attachmentId, question: "q", pages: [1], mode: "visual" }),
            },
          },
        };
      } else if (call === 2) {
        yield {
          type: "tool_call",
          toolCall: {
            id: "inspect-2",
            type: "function",
            function: {
              name: "inspect_attachment",
              arguments: JSON.stringify({ attachmentId, question: "q again", pages: [1], mode: "visual" }),
            },
          },
        };
      } else {
        yield { type: "text", content: "auxiliary inspected" };
      }
      yield { type: "done", finishReason: call < 3 ? "tool_calls" : "stop" };
    });
    const routes: unknown[] = [];
    const broker = fakeBroker(
      [{ name: "inspect_attachment", description: "inspect", parameters: {}, category: "foreground", tier: "read" }],
      async (inv) => {
        routes.push(inv.attachmentVisionRoute);
        return inv.attachmentVisionRoute === "direct"
          ? { content: marker, isError: false }
          : { content: '{"answer":"auxiliary inspected"}', isError: false };
      },
    );
    let resolution = 0;

    await runTurn(
      {
        provider,
        resolveMainModel: async () => ({
          client: provider,
          provider: "ollama-cloud",
          catalogModelId: resolution++ === 0 ? "vision:cloud" : "unknown:cloud",
          outboundModel: resolution === 1 ? "vision" : "unknown",
          supportsVision: resolution === 1 ? true : "unknown",
          supportsTools: true,
          contextLength: null,
        }),
        broker,
        store,
        timeZone: { zone: () => "UTC" },
        systemPrompt: "system",
        sessionId,
        requestTimeoutMs: 1000,
        onTextDelta: () => {},
        onToolUpdate: () => {},
      },
      { turnId: "switch-turn", signal: new AbortController().signal },
    );

    expect(provider.calls).toHaveLength(3);
    expect(routes).toEqual(["direct", "auxiliary"]);
    expect(JSON.stringify(provider.calls[1]?.messages)).toContain("Prepared visual evidence is unavailable");
    expect(JSON.stringify(provider.calls[1]?.messages)).not.toContain("image_url");
    expect(JSON.stringify(provider.calls[2]?.messages)).not.toContain("image_url");
    store.close();
  });

  for (const capability of [false, "unknown"] as const) {
    it(`routes supportsVision=${capability} inspection through auxiliary with zero main image bytes`, async () => {
      const store = openSessionStore(cap);
      const sessionId = `vision-${capability}`;
      seedUserMessage(store, sessionId, "inspect");
      const attachmentId = `att_${"f".repeat(32)}`;
      const provider = fakeProvider(async function* (call) {
        if (call === 1) {
          yield {
            type: "tool_call",
            toolCall: {
              id: "inspect",
              type: "function",
              function: {
                name: "inspect_attachment",
                arguments: JSON.stringify({ attachmentId, question: "q", mode: "visual" }),
              },
            },
          };
        } else {
          yield { type: "text", content: "done" };
        }
        yield { type: "done", finishReason: call === 1 ? "tool_calls" : "stop" };
      });
      const routes: unknown[] = [];

      await runTurn(
        {
          provider,
          resolveMainModel: async () => ({
            client: provider,
            provider: "ollama-cloud",
            catalogModelId: "model:cloud",
            outboundModel: "model",
            supportsVision: capability,
            supportsTools: true,
            contextLength: null,
          }),
          broker: fakeBroker(
            [
              {
                name: "inspect_attachment",
                description: "inspect",
                parameters: {},
                category: "foreground",
                tier: "read",
              },
            ],
            async (inv) => {
              routes.push(inv.attachmentVisionRoute);
              return { content: '{"answer":"auxiliary"}', isError: false };
            },
          ),
          store,
          timeZone: { zone: () => "UTC" },
          systemPrompt: "system",
          sessionId,
          requestTimeoutMs: 1000,
          onTextDelta: () => {},
          onToolUpdate: () => {},
        },
        { turnId: "turn", signal: new AbortController().signal },
      );

      expect(routes).toEqual(["auxiliary"]);
      expect(JSON.stringify(provider.calls).match(/"type":"image_url"/g)).toBeNull();
      store.close();
    });
  }
});

describe("runTurn — mid-stream provider stall", () => {
  it("fails the turn (not a cutoff) when the provider goes silent past requestTimeoutMs", async () => {
    const store = openSessionStore(cap);
    const sessionId = "provider-stall";
    seedUserMessage(store, sessionId, "tell me a story");

    // Yields one chunk, then goes silent — resolving only when the (stall) abort
    // fires, exactly like the OpenAI SDK exiting its SSE loop on abort. Never
    // yields "done".
    const provider = fakeProvider(async function* (_call, req) {
      yield { type: "text", content: "Once upon a time" };
      await new Promise<void>((resolve) => {
        if (req.signal.aborted) return resolve();
        req.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    const turnSignal = new AbortController().signal; // the turn is NEVER cut off
    const result = await runTurn(
      {
        provider,
        broker: noopBroker(),
        store,
        timeZone: { zone: () => "UTC" },
        systemPrompt: "you are a test assistant",
        sessionId,
        requestTimeoutMs: 40, // short stall budget so the watchdog fires fast
        onTextDelta: () => {},
        onToolUpdate: () => {},
      },
      { turnId: "turn-stall", signal: turnSignal },
    );

    // The turn FAILED (not aborted) — session-runtime's `failed` branch commits
    // a user-visible failure notice (failed = !completed && !signal.aborted).
    expect(result.completed).toBe(false);
    expect(turnSignal.aborted).toBe(false);

    // No partial pre-stall text was committed as a completed assistant reply.
    const entries = store.readSession(sessionId);
    expect(entries.some((e) => e.kind === "assistant")).toBe(false);

    store.close();
  });
});
