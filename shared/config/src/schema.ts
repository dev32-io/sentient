import { z } from "zod";
import { hermesBuiltinToolsSchema } from "./schemas/hermes-builtin-tools";
import { hermesConfigSchema } from "./schemas/hermes-config";
import { mcpCatalogSchema } from "./schemas/mcp-catalog";

// ---------------------------------------------------------------------------
// Session — turn detection, barge-in, inactivity
// ---------------------------------------------------------------------------

export const bargeInConfigSchema = z.object({
  no_interrupt_ms: z.number().int().min(0).default(500),
  min_speech_duration_ms: z.number().int().min(0).default(50),
});

export type BargeInConfig = z.output<typeof bargeInConfigSchema>;

export const sessionConfigSchema = z.object({
  inactivity_timeout_ms: z.number().int().min(0).default(300_000),
  inactivity_check_interval_ms: z.number().int().min(1000).default(30_000),
  tts_drain_grace_ms: z.number().int().min(0).max(5000).default(2000),
  barge_in: bargeInConfigSchema.default({}),
  // WS resilience (resumable sequenced stream + replay buffer) — Slice 3
  // Bun WS idle close timeout in ms; gateway converts to seconds at boot.
  // Bun's idleTimeout cap is 255 s → max effective value 255000 ms.
  ws_idle_timeout_ms: z.number().int().min(1000).max(255000),
  // How long a disconnected PersonSession + per-device replay buffer survive
  // before eviction. Range: 60000–86400000 (1 min – 24 hr).
  retention_ttl_ms: z.number().int().min(60_000).max(86_400_000),
  // Per device-session replay ring buffer cap in bytes (evict-oldest).
  // Range: 65536–268435456 (64 KB – 256 MB).
  replay_buffer_max_bytes: z.number().int().min(65_536).max(268_435_456),
});

export type SessionConfig = z.output<typeof sessionConfigSchema>;

// ---------------------------------------------------------------------------
// STT — local-stt service (Silero VAD + Smart-Turn v3 + SenseVoice-Small)
// ---------------------------------------------------------------------------

export const sttConfigSchema = z.object({
  provider: z.literal("local-stt"),
  url: z.string().default("ws://stt-service:8766"),
  language: z.enum(["en", "zh"]).default("en"),
  input_sample_rate: z.number().int().min(8000).default(48000),
  silence_idle_gap_ms: z.number().int().min(0).max(10000).default(200),
  tts_echo_cooldown_ms: z.number().int().min(0).max(5000).default(2500),
  connect_timeout_ms: z.number().int().min(1000).default(10000),
});

export type STTConfig = z.output<typeof sttConfigSchema>;

// ---------------------------------------------------------------------------
// LLM — OpenRouter
// ---------------------------------------------------------------------------

export const llmConfigSchema = z.object({
  // Gateway-side LLM client. ONLY used for the emotion-tagger pass today
  // (Hermes owns the chat LLM). Both `openrouter` and `ollama-cloud` speak
  // OpenAI-compatible REST; provider selects api-key env + default base_url.
  // ollama-cloud requires a local ollama daemon sidecar (see Task 82); the
  // hosted https://ollama.com endpoint rejects auth on completions even
  // with a valid key. Keep openrouter as the working default until the
  // sidecar lands.
  provider: z.enum(["openrouter", "ollama-cloud"]).default("openrouter"),
  // Optional override; when omitted the factory uses the canonical base_url
  // for the chosen provider (openrouter → openrouter.ai/api/v1,
  // ollama-cloud → ollama.com/v1).
  base_url: z.string().optional(),
  chat_model: z.string().default("google/gemini-2.5-flash"),
  max_tokens: z.number().int().min(1).default(1024),
  timeout_ms: z.number().int().min(1000).default(30000),
  use_tool_calling: z.boolean().default(true),
  stream: z.boolean().default(true),
});

export type LLMConfig = z.output<typeof llmConfigSchema>;

// ---------------------------------------------------------------------------
// TTS — Fish Audio
//
// Note: emotion_tags + utterance_aggregator live here because they are
// internal stages of the speak effect's text→audio pipeline, not general
// LLM configuration. The speak effect streams LLM text deltas through
// UtteranceAggregator → EmotionTagger → Fish Audio as one mini-pipeline.
// ---------------------------------------------------------------------------

