import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import type { OrchestratorConfig } from "@sentient/config";
import type { Capability } from "../access/capability.js";
import type { ProviderClient, ProviderRequest, ProviderStreamChunk } from "../provider/provider-client.js";
import { projectForClient } from "../store/client-projection.js";
import type { NewSessionEntry } from "../store/entry-types.js";
import { projectForModel } from "../store/model-projection.js";
import { openSessionStore } from "../store/session-store.js";
import { maybeCompact } from "./compaction.js";

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
};

/** ~1250 estimated tokens of latin filler — comfortably over the threshold. */
const LONG_TEXT = "x".repeat(5000);

function entry(overrides: Partial<NewSessionEntry>): NewSessionEntry {
  return {
    sessionId: "s1",
    turnId: "t1",
    kind: "user",
    createdAt: 1000,
    text: null,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
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
function fakeProvider(summary: string, onStream?: () => void): FakeProvider {
  const calls: ProviderRequest[] = [];
  return {
    calls,
    stream(req: ProviderRequest): AsyncGenerator<ProviderStreamChunk> {
      calls.push(req);
      onStream?.();
      return (async function* () {
        yield { type: "text", content: summary } as ProviderStreamChunk;
        yield { type: "done", finishReason: "stop" } as ProviderStreamChunk;
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
