import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import type { OrchestratorConfig } from "@sentient/config";
import type { ConversationFeedItem } from "@sentient/protocol";
import { createAccessManager } from "../access/access-manager.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { ProviderClient, ProviderRequest, ProviderStreamChunk } from "../provider/provider-client.js";
import type { CutoffKind } from "../store/entry-types.js";
import { openSessionStore } from "../store/session-store.js";
import type { BackgroundRegistry } from "../tools/background-registry.js";
import type { BackgroundToolRunner, ToolBroker } from "../tools/tool-broker.js";
import { createToolBroker } from "../tools/tool-broker.js";
import type { ToolDefinition, ToolInvocation, ToolResult } from "../tools/tool-types.js";
import type { SessionRuntime } from "./session-runtime.js";
import { createSessionRuntime } from "./session-runtime.js";
import type { TurnEmitter } from "./turn-emitter.js";
import type { TurnVoice, TurnVoiceStream } from "./turn-voice.js";

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
      max_output_tokens: 1024,
      request_timeout_ms: 120000,
      site_name: "Sentient",
    },
    loop: { max_iterations: maxIterations },
    permission: { request_timeout_ms: 120000 },
    tools: { foreground_timeout_ms: 30000, max_concurrent_background_tasks: 50 },
    delegation: { frontmatter_dir: "./config/delegation", hermes_timeout_ms: 600000 },
    // OFF for every pre-existing case: compaction adds a second provider
    // call at turn end, which would silently change the call-index
    // assertions those cases are built on. The compaction case below
    // builds its own config with it enabled.
    compaction: { enabled: false, compact_threshold_tokens: 24000, keep_recent_turns: 4 },
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
    setBackgroundCompletionSink: () => {},
  };
}

function noopBroker(): FakeBroker {
  return fakeBroker([], async () => {
    throw new Error("dispatch should never be called for a text-only response");
  });
}

