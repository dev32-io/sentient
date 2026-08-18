// REPRO HARNESS — a multi-stretch reply must render as ONE bubble everywhere.
//
// Reproduces the exact turn shape captured in the 2026-08-05 iOS vitals
// (`~/.sentient/gateway/clientLogs/mobile/u_0417d3b0-1785984302291-5E0DFA.log`):
// ONE ReAct turn in which the model produced text THREE times — narration,
// a tool round trip, more narration, another tool round trip, the answer —
// committed as entries 824 / 831 / 834, all carrying one bubble key, while
// the live stream accumulated all three into a single buffer
// (`inflight-message done turnId=… bubbles=1`, totalLen=364).
//
// A scripted provider makes that shape deterministic. Waiting for a real model
// to narrate mid-loop is what made this bug hard to reproduce three times over.
//
// The turn is then rendered THREE ways and the three must agree:
//
//   live      — `turn.text.delta` grouped by the bubble key the gateway stamps.
//               This is what InFlightMessageConnector / the web in-flight
//               connector accumulate, one buffer per key.
//   committed — the `conversation.entry` stream, appended in arrival order.
//               This is what a client's committed mirror holds.
//   replay    — a fresh `conversation.snapshot`. This is what a reload paints.
//
// `render(live) == render(committed) == render(replay)` is the contract. The
// gateway is the authority for where a reply starts and stops; no client may
// re-derive it, so all three readings of the same turn must already agree on
// the wire.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import type { OrchestratorConfig } from "@sentient/config";
import type { ConversationFeedItem } from "@sentient/protocol";
import { createAccessManager } from "../access/access-manager.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { ProviderClient, ProviderRequest, ProviderStreamChunk } from "../provider/provider-client.js";
import type { BackgroundRegistry } from "../tools/background-registry.js";
import type { ToolBroker } from "../tools/tool-broker.js";
import type { ToolDefinition, ToolInvocation, ToolResult } from "../tools/tool-types.js";
import type { SessionRuntime } from "./session-runtime.js";
import { createSessionRuntime } from "./session-runtime.js";
import type { TurnEmitter } from "./turn-emitter.js";

const ROOT = "/tmp/sentient-reply-bubble-convergence-test";
mkdirSync(ROOT, { recursive: true });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

// ─── Fixtures ───────────────────────────────────────────────────────────────

function testConfig(): OrchestratorConfig {
  return {
    calendar: { enabled: true, recurrence: { max_occurrences: 1000, max_days: 366 }, nudge: { max_per_day: 10 }, default_event_tz_id: "household" },
    provider: {
      base_url: "http://localhost:0",
      model: "test-model",
      max_output_tokens: 1024,
      request_timeout_ms: 120000,
      site_name: "Sentient",
      reasoning_effort: "low",
    },
    skills: { max_index_entries: 50, max_body_chars: 20000 },
    loop: { max_iterations: 10 },
    permission: { request_timeout_ms: 120000 },
    tools: {
      foreground_timeout_ms: 30000,
      max_concurrent_background_tasks: 50,
      background_completion_request_echo_chars: 240,
      max_tool_result_chars: 20000,
    },
    delegation: {
      frontmatter_dir: "./config/delegation",
      hermes_timeout_ms: 600000,
      hermes_source_profile: "default",
      hermes_delegation_profile: "default",
      hermes_profile_create_timeout_ms: 30000,
      hermes_mcp_register_timeout_ms: 30000,
    },
    // Off: an auxiliary title call would take a provider slot the scripted
    // fixture below indexes by call number.
    auxiliary: {
      enabled: false,
      template_dir: "system_prompts/auxiliary",
      override_dir: "config/auxiliary",
      max_output_tokens: 200,
      input_truncation_chars: 4000,
      reasoning_effort: "none",
      title_word_target: 5,
      title_max_chars: 60,
    },
    compaction: {
      enabled: false,
      compact_threshold_tokens: 24000,
      keep_recent_turns: 4,
      summarizer_max_output_tokens: 4000,
      max_consecutive_failures: 3,
      max_backoff_turns: 16,
    },
    memory: {
      enabled: true,
      core_max_lines: 300,
      core_max_chars: 12000,
      topic_max_lines: 2000,
      topic_max_chars: 80000,
      read_max_chars: 8000,
      prompt_budget_chars: 20000,
      service: { url: "http://127.0.0.1:8771", request_timeout_ms: 5000 },
      spark: {
        enabled: true,
        min_similarity: 0.6,
        max_snippets: 3,
        token_budget: 250,
        recency_half_life_days: 90,
        recency_floor: 0.35,
        timeout_ms: 500,
        raw_chunks: false,
      },
      recall: { k: 5, context_entries: 2 },
      dreamer: {
        enabled: true,
        hour: 3,
        preservation_pct: 75,
        max_input_chars_per_call: 60000,
        max_output_tokens: 3000,
        catch_up_threshold_hours: 24,
        yield_check_ms: 5000,
        model: "",
      },
    },
  };
}

