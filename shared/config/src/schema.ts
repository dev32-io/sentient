import { z } from "zod";
import { accessConfigSchema } from "./schemas/access-config";
import { hermesBuiltinToolsSchema } from "./schemas/hermes-builtin-tools";
import { hermesConfigSchema } from "./schemas/hermes-config";
import { mcpCatalogSchema } from "./schemas/mcp-catalog";
import { orchestratorConfigSchema } from "./schemas/orchestrator-config";
import { storeConfigSchema } from "./schemas/store-config";
import { systemOrchestratorConfigSchema } from "./schemas/system-orchestrator-config";

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
  // Reconnect gap-fill + multi-window join (session-model spec §2.1). Per-
  // SESSION cap on the outbound frame journal that every attached window reads
  // from. Oldest frames evict first — including the last one, so a stale
  // `turn.started` cannot pin itself as the sole survivor. Range
  // 65536–268435456 (64 KB–256 MB).
  // `.default()` (unlike this block's two older keys) so an operator's
  // existing config.yaml keeps booting without an operator-config-migrator
  // schema_version bump.
  //
  // RE-TUNED 16 MB → 32 MB with derived retention (task 8), for two reasons
  // that both point the same way:
  //  1. One journal now serves N windows, and a window that was away has to
  //     gap-fill everything the SESSION produced while it was gone — including
  //     other windows' turns. Per-surface, a detached surface's journal simply
  //     stopped growing; there was nobody writing to it.
  //  2. A session now stays resident while a background task runs, so a whole
  //     turn — text AND its Opus audio — can be journaled with ZERO windows
  //     attached. That is new production, not a redistribution of old.
  // Sized off the retention window rather than a round number: at the ~33 KB/s
  // this journal's own `max_window_lag_bytes` comment anchors 48 kHz Opus at,
  // `retention_ms` (15 min) of continuous speech is ~30 MB. A cap below that
  // would silently break the promise `retention_ms` makes — a window returning
  // at minute 14 would find its cursor evicted and take a fresh snapshot
  // anyway. Note a journal can live up to 2x `retention_ms`: the replay
  // registry's clock starts when the journal is RELEASED, which is at disposal
  // — itself `retention_ms` after the session went idle. That does not move the
  // answer, because the 33 KB/s anchor is several times above real Opus speech
  // bitrate and this is a CEILING on an evict-oldest ring, not an allocation.
  replay_journal_max_bytes: z.number().int().min(65536).max(268435456).default(33554432),
  // How long a SESSION is kept once nothing observable is working on it, and
  // for the same window afterwards, how long its journal survives its last
  // holder. Renamed from `replay_journal_retention_ms` (task 8): the key now
  // governs session lifetime, not journal bytes, and a key that
  // under-describes its job is how the dead `session.idle_timeout_ms` survived
  // with zero readers. What "retained" MEANS is derived, never stored — see
  // gateway/src/runtime/session-retention.ts. Range 1000–3600000 (1 s–1 h).
  retention_ms: z.number().int().min(1000).max(3600000).default(900000),
  // When a still-registered background task is treated as LOST: dropped from
  // the retention predicate and WARNed. MUST exceed the longest a task can
  // legitimately run — for `delegateTask` that is
  // `orchestrator.delegation.hermes_timeout_ms` (600000), after which the
  // runner kills the child and settles. Anything still registered past this is
  // a bookkeeping leak, not work, and without the bound it would hold its
  // session resident for the life of the process. Range 60000–3600000.
  //
  // The ordering constraint is ENFORCED at boot, not left to this comment:
  // `create-gateway-services.ts` floors the effective value at
  // `hermes_timeout_ms + 60s` and WARNs, because getting it wrong marks live
  // work lost and re-arms the orphan derived retention exists to close. This
  // key is only the floor's lower bound, so raising `hermes_timeout_ms` alone
  // is safe.
  lost_task_threshold_ms: z.number().int().min(60000).max(3600000).default(660000),
  // Cap on sessions kept resident while NOTHING holds them — no window, no
  // turn, no tool, no task, no prompt — waiting out `retention_ms`. The oldest
  // idle session is released first when the cap is exceeded.
  //
  // It exists because derived retention REMOVED a bound that used to hold
  // implicitly: under "the last one out disposes", residency was bounded by
  // live attachments (`max_sessions`, `per_user_max_sessions`). Now
  // `conversation.activate` builds a full session per target and each one
  // lingers, so walking the past-chats drawer would leave one resident session
  // per chat visited, each holding a `bun:sqlite` handle, a `ToolBroker` with
  // warmed MCP definitions, a voice and a journal. RETAINED sessions are never
  // counted or evicted — eviction runs the ordinary disposal path, which
  // re-derives first, so this can never cut work. Range 1–500.
  max_idle_resident_sessions: z.number().int().min(1).max(500).default(16),
  // How often a session held ONLY by work, with no window attached, is
  // re-derived. Work COMPLETING is not an attach or a detach, so the registry
  // has no event for it; `SessionRegistry.reevaluate` covers the normal case
  // and this timer bounds the abnormal one. Range 1000–600000 (1 s–10 min).
  retention_recheck_interval_ms: z.number().int().min(1000).max(600000).default(30000),
  // Maximum bytes one window may have queued (transport backpressure, or the
  // attach buffer) before the gateway CLOSES it with RFC 6455 1013. With a
  // shared journal a slow window's prerequisite frames can be evicted while it
  // lags, so it must not be allowed to lag without bound. Disconnect rather
  // than forced re-snapshot: both SDKs already reconnect and gap-fill, and
  // writing more to a socket that cannot drain does not make it drain.
  //
  // The ceiling is Bun's own `backpressureLimit` default (16 MB), NOT an
  // arbitrary round number. The gateway sets no `backpressureLimit` and leaves
  // `closeOnBackpressureLimit` false, so past that limit `ws.send()` returns 0
  // and Bun DROPS the message silently. A threshold above it could never be
  // reached — this policy would be unreachable and the silent loss it exists to
  // bound would be back. Range 65536–16777216 (64 KB–16 MB).
  max_window_lag_bytes: z.number().int().min(65536).max(16777216).default(4194304),
  // How long after one window's input the SESSION's input floor stays that
  // window's (session-model spec §8.3). Two windows sending inside this span are
  // contending simultaneously: the first is applied, the second is refused
  // `session_busy`. Outside it, a later message STEERS the running turn through
  // the ordinary stimulus seam — arbitration is for races, never a floor lock
  // for the whole turn, which would let one speaker own the session until their
  // reply finished and defeat multi-window entirely.
  //
  // WHAT IT DOES *NOT* DO, stated first because the obvious reading is wrong:
  // it does not prevent two concurrent turns. Bun runs WS handlers to
  // completion serially on one thread and `SessionRuntime.submit` sets its
  // in-flight marker synchronously, so by the time a second window's frame
  // dispatches the first turn is ALWAYS already running and the second message
  // would steer. One-turn-at-a-time is structural, not something this key
  // defends.
  //
  // Its only observable effect is converting a would-be steer into a
  // `session_busy` refusal while the window is open. That is worth doing for a
  // genuine race — two people pressing send on the same idle session produce
  // one message and one clear "try again" rather than a spliced double
  // prompt — and it is pure loss outside one, because webui has no optimistic
  // echo and a refused message simply vanishes from the composer.
  //
  // So it is sized to the RACE, not to human patience: ~100 ms covers two
  // clients whose frames left at the same instant plus loopback jitter.
  // Anything longer starts destroying messages that would have been absorbed
  // perfectly well by the running turn. 0 disables arbitration entirely — every
  // input is applied, which is the pre-§8.3 behaviour. Range 0–5000.
  input_arbitration_window_ms: z.number().int().min(0).max(5000).default(100),
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
// inbound-proxy — the public host/LAN entrance
// ---------------------------------------------------------------------------

