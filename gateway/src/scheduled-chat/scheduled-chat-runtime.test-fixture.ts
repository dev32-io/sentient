import type { OrchestratorConfig } from "@sentient/config";
import type { AccessManager } from "../access/access-manager.js";
import type { UserPrincipal } from "../identity/user-principal.js";
import type { ProviderClient, ProviderRequest } from "../provider/provider-client.js";
import { createSessionRuntime } from "../runtime/session-runtime.js";
import type { TurnEmitter } from "../runtime/turn-emitter.js";
import type { SessionHandles } from "../session-handlers/session-registry.js";
import type { BackgroundRegistry } from "../tools/background-registry.js";
import type { ToolBroker } from "../tools/tool-broker.js";

function runtimeConfig(): OrchestratorConfig {
  return {
    calendar: {
      enabled: true,
      query: { max_days: 30, max_occurrences: 25, page_size: 10 },
      input: {
        max_title_chars: 64,
        max_description_chars: 256,
        max_query_chars: 64,
        max_group_chars: 32,
        max_tag_chars: 16,
        max_tags: 4,
      },
      output: { max_result_chars: 4000 },
      recurrence: { max_occurrences: 1000, max_days: 4000 },
      nudge: { max_per_day: 10 },
      default_event_tz_id: "UTC",
    },
    provider: {
      base_url: "http://localhost:0",
      model: "test-model",
      max_output_tokens: 1024,
      request_timeout_ms: 120000,
      site_name: "Sentient",
      reasoning_effort: "low",
    },
    skills: { max_index_entries: 10, max_body_chars: 1000 },
    loop: { max_iterations: 2 },
    permission: { request_timeout_ms: 1000 },
    tools: {
      foreground_timeout_ms: 1000,
      max_concurrent_background_tasks: 1,
      background_completion_request_echo_chars: 100,
      max_tool_result_chars: 1000,
    },
    delegation: {
      frontmatter_dir: "./config/delegation",
      hermes_timeout_ms: 1000,
      hermes_source_profile: "default",
      hermes_delegation_profile: "default",
      hermes_profile_create_timeout_ms: 1000,
      hermes_mcp_register_timeout_ms: 1000,
    },
    auxiliary: {
      enabled: false,
      template_dir: "system_prompts/auxiliary",
      override_dir: "config/auxiliary",
      max_output_tokens: 100,
      input_truncation_chars: 1000,
      reasoning_effort: "none",
      title_word_target: 5,
      title_max_chars: 60,
    },
    compaction: {
      enabled: false,
      compact_threshold_tokens: 24000,
      keep_recent_turns: 4,
      summarizer_max_output_tokens: 1000,
      max_consecutive_failures: 3,
      max_backoff_turns: 16,
    },
    memory: {
      enabled: false,
      core_max_lines: 10,
      core_max_chars: 1000,
      topic_max_lines: 10,
      topic_max_chars: 1000,
      read_max_chars: 1000,
      prompt_budget_chars: 1000,
      service: { url: "http://127.0.0.1:0", request_timeout_ms: 100 },
      spark: {
        enabled: false,
        min_similarity: 0.6,
        max_snippets: 1,
        token_budget: 100,
        recency_half_life_days: 90,
        recency_floor: 0.35,
        timeout_ms: 100,
        raw_chunks: false,
      },
      recall: { k: 1, context_entries: 1 },
      dreamer: {
        enabled: false,
        hour: 3,
        preservation_pct: 75,
        max_input_chars_per_call: 1000,
        max_output_tokens: 100,
        catch_up_threshold_hours: 24,
        yield_check_ms: 100,
        model: "",
      },
    },
  };
}

function noToolBroker(ownerUserId: string): ToolBroker {
  const background: BackgroundRegistry = {
    count: () => 0,
    newestStartedAtMs: () => null,
    register: () => {},
    complete: () => {},
  };
  return {
    ownerUserId: ownerUserId as never,
    foregroundInFlight: 0,
    ready: async () => {},
    definitions: () => [],
    dispatch: async () => {
      throw new Error("text fixture must not dispatch tools");
    },
    background,
    setBackgroundCompletionSink: () => {},
  };
}

const emitter: TurnEmitter = {
  sessionTitle: () => {},
  turnStarted: () => {},
  textDelta: () => {},
  turnCompleted: () => {},
  turnAborted: () => {},
  playbackStop: () => {},
  conversationSnapshot: () => {},
  conversationEntry: () => {},
  taskList: () => {},
  audioStart: () => {},
  audioFrame: () => {},
  audioDone: () => {},
  permissionRequest: () => {},
  permissionResolved: () => {},
  delegationProgress: () => {},
};

export function createTextRuntimeFixture(accessManager: AccessManager): {
  readonly providerCalls: ProviderRequest[];
  readonly buildHandles: (principal: UserPrincipal, sessionId: string) => SessionHandles;
} {
  const providerCalls: ProviderRequest[] = [];
  const provider: ProviderClient = {
    stream(request) {
      providerCalls.push(request);
      return (async function* () {
        yield { type: "text" as const, content: "Saved scheduled response" };
        yield { type: "done" as const, finishReason: "stop" };
      })();
    },
  };
  return {
    providerCalls,
    buildHandles(principal, sessionId) {
      const runtime = createSessionRuntime({
        principal,
        sessionId,
        accessManager,
        provider,
        broker: noToolBroker(principal.userId),
        emitter,
        timeZone: { zone: () => "UTC" },
        systemPrompt: "test scheduled conversation",
        config: runtimeConfig(),
      });
      return {
        runtime,
        work: {
          get isTurnInFlight() {
            return runtime.running;
          },
          get hasPendingForegroundTool() {
            return false;
          },
          get hasOutstandingPrompt() {
            return false;
          },
          get hasAuxiliaryTaskInFlight() {
            return false;
          },
          get newestBackgroundTaskStartedAtMs() {
            return null;
          },
        },
        dispose: () => runtime.dispose(),
      } as unknown as SessionHandles;
    },
  };
}
