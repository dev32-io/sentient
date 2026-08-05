import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import type { OrchestratorConfig } from "@sentient/config";
import type { Capability } from "../access/capability.js";
import type { ProviderClient, ProviderRequest, ProviderStreamChunk } from "../provider/provider-client.js";
import { projectForClient } from "../store/client-projection.js";
import type { NewSessionEntry } from "../store/entry-types.js";
import { projectForModel } from "../store/model-projection.js";
import { openSessionStore } from "../store/session-store.js";
import { createCompactionGate, maybeCompact } from "./compaction.js";

const ROOT = "/tmp/sentient-compaction-test";
mkdirSync(`${ROOT}/u_aaaaaaaa`, { recursive: true });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const cap: Capability = Object.freeze({
  ownerUserId: "u_aaaaaaaa",
  resource: "session-store",
  rootPath: `${ROOT}/u_aaaaaaaa`,
});

// keep_recent_turns = 1: the newest turn rides verbatim in the marker, the
// rest is summarized. Threshold is tiny so LONG_TEXT alone trips it.
const config: OrchestratorConfig["compaction"] = {
  enabled: true,
  compact_threshold_tokens: 1000,
  keep_recent_turns: 1,
  summarizer_max_output_tokens: 4000,
  max_consecutive_failures: 3,
  max_backoff_turns: 16,
};

/** ~1250 estimated tokens of latin filler — comfortably over the threshold. */
const LONG_TEXT = "x".repeat(5000);

function entry(overrides: Partial<NewSessionEntry>): NewSessionEntry {
  return {
    sessionId: "s1",
    turnId: "t1",
    messageId: null,
    kind: "user",
    createdAt: 1000,
    text: null,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
    pendingId: null,
    ...overrides,
  };
}

interface FakeProvider extends ProviderClient {
  calls: ProviderRequest[];
}

/** `calls.push` happens in `stream()` itself, NOT inside the generator body,
 *  so "the provider was never called" is assertable even though nothing
 *  consumes the stream. `onStream` runs at call time too — that is how the
 *  race case injects an append into the summarization window. */
function fakeProvider(summary: string, onStream?: () => void, finishReason = "stop"): FakeProvider {
  const calls: ProviderRequest[] = [];
  return {
    calls,
    stream(req: ProviderRequest): AsyncGenerator<ProviderStreamChunk> {
      calls.push(req);
      onStream?.();
      return (async function* () {
        yield { type: "text", content: summary } as ProviderStreamChunk;
        yield { type: "done", finishReason } as ProviderStreamChunk;
      })();
    },
  };
}

function deps(sessionId: string, store: ReturnType<typeof openSessionStore>, provider: FakeProvider) {
  return {
    store,
    provider,
    sessionId,
    userId: "u_aaaaaaaa" as const,
    turnId: "turn-2",
    config,
    summarizerPrompt: "you are the context compactor",
    signal: new AbortController().signal,
  };
}

