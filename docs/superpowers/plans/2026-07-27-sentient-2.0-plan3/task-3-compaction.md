### Task 3: Compaction — gateway-side summarization at the turn boundary (spec §8 + §3.4, build-order slice 8)

**Wave 2.** Touches `gateway/src/runtime/` + `gateway/src/store/` (read-only) + `shared/config` + `gateway/config.yaml` + one gateway template. Disjoint from T2 (WS/voice), T4 (`shared/web-sdk`), T5 (`shared/mobile-sdk`). **Adds no wire frame** — the frozen contract from Task 1 is untouched (see "No client frame" below).

---

#### 0. Read this before writing any code

**0.1 — The spec says one thing; the SDK says another. We do the other thing.**

Spec §8 specifies **provider server-side compaction**: "OpenAI-compatible `context_management` with a config `compact_threshold`". Verified against the pinned SDK actually installed (`openai@6.49.0`, `gateway/package.json`):

- `context_management` / `compact_threshold` exist **only on the Responses API** — `ResponseCreateParamsBase.context_management?: Array<ResponseCreateParams.ContextManagement>` with `{ type: string; compact_threshold?: number | null }`, in `resources/responses/responses.d.ts` (lines 6954 and 7216). Reached via `client.responses.create(...)`.
- They are **absent from `ChatCompletionCreateParamsBase`** (`grep -rl context_management` over `resources/chat/` returns nothing).
- `gateway/src/provider/openai-provider.ts` calls `client.chat.completions.create(...)`, and spec **§4.1 explicitly commits the gateway to the Chat Completions shape** ("`messages`, `tools`, `tool_calls`").
- The two configured providers are OpenRouter and Ollama Cloud (`gateway/config.yaml#orchestrator.provider.base_url: https://ollama.com/v1`). Neither is verified to serve `/responses` at all.

So §8's mechanism is not reachable from the code §4.1 mandates, with the providers this install dials. **This task implements Option B (gateway-side compaction)**: our own summarization round trip through the existing `ProviderClient`, producing exactly the same `kind:"compaction"` store entry §3.4 specifies. Everything downstream of the entry — the entry model and both projections — is identical under either option, so this is a provider-layer decision, not a redesign. Option A is scoped at the bottom of this task for the operator to pick up later.

**0.2 — What already exists (do NOT rebuild it).**

| Piece | Where | Status |
|---|---|---|
| `kind: "compaction"` entry + `compactedThroughSeq` field | `gateway/src/store/entry-types.ts` | **Done.** In the type, the zod schema, and the SQLite DDL. |
| Model projection replays from the latest marker forward, with dangling-`tool_result` repair | `gateway/src/store/model-projection.ts` (`sliceFromLatestCompaction`, `emitToolBlock`) | **Done + tested** (`model-projection.test.ts` cases at lines 105, 121, 164, 297). |
| Client projection skips markers so the user still sees full history | `gateway/src/store/client-projection.ts` line 32 | **Done + tested** (`client-projection.test.ts:43`). |
| Convergence across a compaction boundary | `gateway/src/store/projection-convergence.test.ts:156` | **Done.** |

**The one and only gap: nothing in production ever CREATES a compaction entry.** Every existing test hand-builds the marker. This task builds the producer. **Do not modify `model-projection.ts` or `client-projection.ts`** — your job is to emit entries they already handle correctly, and to prove it.

**0.3 — The load-bearing fact everyone gets wrong: the marker is POSITIONAL.**

`sliceFromLatestCompaction()` (model-projection.ts:52-74) finds the last `compaction` entry **by index** and keeps `entries.slice(lastCompactionIdx + 1)`. It never reads `compactedThroughSeq` — that field is logged, not used for slicing. Since the store is append-only, a marker always lands at the tail, which means:

> **A compaction marker supersedes every entry appended before it, whatever `compactedThroughSeq` says.**

Three consequences, all mandatory:

1. **The boundary is always the store's current tail.** A marker whose `compactedThroughSeq` points backwards would be a lie: entries between that seq and the marker's own position vanish from the model window without being summarized. So the boundary is never "moved backwards to snap"; an unsafe tail is **refused** and retried at the next turn end.
2. **`keep_recent_turns` cannot mean "leave those turns after the marker."** Nothing survives after an append-only marker. It means those turns are rendered **verbatim into the marker's own text**. That is squarely inside §3.4's licence for the two projections to diverge — the client still renders every original entry from the store.
3. **A marker appended over an entry that landed during summarization makes that entry invisible to the model forever.** The summarization round trip is the only `await` in this path, and `SessionRuntime.submit()` can append a steer during it. Therefore: snapshot the tail seq, and after the round trip **re-check that the tail is still that seq; skip the append if it moved.** Skipping costs one turn of over-long context. Not skipping costs the user's message.

**0.4 — Where it runs: at turn end, under the one-turn lock.**

From (0.3.1), the marker can only be appended when the store's tail *is* the boundary — i.e. between turns, never mid-turn. `SessionRuntime` is the only component that knows when that is true and can keep it true. So `maybeCompact` is called from `session-runtime.ts`'s settle path: **after** `emitter.turnCompleted()` (the client never waits on a summarizer round trip) and **before** `inFlight = null` (the one-turn-at-a-time lock still held, so no new turn can start while the summary is being written). This is the only structural change to `SessionRuntime`, and it preserves every documented cancellation invariant — see Step 12's comment block.

**0.5 — No client frame.** v1 emits nothing to the client when a compaction happens. `projectForClient` skips markers, so there is nothing to render, and Task 1 froze the frame list. Do **not** add a `compaction.*` frame.

---

#### Files

**Create**
- `gateway/src/runtime/compaction.ts` — the producer.
- `gateway/src/runtime/compaction.test.ts` — 5 contract/invariant cases.
- `gateway/templates/prompts/compaction-summarizer.md` — baked-in summarizer system prompt.