export const inboundProxyConfigSchema = z.object({
  // Directory holding the cert.pem + key.pem the proxy presents on 443. Null
  // (the default) means "use the gateway's own self-signed material". Prod
  // points this at the externally-managed acme.sh cert. A configured path that
  // does not exist falls back to the self-signed material rather than failing
  // to start — a fresh host has no real cert yet and still needs a door.
  cert_dir: z.string().nullable().default(null),
});
export type InboundProxyConfig = z.output<typeof inboundProxyConfigSchema>;

// ---------------------------------------------------------------------------
// stack — the dev launcher (scripts/stack.sh)
// ---------------------------------------------------------------------------

export const stackConfigSchema = z.object({
  // How long `bun run dev` waits for BOTH the gateway's loopback health and the
  // proxied https://localhost/ before declaring the launch failed. Range
  // 5000-300000. Must outlast a cold image pull plus nginx start.
  readiness_timeout_ms: z.number().int().min(5000).max(300000).default(60000),
  // How often each readiness probe retries within that budget. Range 100-5000.
  readiness_poll_ms: z.number().int().min(100).max(5000).default(500),
  // Seconds to wait for the docker daemon before refusing to launch. Range
  // 0-120. Docker Desktop takes a while from cold on a rebooted machine.
  docker_wait_s: z.number().int().min(0).max(120).default(30),
});
export type StackConfig = z.output<typeof stackConfigSchema>;

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
// Security — inbound prompt-injection scanning (gateway/src/security/)
// ---------------------------------------------------------------------------