export const utteranceAggregatorConfigSchema = z.object({
  // Hard cap; if no paragraph break hits, force-flush so TTS doesn't
  // stall on a run-on generation. Trade-off: slightly awkward mid-
  // paragraph cut vs. stalled audio. Paragraph-sized default keeps the
  // aggregator out of the way for normal replies.
  max_block_chars: z.number().int().min(10).max(4000).default(600),
});

export type UtteranceAggregatorConfig = z.output<typeof utteranceAggregatorConfigSchema>;

export const emotionTagsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  // Model used for the per-block emotion-tagging LLM call. Cheap +
  // fast is preferable since this runs in the critical path of first
  // audio byte. Multi-turn message shape benefits from prompt caching.
  // Routed through `llm.provider` (default ollama-cloud).
  model: z.string().default("google/gemini-2.5-flash"),
  // Per-call budget. On timeout, falls through with the raw (untagged)
  // block so TTS still gets audio.
  timeout_ms: z.number().int().min(100).max(30000).default(2000),
});

export type EmotionTagsConfig = z.output<typeof emotionTagsConfigSchema>;

export const ttsConfigSchema = z.object({
  provider: z.literal("fish-audio"),
  voice_id: z.string().default("default"),
  model_id: z.string().default("speech-1.6"),
  // Defaults match the pre-refactor runtime: index.ts used to spread
  // TTS_DEFAULTS (opus/48000) then override to "pcm" + 44100. PCM is what
  // the Fish Audio stream + WebRTC loopback expect; opus/48000 produces
  // static. Keep these defaults stable — they are the working combination.
  format: z.enum(["opus", "pcm", "mp3"]).default("pcm"),
  bitrate: z.number().int().min(1).default(48000),
  sample_rate: z.number().int().min(1).default(44100),
  latency: z.enum(["normal", "balanced"]).default("balanced"),
  chunk_length_ms: z.number().int().min(50).default(200),
  connect_timeout_ms: z.number().int().min(1000).default(10000),
  stop_timeout_ms: z.number().int().min(1000).default(10000),
  idle_timeout_ms: z.number().int().min(1000).default(10000),
  utterance_aggregator: utteranceAggregatorConfigSchema.default({}),
  emotion_tags: emotionTagsConfigSchema.default({}),
});

export type TTSConfig = z.output<typeof ttsConfigSchema>;

// ---------------------------------------------------------------------------
// TLS — self-signed cert for LAN HTTPS/WSS
// ---------------------------------------------------------------------------

export const tlsConfigSchema = z.object({
  // Flip to false to serve plain HTTP/WS. Only useful for local debugging —
  // browsers refuse `new WebSocket("ws://…")` from an HTTPS page (mixed
  // content), so this must be true whenever the web client is HTTPS.
  enabled: z.boolean().default(true),
  // Every hostname/IP the browser might use to reach the gateway. Each entry
  // lands in the cert's SubjectAltName list. A mismatch produces a hard
  // browser warning AND refuses mic access. Edit this list and delete the
  // persisted cert dir to force regeneration.
  hostnames: z.array(z.string()).default(["localhost"]),
});

export type TlsConfig = z.output<typeof tlsConfigSchema>;

// ---------------------------------------------------------------------------
// Logging — file retention
// ---------------------------------------------------------------------------

export const loggingConfigSchema = z.object({
  // Log verbosity. "debug" for local dev (deploy/docker/), "info" for
  // production (deploy/pi/). Lower-cased; accepts debug|info|warning|error.
  level: z.enum(["debug", "info", "warning", "error"]).default("info"),

  // Number of days to keep rotated log files. Files older than this are
  // deleted at startup and on each daily rollover. 0 disables pruning.
  retention_days: z.number().int().min(0).max(365).default(7),

  // Per-category level overrides, keyed by colon-joined LogTape category
  // path (e.g. "sentient:cerebrum:hermes-event-translator"). Anything not
  // listed inherits the top-level `level`. Use this to flip debug on for
  // a specific path while chasing a stall, without redeploying with a
  // global debug level.
  level_overrides: z.record(z.string(), z.enum(["debug", "info", "warning", "error"])).default({}),
});

export type LoggingConfig = z.output<typeof loggingConfigSchema>;

// ---------------------------------------------------------------------------
// Cerebrum — cognitive cycle orchestration
// ---------------------------------------------------------------------------