interface RecordedEvent {
  type:
    | "turnStarted"
    | "textDelta"
    | "toolUpdate"
    | "turnCompleted"
    | "turnAborted"
    | "playbackStop"
    | "conversationSnapshot"
    | "conversationEntry";
  turnId: string;
  /** Set on `turnAborted` and `playbackStop` — the wire's cutoff kind. */
  cutoff?: CutoffKind;
  /** Set on the two committed-feed events. */
  item?: ConversationFeedItem;
  items?: ConversationFeedItem[];
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
    turnAborted: (turnId, cutoff) => events.push({ type: "turnAborted", turnId, cutoff }),
    playbackStop: (turnId, reason) => events.push({ type: "playbackStop", turnId, cutoff: reason }),
    conversationSnapshot: (items) => events.push({ type: "conversationSnapshot", turnId: "", items }),
    conversationEntry: (item, turnId) => events.push({ type: "conversationEntry", turnId: turnId ?? "", item }),
    // Not part of any assertion in this file — SessionRuntime never drives
    // these (audio is the voice pipeline's, permission/delegation the PDP's
    // and broker's). Present only to satisfy the TurnEmitter contract.
    audioStart: () => {},
    audioFrame: () => {},
    audioDone: () => {},
    permissionRequest: () => {},
    permissionResolved: () => {},
    delegationProgress: () => {},
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
// Case 3b: delegateTask's fire-and-steer loop, end to end — a background
// tool's settled result must reach the model as a follow-up turn, not dead-
// end. Mirrors phase-services.ts's `buildCreateSessionRuntime` composition
// exactly: a REAL ToolBroker (not the FakeBroker used elsewhere in this
// file) is built first, the runtime second, and
// `broker.setBackgroundCompletionSink` is bound to `runtime.submit` only
// AFTER the runtime exists — same order, same chicken-and-egg the real
// composition root resolves. This is the regression test for the gap fixed
// here: before the fix, `dispatchBackground` discarded the settled
// `ToolResult` and no `trigger` entry — and no next turn — ever appeared.
// ---------------------------------------------------------------------------

describe("SessionRuntime — delegateTask fire-and-steer loop closes end to end", () => {
  it("a background tool's settled result lands as a trigger entry and fires a follow-up turn", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/case3b` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    // Controlled by the test — the background runner's `result` promise
    // settles only when this resolves, so the assertions below can pin
    // "no trigger/next-turn until the background task actually completes."
    let resolveDelegated: (() => void) | undefined;
    const delegatedGate = new Promise<void>((resolve) => {
      resolveDelegated = resolve;
    });

    const backgroundRunner: BackgroundToolRunner = {
      definition: {
        name: "delegateTask",
        description: "delegate to a background worker",
        parameters: { type: "object", properties: {} },
        category: "background",
      },
      run: () => ({
        cancel: () => {},
        result: delegatedGate.then(() => ({ content: "the delegated worker's answer", isError: false })),
      }),
    };

    const broker = createToolBroker({
      mcp: {
        listTools: async () => [],
        callTool: async () => ({ content: "unused", isError: false }),
        close: async () => {},
      },
      policy: { evaluate: () => ({ action: "allow" }) },
      store: {
        append: () => {
          throw new Error("ToolBroker.store is interface-parity only");
        },
        readSession: () => [],
        readSince: () => [],
        listSessions: () => [],
        close: () => {},
      },
      principal: alice,
      sessionId: "sess-3b",
      backgroundTools: new Map([["delegateTask", backgroundRunner]]),
      config: { foreground_timeout_ms: 30000, max_concurrent_background_tasks: 5 },
      requestConfirm: async () => false,
    });

    const provider = fakeProvider(async function* (callIndex) {
      if (callIndex === 1) {
        // Turn 1: model delegates, then narrates a foreground reply without
        // waiting for the background task — the real ReAct shape.
        yield {
          type: "tool_call",
          toolCall: { id: "call_1", type: "function", function: { name: "delegateTask", arguments: "{}" } },
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      if (callIndex === 2) {
        yield { type: "text", content: "I'll get back to you on that." };
        yield { type: "done", finishReason: "stop" };
        return;
      }
      // Turn 2 (the follow-up fired by the background-completion trigger).
      yield { type: "text", content: "Update: here is what the delegated worker found." };
      yield { type: "done", finishReason: "stop" };
    });

    const emitter = recordingEmitter();
    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-3b",
      accessManager: am,
      provider,
      broker,
      emitter,
      systemPrompt: "you are a test assistant",
      config: testConfig(),
    });

    // Exactly mirrors phase-services.ts: the sink is bound AFTER `runtime`
    // exists, closing over it.
    broker.setBackgroundCompletionSink((result) => {
      const note = result.isError
        ? `Delegated task ${result.taskId} (${result.toolName}) failed: ${result.content}`
        : `Delegated task ${result.taskId} (${result.toolName}) completed: ${result.content}`;
      runtime.submit({ kind: "background-completion", note });
    });

    runtime.submit({ kind: "conversational", text: "please delegate this" });
    await waitUntilIdle(runtime);

    // Turn 1 completed WITHOUT waiting on the background task.
    expect(emitter.events.filter((e) => e.type === "turnCompleted")).toHaveLength(1);
    expect(provider.calls).toHaveLength(2);
    expect(broker.background.count()).toBe(1); // still running

    const readback = openSessionStore(am.grant(alice, "session-store"));
    expect(readback.readSession("sess-3b").some((e) => e.kind === "trigger")).toBe(false);

    // Now let the background runner settle — this is the exact moment the
    // fixed gap closes: the broker's dispatchBackground observes the
    // settled promise and calls the bound sink. Poll for the follow-up
    // turn's completion rather than an intermediate `runtime.running`
    // flip — with this fixture's ungated second turn, the whole
    // settle→submit→turn-2-completes chain can resolve within the same
    // microtask flush, too fast for a 5ms-interval poll to reliably catch
    // `running` transiently `true`.
    resolveDelegated?.();
    await waitFor(() => emitter.events.filter((e) => e.type === "turnCompleted").length >= 2);

    const triggerEntry = readback
      .readSession("sess-3b")
      .find((e) => e.kind === "trigger" && e.text?.includes("the delegated worker's answer"));
    expect(triggerEntry).toBeDefined();
    expect(triggerEntry?.text).toContain("Delegated task");
    expect(triggerEntry?.text).toContain("completed:");

    await waitUntilIdle(runtime);
    readback.close();

    // A SECOND turn actually ran and completed — the loop closed, not just
    // the trigger entry landing inertly in the store.
    expect(emitter.events.filter((e) => e.type === "turnCompleted")).toHaveLength(2);
    expect(provider.calls).toHaveLength(3);
    expect(broker.background.count()).toBe(0); // slot freed on settle

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

  // Case 5: a re-entrant submit from a turnCompleted callback must not start a
  // SECOND concurrent turn. A future real TurnEmitter could call submit()
  // synchronously from turnCompleted, inside onTurnSettled's clear-and-decide
  // window; the startTurn re-entrancy guard must keep exactly one turn live.
  it("SECURITY/INVARIANT: a re-entrant submit from turnCompleted never runs two concurrent turns", async () => {
    const ROOT5 = `${ROOT}/case5`;
    const am = createAccessManager({ userDataRoot: ROOT5 });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    let concurrent = 0;
    let concurrentPeak = 0;
    const provider = fakeProvider(async function* () {
      concurrent += 1;
      concurrentPeak = Math.max(concurrentPeak, concurrent);
      yield { type: "text", content: "ok" };
      yield { type: "done", finishReason: "stop" };
      concurrent -= 1;
    });

    // Re-entrant emitter: the first turnCompleted submits a follow-up message
    // synchronously (once), mimicking a client-wire emitter that echoes.
    let reentered = false;
    // Mutable holder so the emitter closure can reach the runtime that is
    // constructed after it (genuine forward reference).
    const ref: { runtime?: SessionRuntime } = {};
    const events: RecordedEvent[] = [];
    const emitter: RecordingEmitter = {
      events,
      turnStarted: (t) => events.push({ type: "turnStarted", turnId: t }),
      textDelta: (t) => events.push({ type: "textDelta", turnId: t }),
      toolUpdate: (t) => events.push({ type: "toolUpdate", turnId: t }),
      turnCompleted: (t) => {
        events.push({ type: "turnCompleted", turnId: t });
        // Submit TWICE: the first re-entrant submit starts a turn (setting
        // inFlight); the second appends a stimulus AFTER that turn's seq
        // snapshot, so onTurnSettled's own next-turn check then also wants to
        // start — without the startTurn guard the two collide into two
        // concurrent loops over one store (the reviewer's reproduced race).
        if (!reentered) {
          reentered = true;
          ref.runtime?.submit({ kind: "conversational", text: "follow-up-1" });
          ref.runtime?.submit({ kind: "conversational", text: "follow-up-2" });
        }
      },
      turnAborted: (t) => events.push({ type: "turnAborted", turnId: t }),
      playbackStop: (t, reason) => events.push({ type: "playbackStop", turnId: t, cutoff: reason }),
      conversationSnapshot: (items) => events.push({ type: "conversationSnapshot", turnId: "", items }),
      conversationEntry: (item, t) => events.push({ type: "conversationEntry", turnId: t ?? "", item }),
      audioStart: () => {},
      audioFrame: () => {},
      audioDone: () => {},
      permissionRequest: () => {},
      permissionResolved: () => {},
      delegationProgress: () => {},
    };

    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "reentry",
      accessManager: am,
      provider,
      broker: noopBroker(),
      emitter,
      systemPrompt: "you are a test assistant",
      config: testConfig(),
    });
    ref.runtime = runtime;

    runtime.submit({ kind: "conversational", text: "hello" });
    await waitUntilIdle(runtime);

    // Peak concurrency must be 1 — never two loops over one store at once.
    expect(concurrentPeak).toBe(1);
    // The follow-up was still processed (two turns total, back-to-back).
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);
    runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Cancellation (spec §4.7, Task 8) — barge-in vs interrupt. Two distinct
// gestures, pinned as the FSM invariant that must never regress into one
// do-everything "cancel": barge-in aborts the turn but keeps background
// tasks alive; interrupt aborts the turn AND cancels them. Both commit the
// turn's not-yet-durable partial as a `cutoff` assistant entry before
// aborting.
// ---------------------------------------------------------------------------

interface SpyBackgroundRegistry extends BackgroundRegistry {
  cancelAllCalls: number;
}

function spyBackgroundRegistry(): SpyBackgroundRegistry {
  const tasks = new Map<string, () => void>();
  const registry: SpyBackgroundRegistry = {
    cancelAllCalls: 0,
    count: () => tasks.size,
    register: (taskId, cancel) => {
      tasks.set(taskId, cancel);
    },
    complete: (taskId) => {
      tasks.delete(taskId);
    },
    cancelAll: () => {
      registry.cancelAllCalls += 1;
      tasks.clear();
    },
  };
  return registry;
}

function fakeBrokerWithBackground(background: BackgroundRegistry): FakeBroker {
  return {
    dispatchCalls: [],
    definitions: () => [],
    async dispatch(): Promise<ToolResult> {
      throw new Error("dispatch should never be called in cancellation tests");
    },
    background,
    setBackgroundCompletionSink: () => {},
  };
}

/** A provider that streams one text chunk, then blocks until the turn's
 *  AbortSignal actually fires — mirroring a real streaming HTTP call (which
 *  ends promptly on abort rather than throwing). react-loop.test.ts's own
 *  "abort mid-stream" case establishes the same requirement: merely calling
 *  `controller.abort()` does not itself unblock a generator already
 *  suspended on an unrelated promise, so the fake must cooperate with the
 *  signal directly. */
function partialReplyThenHangProvider(partial: string): FakeProvider {
  return fakeProvider(async function* (_callIndex, req) {
    yield { type: "text", content: partial };
    await new Promise<void>((resolve) => {
      if (req.signal.aborted) {
        resolve();
        return;
      }
      req.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    // real providers don't throw on abort; neither does this fake — it just
    // stops yielding, exactly like react-loop.test.ts's abort-mid-stream case.
  });
}

describe("SessionRuntime — cancellation: barge-in keeps background tasks alive", () => {
  it("aborts the turn, commits cutoff:barge-in, and does NOT cancel background tasks", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/case-bargein` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    const provider = partialReplyThenHangProvider("here is a partial answer");
    const background = spyBackgroundRegistry();
    background.register("task-1", () => {});
    const broker = fakeBrokerWithBackground(background);
    const emitter = recordingEmitter();

    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-bargein",
      accessManager: am,
      provider,
      broker,
      emitter,
      systemPrompt: "you are a test assistant",
      config: testConfig(),
    });

    runtime.submit({ kind: "conversational", text: "tell me something" });
    await waitFor(() => emitter.events.some((e) => e.type === "textDelta"));

    runtime.bargeIn();
    await waitUntilIdle(runtime);

    const readback = openSessionStore(am.grant(alice, "session-store"));
    const cutoffEntry = readback
      .readSession("sess-bargein")
      .find((e) => e.kind === "assistant" && e.cutoff === "barge-in");
    expect(cutoffEntry?.text).toBe("here is a partial answer");
    readback.close();

    expect(background.cancelAllCalls).toBe(0);
    expect(background.count()).toBe(1); // still registered — barge-in never touches it

    expect(emitter.events.some((e) => e.type === "turnAborted")).toBe(true);

    runtime.dispose();
  });
});

