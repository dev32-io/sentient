import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import type { OrchestratorConfig } from "@sentient/config";
import { createAccessManager } from "../access/access-manager.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { ProviderClient, ProviderRequest, ProviderStreamChunk } from "../provider/provider-client.js";
import { openSessionStore } from "../store/session-store.js";
import type { BackgroundRegistry } from "../tools/background-registry.js";
import type { ToolBroker } from "../tools/tool-broker.js";
import type { ToolDefinition, ToolInvocation, ToolResult } from "../tools/tool-types.js";
import type { SessionRuntime } from "./session-runtime.js";
import { createSessionRuntime } from "./session-runtime.js";
import type { TurnEmitter } from "./turn-emitter.js";

// ---------------------------------------------------------------------------
// Fixtures — real on-disk stores under a scratch /tmp root (matches
// react-loop.test.ts's and session-store.test.ts's own precedent) + small
// hand-rolled fakes for ProviderClient / ToolBroker / TurnEmitter.
// ---------------------------------------------------------------------------

const ROOT = "/tmp/sentient-session-runtime-test";
mkdirSync(ROOT, { recursive: true });

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function testConfig(maxIterations = 10): OrchestratorConfig {
  return {
    provider: {
      base_url: "http://localhost:0",
      model: "test-model",
      api_key_env: "TEST_KEY",
      max_output_tokens: 1024,
      request_timeout_ms: 120000,
      site_name: "Sentient",
    },
    loop: { max_iterations: maxIterations },
    tools: { foreground_timeout_ms: 30000, max_concurrent_background_tasks: 50 },
    delegation: { frontmatter_dir: "./config/delegation", hermes_timeout_ms: 600000 },
  };
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

interface RecordedEvent {
  type: "turnStarted" | "textDelta" | "toolUpdate" | "turnCompleted" | "turnAborted";
  turnId: string;
}

interface RecordingEmitter extends TurnEmitter {
  events: RecordedEvent[];
}

function recordingEmitter(): RecordingEmitter {
  const events: RecordedEvent[] = [];
  return {
    events,
    turnStarted: (turnId) => events.push({ type: "turnStarted", turnId }),
    textDelta: (turnId) => events.push({ type: "textDelta", turnId }),
    toolUpdate: (turnId) => events.push({ type: "toolUpdate", turnId }),
    turnCompleted: (turnId) => events.push({ type: "turnCompleted", turnId }),
    turnAborted: (turnId) => events.push({ type: "turnAborted", turnId }),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitUntilIdle(runtime: SessionRuntime, timeoutMs = 2000): Promise<void> {
  await waitFor(() => !runtime.running, timeoutMs);
}

const weatherDef: ToolDefinition = {
  name: "get_weather",
  description: "gets the weather",
  parameters: { type: "object", properties: {} },
  category: "foreground",
};

// ---------------------------------------------------------------------------
// Case 1: one submit while idle starts exactly one turn.
// ---------------------------------------------------------------------------

describe("SessionRuntime — idle submit", () => {
  it("starts exactly one turn and reports it complete", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/case1` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    const provider = fakeProvider(async function* () {
      yield { type: "text", content: "hello back" };
      yield { type: "done", finishReason: "stop" };
    });
    const emitter = recordingEmitter();

    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-1",
      accessManager: am,
      provider,
      broker: noopBroker(),
      emitter,
      systemPrompt: "you are a test assistant",
      config: testConfig(),
    });

    expect(runtime.running).toBe(false);
    runtime.submit({ kind: "conversational", text: "hello" });
    // Synchronous: submit() sets the in-flight marker before returning.
    expect(runtime.running).toBe(true);

    await waitUntilIdle(runtime);

    expect(provider.calls).toHaveLength(1);
    expect(emitter.events.filter((e) => e.type === "turnStarted")).toHaveLength(1);
    expect(emitter.events.filter((e) => e.type === "turnCompleted")).toHaveLength(1);

    runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Case 2: a second submit while a turn is running steers it — no parallel
// loop, and the steered text reaches the running loop's next iteration.
// ---------------------------------------------------------------------------

describe("SessionRuntime — steer while running", () => {
  it("does not start a second concurrent turn; steered text reaches the next iteration", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/case2` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    // Gate iteration 1's own stream (not the tool dispatch) so the steered
    // entry lands BEFORE the tool_call/tool_result pair, not between them —
    // an entry landing mid-pair would hit model-projection's block-adjacency
    // rule and get dropped, which is real system behavior but orthogonal to
    // what this test is pinning.
    let signalStreamStarted: (() => void) | undefined;
    const streamStarted = new Promise<void>((resolve) => {
      signalStreamStarted = resolve;
    });
    let releaseFirstIteration: (() => void) | undefined;
    const firstIterationGate = new Promise<void>((resolve) => {
      releaseFirstIteration = resolve;
    });

    const provider = fakeProvider(async function* (callIndex) {
      if (callIndex === 1) {
        signalStreamStarted?.();
        await firstIterationGate;
        yield {
          type: "tool_call",
          toolCall: { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } },
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      // Any further call (including a possible back-to-back next turn) just
      // gives a plain final answer so the fixture always terminates cleanly.
      yield { type: "text", content: "final reply" };
      yield { type: "done", finishReason: "stop" };
    });

    const broker = fakeBroker([weatherDef], async () => ({ content: "sunny", isError: false }));

    const emitter = recordingEmitter();
    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-2",
      accessManager: am,
      provider,
      broker,
      emitter,
      systemPrompt: "you are a test assistant",
      config: testConfig(),
    });

    runtime.submit({ kind: "conversational", text: "what is the weather?" });
    await streamStarted; // iteration 1 has called the provider and is now awaiting the gate

    expect(runtime.running).toBe(true);
    expect(provider.calls).toHaveLength(1);

    // Steer: a second submit while the turn is running.
    runtime.submit({ kind: "conversational", text: "also check tomorrow" });

    // Still exactly one turn in flight — no parallel loop was spawned.
    expect(runtime.running).toBe(true);
    expect(provider.calls).toHaveLength(1);

    releaseFirstIteration?.();
    await waitFor(() => provider.calls.length >= 2);

    const secondCallMessages = provider.calls[1]?.messages ?? [];
    const steeredMessage = secondCallMessages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("also check tomorrow"),
    );
    expect(steeredMessage).toBeDefined();

    await waitUntilIdle(runtime);
    runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Case 3: a stimulus that arrives during a turn's ONLY iteration (so no
// later iteration can pick it up) triggers a back-to-back next turn once
// the first one ends — the next-turn-trigger path, exercised end to end.
// ---------------------------------------------------------------------------

describe("SessionRuntime — next-turn trigger", () => {
  it("starts a back-to-back turn for a stimulus that arrived too late for the first turn to see", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/case3` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    let releaseFirstReply: (() => void) | undefined;
    const firstReplyGate = new Promise<void>((resolve) => {
      releaseFirstReply = resolve;
    });

    const provider = fakeProvider(async function* (callIndex) {
      if (callIndex === 1) {
        yield { type: "text", content: "quick reply" };
        await firstReplyGate;
        yield { type: "done", finishReason: "stop" };
        return;
      }
      yield { type: "text", content: "follow-up reply" };
      yield { type: "done", finishReason: "stop" };
    });

    const emitter = recordingEmitter();
    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-3",
      accessManager: am,
      provider,
      broker: noopBroker(),
      emitter,
      systemPrompt: "you are a test assistant",
      config: testConfig(),
    });

    runtime.submit({ kind: "conversational", text: "hello" });
    await waitFor(() => provider.calls.length >= 1);

    // Lands mid-stream, on the turn's only iteration — cannot be absorbed by
    // a later iteration because there isn't one.
    runtime.submit({ kind: "conversational", text: "one more thing" });

    releaseFirstReply?.();
    await waitFor(() => provider.calls.length >= 2);

    const followUpMessages = provider.calls[1]?.messages ?? [];
    const carriedOver = followUpMessages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("one more thing"),
    );
    expect(carriedOver).toBeDefined();

    await waitUntilIdle(runtime);
    expect(emitter.events.filter((e) => e.type === "turnCompleted")).toHaveLength(2);

    runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Case 4: isolation — two runtimes for different principals write to
// separate stores; neither can read the other's entries.
// ---------------------------------------------------------------------------

describe("SessionRuntime — isolation", () => {
  it("SECURITY: two principals get separate stores; one cannot read the other's entries", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/case4` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    const bob = createUserPrincipal("u_bbbbbbbb", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });
    mkdirSync(am.userHomeDir(bob), { recursive: true });

    expect(am.userHomeDir(alice)).not.toBe(am.userHomeDir(bob));

    const provider = fakeProvider(async function* () {
      yield { type: "text", content: "ok" };
      yield { type: "done", finishReason: "stop" };
    });

    const runtimeA = createSessionRuntime({
      principal: alice,
      sessionId: "shared-session-id",
      accessManager: am,
      provider,
      broker: noopBroker(),
      emitter: recordingEmitter(),
      systemPrompt: "you are a test assistant",
      config: testConfig(),
    });

    runtimeA.submit({ kind: "conversational", text: "alice's secret" });
    await waitUntilIdle(runtimeA);
    runtimeA.dispose();

    // Alice's own store really does hold what she said (positive control).
    const aliceDirect = openSessionStore(am.grant(alice, "session-store"));
    const aliceEntries = aliceDirect.readSession("shared-session-id");
    expect(aliceEntries.some((e) => e.text === "alice's secret")).toBe(true);
    aliceDirect.close();

    // Bob's store, opened independently under the SAME session id, sees
    // nothing — different capability root, physically different file.
    const bobDirect = openSessionStore(am.grant(bob, "session-store"));
    expect(bobDirect.readSession("shared-session-id")).toEqual([]);
    bobDirect.close();
  });
});
