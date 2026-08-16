import { z } from "zod";

export const orchestratorConfigSchema = z.object({
  provider: z.object({
    // OPTIONAL OpenAI-compatible base URL override (OpenRouter, local Ollama,
    // etc.). The composition root's active-provider connection comes from
    // the operator's secrets store (`SecretsStore.getActiveLlm()`) — this
    // key is consulted ONLY when the secrets store's own base_url is empty
    // (e.g. the default openrouter entry ships with no base_url). Leave
    // empty ("") to always defer to the secrets store.
    base_url: z.union([z.literal(""), z.string().url()]).default(""),
    // Model id sent on every request. The key + base_url are resolved from
    // the secrets store at composition-root construction time, NOT from an
    // env var — see gateway/src/bootstrap/resolve-provider-connection.ts.
    model: z.string().min(1),
    // Per-request ANSWER cap. Reasoning tokens are charged against this SAME
    // budget, so a reasoning model (gpt-oss:20b emits a Harmony reasoning
    // channel first) can exhaust it before any visible text —
    // finish_reason:"length" with an EMPTY reply (D17, docs/native-todo.md
    // § 1: an 81KB ha_get_history result was enough to trigger it live). Same
    // question as `compaction.summarizer_max_output_tokens` below, just for
    // the main loop instead of the summarizer. See config.yaml for the full
    // "why 8000" rationale. Range 1-32000.
    max_output_tokens: z.number().int().min(1).max(32000).default(8000),
    // Per-request wall-clock deadline (ms). Match to the model's worst case.
    request_timeout_ms: z.number().int().min(1000).max(600000).default(120000),
    // Optional site attribution headers (OpenRouter convention).
    site_name: z.string().default("Sentient"),
    // Constrains how much the model reasons before answering. Sent
    // UNCONDITIONALLY (see openai-provider.ts) on every value except
    // "unset" — an OpenAI-compatible endpoint that rejects the unrecognized
    // field will 400 on EVERY turn until reconfigured. "unset" is the
    // escape hatch: it omits the field from the request entirely. "none" is
    // NOT that escape hatch — it is a real SDK-typed value (zero reasoning
    // effort, field still sent). "low" rather than "minimal": minimal
    // reasoning effort can degrade TOOL SELECTION, and picking the wrong
    // tool is worse than a slightly slower reply. See config.yaml for the
    // full rationale.
    reasoning_effort: z.enum(["unset", "none", "minimal", "low", "medium", "high", "xhigh", "max"]).default("low"),
  }),
  loop: z.object({
    // ReAct iteration cap: consecutive tool-calling iterations before a
    // forced content-only final answer.
    max_iterations: z.number().int().min(1).max(50).default(10),
  }),
  permission: z
    .object({
      // Wall-clock deadline for a human answer to an L3 `confirm` prompt
      // (ms). On expiry the request AUTO-DENIES (spec §7.1 — a timeout is
      // never an implicit approval) and the model receives a "permission
      // request timed out" tool result. 5000-600000; spec default 120000
      // (2 minutes).
      request_timeout_ms: z.number().int().min(5000).max(600000).default(120000),
    })
    // Block-level default: operator configs (`~/.sentient/gateway/config/config.yaml`)
    // are edited in place and predate this key — a missing block must never
    // brick boot for a gateway that was working yesterday.
    .default({}),
  web: z
    .object({
      worker_url: z.string().url().default("http://127.0.0.1:8090"),
      request_timeout_ms: z.number().int().min(500).max(120000).default(20000),
      max_compressed_bytes: z.number().int().min(1024).max(20_000_000).default(2_000_000),
      max_decompressed_bytes: z.number().int().min(1024).max(50_000_000).default(5_000_000),
      max_redirects: z.number().int().min(0).max(10).default(5),
      initial_extract_chars: z.number().int().min(200).max(20_000).default(6000),
      artifact_ttl_ms: z.number().int().min(60_000).max(604_800_000).default(86_400_000),
      artifact_max_entries: z.number().int().min(1).max(1000).default(100),
      artifact_max_bytes: z.number().int().min(1024).max(500_000_000).default(50_000_000),
      read_max_chars: z.number().int().min(200).max(50_000).default(12_000),
      match_max_passages: z.number().int().min(1).max(20).default(5),
      match_context_chars: z.number().int().min(50).max(2000).default(500),
    })
    .optional(),
  tools: z.object({
    // Per-tool-call deadline for a foreground MCP call (ms).
    foreground_timeout_ms: z.number().int().min(1000).max(120000).default(30000),
    // Max concurrent background tasks per session (generous for family scale).
    max_concurrent_background_tasks: z.number().int().min(1).max(500).default(50),
    // Chars of the ORIGINATING request echoed back into a background-task
    // completion note, so the model can tell which of several in-flight tasks
    // just came back without joining on the dispatch — which compaction
    // summarises away. Too small and the echo stops identifying the task; too
    // large and every completion re-pays for the dispatch. 32-2000.
    background_completion_request_echo_chars: z.number().int().min(32).max(2000).default(240),
    // Ceiling on a SINGLE tool result's character length before it reaches
    // the model, enforced at the broker (tool-broker.ts) so every tool
    // inherits it rather than each tool author remembering to bound its own
    // output. ha_get_history returning ~81KB was the first result big enough
    // to crowd the answer out of `provider.max_output_tokens` entirely (D17);
    // read_file/write_file hit the same ceiling next. See config.yaml for the
    // full rationale (head-and-tail truncation, marker wording). Range
    // 1000-200000.
    max_tool_result_chars: z.number().int().min(1000).max(200000).default(20000),
  }),
  // SKILLS (skill-system spec) — the per-user/operator SKILL.md library
  // surfaced to the model as a system-prompt index plus on-demand bodies.
  skills: z
    .object({
      // Skills listed in the system-prompt index. Overflow WARNs at boot and
      // truncates newest-first, so an operator who keeps piling on skills
      // notices rather than silently losing the oldest ones out of context.
      // Range 1-500.
      max_index_entries: z.number().int().min(1).max(500).default(50),
      // Max SKILL.md body accepted at write time, in characters (~5k tokens
      // at the default). Guards the same class of blowout as
      // `tools.max_tool_result_chars` — a skill body is read into model
      // context whenever the skill is invoked. Range 1000-100000.
      max_body_chars: z.number().int().min(1000).max(100000).default(20000),
    })
    // Block-level default: operator configs (`~/.sentient/gateway/config/config.yaml`)
    // are edited in place and predate this key — a missing block must never
    // brick boot for a gateway that was working yesterday.
    .default({}),
  delegation: z.object({
    // Per-agent frontmatter file dir (static delegation envelopes).
    frontmatter_dir: z.string().default("./config/delegation"),
    // Deadline for a single Hermes one-shot invocation (ms). Long-running.
    //
    // COUPLED TO `session.lost_task_threshold_ms`: a delegation still
    // registered past that threshold is treated as LOST and stops holding its
    // session resident, so a value here ABOVE it would let a live delegation be
    // orphaned — the session torn down with its store handle closed, and the
    // result dropped when it finally lands. `create-gateway-services.ts` floors
    // the effective threshold at this value + 60s and WARNs, so raising this
    // key alone is safe; the two are stated together because the operator who
    // raises it has no reason to read the session block.
    hermes_timeout_ms: z.number().int().min(1000).max(3600000).default(600000),
    // Configured Hermes profile that each new per-user profile is cloned from,
    // so the clone inherits provider + model + credentials. The gateway never
    // holds a Hermes credential; Hermes copies its own.
    hermes_source_profile: z.string().min(1).default("default"),
    // The Hermes profile a delegation actually RUNS under (`hermes -p <this>`),
    // and therefore whose provider credential it uses. Distinct from
    // `hermes_source_profile` above, which is only the clone template at user
    // creation: a clone copies the credential once and nothing re-syncs it, so
    // per-user profiles go stale and answer HTTP 401. Interim — per-user
    // isolation for delegated agents is product design with its own spec.
    hermes_delegation_profile: z.string().min(1).default("default"),
    // Deadline for one `hermes profile create` (ms). Range 1000-120000.
    hermes_profile_create_timeout_ms: z.number().int().min(1000).max(120000).default(30000),
    // Deadline for one `hermes mcp add` / `hermes config get` invocation used
    // to register the gateway's MCP on a user's Hermes profile (ms). `mcp add`
    // dials the socket and lists its tools before saving, so this is longer
    // than a pure config write. Range 1000-120000.
    hermes_mcp_register_timeout_ms: z.number().int().min(1000).max(120000).default(30000),
  }),
  // AUXILIARY TASKS (spec §6) — the out-of-band model calls that are ABOUT a
  // conversation rather than part of it. Session titling is the first; tags,
  // follow-up suggestions and summarisation are the named next ones, and each
  // is a template plus a caller, not a new config block. Every knob here is
  // therefore deliberately task-AGNOSTIC except the two `title_*` ones.
  auxiliary: z
    .object({
      // Master switch for EVERY auxiliary task. false = the gateway never
      // makes an out-of-band model call, and a session keeps the fallback
      // title its first message produced.
      enabled: z.boolean().default(true),
      // Baked-in template directory, relative to the gateway asset root
      // (config/asset-root.ts). Ships with the build.
      template_dir: z.string().min(1).default("system_prompts/auxiliary"),
      // OPERATOR OVERRIDE directory, same root, consulted FIRST. A file here
      // wins over the baked-in one of the same name, so an operator can
      // retune a prompt without a rebuild. Missing is the normal case.
      // Survives a restart but NOT an upgrade — it resolves inside the
      // installed release's asset root, and each deploy is a new versioned
      // dir. See config.yaml for the full caveat.
      override_dir: z.string().min(1).default("config/auxiliary"),
      // Output cap for one auxiliary call. A structured answer of a few words
      // needs nothing like the loop's answer cap, and an auxiliary call that
      // runs long is a call the user is paying for and never sees. Large
      // enough that a model emitting a short reasoning preamble still reaches
      // its JSON. Range 32-2000.
      max_output_tokens: z.number().int().min(32).max(2000).default(200),
      // Ceiling on the CHARACTERS of substituted input in one auxiliary
      // prompt, shared across every variable. Bounds the seam, not each
      // caller: a pasted document in the first message must not blow the
      // titling prompt — the same class as `tools.max_tool_result_chars`.
      // Range 200-20000.
      input_truncation_chars: z.number().int().min(200).max(20000).default(4000),
      // Reasoning effort for auxiliary calls specifically. "none" because a
      // title does not need a reasoning phase and the reasoning channel is
      // charged against `max_output_tokens` above. Same vocabulary as
      // `provider.reasoning_effort`, and the operator's global "unset"
      // escape hatch still wins: when the provider block is "unset" the field
      // is omitted from EVERY request, auxiliary ones included, so a strict
      // endpoint stays working.
      reasoning_effort: z.enum(["unset", "none", "minimal", "low", "medium", "high", "xhigh", "max"]).default("none"),
      // TITLING — how many words a generated session title should aim for.
      // Substituted into the template, so it is a target the prompt states,
      // never a cap the code enforces (`title_max_chars` is the cap).
      // Range 2-12; 3-5 is the Open WebUI convention.
      title_word_target: z.number().int().min(2).max(12).default(5),
      // TITLING — hard ceiling on a stored/emitted title, in characters, and
      // the length the fallback truncates the first message to. MUST stay at
      // or under the wire contract's own 200-char `TITLE_MAX`
      // (shared/protocol/src/sessions.ts) or the frame is rejected before it
      // leaves. Range 8-200.
      title_max_chars: z.number().int().min(8).max(200).default(60),
    })
    // Block-level default: operator configs are edited in place and predate
    // this key — a missing block must never brick a gateway that worked
    // yesterday.
    .default({}),
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
      // Output cap for the SUMMARIZER request specifically. The loop's
      // `provider.max_output_tokens` is an ANSWER cap; a reasoning model
      // (gpt-oss:20b emits a Harmony reasoning channel before any visible
      // text) exhausts 1024 on the transcript it is digesting and finishes
      // with finish_reason:"length" and an EMPTY summary, which fails
      // compaction silently and forever. Range 512-8000.
      summarizer_max_output_tokens: z.number().int().min(512).max(8000).default(4000),
      // Consecutive failed compaction attempts before the runtime stops
      // retrying at every single turn boundary and logs one ERROR naming the
      // reason. Past this it retries on an exponentially widening turn
      // interval instead, so a permanently-failing summarizer costs one
      // provider call per 2^n turns rather than one per turn. Range 1-20.
      max_consecutive_failures: z.number().int().min(1).max(20).default(3),
      // Ceiling on that exponentially widening retry interval, in turn
      // boundaries. Without one, `2 ** (failures - max_consecutive_failures)`
      // doubles forever: ~20 further failures puts the next attempt a million
      // turns away, which in a long session IS the permanent give-up the gate
      // is documented not to be. On reaching the cap the runtime logs one
      // ERROR naming it, so a stalled summarizer is visible rather than silent.
      // Keep well above max_consecutive_failures and low enough that a
      // recovered provider is retried within one sitting. Range 1-256.
      max_backoff_turns: z.number().int().min(1).max(256).default(16),
    })
    .default({}),
  // MEMORY (memory-system spec §11) — MEMORY.md + topic files + spark recall +
  // the dreamer consolidation pass. Every sub-block defaults to `{}` and every
  // leaf carries its own zod default, same as the other blocks in this file:
  // an operator config predating this key must still boot.
  memory: z
    .object({
      // Master switch for the whole memory module.
      enabled: z.boolean().default(true),
      // MEMORY.md line cap; injected every session. Range 50-2000.
      core_max_lines: z.number().int().min(50).max(2000).default(300),
      // MEMORY.md char cap, dual with the line cap — first hit wins. Range 2000-100000.
      core_max_chars: z.number().int().min(2000).max(100000).default(12000),
      // Topic files are read on demand, not injected every turn. Range 100-10000.
      topic_max_lines: z.number().int().min(100).max(10000).default(2000),
      // Range 10000-500000.
      topic_max_chars: z.number().int().min(10000).max(500000).default(80000),
      // Per memory_read page, head-and-tail capped. Range 1000-40000.
      read_max_chars: z.number().int().min(1000).max(40000).default(8000),
      // Aggregate memory block budget in the system prompt. Range 5000-100000.
      prompt_budget_chars: z.number().int().min(5000).max(100000).default(20000),
      service: z
        .object({
          // OPTIONAL deep-memory service base URL. LOOPBACK ONLY — the
          // service is a native managed addon (like whisper-stt/local-tts),
          // never LAN- or internet-reachable.
          url: z.string().url().default("http://127.0.0.1:8771"),
          // Deadline on every DeepMemoryClient call. Range 200-60000.
          request_timeout_ms: z.number().int().min(200).max(60000).default(5000),
        })
        .default({}),
      spark: z
        .object({
          // Per-user toggle overrides downward. Slice-staged: zod default
          // stays `true` for missing-block resilience; the SHIPPED config.yaml
          // sets this `false` until T15 flips it on.
          enabled: z.boolean().default(true),
          // Relevance gate (cosine similarity, 0-1) — gates alone; recency
          // only orders passed hits. Prefer empty over weak. Range 0-1.
          // CALIBRATED FOR multilingual-e5-small (the pinned embedding model):
          // unrelated text floors around ~0.74 cosine, a genuine match measures
          // ~0.86+ (0.866 observed live in S2 e2e), so 0.60 never withheld
          // anything. A DIFFERENT embedding model has a different floor and needs
          // recalibration here.
          min_similarity: z.number().min(0).max(1).default(0.78),
          // Hard cap on injected snippets. Range 1-10.
          max_snippets: z.number().int().min(1).max(10).default(3),
          // Hard cap on the injected spark section, in tokens. Range 50-2000.
          token_budget: z.number().int().min(50).max(2000).default(250),
          // Ordering decay half-life, in days. Range 7-3650.
          recency_half_life_days: z.number().int().min(7).max(3650).default(90),
          // Decay floor — orders passed hits, never gates them. Range 0-1.
          recency_floor: z.number().min(0).max(1).default(0.35),
          // Per-turn search deadline; expiry = spark withheld. Range 50-5000.
          timeout_ms: z.number().int().min(50).max(5000).default(500),
          // Index raw transcript chunks in addition to memory text — noisy
          // and costly; off by default.
          raw_chunks: z.boolean().default(false),
        })
        .default({}),
      recall: z
        .object({
          // Hits per memory_recall. Range 1-20.
          k: z.number().int().min(1).max(20).default(5),
          // Entries of context around a drill-down hit. Range 0-10.
          context_entries: z.number().int().min(0).max(10).default(2),
        })
        .default({}),
      dreamer: z
        .object({
          // Per-user toggle overrides downward. Slice-staged: zod default
          // stays `true` for missing-block resilience; the SHIPPED config.yaml
          // sets this `false` until T20 flips it on.
          enabled: z.boolean().default(true),
          // Local time hour the nightly consolidation pass runs. Range 0-23.
          hour: z.number().int().min(0).max(23).default(3),
          // Refuse op batches that would shrink MEMORY.md below this percent
          // of its current size. Range 0-100.
          preservation_pct: z.number().int().min(0).max(100).default(75),
          // Per-map-call session window, in chars. Range 4000-400000.
          max_input_chars_per_call: z.number().int().min(4000).max(400000).default(60000),
          // Output cap for one dreamer LLM call. Range 200-16000.
          max_output_tokens: z.number().int().min(200).max(16000).default(3000),
          // Boot catch-up fires when the last consolidation mark is older
          // than this many hours. Range 1-168.
          catch_up_threshold_hours: z.number().int().min(1).max(168).default(24),
          // Defer while the user has an active turn; re-checked on this
          // interval. Range 500-60000.
          yield_check_ms: z.number().int().min(500).max(60000).default(5000),
          // "" = inherit provider.model; a non-empty value overrides the model
          // for dreamer map/reduce calls only (background distillation can run
          // a cheaper/faster model than chat).
          model: z.string().default(""),
        })
        .default({}),
    })
    // Block-level default: operator configs are edited in place and predate
    // this key — a missing block must never brick boot for a gateway that
    // was working yesterday.
    .default({}),
});
export type OrchestratorConfig = z.output<typeof orchestratorConfigSchema>;