**Modify**
- `shared/config/src/schemas/orchestrator-config.ts` — add the `compaction` block.
- `gateway/config.yaml` — add the `orchestrator.compaction:` keys with inline comments + ranges.
- `gateway/src/context/system-prompt-loader.ts` — add `loadCompactionSummarizerPrompt()` (operator dir → baked-in template).
- `gateway/src/runtime/session-runtime.ts` — call `maybeCompact` in the settle path.
- `gateway/src/runtime/session-runtime.test.ts` — extend the `testConfig()` fixture (compaction OFF by default so no existing case changes behavior) + add one wiring invariant case.
- `docs/superpowers/specs/2026-07-23-sentient-2.0-native-orchestrator-design.md` — a 5-line implementation note under §8 recording the Option B decision (stale-reference rule: a spec that still claims provider-side compaction after this ships is a stale reference).

**Do NOT touch**
- `gateway/src/store/model-projection.ts`, `gateway/src/store/client-projection.ts`, `gateway/src/store/entry-types.ts`, `gateway/src/store/session-store.ts` — already correct and tested.
- `gateway/src/runtime/react-loop.ts`, `gateway/src/runtime/cancellation.ts` — untouched by this task.
- `gateway/src/bootstrap/phase-services.ts` — `SessionRuntimeDeps.config` is already the whole `OrchestratorConfig` (`phase-services.ts:800-802` passes `config: orchestratorCfg`), so the new block threads through with zero bootstrap changes. Leave it alone; T6 needs that file.

---

#### Interfaces

**Consumes (exact, verified signatures — all already exist):**

```ts
// gateway/src/store/session-store.ts
export interface SessionStore {
  append(entry: NewSessionEntry): SessionEntry;
  readSession(sessionId: string): SessionEntry[];
  readSince(sessionId: string, afterSeq: number): SessionEntry[];
  listSessions(): Array<{ sessionId: string; startedAt: number; lastAt: number }>;
  close(): void;
}

// gateway/src/store/entry-types.ts
export type EntryKind = "user" | "assistant" | "tool_call" | "tool_result" | "trigger" | "system" | "compaction";
export interface SessionEntry {
  seq: number; sessionId: string; turnId: string; kind: EntryKind; createdAt: number;
  text: string | null; toolCallId: string | null; toolName: string | null; toolArgs: string | null;
  cutoff: CutoffKind | null; compactedThroughSeq: number | null;
}
export type NewSessionEntry = Omit<SessionEntry, "seq">;

// gateway/src/store/model-projection.ts   (READ-ONLY for this task)
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}
export function projectForModel(entries: SessionEntry[]): ChatMessage[];

// gateway/src/store/client-projection.ts  (READ-ONLY for this task)
export function projectForClient(entries: SessionEntry[]): FeedItem[];

// gateway/src/provider/provider-client.ts
export interface ProviderRequest { messages: ChatMessage[]; tools: ProviderTool[]; signal: AbortSignal; }
export interface ProviderClient { stream(req: ProviderRequest): AsyncGenerator<ProviderStreamChunk>; }
export type ProviderStreamChunk =
  | { type: "text"; content: string }
  | { type: "tool_call"; toolCall: ChatToolCall }
  | { type: "done"; finishReason: string; usage?: { promptTokens: number; cachedTokens: number; completionTokens: number } };

// gateway/src/user-auth/user-id.ts
export type UserId = `u_${string}`;

// gateway/src/logging/logger.ts
export function getLog(tags: string[]): Logger;

// gateway/src/context/system-prompt-loader.ts  (existing helpers you extend)
const GATEWAY_ROOT = process.env.GATEWAY_RUNTIME_DIR ?? join(import.meta.dir, "..", "..");
function tryRead(path: string, kind: string): string | undefined;
```

**Produces (later tasks and the operator rely on these exact names):**

```ts
// gateway/src/runtime/compaction.ts
export type CompactionReason =
  | "compacted" | "disabled" | "below-threshold" | "unsafe-boundary"
  | "nothing-to-summarize" | "raced-with-append" | "empty-summary" | "aborted" | "provider-error";
export interface CompactionOutcome { compacted: boolean; reason: CompactionReason; estimatedTokens: number; compactedThroughSeq: number | null; }
export interface CompactionDeps {
  store: SessionStore; provider: ProviderClient; sessionId: string; userId: UserId; turnId: string;
  config: OrchestratorConfig["compaction"]; summarizerPrompt: string; signal: AbortSignal;
}
/** Never throws. Appends at most one `kind:"compaction"` entry. */
export function maybeCompact(deps: CompactionDeps): Promise<CompactionOutcome>;
export function estimateTokens(messages: ChatMessage[]): number;
export function regionAfterLatestMarker(entries: SessionEntry[]): { priorSummary: string | null; region: SessionEntry[] };
export function splitAtTurnBoundary(region: SessionEntry[], keepRecentTurns: number): { older: SessionEntry[]; recent: SessionEntry[] } | null;
export function safeBoundarySeq(entries: SessionEntry[]): number | null;
export function renderTranscript(entries: SessionEntry[]): string;

// gateway/src/context/system-prompt-loader.ts
export const DEFAULT_COMPACTION_SUMMARIZER: string;
export function loadCompactionSummarizerPrompt(opts?: { runtimeDir?: string }): string;

// shared/config/src/schemas/orchestrator-config.ts → OrchestratorConfig["compaction"]
{ enabled: boolean; compact_threshold_tokens: number; keep_recent_turns: number }
```

---

#### Steps

- [ ] **Step 1: Add the `compaction` block to the orchestrator config schema.**

  In `shared/config/src/schemas/orchestrator-config.ts`, insert this **after** the `delegation: z.object({...}),` entry and before the closing `});`:

  ```ts
    compaction: z
      .object({
        // Master switch (spec §8). false = the model window grows unbounded
        // until the provider rejects the request; only sensible for a
        // short-lived debug session.
        enabled: z.boolean().default(true),
        // Estimated model-window size (tokens) at or above which a compaction
        // fires at the NEXT turn boundary. Set to roughly 40-60% of the active
        // model's context window: the estimate is character-based (±30%) and
        // the summarizer itself needs headroom to read the transcript it is
        // compacting. Range 1000-1000000.
        compact_threshold_tokens: z.number().int().min(1000).max(1000000).default(24000),
        // How many of the most recent turns are copied VERBATIM into the
        // compaction marker instead of being summarized away. Recent detail
        // survives inside the marker's own text because the model projection
        // slices POSITIONALLY from the marker forward — nothing can be left
        // "after" an append-only marker. 0 = summarize everything.
        // Range 0-50.
        keep_recent_turns: z.number().int().min(0).max(50).default(4),
      })
      .default({}),
  ```

  `.default({})` is required, not cosmetic: every existing config fixture (`shared/config/src/schema.test.ts`'s `minimalOrchestrator`, `shared/config/src/schemas/orchestrator-config.test.ts`'s `base`) and every operator `config.yaml` already in the field omits this block, and a bare `z.object` is a required key in zod 3.