/** One `stream()` call's chunks — the loop calls the provider once per ReAct
 *  iteration, so a script is a list of iterations, not a list of chunks. */
type ScriptedIteration = ProviderStreamChunk[];

function scriptedProvider(script: ScriptedIteration[]): ProviderClient & { calls: ProviderRequest[] } {
  const calls: ProviderRequest[] = [];
  return {
    calls,
    async *stream(req) {
      calls.push(req);
      const iteration = script[calls.length - 1];
      if (iteration === undefined) {
        // Past the end of the script — terminate cleanly rather than hang.
        yield { type: "text", content: "(script exhausted)" };
        yield { type: "done", finishReason: "stop" };
        return;
      }
      for (const chunk of iteration) yield chunk;
    },
  };
}

function fakeBroker(defs: ToolDefinition[], result: (inv: ToolInvocation) => ToolResult): ToolBroker {
  const background: BackgroundRegistry = {
    count: () => 0,
    newestStartedAtMs: () => null,
    register: () => {},
    complete: () => {},
  };
  return {
    ownerUserId: "u_aaaaaaaa",
    foregroundInFlight: 0,
    ready: async () => {},
    definitions: () => defs,
    dispatch: async (inv) => result(inv),
    background,
    setBackgroundCompletionSink: () => {},
  };
}

// ─── The three readings ─────────────────────────────────────────────────────

interface CapturedDelta {
  turnId: string;
  replyId: string | undefined;
  text: string;
}

interface CapturedEntry {
  turnId: string | undefined;
  replyId: string | undefined;
  item: ConversationFeedItem;
}

interface CapturingEmitter extends TurnEmitter {
  deltas: CapturedDelta[];
  entries: CapturedEntry[];
  snapshots: ConversationFeedItem[][];
  completedTurns: string[];
}

function capturingEmitter(): CapturingEmitter {
  const deltas: CapturedDelta[] = [];
  const entries: CapturedEntry[] = [];
  const snapshots: ConversationFeedItem[][] = [];
  const completedTurns: string[] = [];
  return {
    deltas,
    entries,
    snapshots,
    completedTurns,
    turnStarted: () => {},
    textDelta: (turnId, text, replyId) => deltas.push({ turnId, replyId, text }),
    turnCompleted: (turnId) => completedTurns.push(turnId),
    turnAborted: () => {},
    playbackStop: () => {},
    conversationSnapshot: (items) => snapshots.push(items),
    conversationEntry: (item, turnId, replyId) => entries.push({ turnId, replyId, item }),
    audioStart: () => {},
    audioFrame: () => {},
    audioDone: () => {},
    permissionRequest: () => {},
    permissionResolved: () => {},
    delegationProgress: () => {},
    taskList: () => {},
    sessionTitle: () => {},
  };
}

/**
 * What a client's in-flight connector accumulates: one buffer per bubble key,
 * in the order the keys were first seen. Mirrors
 * `InFlightMessageConnector.buffers` (a LinkedHashMap keyed by
 * `replyId ?: turnId`) and the web SDK's equivalent.
 */
function renderLive(deltas: readonly CapturedDelta[]): string[] {
  const buffers = new Map<string, string>();
  for (const d of deltas) {
    const key = d.replyId ?? d.turnId;
    buffers.set(key, (buffers.get(key) ?? "") + d.text);
  }
  return [...buffers.values()];
}

/** Assistant text a client's committed mirror holds, in arrival order. */
function renderCommitted(entries: readonly CapturedEntry[]): string[] {
  return entries.filter((e) => e.item.kind === "assistant").map((e) => (e.item as { content: string }).content);
}