describe("SessionRuntime — cancellation: interrupt cancels background tasks", () => {
  it("aborts the turn, commits cutoff:interrupt, and DOES cancel background tasks", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/case-interrupt` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    const provider = partialReplyThenHangProvider("stopping now");
    const background = spyBackgroundRegistry();
    background.register("task-1", () => {});
    const broker = fakeBrokerWithBackground(background);
    const emitter = recordingEmitter();

    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-interrupt",
      accessManager: am,
      provider,
      broker,
      emitter,
      systemPrompt: "you are a test assistant",
      config: testConfig(),
    });

    runtime.submit({ kind: "conversational", text: "do a long task" });
    await waitFor(() => emitter.events.some((e) => e.type === "textDelta"));

    runtime.interrupt();
    await waitUntilIdle(runtime);

    const readback = openSessionStore(am.grant(alice, "session-store"));
    const cutoffEntry = readback
      .readSession("sess-interrupt")
      .find((e) => e.kind === "assistant" && e.cutoff === "interrupt");
    expect(cutoffEntry?.text).toBe("stopping now");
    readback.close();

    expect(background.cancelAllCalls).toBe(1);
    expect(background.count()).toBe(0); // cancelAll cleared the registry

    expect(emitter.events.some((e) => e.type === "turnAborted")).toBe(true);

    runtime.dispose();
  });
});

describe("SessionRuntime — cancellation: double-commit guard", () => {
  it("interrupt() right after bargeIn() on the same turn still cancels background but never double-appends a cutoff entry", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/case-double-cancel` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    const provider = partialReplyThenHangProvider("only once");
    const background = spyBackgroundRegistry();
    background.register("task-1", () => {});
    const broker = fakeBrokerWithBackground(background);
    const emitter = recordingEmitter();

    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-double-cancel",
      accessManager: am,
      provider,
      broker,
      emitter,
      systemPrompt: "you are a test assistant",
      config: testConfig(),
    });

    runtime.submit({ kind: "conversational", text: "go" });
    await waitFor(() => emitter.events.some((e) => e.type === "textDelta"));

    // Same still-in-flight turn, back to back — the second call must see the
    // signal already aborted and skip straight to its own background step
    // without re-committing a cutoff entry for a turn already cut off.
    runtime.bargeIn();
    runtime.interrupt();

    await waitUntilIdle(runtime);

    const readback = openSessionStore(am.grant(alice, "session-store"));
    const cutoffEntries = readback.readSession("sess-double-cancel").filter((e) => e.cutoff !== null);
    expect(cutoffEntries).toHaveLength(1);
    expect(cutoffEntries[0]?.cutoff).toBe("barge-in"); // first call wins
    readback.close();

    expect(background.cancelAllCalls).toBe(1); // interrupt's own background step still fires
    runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Cancellation — terminal-completion race (reviewer-reproduced regression).
//
// A turn that completes NATURALLY never sets `signal.aborted`, and
// `inFlight` is only cleared asynchronously in `onTurnSettled` (a `.then()`
// microtask after `runTurn` resolves). Before the `onTurnCommitting` /
// `settled` fix, a bargeIn()/interrupt() landing in the window between
// "terminal assistant text committed" and "inFlight cleared" would
// re-commit that already-durable text as a bogus SECOND cutoff-stamped
// assistant entry (double-append into append-only history) and fire a
// spurious turnAborted racing the legitimate turnCompleted. This test
// reproduces that window by spinning microtask ticks after submit, exactly
// as the reviewer did, then asserts the race is closed.
// ---------------------------------------------------------------------------

describe("SessionRuntime — cancellation: terminal-completion race", () => {
  it("bargeIn landing after natural completion but before inFlight clears commits nothing extra and fires no turnAborted", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/case-terminal-race` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    const provider = fakeProvider(async function* () {
      yield { type: "text", content: "a normal, complete reply" };
      yield { type: "done", finishReason: "stop" };
    });
    const emitter = recordingEmitter();

    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-terminal-race",
      accessManager: am,
      provider,
      broker: noopBroker(),
      emitter,
      systemPrompt: "you are a test assistant",
      config: testConfig(),
    });

    // A second, independent handle onto the SAME on-disk store (bun:sqlite —
    // synchronous, auto-committed writes) lets us POLL for the terminal
    // entry's durability instead of guessing a magic microtask-tick count.
    // Empirically this window is exactly ONE microtask tick wide: the entry
    // becomes readable in the same synchronous continuation react-loop.ts
    // uses to call the (pre-fix: nonexistent, post-fix: `onTurnCommitting`)
    // durability hook, one tick before `onTurnSettled`'s `.then()`
    // continuation clears `inFlight`. Polling — rather than a fixed tick
    // count — finds that tick deterministically regardless of exactly how
    // many ticks the fake provider's async-generator machinery burns getting
    // there, so this test doesn't rot if that plumbing changes.
    const reader = openSessionStore(am.grant(alice, "session-store"));
    const hasCommittedText = (): boolean =>
      reader
        .readSession("sess-terminal-race")
        .some((e) => e.kind === "assistant" && e.text === "a normal, complete reply");

    runtime.submit({ kind: "conversational", text: "hello" });

    const MAX_POLL_TICKS = 50;
    let found = false;
    for (let i = 0; i < MAX_POLL_TICKS; i++) {
      await Promise.resolve();
      if (hasCommittedText()) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true); // sanity: the terminal commit must actually have happened

    // Fire bargeIn() in the SAME synchronous continuation we detected the
    // durable commit in — no further await in between — landing as early as
    // possible inside the race window this test targets.
    runtime.bargeIn();

    await waitUntilIdle(runtime);

    const assistantEntries = reader.readSession("sess-terminal-race").filter((e) => e.kind === "assistant");
    reader.close();

    // Exactly one assistant entry for the turn — no second, cutoff-stamped
    // duplicate from the race.
    expect(assistantEntries).toHaveLength(1);
    expect(assistantEntries[0]?.text).toBe("a normal, complete reply");
    // It completed normally — never stamped with a bogus cutoff.
    expect(assistantEntries[0]?.cutoff).toBeNull();

    // The legitimate turnCompleted fired; no spurious turnAborted raced it.
    expect(emitter.events.some((e) => e.type === "turnCompleted")).toBe(true);
    expect(emitter.events.some((e) => e.type === "turnAborted")).toBe(false);

    runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Case: compaction runs at the turn boundary, under the one-turn lock.
// Pins the ONE thing session-runtime.ts adds: the marker is appended after
// the turn's terminal frame (the client never waits on the summarizer) and
// before `inFlight` clears (no turn can start over a half-written window),
// and the NEXT turn replays from the summary instead of the raw history.
// ---------------------------------------------------------------------------

describe("SessionRuntime — compaction at the turn boundary", () => {
  it("appends the marker at turn end under the lock, and the next turn replays from the summary", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/compaction` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    const emitter = recordingEmitter();
    // Mutable holder so the provider closure can reach the runtime that is
    // constructed after it (genuine forward reference — same shape as the
    // re-entrancy case above).
    const ref: { runtime?: SessionRuntime } = {};

    const provider = fakeProvider(async function* (callIndex) {
      if (callIndex === 2) {
        // The compaction summarizer call. The turn is over — its terminal
        // frame is already out — but the one-turn lock is still held.
        expect(emitter.events.some((e) => e.type === "turnCompleted")).toBe(true);
        expect(ref.runtime?.running).toBe(true);
        yield { type: "text", content: "EARLIER-SUMMARY" };
        yield { type: "done", finishReason: "stop" };
        return;
      }
      yield { type: "text", content: "an answer" };
      yield { type: "done", finishReason: "stop" };
    });

    const config: OrchestratorConfig = {
      ...testConfig(),
      // keep_recent_turns 0 keeps the marker small, so the follow-up turn
      // lands back under the threshold and does not compact again.
      compaction: { enabled: true, compact_threshold_tokens: 1000, keep_recent_turns: 0 },
    };

    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-compaction",
      accessManager: am,
      provider,
      broker: noopBroker(),
      emitter,
      systemPrompt: "you are a test assistant",
      config,
    });
    ref.runtime = runtime;

    runtime.submit({ kind: "conversational", text: `a long question ${"x".repeat(5000)}` });
    await waitFor(() => provider.calls.length >= 2);
    await waitUntilIdle(runtime);

    const store = openSessionStore(am.grant(alice, "session-store"));
    const kinds = store.readSession("sess-compaction").map((e) => e.kind);
    expect(kinds.filter((k) => k === "compaction")).toHaveLength(1);
    expect(kinds[kinds.length - 1]).toBe("compaction"); // marker is the tail
    store.close();

    runtime.submit({ kind: "conversational", text: "follow up" });
    await waitUntilIdle(runtime);

    // messages[0] is the loop's own system prompt; [1] is the projection
    // head (the summary); [2] is the new user message.
    const followUp = provider.calls[2];
    expect(followUp?.messages[1]?.role).toBe("system");
    expect(followUp?.messages[1]?.content).toContain("EARLIER-SUMMARY");
    expect(followUp?.messages[2]?.content).toBe("follow up");

    runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Voice fork (spec §6, §4.7 — Plan 3 Task 2). SessionRuntime is the ONLY
// driver of `TurnVoice`, and the composition is load-bearing in a way no
// other test file can see: turn-voice.test.ts builds its own AbortController,
// so it proves TurnVoice honours *a* signal, never that the signal it gets in
// production is the TURN'S OWN one.
//
// That distinction IS §4.7's barge-in guarantee. If a refactor mints a fresh
// controller for `voice.begin(...)` — the obvious-looking option the task's
// composition-root section explicitly rejects — barge-in would abort the turn
// while TTS kept draining, and the assistant would talk over the user. It
// would compile, typecheck, and pass every other test in the repo. So the
// cases below pin the four wiring points by identity, not by shape:
//   1. deltas fork to `pushText`, tool updates fork to `flush(toolCallId)`;
//   2. settle closes the text stream with exactly one `end()`;
//   3. `bargeIn()` aborts the very AbortSignal instance handed to `begin()`;
//   4. `interrupt()` does the same.
// ---------------------------------------------------------------------------

interface VoiceCall {
  turnId: string;
  /** The signal instance `begin()` was handed — asserted by identity below. */
  signal: AbortSignal;
  pushed: string[];
  flushed: string[];
  ends: number;
  /** Audio OUTLIVES the turn: `end()` closes only the text queue, so this
   *  stays true until a cancel gesture cuts the drain. */
  audioLive: boolean;
}

interface RecordingVoice extends TurnVoice {
  calls: VoiceCall[];
  /** turnIds reported cut, one entry per `cancelAudio()` call. */
  cancelledAudio: string[][];
}

function recordingVoice(): RecordingVoice {
  const calls: VoiceCall[] = [];
  const cancelledAudio: string[][] = [];
  return {
    calls,
    cancelledAudio,
    // Mirrors turn-voice.ts: reports the turns whose audio was still live.
    // Deliberately independent of the turns' own signals — that independence
    // is the whole point of the tail-window fix.
    cancelAudio(): string[] {
      const cut = calls.filter((c) => c.audioLive).map((c) => c.turnId);
      for (const call of calls) call.audioLive = false;
      cancelledAudio.push(cut);
      return cut;
    },
    begin(turnId, signal): TurnVoiceStream {
      const call: VoiceCall = { turnId, signal, pushed: [], flushed: [], ends: 0, audioLive: true };
      calls.push(call);
      return {
        pushText: (text) => {
          call.pushed.push(text);
        },
        // Records EVERY forward: de-duplication per toolCallId is
        // turn-voice.ts's contract (pinned in turn-voice.test.ts), not the
        // runtime's — the runtime must forward each status transition.
        flush: (toolCallId) => {
          call.flushed.push(toolCallId);
        },
        end: () => {
          call.ends += 1;
        },
      };
    },
  };
}

describe("SessionRuntime — voice fork: loop output reaches the turn's TTS stream", () => {
  it("forks text deltas and the tool call id into the turn's voice stream", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/voice-fork` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    const provider = fakeProvider(async function* (callIndex) {
      if (callIndex === 1) {
        yield { type: "text", content: "Let me check." };
        yield {
          type: "tool_call",
          toolCall: { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } },
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text", content: "It is sunny." };
      yield { type: "done", finishReason: "stop" };
    });

    const voice = recordingVoice();
    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-voice-fork",
      accessManager: am,
      provider,
      broker: fakeBroker([weatherDef], async () => ({ content: "sunny", isError: false })),
      emitter: recordingEmitter(),
      systemPrompt: "you are a test assistant",
      config: testConfig(),
      voice,
    });

    runtime.submit({ kind: "conversational", text: "what is the weather?" });
    await waitUntilIdle(runtime);

    expect(voice.calls).toHaveLength(1);
    expect(voice.calls[0]?.pushed).toEqual(["Let me check.", "It is sunny."]);
    // The loop's tool-call id must reach the voice stream so local-tts speaks
    // the pre-tool line now instead of holding it for the round trip.
    expect(voice.calls[0]?.flushed).toContain("call_1");
    expect(voice.calls[0]?.flushed.every((id) => id === "call_1")).toBe(true);

    runtime.dispose();
  });

  it("ends the turn's voice stream exactly once when the turn settles", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/voice-end` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    const provider = fakeProvider(async function* () {
      yield { type: "text", content: "done talking" };
      yield { type: "done", finishReason: "stop" };
    });

    const voice = recordingVoice();
    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-voice-end",
      accessManager: am,
      provider,
      broker: noopBroker(),
      emitter: recordingEmitter(),
      systemPrompt: "you are a test assistant",
      config: testConfig(),
      voice,
    });

    runtime.submit({ kind: "conversational", text: "say something" });
    await waitUntilIdle(runtime);

    expect(voice.calls[0]?.ends).toBe(1);

    // A second turn gets its OWN stream — the session-scoped TurnVoice is
    // begun per turn, never reused across turns.
    runtime.submit({ kind: "conversational", text: "again" });
    await waitUntilIdle(runtime);

    expect(voice.calls).toHaveLength(2);
    expect(voice.calls[1]?.turnId).not.toBe(voice.calls[0]?.turnId);
    expect(voice.calls[1]?.ends).toBe(1);
    expect(voice.calls[0]?.ends).toBe(1); // not re-ended by the second turn

    runtime.dispose();
  });
});