export const cerebrumCycleConfigSchema = z.object({
  debounce_window_ms: z.number().int().min(10).max(5000).default(80),
  standard_threshold: z.number().min(0).max(100).default(50),
  immediate_wake_threshold: z.number().min(0).max(200).default(100),
  max_per_hour: z.number().int().min(1).max(1000).default(120),
  max_iterations: z.number().int().min(1).max(50).default(10),
  max_iter_warn_ahead: z.number().int().min(1).max(20).default(3),
  history_max_tokens: z.number().int().min(256).max(32768).default(4096),
});

export type CerebrumCycleConfig = z.output<typeof cerebrumCycleConfigSchema>;

export const cerebrumTaskTableConfigSchema = z.object({
  // Last N completed tasks to include alongside running tasks in the
  // per-cycle task table. Raising this gives the model longer recall of
  // what it's done; lowering it saves tokens.
  window: z.number().int().min(1).max(500).default(30),
});

export type CerebrumTaskTableConfig = z.output<typeof cerebrumTaskTableConfigSchema>;

export const cerebrumConversationHistoryConfigSchema = z.object({
  // Hard cap on in-memory history entries (FIFO eviction). OOM guard only;
  // per-cycle token budget is controlled by cycle.history_max_tokens.
  // At default 10000 entries × ~300 B/entry the memory ceiling is ~3-5 MB,
  // plenty of headroom for realistic family-voice-assistant sessions.
  max_entries: z.number().int().min(100).max(1_000_000).default(10_000),
});

export type CerebrumConversationHistoryConfig = z.output<typeof cerebrumConversationHistoryConfigSchema>;

export const cerebrumConfigSchema = z.object({
  // Sole supported provider since Phase 1.9. The "in-process" cerebrum
  // (CognitiveCycle / TaskManager / effects) was deleted; only Hermes
  // remains. Kept as a single-value enum for future provider plugins.
  provider: z.literal("hermes").default("hermes"),
  cycle: cerebrumCycleConfigSchema.default({}),
  task_table: cerebrumTaskTableConfigSchema.default({}),
  conversation_history: cerebrumConversationHistoryConfigSchema.default({}),
  salience_map_path: z.string().default("/app/config/salience_map.yaml"),
  // Bypass the family-friendly persona guardrails. When true, loads
  // `system_prompts/system_prompt_unlimited.md` (STT + TTS mechanics only,
  // no safety/behavior rules) instead of `persona.md` + `system_prompt.md`.
  // Use for testing local / uncensored models; keep `false` in production.
  unlimited_mode: z.boolean().default(false),
});

export type CerebrumConfig = z.output<typeof cerebrumConfigSchema>;

// ---------------------------------------------------------------------------
// WebUI — client-side playback tuning relayed via session.ready
// ---------------------------------------------------------------------------

export const webuiPlaybackConfigSchema = z.object({
  // Minimum playback duration (ms) guaranteed to the current cycle before a
  // newer cycle's audio is allowed to preempt. Set to 0 to disable. Default 3000.
  min_eager_end_ms: z.number().int().min(0).default(3000),
  // Gain fade-out duration (ms) applied when preempting to avoid clicks.
  // Range: 10–100. Default 30.
  preempt_fadeout_ms: z.number().int().min(0).max(100).default(30),
});

export type WebuiPlaybackConfig = z.output<typeof webuiPlaybackConfigSchema>;

export const webuiConfigSchema = z.object({
  playback: webuiPlaybackConfigSchema.default({}),
});

export type WebuiConfig = z.output<typeof webuiConfigSchema>;

// ---------------------------------------------------------------------------
// Auth — user-facing login (PIN + token)
// ---------------------------------------------------------------------------

export const authConfigSchema = z.object({
  // Lifetime (seconds) for issued PASETO tokens. Rolling-refreshed on each
  // auth-check. Default 7 days (604800).
  token_ttl_seconds: z.number().int().min(60).default(604800),
  // Window (ms) for the WS client to send its auth message after connect.
  // Connection closed if not received in time. Default 5000.
  ws_auth_timeout_ms: z.number().int().min(100).default(5000),
  // argon2id parameters — increase memory/iterations if Pi-5 can spare the CPU.
  argon2_memory_kb: z.number().int().min(8192).default(65536),
  argon2_iterations: z.number().int().min(1).default(3),
  argon2_parallelism: z.number().int().min(1).default(1),
});