- [ ] **Step 2: Add the keys to `gateway/config.yaml`.**

  In the `orchestrator:` section (starts at line 102), append after the `delegation:` block:

  ```yaml
    compaction:
      enabled: true                          # master switch; false = never compact (window grows until the provider rejects the request)
      compact_threshold_tokens: 24000        # estimated model-window tokens that trigger compaction at the next turn boundary (1000-1000000; ~40-60% of the model's context)
      keep_recent_turns: 4                   # most-recent turns copied VERBATIM into the summary marker rather than summarized away (0-50)
  ```

  Do **not** touch `~/.sentient/gateway/config/config.yaml` here — it is operator-owned, and the schema defaults cover its omission. (The E2E step below lowers the threshold there by hand, in place.)

- [ ] **Step 3: Keep the existing runtime fixture compiling — compaction OFF by default in tests.**

  `OrchestratorConfig` now has a required `compaction` field, which breaks the only full-config literal in the codebase. In `gateway/src/runtime/session-runtime.test.ts`, extend `testConfig()` (line 27):

  ```ts
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
      tools: { foreground_timeout_ms: 30000, max_concurrent_background_tasks: 50 },
      delegation: { frontmatter_dir: "./config/delegation", hermes_timeout_ms: 600000 },
      // OFF for every pre-existing case: compaction adds a second provider
      // call at turn end, which would silently change the call-index
      // assertions those cases are built on. The compaction case below
      // builds its own config with it enabled.
      compaction: { enabled: false, compact_threshold_tokens: 24000, keep_recent_turns: 4 },
    };
  }
  ```

- [ ] **Step 4: Verify the schema + YAML round-trip.**

  ```bash
  source scripts/env.sh
  bun run --filter '@sentient/config' test
  cd gateway && bun -e 'const {loadGatewayConfig} = await import("./src/config/gateway-config.ts"); console.log(JSON.stringify(loadGatewayConfig("./config.yaml").orchestrator?.compaction));'
  ```

  Expected: config tests green, and the second command prints exactly
  `{"enabled":true,"compact_threshold_tokens":24000,"keep_recent_turns":4}`.

- [ ] **Step 5: Commit the config surface.**

  ```bash
  git add shared/config/src/schemas/orchestrator-config.ts gateway/config.yaml gateway/src/runtime/session-runtime.test.ts
  git commit -m "feat(config): add orchestrator.compaction tunables (enabled, threshold, keep_recent_turns)"
  ```