describe("SessionRuntime — voice fork: the turn's own AbortSignal drives TTS", () => {
  it("INVARIANT: bargeIn() aborts the exact AbortSignal instance handed to voice.begin()", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/voice-bargein` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    const provider = partialReplyThenHangProvider("mid sentence");
    const voice = recordingVoice();
    const emitter = recordingEmitter();

    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-voice-bargein",
      accessManager: am,
      provider,
      broker: fakeBrokerWithBackground(spyBackgroundRegistry()),
      emitter,
      systemPrompt: "you are a test assistant",
      config: testConfig(),
      voice,
    });

    runtime.submit({ kind: "conversational", text: "tell me something" });
    await waitFor(() => emitter.events.some((e) => e.type === "textDelta"));

    const turnStarted = emitter.events.find((e) => e.type === "turnStarted");
    expect(voice.calls[0]?.turnId).toBe(turnStarted?.turnId ?? "");
    expect(voice.calls[0]?.signal.aborted).toBe(false);

    runtime.bargeIn();

    // Synchronous: bargeIn() aborts the turn's controller, and TTS dies with
    // it because that is the same object `begin()` was given. A separately
    // minted TTS controller would leave this false and let the assistant keep
    // talking over the user.
    expect(voice.calls[0]?.signal.aborted).toBe(true);

    await waitUntilIdle(runtime);
    runtime.dispose();
  });

  it("INVARIANT: interrupt() aborts the exact AbortSignal instance handed to voice.begin()", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/voice-interrupt` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    const provider = partialReplyThenHangProvider("stopping now");
    const voice = recordingVoice();
    const emitter = recordingEmitter();

    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-voice-interrupt",
      accessManager: am,
      provider,
      broker: fakeBrokerWithBackground(spyBackgroundRegistry()),
      emitter,
      systemPrompt: "you are a test assistant",
      config: testConfig(),
      voice,
    });

    runtime.submit({ kind: "conversational", text: "do a long task" });
    await waitFor(() => emitter.events.some((e) => e.type === "textDelta"));

    expect(voice.calls[0]?.signal.aborted).toBe(false);

    runtime.interrupt();

    expect(voice.calls[0]?.signal.aborted).toBe(true);

    await waitUntilIdle(runtime);
    runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// turn.aborted producer (spec §4.7, Plan 3 Task 6). `cancellation.ts` commits
// the cutoff-stamped entry and calls `emitter.turnAborted`; this pins the
// PRODUCER end — that the frame actually reaches the emitter, carries the
// cutoff kind, and fires exactly ONCE for a repeated gesture — so a future
// refactor of the cutoff path cannot silently go log-only again.
// ---------------------------------------------------------------------------

describe("SessionRuntime — turn.aborted producer", () => {
  it("fires turnAborted exactly once with cutoff=interrupt for the in-flight turn", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/abort-frame` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    // Streams one delta then blocks on the turn's own AbortSignal, so the
    // turn is reliably mid-flight when interrupt() lands.
    const provider = partialReplyThenHangProvider("thinking");
    const emitter = recordingEmitter();
    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "session-abort",
      accessManager: am,
      provider,
      broker: fakeBrokerWithBackground(spyBackgroundRegistry()),
      emitter,
      systemPrompt: "test",
      config: testConfig(),
    });

    runtime.submit({ kind: "conversational", text: "hello" });
    await waitFor(() => emitter.events.some((e) => e.type === "textDelta"));

    runtime.interrupt();
    runtime.interrupt(); // idempotent — must NOT produce a second frame

    const aborted = emitter.events.filter((e) => e.type === "turnAborted");
    expect(aborted).toHaveLength(1);
    expect(aborted[0]?.cutoff).toBe("interrupt");
    expect(emitter.events.filter((e) => e.type === "turnCompleted")).toHaveLength(0);

    await waitUntilIdle(runtime);
    runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Committed-feed producer (spec §3.2/§3.4, §7). The `turn.*` family is a live,
// disposable stream — the client drops it on `turn.completed`. These cases pin
// that `conversation.entry` actually reaches the emitter at the two lifecycle
// points that matter, because a producer that exists but is never called
// leaves the chat empty in exactly the way the whole-branch review found.
// Convergence of the frames themselves is pinned in conversation-feed.test.ts.
// ---------------------------------------------------------------------------

describe("SessionRuntime — committed-feed producer", () => {
  it("commits the USER entry to the feed before the turn it triggers even starts", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/feed-user` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    const provider = fakeProvider(async function* () {
      yield { type: "text", content: "hi there" };
      yield { type: "done", finishReason: "stop" };
    });
    const emitter = recordingEmitter();
    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-feed-user",
      accessManager: am,
      provider,
      broker: noopBroker(),
      emitter,
      systemPrompt: "test",
      config: testConfig(),
    });

    runtime.submit({ kind: "conversational", text: "hello" });

    // Synchronous: the user's own bubble must not wait on the model.
    const first = emitter.events[0];
    expect(first?.type).toBe("conversationEntry");
    expect(first?.item).toMatchObject({ kind: "user", content: "hello", channel: "text" });
    expect(emitter.events[1]?.type).toBe("turnStarted");

    await waitUntilIdle(runtime);
    runtime.dispose();
  });

  it("commits the assistant entry to the feed BEFORE turn.completed clears the live bubble", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/feed-assistant` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    const provider = fakeProvider(async function* () {
      yield { type: "text", content: "the answer" };
      yield { type: "done", finishReason: "stop" };
    });
    const emitter = recordingEmitter();
    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-feed-assistant",
      accessManager: am,
      provider,
      broker: noopBroker(),
      emitter,
      systemPrompt: "test",
      config: testConfig(),
    });

    runtime.submit({ kind: "conversational", text: "ask" });
    await waitUntilIdle(runtime);

    const kinds = emitter.events.map((e) => e.type);
    const assistantIdx = emitter.events.findIndex(
      (e) => e.type === "conversationEntry" && e.item?.kind === "assistant",
    );
    expect(assistantIdx).toBeGreaterThan(-1);
    expect(assistantIdx).toBeLessThan(kinds.indexOf("turnCompleted"));

    const committed = emitter.events[assistantIdx];
    expect(committed?.item).toMatchObject({ kind: "assistant", content: "the answer" });
    // The join key is the entry's OWN turn, so the client folds the committed
    // twin into its live bubble instead of rendering a second one.
    expect(committed?.turnId).toBe(emitter.events.find((e) => e.type === "turnStarted")?.turnId ?? "");

    runtime.dispose();
  });

  it("emitConversationSnapshot replays the whole session for a reconnecting client", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/feed-snapshot` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    const provider = fakeProvider(async function* () {
      yield { type: "text", content: "remembered" };
      yield { type: "done", finishReason: "stop" };
    });
    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-feed-snapshot",
      accessManager: am,
      provider,
      broker: noopBroker(),
      emitter: recordingEmitter(),
      systemPrompt: "test",
      config: testConfig(),
    });
    runtime.submit({ kind: "conversational", text: "say something" });
    await waitUntilIdle(runtime);
    runtime.dispose();

    // A brand new connection for the same session — what session.configure does.
    const reconnectEmitter = recordingEmitter();
    const reconnected = createSessionRuntime({
      principal: alice,
      sessionId: "sess-feed-snapshot",
      accessManager: am,
      provider,
      broker: noopBroker(),
      emitter: reconnectEmitter,
      systemPrompt: "test",
      config: testConfig(),
    });
    reconnected.emitConversationSnapshot();

    const snapshot = reconnectEmitter.events.find((e) => e.type === "conversationSnapshot");
    expect(snapshot?.items?.map((i) => i.kind)).toEqual(["user", "assistant"]);

    // Armed at the snapshot's tail: the next turn's entries must not re-send
    // history the client already has.
    reconnected.submit({ kind: "conversational", text: "again" });
    const afterSnapshot = reconnectEmitter.events
      .slice(reconnectEmitter.events.indexOf(snapshot as RecordedEvent) + 1)
      .filter((e) => e.type === "conversationEntry");
    expect(afterSnapshot.map((e) => e.item?.kind)).toEqual(["user"]);

    await waitUntilIdle(reconnected);
    reconnected.dispose();
  });
});