export const inboundScanConfigSchema = z
  .object({
    // Master switch for scanning non-person text before it enters model
    // context (tool results, background-task completions, skill bodies,
    // delegation prompts). Missing block or missing key = scanning ON —
    // secure by default, never opt-in.
    enabled: z.boolean().default(true),
    // Per-channel toggles. A channel set to false lets that text pass
    // unscanned into model context — logged at boot so a silently-disabled
    // channel is visible in the log trail, not just the YAML.
    channels: z
      .object({
        tool_result: z.boolean().default(true),
        background_completion: z.boolean().default(true),
        skill_body: z.boolean().default(true),
        delegation_prompt: z.boolean().default(true),
        // Read-time gate on sparked snippets, memory_recall hits, and
        // drill-down session reads (memory-system spec §3.1). MEMORY.md
        // rendered into the system prompt does NOT transit this gate at
        // read time (same as skill descriptions) — it relies on write-time
        // + edit-ingest scanning instead.
        memory_body: z.boolean().default(true),
      })
      .default({}),
  })
  // Block-level default: operator configs are edited in place and predate
  // this key — a missing block must never brick boot for a gateway that was
  // working yesterday. Because every field here also defaults to `true`, the
  // secure-by-default posture holds even when the whole block is absent.
  .default({});

export type InboundScanConfig = z.output<typeof inboundScanConfigSchema>;

export const securityConfigSchema = z.object({
  inbound_scan: inboundScanConfigSchema,
});

export type SecurityConfig = z.output<typeof securityConfigSchema>;

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export const gatewayConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(8888),
  // LOOPBACK ONLY. inbound-proxy owns the LAN-facing 443 and proxies here over
  // the loopback interface; the gateway itself is not reachable from another
  // host. Reverting this to 0.0.0.0 puts the API on every interface with no
  // policy in front of it. This default must agree with the checked-in
  // config.yaml default — a reader assumes the two match.
  host: z.string().default("127.0.0.1"),
  max_sessions: z.number().int().min(1).max(1000).default(100),
  auth_timeout_ms: z.number().int().min(1000).default(5000),
  tls: tlsConfigSchema.default({}),
  // inbound-proxy — the ONE outward-facing door (design 2026-08-04 §2).
  // `.default({})` so a config predating this block still parses; cert_dir
  // falls back to null (gateway's own self-signed material).
  inbound_proxy: inboundProxyConfigSchema.default({}),
  // stack — dev launcher budgets (scripts/stack.sh). `.default({})` for the
  // same reason as inbound_proxy above.
  stack: stackConfigSchema.default({}),
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
  // Operator-managed inventory of available MCP servers, and the ONE
  // enumeration of the tool universe: it declares which tools exist and what
  // impact tier each carries, which is what the role gate and every per-role
  // permission template are derived from. A person's profile addresses these
  // by server + tool name in `tools.permissions` (the retired `tools.enabled[]`
  // name list is gone). Add a new MCP by editing this section in config.yaml
  // (no code change required) — but every tool needs a `tier:`, or the gateway
  // refuses to boot.
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
  // Policy for the system orchestrator itself (health watchdog cadence and
  // back-off) as opposed to the per-service map above. `.default({})` so an
  // operator config.yaml predating this block keeps booting without an
  // operator-config-migrator schema_version bump.
  system_orchestrator: systemOrchestratorConfigSchema.default({}),
  // Public /download page + mobile OTA artifact serving. Always present;
  // defaults match the standard docker-compose volume layout. Override
  // artifacts_dir and public_base_url in config.yaml for your deployment.
  downloads: downloadsConfigSchema.default({}),
  // Security — inbound prompt-injection scanning master switch + per-channel
  // toggles (gateway/src/security/). `.default({})` so an operator config
  // predating this block keeps booting, and every leaf field also defaults
  // to `true` so a missing block lands on scanning ON, never OFF.
  security: securityConfigSchema.default({}),
});

export type GatewayConfig = z.output<typeof gatewayConfigSchema>;