export type AuthConfig = z.output<typeof authConfigSchema>;

// ---------------------------------------------------------------------------
// Apply — settings-change orchestration (docker restart + health check)
// ---------------------------------------------------------------------------

export const applyConfigSchema = z.object({
  // Max wall time for `docker restart hermes-<user>` to return.
  docker_restart_timeout_ms: z.number().int().min(5000).default(30000),
  // Max wall time for Hermes /health to return 200 after the restart command.
  // Hermes boot is not just process-up: MCP discovery (3–10s × N servers) +
  // auxiliary-client provider detect + tool registration + session-db open
  // all happen before /health flips to 200. Cold cache + busy upstream
  // routinely pushes past 30s; the old default produced false-positive
  // "agent didn't come back" UX in the apply-bar.
  health_check_timeout_ms: z.number().int().min(1000).default(90000),
  // Poll cadence for /health during the health-checking state.
  health_poll_interval_ms: z.number().int().min(100).default(1000),
  // Max wall time for the Phase D personality/SOUL profile-restart orchestrator
  // to wait for the per-user WS adapter to come back online after supervisord
  // restarts the Hermes process. Same boot-cost story as health_check_timeout_ms
  // above — kept in the same neighbourhood. Range: 5000–120000.
  profile_restart_timeout_ms: z.number().int().min(5000).default(90000),
  // Cadence between WS-readiness polls during the profile-restart orchestrator's
  // polling phase. Range: 50–1000.
  profile_restart_poll_interval_ms: z.number().int().min(50).default(250),
  // Max wait for a ping→pong round-trip after pool upsert during user creation,
  // confirming the new worker can accept dispatches. Range: 1000–30000.
  dispatch_ping_timeout_ms: z.number().int().min(1000).default(8000),
});

export type ApplyConfig = z.output<typeof applyConfigSchema>;

// ---------------------------------------------------------------------------
// Providers — external catalog endpoints + cache TTLs
// ---------------------------------------------------------------------------

export const providersConfigSchema = z.object({
  openrouter_cache_ttl_ms: z.number().int().min(10_000).default(3_600_000),
  ollama_cloud_base_url: z.string().url().default("https://ollama.com/v1"),
  ollama_cache_ttl_ms: z.number().int().min(10_000).default(3_600_000),
  fish_cache_ttl_ms: z.number().int().min(10_000).default(600_000),
  external_fetch_timeout_ms: z.number().int().min(1000).default(5000),
});

export type ProvidersConfig = z.output<typeof providersConfigSchema>;

// ---------------------------------------------------------------------------
// Sessions — past-sessions feature: pagination, search, titles, switch flow
// ---------------------------------------------------------------------------

export const sessionsConfigSchema = z.object({
  // Default page size for the sessions.list wire request. Range: 1–100.
  list_page_size: z.number().int().positive().max(100).default(20),
  // Hard cap on FTS results returned by sessions.search. Range: 1–50.
  search_max_results: z.number().int().positive().max(50).default(20),
  // Minimum query length; shorter queries are dropped before hitting the
  // server. Range: 0–10.
  search_min_chars: z.number().int().min(0).max(10).default(2),
  // Client-side debounce floor for sessions.search keystrokes. Surfaced
  // here so operators can tune without rebuilding the webui. Range: 50–1000.
  search_debounce_ms: z.number().int().min(50).max(1000).default(300),
  // Upper bound on user-supplied session titles (rename input). Range: 10–500.
  title_max_chars: z.number().int().min(10).max(500).default(200),
  // Per-profile JSON store directory for title overrides (legacy layout).
  // Migrator runs at startup; once migrated to user_data_root the file at
  // <title_override_dir>/<userId>.json moves to
  // <user_data_root>/<userId>/sessions/titles.json. Kept for the migration
  // window only; remove once all profiles have been migrated.
  title_override_dir: z.string().min(1).default("~/.sentient/gateway/session-titles"),
  // Per-user, per-category data root. Layout:
  //   <user_data_root>/<userId>/sessions/titles.json
  //   <user_data_root>/<userId>/preferences/...   (future)
  //   <user_data_root>/<userId>/memory/...        (future)
  // Outermost dir is the userId so per-user wipe/backup is one rm. Categories
  // nest under each userId so future stores drop in without restructuring.
  user_data_root: z.string().min(1).default("~/.sentient/gateway/users"),
  // Adapter-side `source` tag written on every new Hermes chain so the
  // gateway can distinguish UI-created sessions from agent-spawned ones.
  source_tag: z.string().min(1).default("sentient-user"),
  // Per-request timeout for the gateway → Hermes /api/sessions/* HTTP
  // calls (list, search, getMessages, rename, …). Range: 1000–30000.
  hermes_http_timeout_ms: z.number().int().min(1000).max(30_000).default(5000),
  // Max wall time SwitchFlow waits for the active cycle to cancel before
  // proceeding with the switch anyway. Range: 500–10000.
  switch_teardown_timeout_ms: z.number().int().min(500).max(10_000).default(3000),
  // Min ms between client session.new — blocks spam/double-fire, not
  // human-paced new chats. Per-connection (one client), NOT per-user.
  // Range: 0–60000.
  min_new_interval_ms: z.number().int().min(0).max(60_000).default(500),
});

