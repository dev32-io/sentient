import { z } from "zod";
import { accessConfigSchema } from "./schemas/access-config";
import { hermesBuiltinToolsSchema } from "./schemas/hermes-builtin-tools";
import { hermesConfigSchema } from "./schemas/hermes-config";
import { mcpCatalogSchema } from "./schemas/mcp-catalog";
import { orchestratorConfigSchema } from "./schemas/orchestrator-config";
import { storeConfigSchema } from "./schemas/store-config";

// ---------------------------------------------------------------------------
// Session — connection + inactivity limits
// ---------------------------------------------------------------------------

export const sessionConfigSchema = z.object({
  // Bun WS idle close timeout in ms; gateway converts to seconds at boot.
  // Bun's idleTimeout cap is 255 s → max effective value 255000 ms.
  ws_idle_timeout_ms: z.number().int().min(1000).max(255000),
  // Per-user concurrent WS session cap. Bounds memory under churn (one user /
  // reconnect-loop). Range 1–100.
  per_user_max_sessions: z.number().int().min(1).max(100),
  // Reconnect gap-fill (spec §11 slice 6). Per-surface cap on the outbound
  // frame journal that lets a reconnecting client replay what it missed.
  // Oldest frames evict first; the newest frame is never evicted. Range
  // 65536–268435456 (64 KB–256 MB).
  // `.default()` (unlike this block's two older keys) so an operator's
  // existing config.yaml keeps booting without an operator-config-migrator
  // schema_version bump.
  replay_journal_max_bytes: z.number().int().min(65536).max(268435456).default(16777216),
  // How long a DETACHED surface journal is kept for a reconnect before it is
  // dropped. Past this, a resuming client gets stream.resumed{recovered:false}
  // and REST-refetches its history. Range 1000–3600000 (1 s–1 h).
  replay_journal_retention_ms: z.number().int().min(1000).max(3600000).default(300000),
});

export type SessionConfig = z.output<typeof sessionConfigSchema>;

// ---------------------------------------------------------------------------
// STT — local-stt service (Silero VAD + Smart-Turn v3 + SenseVoice-Small)
// ---------------------------------------------------------------------------

export const sttConfigSchema = z.object({
  provider: z.literal("local-stt"),
  url: z.string().default("ws://stt-service:8766"),
  language: z.enum(["en", "zh", "auto"]).default("auto"),
  input_sample_rate: z.number().int().min(8000).default(48000),
  silence_idle_gap_ms: z.number().int().min(0).max(10000).default(200),
  tts_echo_cooldown_ms: z.number().int().min(0).max(5000).default(2500),
  connect_timeout_ms: z.number().int().min(1000).default(10000),
});

export type STTConfig = z.output<typeof sttConfigSchema>;

// ---------------------------------------------------------------------------
// TTS — local-tts (LocalTTSService)
//
// The full text frontend (markdown stripping, emoji stripping, paragraph
// aggregation) runs service-side in local-tts — the gateway forwards raw LLM
// text deltas over the wire and does no text preprocessing of its own.
// ---------------------------------------------------------------------------

export const ttsConfigSchema = z.object({
  // WS endpoint for the native local-tts (LocalTTSService) provider.
  // The service needs Metal/MLX GPU access, so it runs on the host, not in
  // a container — reachable from the gateway container via
  // host.docker.internal (same pattern as native-whisper STT).
  url: z.string().default("ws://host.docker.internal:8770"),
  voice_id: z.string().default("default"),
  // The gateway live path is opus-only: webui + mobile decoders only
  // understand OGG-Opus, and local-tts-provider.ts's LIVE_ENCODING/
  // LIVE_SAMPLE_RATE hardcode the "opus" tag on every TTSAudioChunk
  // regardless of what's requested here. "pcm" is a real, tested wire
  // format the LocalTTSService SUPPORTS (see
  // capabilityServices/LocalTTSService's `?format=pcm` negotiation)
  // for direct, non-gateway consumers (e.g. audiobook generation) — but
  // the gateway itself never requests it, so the enum only offers the
  // value the gateway can actually decode. These fields shape the
  // connect-time negotiation query string only.
  format: z.enum(["opus"]).default("opus"),
  sample_rate: z.number().int().min(1).default(48000),
  connect_timeout_ms: z.number().int().min(1000).default(10000),
  // Max ms to await a voice.create/list/delete reply from the local TTS
  // service; create can block behind an in-flight synthesis, so keep
  // generous.
  voice_op_timeout_ms: z.number().int().min(1).default(30000),
  // Preview greetings by language — one is chosen at random per Play preview
  // and synthesized live in the target voice, in the voice pack's language.
  // Keyed by language code (e.g. "en", "zh"); each value is a short (~2s)
  // greeting pool. The default covers English only — see gateway/config.yaml
  // for the full per-language map.
  preview_greetings: z
    .record(z.string(), z.array(z.string()))
    .default({ en: ["Hi, I'm your family's Sentient assistant. How can I help?"] }),
  preview_timeout_ms: z.number().int().min(1).default(8000), // max wait for a preview synth
  voice_description_max_len: z.number().int().min(1).default(12000), // create/edit description cap (~2000 words)
  voice_tag_max_len: z.number().int().min(1).default(24), // per-tag char cap
  voice_max_tags: z.number().int().min(0).default(8), // max tags per voice
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
  // production (deploy/mac-prod/). Lower-cased; accepts debug|info|warning|error.
  level: z.enum(["debug", "info", "warning", "error"]).default("info"),

  // Number of days to keep rotated log files. Files older than this are
  // deleted at startup and on each daily rollover. 0 disables pruning.
  retention_days: z.number().int().min(0).max(365).default(7),

  // Per-category level overrides, keyed by colon-joined LogTape category
  // path (e.g. "sentient:session-router"). Anything not listed inherits
  // the top-level `level`. Use this to flip debug on for a specific path
  // while chasing a stall, without redeploying with a global debug level.
  level_overrides: z.record(z.string(), z.enum(["debug", "info", "warning", "error"])).default({}),
});