describe("compaction — the producer of kind:'compaction' entries", () => {
  it("CONTRACT: the marker it appends leaves a valid, summary-only model window", async () => {
    const store = openSessionStore(cap);
    const sessionId = "case-valid-window";
    // Turn 1 — a complete foreground tool round trip, long enough to trip
    // the threshold.
    store.append(entry({ sessionId, turnId: "turn-1", kind: "user", text: `weather in SF? ${LONG_TEXT}` }));
    store.append(
      entry({
        sessionId,
        turnId: "turn-1",
        kind: "tool_call",
        toolCallId: "call_1",
        toolName: "get_weather",
        toolArgs: '{"city":"SF"}',
      }),
    );
    store.append(
      entry({
        sessionId,
        turnId: "turn-1",
        kind: "tool_result",
        toolCallId: "call_1",
        toolName: "get_weather",
        toolArgs: '{"tempC":20}',
      }),
    );
    store.append(entry({ sessionId, turnId: "turn-1", kind: "assistant", text: "It is 20C in SF." }));
    // Turn 2 — the kept-verbatim turn (keep_recent_turns = 1).
    store.append(entry({ sessionId, turnId: "turn-2", kind: "user", text: "and tomorrow?" }));
    store.append(entry({ sessionId, turnId: "turn-2", kind: "assistant", text: "Rain tomorrow." }));

    const before = store.readSession(sessionId);
    // `?? null` matches CompactionOutcome["compactedThroughSeq"]'s own
    // `number | null`; an empty store would surface as null-vs-number, which
    // is still a real failure, not a silently-passing undefined.
    const tailSeq = before[before.length - 1]?.seq ?? null;

    const provider = fakeProvider("The user asked about SF weather; the assistant reported 20C.");
    const outcome = await maybeCompact(deps(sessionId, store, provider));

    expect(outcome.compacted).toBe(true);
    expect(outcome.compactedThroughSeq).toBe(tailSeq);

    // The marker is positional: it supersedes everything before it, so the
    // whole model window is one system message carrying summary + verbatim
    // tail — and nothing dangling that a provider would 400 on.
    const messages = projectForModel(store.readSession(sessionId));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("reported 20C");
    expect(messages[0]?.content).toContain("and tomorrow?");
    expect(messages.some((m) => m.role === "tool")).toBe(false);
    store.close();
  });

  it("INVARIANT: refuses a tail that would split a tool_call from its tool_result", async () => {
    const store = openSessionStore(cap);
    const sessionId = "case-unsafe-tail";
    store.append(entry({ sessionId, turnId: "turn-1", kind: "user", text: LONG_TEXT }));
    store.append(entry({ sessionId, turnId: "turn-1", kind: "assistant", text: "ok" }));
    store.append(entry({ sessionId, turnId: "turn-2", kind: "user", text: "look it up" }));
    // Turn aborted mid-dispatch: a tool_call whose result may still land.
    store.append(
      entry({
        sessionId,
        turnId: "turn-2",
        kind: "tool_call",
        toolCallId: "call_9",
        toolName: "search",
        toolArgs: "{}",
      }),
    );

    const provider = fakeProvider("must never be produced");
    const outcome = await maybeCompact(deps(sessionId, store, provider));

    expect(outcome.compacted).toBe(false);
    expect(outcome.reason).toBe("unsafe-boundary");
    expect(provider.calls).toHaveLength(0);
    expect(store.readSession(sessionId).some((e) => e.kind === "compaction")).toBe(false);
    store.close();
  });

  it("does not call the provider when the model window is under the threshold", async () => {
    const store = openSessionStore(cap);
    const sessionId = "case-below-threshold";
    store.append(entry({ sessionId, turnId: "turn-1", kind: "user", text: "hi" }));
    store.append(entry({ sessionId, turnId: "turn-1", kind: "assistant", text: "hello" }));
    store.append(entry({ sessionId, turnId: "turn-2", kind: "user", text: "bye" }));
    store.append(entry({ sessionId, turnId: "turn-2", kind: "assistant", text: "bye" }));

    const provider = fakeProvider("never");
    const outcome = await maybeCompact(deps(sessionId, store, provider));

    expect(outcome.reason).toBe("below-threshold");
    expect(provider.calls).toHaveLength(0);
    expect(store.readSession(sessionId).some((e) => e.kind === "compaction")).toBe(false);
    store.close();
  });

  it("CONTRACT: the client feed still renders the full pre-compaction history", async () => {
    const store = openSessionStore(cap);
    const sessionId = "case-client-feed";
    store.append(entry({ sessionId, turnId: "turn-1", kind: "user", text: `remember this: ${LONG_TEXT}` }));
    store.append(entry({ sessionId, turnId: "turn-1", kind: "assistant", text: "noted" }));
    store.append(entry({ sessionId, turnId: "turn-2", kind: "user", text: "thanks" }));
    store.append(entry({ sessionId, turnId: "turn-2", kind: "assistant", text: "anytime" }));

    const before = projectForClient(store.readSession(sessionId));
    const outcome = await maybeCompact(deps(sessionId, store, fakeProvider("a summary")));
    expect(outcome.compacted).toBe(true);

    // §3.4: compaction shrinks what the MODEL replays, never what the user
    // sees. Marker entries are invisible to the client projection.
    expect(projectForClient(store.readSession(sessionId))).toEqual(before);
    store.close();
  });

  it("INVARIANT: skips the append when an entry lands during summarization — a steer is never swallowed", async () => {
    const store = openSessionStore(cap);
    const sessionId = "case-race";
    store.append(entry({ sessionId, turnId: "turn-1", kind: "user", text: LONG_TEXT }));
    store.append(entry({ sessionId, turnId: "turn-1", kind: "assistant", text: "ok" }));
    store.append(entry({ sessionId, turnId: "turn-2", kind: "user", text: "second question" }));
    store.append(entry({ sessionId, turnId: "turn-2", kind: "assistant", text: "second answer" }));

    // The steer lands INSIDE the summarization window — the exact hazard the
    // guard exists for. A marker appended over it would make it invisible to
    // the model forever (model-projection slices positionally).
    const provider = fakeProvider("a summary", () => {
      store.append(entry({ sessionId, turnId: "turn-2", kind: "user", text: "wait, also check the calendar" }));
    });

    const outcome = await maybeCompact(deps(sessionId, store, provider));

    expect(outcome.compacted).toBe(false);
    expect(outcome.reason).toBe("raced-with-append");
    expect(store.readSession(sessionId).some((e) => e.kind === "compaction")).toBe(false);
    const messages = projectForModel(store.readSession(sessionId));
    expect(messages.some((m) => (m.content ?? "").includes("wait, also check the calendar"))).toBe(true);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// D4: the summarizer's own budget, and not thrashing when it fails.
// ---------------------------------------------------------------------------

describe("compaction — summarizer request shape", () => {
  it("CONTRACT: the summarizer request carries its OWN output budget, not the loop's answer cap", async () => {
    const store = openSessionStore(cap);
    const sessionId = "case-summarizer-budget";
    store.append(entry({ sessionId, turnId: "t1", kind: "user", text: LONG_TEXT }));
    store.append(entry({ sessionId, turnId: "t1", kind: "assistant", text: LONG_TEXT }));
    store.append(entry({ sessionId, turnId: "t2", kind: "user", text: "and now?" }));
    store.append(entry({ sessionId, turnId: "t2", kind: "assistant", text: "here you go" }));

    const provider = fakeProvider("a summary");
    const outcome = await maybeCompact(deps(sessionId, store, provider));

    expect(outcome.compacted).toBe(true);
    // gpt-oss:20b spends the whole cap on its Harmony reasoning channel and
    // returns finish_reason:"length" with NO visible text when this is the
    // loop's 1024 answer cap — observed 2/2 live.
    expect(provider.calls[0]?.maxOutputTokens).toBe(config.summarizer_max_output_tokens);
    store.close();
  });

  it("INVARIANT: an empty summary is never appended as a compaction entry", async () => {
    const store = openSessionStore(cap);
    const sessionId = "case-empty-summary";
    store.append(entry({ sessionId, turnId: "t1", kind: "user", text: LONG_TEXT }));
    store.append(entry({ sessionId, turnId: "t1", kind: "assistant", text: LONG_TEXT }));
    store.append(entry({ sessionId, turnId: "t2", kind: "user", text: "and now?" }));
    store.append(entry({ sessionId, turnId: "t2", kind: "assistant", text: "here you go" }));
    const before = store.readSession(sessionId).length;

    // What finish_reason:"length" on the reasoning channel looks like here.
    const outcome = await maybeCompact(deps(sessionId, store, fakeProvider("   \n  ")));

    expect(outcome.compacted).toBe(false);
    expect(outcome.reason).toBe("empty-summary");
    // A marker supersedes EVERY entry before it positionally, so an empty one
    // would blank the model window while the client still rendered everything.
    expect(store.readSession(sessionId).length).toBe(before);
    expect(store.readSession(sessionId).some((e) => e.kind === "compaction")).toBe(false);
    store.close();
  });

  it("CONTRACT: an empty summary carries the provider's terminal finishReason onto the outcome", async () => {
    const store = openSessionStore(cap);
    const sessionId = "case-empty-summary-diagnosis";
    store.append(entry({ sessionId, turnId: "t1", kind: "user", text: LONG_TEXT }));
    store.append(entry({ sessionId, turnId: "t1", kind: "assistant", text: LONG_TEXT }));
    store.append(entry({ sessionId, turnId: "t2", kind: "user", text: "and now?" }));
    store.append(entry({ sessionId, turnId: "t2", kind: "assistant", text: "here you go" }));

    // Exactly what the real gpt-oss:20b-cloud failure looked like: the whole
    // budget spent on the Harmony reasoning channel, terminal chunk says
    // "length", zero visible text. Verified live 2/2 before the budget fix.
    const outcome = await maybeCompact(deps(sessionId, store, fakeProvider("", undefined, "length")));

    expect(outcome.reason).toBe("empty-summary");
    // Without this the operator sees a bare "empty-summary" and cannot tell an
    // exhausted output budget (raise summarizer_max_output_tokens) from a model
    // that simply returned nothing. It is the one fact that makes the gate's
    // loud ERROR actionable.
    expect(outcome.finishReason).toBe("length");
    store.close();
  });
});

describe("compaction gate — a failing summarizer must not thrash", () => {
  const failed = {
    compacted: false,
    reason: "empty-summary",
    estimatedTokens: 9000,
    compactedThroughSeq: null,
    // The live shape: budget exhausted on the reasoning channel.
    finishReason: "length",
  } as const;
  const succeeded = {
    compacted: true,
    reason: "compacted",
    estimatedTokens: 9000,
    compactedThroughSeq: 61,
    finishReason: "stop",
  } as const;

  it("INVARIANT: past max_consecutive_failures it stops attempting at every turn boundary", () => {
    const gate = createCompactionGate(3, 16);
    // maybeCompact runs at EVERY turn end, so an ungated failure is one real
    // provider call per turn, forever, while the window it should bound grows.
    for (let i = 0; i < 3; i += 1) {
      expect(gate.shouldAttempt()).toBe(true);
      gate.record(failed);
    }
    // 3rd failure armed a 1-turn skip; the 4th a 2-turn skip.
    expect(gate.shouldAttempt()).toBe(false);
    expect(gate.shouldAttempt()).toBe(true);
    gate.record(failed);
    expect(gate.shouldAttempt()).toBe(false);
    expect(gate.shouldAttempt()).toBe(false);
    expect(gate.shouldAttempt()).toBe(true);
  });

  // INVARIANT (defect D10). `2 ** (failures - max)` doubled forever: after ~20
  // extra failures the next attempt is 1M turn boundaries away, which in a long
  // session is indistinguishable from the permanent give-up the comment above
  // says this gate deliberately is NOT. The cap makes the widening stop, and it
  // must be VISIBLE when it does — a silent ceiling is the same failure wearing
  // a smaller number.
  it("INVARIANT: the backoff stops widening at max_backoff_turns instead of doubling forever", () => {
    const cap = 4;
    const gate = createCompactionGate(1, cap);
    // Failure 1 arms 2**0 = 1, then 2, then 4, then the cap holds at 4.
    for (const expected of [1, 2, 4, 4, 4]) {
      gate.record(failed);
      let skipped = 0;
      while (!gate.shouldAttempt()) skipped += 1;
      expect(skipped).toBe(expected);
    }
  });

  it("INVARIANT: a success clears the streak, and a normal below-threshold turn never counts as one", () => {
    const gate = createCompactionGate(2, 16);
    gate.record(failed);
    gate.record(succeeded);
    // Streak cleared: two more failures are needed to back off again.
    expect(gate.shouldAttempt()).toBe(true);
    gate.record(failed);
    expect(gate.shouldAttempt()).toBe(true);

    const idle = createCompactionGate(1, 16);
    // below-threshold is the steady state at most turn boundaries.
    const idleOutcome = {
      compacted: false,
      estimatedTokens: 10,
      compactedThroughSeq: null,
      finishReason: null,
    } as const;
    idle.record({ ...idleOutcome, reason: "below-threshold" });
    idle.record({ ...idleOutcome, reason: "nothing-to-summarize" });
    idle.record({ ...idleOutcome, reason: "raced-with-append", finishReason: "stop" });
    expect(idle.shouldAttempt()).toBe(true);
  });
});