export type SessionsConfig = z.output<typeof sessionsConfigSchema>;

// ---------------------------------------------------------------------------
// Companions — version resolution for co-deployed services
// ---------------------------------------------------------------------------

export const companionsConfigSchema = z.object({
  // HTTP endpoint for the STT service health check. Returns {"version":"..."}.
  // Override if your compose setup uses a different service name or port.
  stt_health_url: z.string().url().default("http://sentient-stt-service:8767/health"),
  // Absolute path to the file the hermes container writes on every boot.
  // Both containers mount the sentient-supervisor volume at /data/supervisor.
  hermes_version_path: z.string().default("/data/supervisor/.versions/hermes"),
  // How long (ms) a successfully resolved set of versions is cached.
  // Avoids hammering companion services on every API call. Range: 10000–3600000.
  version_cache_ttl_ms: z.number().int().min(10_000).default(300_000),
  // Per-source fetch timeout (ms) for the STT /health HTTP call.
  // File read for hermes is not subject to this timeout. Range: 500–30000.
  version_fetch_timeout_ms: z.number().int().min(500).default(3000),
});

export type CompanionsConfig = z.output<typeof companionsConfigSchema>;

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export const gatewayConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(8888),
  host: z.string().default("0.0.0.0"),
  max_sessions: z.number().int().min(1).max(1000).default(100),
  auth_timeout_ms: z.number().int().min(1000).default(5000),
  session_persist_ms: z.number().int().min(0).default(120000),
  tls: tlsConfigSchema.default({}),
  // session block is required — no default; WS-resilience fields must be
  // explicitly present in every config.yaml (fail loud if missing per config rule).
  session: sessionConfigSchema,
  logging: loggingConfigSchema.default({}),
  stt: sttConfigSchema,
  llm: llmConfigSchema,
  tts: ttsConfigSchema,
  cerebrum: cerebrumConfigSchema.default({}),
  webui: webuiConfigSchema.default({}),
  hermes: hermesConfigSchema.optional(),
  auth: authConfigSchema.default({}),
  apply: applyConfigSchema.default({}),
  providers: providersConfigSchema.default({}),
  // Past-sessions feature tunables: pagination, search bounds, title length,
  // override-store location, source tag, HTTP + switch-teardown timeouts.
  sessions: sessionsConfigSchema.default({}),
  // Co-deployed companion service configuration: version resolution URLs,
  // file paths, and cache knobs. Defaults work for the standard docker compose.
  companions: companionsConfigSchema.default({}),
  // Operator-managed inventory of available MCP servers. Per-user
  // profiles reference these by name in `tools.enabled[]`. Add a new MCP
  // by editing this section in config.yaml (no code change required).
  mcp_catalog: mcpCatalogSchema,
  // Per-tool inventory of Hermes built-in tools. Powers the webui Tools
  // page's "Hermes built-ins" category (per-tool toggles backed by
  // toolset-level enable/disable). Operator-managed YAML; no runtime
  // introspection of the Hermes image required.
  hermes_builtin_tools: hermesBuiltinToolsSchema,
  // Optional map of managed docker services controlled by the system
  // orchestrator. When absent (default), the orchestrator is disabled and
  // the setup wizard operates without automatic service lifecycle management.
  // Each key is a service name; values are ManagedServiceConfig records
  // validated by the orchestrator's own schema at runtime.
  managed_services: z.record(z.string(), z.unknown()).optional(),
});

export type GatewayConfig = z.output<typeof gatewayConfigSchema>;