- [ ] **Step 6: Write the summarizer prompt as a template file.**

  Create `gateway/templates/prompts/compaction-summarizer.md` (`gateway/templates/` is already `COPY`'d into the image — `gateway/Dockerfile:82`). Prompt content lives in `.md`, never an inline TS string (clean-code rule).

  ```markdown
  You are the context compactor for Sentient, a family voice assistant.

  You are given the earlier part of one conversation as a transcript, and — if
  that conversation was compacted before — the previous summary. Rewrite it as
  a dense factual briefing that lets the assistant carry on the conversation
  without having read the original.

  Rules:

  - Write about "the user" and "the assistant" in the third person. Never
    address the user, never continue the conversation, never answer anything
    in it.
  - Preserve: decisions made, facts the user stated about themselves or their
    home, open questions, promised follow-ups, delegated or still-running
    tasks and their ids, tool results that still matter, and anything the user
    asked to have remembered.
  - Preserve concrete values verbatim: names, dates, times, numbers, ids, file
    paths, device and room names.
  - Drop: greetings, filler, repeated confirmations, and tool chatter that
    changed nothing.
  - Never invent detail that is not in the transcript. If something was left
    unresolved, say so.
  - Output the briefing only. No preamble, no headings, no markdown fences.
  ```

- [ ] **Step 7: Add the loader (operator override → baked-in template).**

  Append to `gateway/src/context/system-prompt-loader.ts` (note: that file imports with `.ts` extensions — match its local style; no new imports are needed):

  ```ts
  // Baked-in default for the compaction summarizer (spec §8). Read at module
  // init, exactly like DEFAULT_PERSONA above: a missing baked-in template is a
  // build error, and failing loudly at boot beats discovering it at the first
  // compaction, mid-conversation.
  export const DEFAULT_COMPACTION_SUMMARIZER = readFileSync(
    join(GATEWAY_ROOT, "templates/prompts/compaction-summarizer.md"),
    "utf8",
  ).trim();

  /** Operator override first, baked-in template as the fallback — same
   *  two-tier shape as `loadSystemPrompt`, so an operator can retune the
   *  summarizer without a rebuild. */
  export function loadCompactionSummarizerPrompt(opts: { runtimeDir?: string } = {}): string {
    const runtimeDir = opts.runtimeDir ?? GATEWAY_ROOT;
    const override = tryRead(join(runtimeDir, "system_prompts", "compaction_summarizer.md"), "compaction-summarizer");
    return override ?? DEFAULT_COMPACTION_SUMMARIZER;
  }
  ```

  No test: this is a loader with a fallback, not a contract/FSM/security boundary (testing rules — borderline tests get deleted, not kept).

- [ ] **Step 8: Write the failing contract + invariant tests (4 of 5 cases).**

  Create `gateway/src/runtime/compaction.test.ts`. Gateway tests run under `bun:test` from `gateway/src` (`gateway/package.json` → `"test": "cd src && bun test"`), and use a real on-disk store under `/tmp` (precedent: `session-store.test.ts`, `session-runtime.test.ts`).

  ```ts
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
      const tailSeq = before[before.length - 1]?.seq;

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
  });
  ```

  Run it — expect a hard module-resolution failure, since `compaction.ts` does not exist yet:

  ```bash
  source scripts/env.sh && cd gateway/src && bun test runtime/compaction.test.ts
  ```

  Expected: `error: Cannot find module './compaction.js' from '.../gateway/src/runtime/compaction.test.ts'` — 0 pass, 1 error.

- [ ] **Step 9: Implement the pure helpers in `gateway/src/runtime/compaction.ts`.**

  Create the file with the header and the pure part (no `maybeCompact` yet):

  ```ts
  // Compaction (spec §8 + §3.4) — the PRODUCER of `kind:"compaction"` entries.
  //
  // WHY GATEWAY-SIDE AND NOT PROVIDER-SIDE. Spec §8 specifies OpenAI-compatible
  // server-side compaction (`context_management` + `compact_threshold`).
  // Verified against the pinned SDK (openai@6.49.0): those fields exist ONLY on
  // the Responses API (resources/responses/responses.d.ts:6954, :7216) and are
  // absent from ChatCompletionCreateParamsBase — and Chat Completions is what
  // openai-provider.ts calls and what spec §4.1 commits the gateway to. Neither
  // configured provider (OpenRouter, Ollama Cloud) is verified to serve
  // Responses at all. So v1 runs the summarization itself, through the same
  // ProviderClient, and produces exactly the entry §3.4 specifies. Switching to
  // the provider-native path later is a provider-layer change: the entry, both
  // projections, and these config keys are identical either way.
  //
  // THE ONE THING TO UNDERSTAND BEFORE EDITING THIS FILE. model-projection.ts
  // slices POSITIONALLY: `sliceFromLatestCompaction()` keeps
  // `entries.slice(lastCompactionIdx + 1)` and never reads
  // `compactedThroughSeq`. A marker therefore supersedes EVERY entry appended
  // before it. Three consequences, all load-bearing:
  //   1. The boundary is always the store's current tail. An unsafe tail is
  //      REFUSED (retry at the next turn end), never snapped backwards — a
  //      backwards-snapped boundary would drop entries from the model window
  //      without summarizing them, and `compactedThroughSeq` would be a lie.
  //   2. "Keep the last N turns" cannot mean "leave them after the marker";
  //      nothing survives after an append-only marker. Those turns are
  //      rendered VERBATIM into the marker's own text. §3.4 explicitly allows
  //      the two projections to diverge — the client still renders every
  //      original entry, straight from the store.
  //   3. The summarization round trip is the only await here, and
  //      SessionRuntime.submit() can append a steer during it. A marker
  //      appended over that entry would make it invisible to the model
  //      FOREVER, so the tail seq is re-checked immediately before the append
  //      and the whole compaction is skipped if it moved. Skipping costs one
  //      turn of over-long context; not skipping costs the user's message.
  //
  // Never throws: every failure path returns a typed outcome (error-handling
  // rule — no throwing from business logic). The caller (session-runtime.ts)
  // is on the turn-settle path and must stay total.

  import type { OrchestratorConfig } from "@sentient/config";
  import { getLog } from "../logging/logger.js";
  import type { ProviderClient } from "../provider/provider-client.js";
  import type { NewSessionEntry, SessionEntry } from "../store/entry-types.js";
  import type { ChatMessage } from "../store/model-projection.js";
  import { projectForModel } from "../store/model-projection.js";
  import type { SessionStore } from "../store/session-store.js";
  import type { UserId } from "../user-auth/user-id.js";

  const log = getLog(["sentient", "runtime", "compaction"]);

  // Estimator internals, NOT operator knobs — the operator knob is
  // `orchestrator.compaction.compact_threshold_tokens`. ~4 chars/token is the
  // standard BPE average for latin script; CJK runs ~1 token/char, and this
  // gateway is bilingual en/zh (stt.language: auto), so counting CJK at a
  // quarter would under-count a Chinese session ~4x and compaction would never
  // fire. Swapping in a real tokenizer later changes only `estimateTokens`.
  const CHARS_PER_TOKEN_LATIN = 4;
  // Kana + CJK ideographs + compatibility ideographs, written as escapes so
  // the source stays ASCII-safe in every editor and diff tool.
  const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;

  // Marker layout. Fixed strings, not config: they are the format contract
  // between this producer and the model that reads the marker back.
  const SUMMARY_HEADER = "[Earlier conversation — summarized]";
  const VERBATIM_HEADER = "[Recent conversation — verbatim]";
  const PRIOR_SUMMARY_HEADER = "[Summary of everything before that]";

  export type CompactionReason =
    | "compacted"
    | "disabled"
    | "below-threshold"
    | "unsafe-boundary"
    | "nothing-to-summarize"
    | "raced-with-append"
    | "empty-summary"
    | "aborted"
    | "provider-error";

  export interface CompactionOutcome {
    compacted: boolean;
    reason: CompactionReason;
    estimatedTokens: number;
    compactedThroughSeq: number | null;
  }

  export interface CompactionDeps {
    store: SessionStore;
    provider: ProviderClient;
    sessionId: string;
    userId: UserId;
    /** The turn that just ended. Stamped on the marker because every row needs
     *  a turnId; the client projection skips markers, so it never renders. */
    turnId: string;
    config: OrchestratorConfig["compaction"];
    /** From `loadCompactionSummarizerPrompt()` — injected, never read from
     *  disk here, so tests drive this with a fixed string. */
    summarizerPrompt: string;
    /** The ended turn's AbortSignal. `SessionRuntime.dispose()` aborts it and
     *  closes the store, so it is re-checked after the summarization round
     *  trip and before the append. */
    signal: AbortSignal;
  }

  function messageChars(m: ChatMessage): string {
    const parts: string[] = [m.content ?? ""];
    for (const tc of m.tool_calls ?? []) parts.push(tc.function.name, tc.function.arguments);
    return parts.join("");
  }

  /** Rough model-window size. Deliberately provider-independent: an exact
   *  count would have to come from a `usage.prompt_tokens` plumbed out of
   *  react-loop.ts, and this decides one boolean against an operator-tuned
   *  threshold. */
  export function estimateTokens(messages: ChatMessage[]): number {
    let cjk = 0;
    let latin = 0;
    for (const m of messages) {
      const s = messageChars(m);
      const cjkCount = s.match(CJK_CHAR)?.length ?? 0;
      cjk += cjkCount;
      latin += s.length - cjkCount;
    }
    return Math.ceil(cjk + latin / CHARS_PER_TOKEN_LATIN);
  }

  /** Entries after the latest marker — the only region a new marker may
   *  summarize — plus that marker's own text, carried into the new summary so
   *  successive compactions never drop the older chain. */
  export function regionAfterLatestMarker(entries: SessionEntry[]): {
    priorSummary: string | null;
    region: SessionEntry[];
  } {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i]?.kind === "compaction") {
        return { priorSummary: entries[i]?.text ?? "", region: entries.slice(i + 1) };
      }
    }
    return { priorSummary: null, region: entries };
  }

  /** Splits a region into "summarize these" / "keep these verbatim" at a TURN
   *  boundary — never inside a turn, so a tool_call and its tool_result can
   *  never land on opposite sides (both carry the same turnId, and a turn's
   *  entries are contiguous by construction: react-loop.ts and
   *  session-runtime.ts only ever append under the running turnId). Returns
   *  null when the region holds no more than `keepRecentTurns` turns — there
   *  is nothing to summarize yet. */
  export function splitAtTurnBoundary(
    region: SessionEntry[],
    keepRecentTurns: number,
  ): { older: SessionEntry[]; recent: SessionEntry[] } | null {
    const turnIds: string[] = [];
    for (const e of region) {
      if (turnIds[turnIds.length - 1] !== e.turnId) turnIds.push(e.turnId);
    }
    if (turnIds.length <= keepRecentTurns) return null;

    const keptIds = new Set(turnIds.slice(turnIds.length - keepRecentTurns));
    const splitIdx = keepRecentTurns === 0 ? region.length : region.findIndex((e) => keptIds.has(e.turnId));
    if (splitIdx <= 0) return null;
    return { older: region.slice(0, splitIdx), recent: region.slice(splitIdx) };
  }

  /** The boundary is ALWAYS the store's tail — a positional marker can
   *  honestly cover nothing else. So this REFUSES an unsafe tail rather than
   *  moving the boundary: a trailing `tool_call` means its `tool_result` may
   *  still be coming (a turn aborted mid-dispatch), and a marker wedged
   *  between the two leaves the next slice starting on a dangling role:"tool"
   *  message. Refuse; the next turn end tries again. A trailing `compaction`
   *  means nothing new has happened since the last marker. */
  export function safeBoundarySeq(entries: SessionEntry[]): number | null {
    const tail = entries[entries.length - 1];
    if (!tail) return null;
    if (tail.kind === "tool_call" || tail.kind === "compaction") return null;
    return tail.seq;
  }

  function renderEntry(e: SessionEntry): string | null {
    switch (e.kind) {
      case "user":
        return `user: ${e.text ?? ""}`;
      case "trigger":
        return `event: ${e.text ?? ""}`;
      case "assistant":
        return e.cutoff ? `assistant (cut off — ${e.cutoff}): ${e.text ?? ""}` : `assistant: ${e.text ?? ""}`;
      case "tool_call":
        return `tool_call ${e.toolName ?? "unknown"}(${e.toolArgs ?? "{}"})`;
      case "tool_result":
        return `tool_result ${e.toolName ?? "unknown"} -> ${e.toolArgs ?? ""}`;
      case "system":
        return `system: ${e.text ?? ""}`;
      default:
        // A prior marker rides as `priorSummary`, never inline; an unknown
        // kind has no defined rendering.
        return null;
    }
  }

  export function renderTranscript(entries: SessionEntry[]): string {
    return entries
      .flatMap((e) => {
        const line = renderEntry(e);
        return line === null ? [] : [line];
      })
      .join("\n");
  }
  ```

- [ ] **Step 10: Implement `maybeCompact` (still without the race guard).**

  Append to `gateway/src/runtime/compaction.ts`:

  ```ts
  function skip(reason: CompactionReason, estimatedTokens: number): CompactionOutcome {
    return { compacted: false, reason, estimatedTokens, compactedThroughSeq: null };
  }

  /** One summarization round trip. Returns null on any provider failure — the
   *  caller turns that into a skip, never a throw. `tools: []` is deliberate:
   *  a summarizer that can act is a side-effecting surface nobody mediates
   *  (spec §2.2). The per-request deadline is the ProviderClient's own
   *  (`orchestrator.provider.request_timeout_ms`). */
  async function summarize(deps: CompactionDeps, transcript: string): Promise<string | null> {
    const messages: ChatMessage[] = [
      { role: "system", content: deps.summarizerPrompt },
      { role: "user", content: transcript },
    ];
    const stream = deps.provider.stream({ messages, tools: [], signal: deps.signal });
    let summary = "";
    try {
      for await (const chunk of stream) {
        if (deps.signal.aborted) break;
        if (chunk.type === "text") summary += chunk.content;
      }
    } catch (err) {
      log.warn("compaction.summarize.failed", {
        userId: deps.userId,
        sessionId: deps.sessionId,
        turnId: deps.turnId,
        reason: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      await stream.return(undefined);
    }
    return summary;
  }

  export async function maybeCompact(deps: CompactionDeps): Promise<CompactionOutcome> {
    const { store, sessionId, userId, turnId, config, signal } = deps;

    if (!config.enabled) return skip("disabled", 0);

    const entries = store.readSession(sessionId);
    const estimatedTokens = estimateTokens(projectForModel(entries));
    if (estimatedTokens < config.compact_threshold_tokens) {
      log.debug("compaction.below-threshold", {
        userId,
        sessionId,
        turnId,
        estimatedTokens,
        thresholdTokens: config.compact_threshold_tokens,
      });
      return skip("below-threshold", estimatedTokens);
    }

    const boundarySeq = safeBoundarySeq(entries);
    if (boundarySeq === null) {
      log.info("compaction.skipped", {
        userId,
        sessionId,
        turnId,
        reason: "unsafe-boundary",
        tailKind: entries[entries.length - 1]?.kind ?? null,
        estimatedTokens,
      });
      return skip("unsafe-boundary", estimatedTokens);
    }

    const { priorSummary, region } = regionAfterLatestMarker(entries);
    const split = splitAtTurnBoundary(region, config.keep_recent_turns);
    if (split === null) {
      log.info("compaction.skipped", {
        userId,
        sessionId,
        turnId,
        reason: "nothing-to-summarize",
        regionEntries: region.length,
        keepRecentTurns: config.keep_recent_turns,
        estimatedTokens,
      });
      return skip("nothing-to-summarize", estimatedTokens);
    }

    const older = renderTranscript(split.older);
    const transcript = priorSummary ? `${PRIOR_SUMMARY_HEADER}\n${priorSummary}\n\n${older}` : older;

    log.info("compaction.summarizing", {
      userId,
      sessionId,
      turnId,
      estimatedTokens,
      thresholdTokens: config.compact_threshold_tokens,
      boundarySeq,
      olderEntries: split.older.length,
      recentEntries: split.recent.length,
      transcriptChars: transcript.length,
    });

    const summary = await summarize(deps, transcript);
    if (summary === null) return skip("provider-error", estimatedTokens);
    if (signal.aborted) {
      log.info("compaction.skipped", { userId, sessionId, turnId, reason: "aborted", boundarySeq });
      return skip("aborted", estimatedTokens);
    }
    if (summary.trim().length === 0) {
      log.warn("compaction.skipped", { userId, sessionId, turnId, reason: "empty-summary", boundarySeq });
      return skip("empty-summary", estimatedTokens);
    }

    const markerText =
      split.recent.length > 0
        ? `${SUMMARY_HEADER}\n${summary.trim()}\n\n${VERBATIM_HEADER}\n${renderTranscript(split.recent)}`
        : `${SUMMARY_HEADER}\n${summary.trim()}`;

    const marker: NewSessionEntry = {
      sessionId,
      turnId,
      kind: "compaction",
      createdAt: Date.now(),
      text: markerText,
      toolCallId: null,
      toolName: null,
      toolArgs: null,
      cutoff: null,
      compactedThroughSeq: boundarySeq,
    };
    const appended = store.append(marker);
    // Lengths and ids only — the marker text is verbatim conversation content
    // and never goes to a log sink (logging rules).
    log.info("compaction.committed", {
      userId,
      sessionId,
      turnId,
      seq: appended.seq,
      compactedThroughSeq: boundarySeq,
      estimatedTokens,
      summaryChars: summary.length,
      markerChars: markerText.length,
    });
    return { compacted: true, reason: "compacted", estimatedTokens, compactedThroughSeq: boundarySeq };
  }
  ```

  Run:

  ```bash
  source scripts/env.sh && cd gateway/src && bun test runtime/compaction.test.ts
  ```

  Expected: **4 pass, 0 fail**.

- [ ] **Step 11: Add the race case — it must FAIL first.**

  Append inside the `describe(...)` block in `gateway/src/runtime/compaction.test.ts`:

  ```ts
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
  ```

  Run:

  ```bash
  source scripts/env.sh && cd gateway/src && bun test runtime/compaction.test.ts
  ```

  Expected failure (the guard does not exist yet):
  `expect(received).toBe(expected)  Expected: false  Received: true` on `outcome.compacted`, i.e. **4 pass, 1 fail**.

- [ ] **Step 12: Add the race guard.**

  In `gateway/src/runtime/compaction.ts`, insert this immediately **before** the `const markerText = ...` line in `maybeCompact`:

  ```ts
    // Re-check + append are ONE synchronous block: Bun is single-threaded, so
    // nothing can interleave between them. Everything before this point is
    // recomputable; only the append is destructive to the model window.
    const nowEntries = store.readSession(sessionId);
    const tailNow = nowEntries[nowEntries.length - 1];
    if (!tailNow || tailNow.seq !== boundarySeq) {
      log.info("compaction.skipped", {
        userId,
        sessionId,
        turnId,
        reason: "raced-with-append",
        boundarySeq,
        tailSeqNow: tailNow?.seq ?? null,
      });
      return skip("raced-with-append", estimatedTokens);
    }
  ```

  Run:

  ```bash
  source scripts/env.sh && cd gateway/src && bun test runtime/compaction.test.ts
  ```

  Expected: **5 pass, 0 fail**.

- [ ] **Step 13: Commit the producer.**

  ```bash
  git add gateway/src/runtime/compaction.ts gateway/src/runtime/compaction.test.ts \
          gateway/templates/prompts/compaction-summarizer.md gateway/src/context/system-prompt-loader.ts
  git commit -m "feat(orchestrator): gateway-side compaction producer — threshold, safe boundary, append-only marker"
  ```

- [ ] **Step 14: Write the wiring invariant case — it must FAIL first.**

  In `gateway/src/runtime/session-runtime.test.ts`, append at the end of the file:

  ```ts
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
      let runtime: SessionRuntime | undefined;

      const provider = fakeProvider(async function* (callIndex) {
        if (callIndex === 2) {
          // The compaction summarizer call. The turn is over — its terminal
          // frame is already out — but the one-turn lock is still held.
          expect(emitter.events.some((e) => e.type === "turnCompleted")).toBe(true);
          expect(runtime?.running).toBe(true);
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

      runtime = createSessionRuntime({
        principal: alice,
        sessionId: "sess-compaction",
        accessManager: am,
        provider,
        broker: noopBroker(),
        emitter,
        systemPrompt: "you are a test assistant",
        config,
      });

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
  ```

  Run:

  ```bash
  source scripts/env.sh && cd gateway/src && bun test runtime/session-runtime.test.ts
  ```

  Expected failure: `waitFor: condition never became true` (only one provider call is ever made — nothing calls `maybeCompact`).

- [ ] **Step 15: Wire `maybeCompact` into the settle path.**

  In `gateway/src/runtime/session-runtime.ts`:

  (a) Add the imports, next to the existing ones:

  ```ts
  import { loadCompactionSummarizerPrompt } from "../context/system-prompt-loader.js";
  import { maybeCompact } from "./compaction.js";
  ```

  (b) Add the module-scope prompt constant, just below `const TURN_TRIGGER_KINDS = ...`:

  ```ts
  // Resolved once at module load (operator override → baked-in template),
  // matching system-prompt-loader.ts's DEFAULT_PERSONA precedent: a missing
  // baked-in template is a boot-time failure, not a per-turn surprise.
  const COMPACTION_SUMMARIZER_PROMPT = loadCompactionSummarizerPrompt();
  ```

  (c) Replace `onTurnSettled` in full:

  ```ts
    async function onTurnSettled(
      turnId: string,
      result: { completed: boolean; iterations: number },
      signal: AbortSignal,
    ): Promise<void> {
      log.info("session-runtime.turn.end", {
        userId,
        sessionId,
        turnId,
        completed: result.completed,
        iterations: result.iterations,
      });

      if (result.completed) {
        emitter.turnCompleted(turnId);
      } else {
        // Cutoff-kind stamping (interrupt|barge-in) on the partial output is
        // cancellation.ts's job (spec §4.7) — this runtime only owns
        // starting/clearing the AbortController the abort came through.
        log.warn("session-runtime.turn.not-completed", { userId, sessionId, turnId, iterations: result.iterations });
      }

      // Compaction (spec §8, §3.4) runs HERE, in the one window where it is
      // safe, and nowhere else:
      //  - AFTER the terminal frame above, so the client never waits on a
      //    summarizer round trip to see its turn complete;
      //  - BEFORE `inFlight` is cleared, so the one-turn-at-a-time lock still
      //    holds and no new turn can start over a half-written model window.
      //    A `submit()` landing in this window still just appends and returns
      //    (the existing steer path) and is picked up by the back-to-back
      //    check below — and compaction.ts's own race guard refuses to append
      //    a marker over it.
      // Cancellation invariants are unaffected by the longer in-flight window:
      // a naturally-completed turn is already `settled: true` and an aborted
      // one already has `signal.aborted`, so cancellation.ts's
      // `signal.aborted || turn.settled` guard no-ops either way (it still
      // reaches interrupt's unconditional `background.cancelAll()`).
      if (!disposed) {
        try {
          await maybeCompact({
            store,
            provider,
            sessionId,
            userId,
            turnId,
            config: config.compaction,
            summarizerPrompt: COMPACTION_SUMMARIZER_PROMPT,
            signal,
          });
        } catch (err) {
          // maybeCompact's contract is "never throws" — a backstop only, so a
          // bug there can never wedge the one-turn guard open forever.
          log.error("session-runtime.compaction.threw", {
            userId,
            sessionId,
            turnId,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      inFlight = null;

      if (disposed) {
        log.debug("session-runtime.turn.settled-after-dispose", { userId, sessionId, turnId });
        return;
      }

      if (hasUnprocessedStimuli()) {
        const nextTurnId = crypto.randomUUID();
        log.info("session-runtime.turn.next-turn-trigger", {
          userId,
          sessionId,
          previousTurnId: turnId,
          nextTurnId,
        });
        startTurn(nextTurnId);
      }
    }
  ```

  (d) Update the two call sites at the bottom of `startTurn` (`onTurnSettled` is now async — never leave its rejection unhandled):

  ```ts
      runTurn(loopDeps, { turnId, signal: controller.signal }).then(
        (result) => {
          void onTurnSettled(turnId, result, controller.signal);
        },
        (err: unknown) => {
          // react-loop.ts's contract is "never throw" — this is a defensive
          // backstop only, so a bug elsewhere can never wedge the one-turn
          // guard open forever.
          log.error("session-runtime.turn.threw", {
            userId,
            sessionId,
            turnId,
            reason: err instanceof Error ? err.message : String(err),
          });
          void onTurnSettled(turnId, { completed: false, iterations: 0 }, controller.signal);
        },
      );
  ```

  (e) Extend the file-header comment (the block starting "SessionRuntime (spec §4.5, Plan 2 Task 7)") with one paragraph, so the next reader does not "optimize" the lock window away:

  ```ts
  // Compaction (spec §8/§3.4) hangs off the settle path, not the loop: the
  // marker is appended after the turn's terminal frame and before `inFlight`
  // clears. That ordering is required, not stylistic — model-projection.ts
  // slices positionally from the latest marker, so a marker is only truthful
  // when the store's tail IS its boundary, which is only true between turns.
  // See runtime/compaction.ts's header.
  ```

  Run:

  ```bash
  source scripts/env.sh && cd gateway/src && bun test runtime/session-runtime.test.ts
  ```

  Expected: all pre-existing cases still pass **plus** the new one — 0 fail.

- [ ] **Step 16: Record the spec divergence (stale-reference rule).**

  In `docs/superpowers/specs/2026-07-23-sentient-2.0-native-orchestrator-design.md`, append to the end of section 8, before the `---`:

  ```markdown
  > **Implementation note (Plan 3 Task 3, 2026-07-27).** v1 ships **gateway-side**
  > compaction, not provider server-side. In the pinned SDK (`openai@6.49.0`)
  > `context_management` / `compact_threshold` exist only on the **Responses**
  > API and are absent from Chat Completions — which §4.1 commits this gateway
  > to, and which neither configured provider (OpenRouter, Ollama Cloud) is
  > verified to supersede. The gateway therefore runs its own summarization call
  > through the same `ProviderClient` (`gateway/src/runtime/compaction.ts`) and
  > appends the identical `kind:"compaction"` entry. Everything downstream —
  > the entry model, both projections, the config keys — is unchanged, so the
  > provider-native path stays a drop-in provider-layer swap. Note also that the
  > model projection slices **positionally** from the latest marker: a marker
  > covers every entry appended before it regardless of `compactedThroughSeq`,
  > which is why the boundary is always the store's tail and "keep recent turns"
  > means "verbatim inside the marker text."
  ```

- [ ] **Step 17: Full gate.**

  ```bash
  source scripts/env.sh
  bun run lint
  bun run typecheck
  bun run test:unit
  ```

  Expected: clean lint (biome), clean typecheck, all suites green. If biome reformats the new files, accept its output and re-run.

- [ ] **Step 18: Commit the wiring.**

  ```bash
  git add gateway/src/runtime/session-runtime.ts gateway/src/runtime/session-runtime.test.ts \
          docs/superpowers/specs/2026-07-23-sentient-2.0-native-orchestrator-design.md
  git commit -m "feat(orchestrator): run compaction at turn end under the one-turn lock"
  ```

---

#### Test bar accounting (why these five and no more)

| Kept | Why it clears the bar |
|---|---|
| valid summary-only model window | **Wire/protocol contract** with the provider — a malformed `messages[]` (dangling `role:"tool"`) is a hard 400. |
| refuses a tool_call tail | **Invariant** (spec §3.4 "never split a tool-call pair") with a documented learning in model-projection.ts's header. |
| skips on a race | **Invariant** — the only path in this system that can make a user message permanently invisible to the model. |
| below threshold → no provider call | **FSM trigger** — the gate that keeps compaction from firing unbidden (and from burning provider spend every turn). |
| client feed unchanged | **Contract** for §3.4's divergence promise — "history vanished after a long chat" is the user-visible regression. |
| runtime wiring case | **FSM ordering invariant** — marker after the terminal frame, before the lock clears. |

**Deliberately NOT tested:** the config defaults (constants), `loadCompactionSummarizerPrompt` (loader plumbing with a fallback), `renderTranscript` string shapes (pure formatting), `estimateTokens` exactness (a heuristic feeding one operator-tuned boolean).

---

#### E2E matrix (executed in Task 11, web)

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| Compaction fires at a turn boundary | 1280×900 | Logged in; `orchestrator.compaction.compact_threshold_tokens` lowered to `1500` **in place** in `~/.sentient/gateway/config/config.yaml`; local stack restarted | Send 4 long messages in one conversation, then reload the page | All 4 exchanges still render in full after reload; the assistant's later answers still reference facts from the first message | `compaction.summarizing` → `compaction.committed {compactedThroughSeq}` → next turn logs `projection.compacted`. No `projection.dropped-parentless-tool-results`, no provider 400 |
| Compaction survives a restart | 1280×900 | Same session, one marker already committed | `docker compose restart gateway` (local stack only), reopen the conversation, send one more message | Full history renders from the store; the reply stays coherent with the pre-compaction context | `projection.compacted` on the first turn after restart; no `compaction.summarizing` (still under threshold) |
| Barge-in during the compaction window | 390×844 | Same lowered threshold, TTS enabled | Speak over the assistant right as a long turn completes | No stall, no duplicate bubble; the next turn starts normally | `cancellation.already-aborted` **or** `compaction.skipped {reason:"raced-with-append"}` — never `compaction.committed` followed by a lost user message |

---

### Alternative: Option A (provider-native Responses API)

Scoped, not planned — no TDD steps. Pick this up only if the verification gate below passes; otherwise Option B above stands.

**Verification gate — do this FIRST, before writing any code.** Option A is dead on arrival if the provider does not serve Responses. Probe the operator's *active* provider (key from the secrets store via `getActiveLlm()`, never an env var, never printed):

```
POST <base_url>/responses   { "model": "<configured model>", "input": "ping", "stream": false }
```

Accept only if it returns a real Responses object **and** a follow-up request carrying `context_management: [{ type: "compaction", compact_threshold: N }]` (a) is not rejected and (b) surfaces the compaction — a summary the gateway can read back. A 404/400, or a silent accept with no observable compaction event, means the gateway cannot append a truthful marker and must fall back to Option B. Record the probe output in the task report.

**What would change, if the gate passes:**

1. **`gateway/src/provider/openai-provider.ts`** — `client.chat.completions.create` → `client.responses.create`. This is not a parameter swap: the request field is `input` (typed items), not `messages`; text arrives as `response.output_text.delta` events, not `choices[0].delta.content`; function calls arrive as `function_call` output items, not `choices[0].delta.tool_calls`. `tool-call-accumulator.ts` (index-keyed delta concat) is rewritten or retired.
2. **`gateway/src/provider/provider-client.ts`** — `ProviderRequest` gains `contextManagement?: { compactThresholdTokens: number }`; `ProviderStreamChunk` gains a variant `{ type: "compaction"; summary: string; coveredThroughIndex: number }`. Note `ProviderStreamChunk` is deliberately structurally compatible with `MockLLMStreamChunk` (`shared/testing/src/mock-llm-provider.ts`) — adding a variant is safe, changing the existing ones is not.
3. **`gateway/src/store/model-projection.ts`** — must emit Responses `input` items rather than Chat `messages[]`, **or** an adapter must sit between them. This is the expensive part: that file's block-adjacency pairing rules encode hard-won failures and must be re-derived, not hand-ported. Its test suite is the acceptance gate.
4. **Statelessness must be preserved.** Responses offers server-side conversation state (`conversation`, `previous_response_id`, `store: true`). Do **not** use it: spec §3 makes the local session store the single source of truth, and a provider-held conversation is a second record that can drift — exactly the `ConversationMirror` failure 2.0 exists to delete. Send the full input every request with `store: false`.
5. **The consumer of the compaction chunk is unchanged in spirit.** On a `{ type: "compaction" }` chunk the gateway still appends a `kind:"compaction"` entry, and every positional constraint from (0.3) still applies — the marker still supersedes everything before it, so it still may only be appended at a turn boundary, and a mid-turn provider-side compaction must be buffered until the turn settles rather than appended where it arrives.
6. **What is deleted:** `summarize()` and the summarizer prompt template. `estimateTokens`, the boundary/turn-split helpers, the race guard, and the whole `orchestrator.compaction` config block **stay** — `enabled` and `compact_threshold_tokens` simply feed the provider parameter instead of the local check, and `keep_recent_turns` becomes inert (drop it from the schema in the same change if so).

**Rule of thumb for the operator:** Option A saves one provider round trip per compaction and hands summary quality to the provider. It costs a full provider-layer rewrite (Chat Completions → Responses) plus a projection rewrite, on a wire that neither configured provider is known to serve. Option B costs one extra completion per compaction, entirely under our control, on the wire §4.1 already commits to.