// ---------------------------------------------------------------------------
// The audio tail window (spec §4.7). TTS OUTLIVES its turn: `onTurnSettled`
// closes only the text queue, and a turn that completes naturally never aborts
// its own controller. Every gesture landing between "final entry committed"
// and "playback finished" used to be a no-op server-side — the gateway kept
// writing frames, the client never learned to flush, and the assistant audibly
// resumed talking after the user pressed Stop.
//
// Cancelling audio and committing a cutoff entry are separate concerns: the
// double-commit guard still owns the second, and must stay untouched by the
// first.
// ---------------------------------------------------------------------------

describe("SessionRuntime — cancellation reaches the audio tail", () => {
  it("INVARIANT: interrupt() after a natural completion still cuts audio and flushes playback", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/tail-interrupt` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    const provider = fakeProvider(async function* () {
      yield { type: "text", content: "a long spoken reply" };
      yield { type: "done", finishReason: "stop" };
    });
    const background = spyBackgroundRegistry();
    const voice = recordingVoice();
    const emitter = recordingEmitter();
    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-tail-interrupt",
      accessManager: am,
      provider,
      broker: fakeBrokerWithBackground(background),
      emitter,
      systemPrompt: "test",
      config: testConfig(),
      voice,
    });

    runtime.submit({ kind: "conversational", text: "tell me a story" });
    await waitUntilIdle(runtime);

    // The turn is over and its own signal was never aborted — this is exactly
    // the window the old guard treated as "nothing to do".
    expect(voice.calls[0]?.signal.aborted).toBe(false);
    expect(emitter.events.some((e) => e.type === "turnCompleted")).toBe(true);

    runtime.interrupt();

    expect(voice.cancelledAudio).toEqual([[voice.calls[0]?.turnId ?? ""]]);
    const stops = emitter.events.filter((e) => e.type === "playbackStop");
    expect(stops).toHaveLength(1);
    expect(stops[0]?.cutoff).toBe("interrupt");
    expect(stops[0]?.turnId).toBe(voice.calls[0]?.turnId ?? "");

    // The double-commit guard still holds: no second cutoff entry, no
    // turn.aborted racing the legitimate turn.completed.
    const readback = openSessionStore(am.grant(alice, "session-store"));
    const assistantEntries = readback.readSession("sess-tail-interrupt").filter((e) => e.kind === "assistant");
    expect(assistantEntries).toHaveLength(1);
    expect(assistantEntries[0]?.cutoff).toBeNull();
    readback.close();
    expect(emitter.events.some((e) => e.type === "turnAborted")).toBe(false);
    // interrupt's unconditional reach into background tasks is unaffected.
    expect(background.cancelAllCalls).toBe(1);

    runtime.dispose();
  });

  it("INVARIANT: bargeIn() during the audio tail flushes playback but leaves background tasks alone", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/tail-bargein` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    const provider = fakeProvider(async function* () {
      yield { type: "text", content: "still speaking" };
      yield { type: "done", finishReason: "stop" };
    });
    const background = spyBackgroundRegistry();
    background.register("task-1", () => {});
    const voice = recordingVoice();
    const emitter = recordingEmitter();
    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-tail-bargein",
      accessManager: am,
      provider,
      broker: fakeBrokerWithBackground(background),
      emitter,
      systemPrompt: "test",
      config: testConfig(),
      voice,
    });

    runtime.submit({ kind: "conversational", text: "keep talking" });
    await waitUntilIdle(runtime);

    runtime.bargeIn();

    const stops = emitter.events.filter((e) => e.type === "playbackStop");
    expect(stops).toHaveLength(1);
    expect(stops[0]?.cutoff).toBe("barge-in");
    expect(background.cancelAllCalls).toBe(0);
    expect(background.count()).toBe(1);

    runtime.dispose();
  });

  it("INVARIANT: dispose() cuts a drain that outlived its turn, so no drain is ever orphaned", async () => {
    // Teardown lands in the SAME tail window as a late gesture: the turn
    // settled naturally, so `inFlight` is null and its controller was never
    // aborted — `inFlight?.controller.abort()` alone is a no-op there. And a
    // drain missed HERE is unreachable FOREVER: ws-session-configure.ts mints a
    // brand-new TurnVoice (with its own empty `draining` map) on the next
    // session.configure, so no later bargeIn()/interrupt() can ever see it. It
    // would keep pulling frames from local-tts and writing them at a dead (or
    // reassigned) socket for the rest of the reply.
    const am = createAccessManager({ userDataRoot: `${ROOT}/dispose-tail` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    const provider = fakeProvider(async function* () {
      yield { type: "text", content: "a reply whose speech outlasts it" };
      yield { type: "done", finishReason: "stop" };
    });
    const voice = recordingVoice();
    const emitter = recordingEmitter();
    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-dispose-tail",
      accessManager: am,
      provider,
      broker: noopBroker(),
      emitter,
      systemPrompt: "test",
      config: testConfig(),
      voice,
    });

    runtime.submit({ kind: "conversational", text: "tell me a story" });
    await waitUntilIdle(runtime);
    expect(voice.calls[0]?.signal.aborted).toBe(false);

    runtime.dispose();

    expect(voice.cancelledAudio).toEqual([[voice.calls[0]?.turnId ?? ""]]);
    // Teardown is NOT a user gesture: the socket is closing (or already
    // belongs to the next runtime), so there is no one to command a flush.
    expect(emitter.events.some((e) => e.type === "playbackStop")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case: dispose() lands WHILE a turn is in flight — a tab closed or reloaded
// mid-reply (server.ts's close hook → cleanupSession), or the newer connection
// of a same-tab reload evicting the superseded one before its close event
// fires (conversation-runtime-registry.ts).
//
// PROCESS-LEVEL INVARIANT, not a cosmetic one. `dispose()` closes the
// bun:sqlite handle SYNCHRONOUSLY, but the turn's settle continuation runs
// LATER, on `runTurn`'s detached `.then` chain. Any store read there raises
// "Statement has finalized"; inside a detached promise that is an
// `unhandledRejection`, and Bun answers one by EXITING the process — the whole
// gateway, for every connected user, because one tab reloaded.
//
// The assertion mechanism is the test runner itself: Bun surfaces an escaped
// rejection as a failure of whichever test is running, so a settle path that
// throws cannot make this file pass. The explicit expectations below pin the
// second half — a disposed runtime stops doing work rather than merely
// surviving it: no terminal frame at a socket that is gone, no committed-feed
// publish against a closed handle, and the one-turn lock released so nothing
// leaks.
// ---------------------------------------------------------------------------

describe("SessionRuntime — dispose while a turn is in flight", () => {
  it("INVARIANT: a turn that settles after dispose() neither throws nor emits", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/dispose-in-flight` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    // Park the turn mid-stream so dispose() lands with `inFlight` still set —
    // exactly the state a mid-reply tab close leaves behind.
    let signalStreamStarted: (() => void) | undefined;
    const streamStarted = new Promise<void>((resolve) => {
      signalStreamStarted = resolve;
    });
    let releaseStream: (() => void) | undefined;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });

    const provider = fakeProvider(async function* () {
      yield { type: "text", content: "half a reply" };
      signalStreamStarted?.();
      await streamGate;
      yield { type: "done", finishReason: "stop" };
    });

    const emitter = recordingEmitter();
    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-dispose-in-flight",
      accessManager: am,
      provider,
      broker: noopBroker(),
      emitter,
      systemPrompt: "test",
      config: testConfig(),
    });

    runtime.submit({ kind: "conversational", text: "tell me a story" });
    await streamStarted;
    expect(runtime.running).toBe(true);

    runtime.dispose(); // closes the store handle; the turn is still in flight
    releaseStream?.(); // the settle continuation now runs against that closed handle

    await waitUntilIdle(runtime);

    expect(emitter.events.filter((e) => e.type === "turnCompleted")).toHaveLength(0);
    expect(emitter.events.filter((e) => e.type === "conversationEntry" && e.turnId !== "")).toHaveLength(1);
  });

  it("INVARIANT: dispose() stays idempotent and leaves every gesture inert", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/dispose-idempotent` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    const provider = fakeProvider(async function* () {
      yield { type: "text", content: "done" };
      yield { type: "done", finishReason: "stop" };
    });
    const emitter = recordingEmitter();
    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-dispose-idempotent",
      accessManager: am,
      provider,
      broker: noopBroker(),
      emitter,
      systemPrompt: "test",
      config: testConfig(),
    });

    runtime.submit({ kind: "conversational", text: "hi" });
    await waitUntilIdle(runtime);

    runtime.dispose();
    const eventCount = emitter.events.length;

    // A stale caller — a background completion, a late STT turn_started, a
    // reconnect racing the close — must not reach the closed handle.
    expect(() => runtime.dispose()).not.toThrow();
    expect(() => runtime.bargeIn()).not.toThrow();
    expect(() => runtime.interrupt()).not.toThrow();
    expect(() => runtime.emitConversationSnapshot()).not.toThrow();
    expect(() => runtime.submit({ kind: "conversational", text: "anyone there?" })).not.toThrow();

    expect(emitter.events).toHaveLength(eventCount);
  });
});