export type LoggingConfig = z.output<typeof loggingConfigSchema>;

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
// Providers — external catalog endpoints + cache TTLs
// ---------------------------------------------------------------------------

export const providersConfigSchema = z.object({
  openrouter_cache_ttl_ms: z.number().int().min(10_000).default(3_600_000),
  ollama_cloud_base_url: z.string().url().default("https://ollama.com/v1"),
  ollama_cache_ttl_ms: z.number().int().min(10_000).default(3_600_000),
  external_fetch_timeout_ms: z.number().int().min(1000).default(5000),
  // Feature flag for the self-contained Fish-Audio browse-and-clone module.
  // When false, the gateway 404s every /providers/voices* route and the webui
  // hides the "Clone from Fish Audio" tab. Set false (or delete the fish/
  // modules) to fully disable the integration.
  fish_browse_enabled: z.boolean().default(true),
  // Cache TTL for the default (unfiltered, page-1) Fish voice listing. Fish
  // rate limits are undocumented — keep short.
  fish_cache_ttl_ms: z.number().int().min(10_000).default(600_000),
});

export type ProvidersConfig = z.output<typeof providersConfigSchema>;

// ---------------------------------------------------------------------------
// Companions — version resolution for co-deployed services
// ---------------------------------------------------------------------------

export const companionsConfigSchema = z.object({
  // HTTP endpoint for the STT service health check. Returns {"version":"..."}.
  // Override if your compose setup uses a different service name or port.
  stt_health_url: z.string().url().default("http://sentient-stt-service:8767/health"),
  // HTTP endpoint for the local-tts (LocalTTSService) health check.
  // Returns {"version":"..."}. The service runs on the host (Metal/MLX),
  // reachable via host.docker.internal — mirrors stt_health_url's shape.
  tts_health_url: z.string().url().default("http://host.docker.internal:8771/health"),
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
// Downloads — public /download page + mobile artifact serving (OTA root)
// ---------------------------------------------------------------------------

export const downloadsConfigSchema = z.object({
  // Container path to the mounted release dir holding apk/ipa/manifest.json.
  // Mounted read-only from ~/.sentient/releases via the docker-compose volumes stanza.
  artifacts_dir: z.string().default("/app/releases"),
  // Absolute HTTPS origin used to build itms-services plist URLs (must be HTTPS).
  // Must match the gateway's externally reachable HTTPS hostname.
  public_base_url: z.string().url().default("https://sentient.dev32.io"),
});

export type DownloadsConfig = z.output<typeof downloadsConfigSchema>;

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export const gatewayConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(8888),
  host: z.string().default("0.0.0.0"),
  max_sessions: z.number().int().min(1).max(1000).default(100),
  auth_timeout_ms: z.number().int().min(1000).default(5000),
  tls: tlsConfigSchema.default({}),
  // session block is required — no default; connection/inactivity fields
  // must be explicitly present in every config.yaml (fail loud if missing
  // per config rule).
  session: sessionConfigSchema,
  // Access — capability minting + per-user physical isolation (spec §2.1, §2.5).
  // Required — no default; every deployment must pick a user_data_root.
  access: accessConfigSchema,
  // Store — durable per-user session history (spec §3). Optional; the
  // filename default matches the standard single-DB-per-user layout.
  store: storeConfigSchema.default({}),
  // Orchestrator — the native LLM agent loop (spec §4/§5). Optional during
  // the mid-transition state: the runtime isn't wired to a consumer yet
  // (Plan 2). The composition root that constructs the orchestrator runtime
  // MUST fail loudly if this is absent when the orchestrator is enabled.
  orchestrator: orchestratorConfigSchema.optional(),
  logging: loggingConfigSchema.default({}),
  stt: sttConfigSchema,
  tts: ttsConfigSchema,
  webui: webuiConfigSchema.default({}),
  hermes: hermesConfigSchema.optional(),
  auth: authConfigSchema.default({}),
  providers: providersConfigSchema.default({}),
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
  // Public /download page + mobile OTA artifact serving. Always present;
  // defaults match the standard docker-compose volume layout. Override
  // artifacts_dir and public_base_url in config.yaml for your deployment.
  downloads: downloadsConfigSchema.default({}),
});

export type GatewayConfig = z.output<typeof gatewayConfigSchema>;