/** Assistant text a reload paints from `conversation.snapshot`. */
function renderSnapshot(items: readonly ConversationFeedItem[]): string[] {
  return items.filter((i) => i.kind === "assistant").map((i) => (i as { content: string }).content);
}

// ─── The case ───────────────────────────────────────────────────────────────

const listPlayers: ToolDefinition = {
  name: "ma_list_players",
  description: "lists media players",
  parameters: { type: "object", properties: {} },
  category: "foreground",
  tier: "read",
};
const playMedia: ToolDefinition = {
  name: "ma_play_media",
  description: "plays media",
  parameters: { type: "object", properties: {} },
  category: "foreground",
  tier: "read",
};

const NARRATION_1 = "Let me check the players";
const NARRATION_2 = "Found 3 speakers, starting playback";
const FINAL_ANSWER = "Done — playing on the Kitchen speaker.";

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function runScriptedTurn(caseDir: string): Promise<{ emitter: CapturingEmitter; runtime: SessionRuntime }> {
  const am = createAccessManager({ userDataRoot: `${ROOT}/${caseDir}` });
  const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
  mkdirSync(am.userHomeDir(alice), { recursive: true });

  const provider = scriptedProvider([
    [
      { type: "text", content: NARRATION_1 },
      {
        type: "tool_call",
        toolCall: { id: "call_1", type: "function", function: { name: "ma_list_players", arguments: "{}" } },
      },
      { type: "done", finishReason: "tool_calls" },
    ],
    [
      { type: "text", content: NARRATION_2 },
      {
        type: "tool_call",
        toolCall: { id: "call_2", type: "function", function: { name: "ma_play_media", arguments: "{}" } },
      },
      { type: "done", finishReason: "tool_calls" },
    ],
    [
      { type: "text", content: FINAL_ANSWER },
      { type: "done", finishReason: "stop" },
    ],
  ]);

  const broker = fakeBroker([listPlayers, playMedia], () => ({ content: "ok", isError: false }));
  const emitter = capturingEmitter();

  const runtime = createSessionRuntime({
    principal: alice,
    sessionId: "sess-multi-stretch",
    accessManager: am,
    provider,
    broker,
    emitter,
    timeZone: { zone: () => "UTC" },
    systemPrompt: "you are a test assistant",
    config: testConfig(),
  });

  runtime.submit({ kind: "conversational", text: "play some music" });
  await waitFor(() => emitter.completedTurns.length === 1);
  // The feed publishes the turn's tail at the turn boundary; let that settle.
  await waitFor(() => renderCommitted(emitter.entries).length > 0);

  return { emitter, runtime };
}

describe("a reply produced across several ReAct iterations", () => {
  it("renders as the same bubbles live, committed, and on replay", async () => {
    const { emitter, runtime } = await runScriptedTurn("convergence");

    const live = renderLive(emitter.deltas);
    const committed = renderCommitted(emitter.entries);

    emitter.snapshots.length = 0;
    runtime.emitConversationSnapshot();
    const replay = renderSnapshot(emitter.snapshots[0] ?? []);

    // The model produced text three times, but it is ONE reply: nothing the
    // person sent interrupted it, so nothing broke the bubble. Each assertion
    // names the projection it compares, so a failure reads as "committed !=
    // live" with both renderings in the diff — no console dump needed.
    expect(live).toHaveLength(1);
    expect(committed).toEqual(live);
    expect(replay).toEqual(live);

    runtime.dispose();
  });

  it("carries the bubble key on every committed assistant item, not just the live frame", async () => {
    const { emitter, runtime } = await runScriptedTurn("bubble-key");

    // A window that attaches MID-TURN is answered with a snapshot, and has to
    // know which committed row its live bubble is currently painting. The
    // frame's sidecar is not enough: a snapshot carries items only.
    emitter.snapshots.length = 0;
    runtime.emitConversationSnapshot();
    const assistantItems = (emitter.snapshots[0] ?? []).filter((i) => i.kind === "assistant");

    expect(assistantItems.length).toBeGreaterThan(0);
    for (const item of assistantItems) {
      expect(item).toHaveProperty("replyId");
    }

    runtime.dispose();
  });
});
