import { join } from "node:path";
import type {
  ApplyConfig as ApplyYaml,
  AuthConfig as AuthYaml,
  CerebrumConfig as CerebrumYaml,
  CompanionsConfig as CompanionsYaml,
  HermesBuiltinTools,
  HermesConfig as HermesYaml,
  LLMConfig as LLMYaml,
  McpCatalog,
  ProvidersConfig as ProvidersYaml,
  STTConfig as STTYaml,
  SessionConfig as SessionYaml,
  SessionsConfig as SessionsYaml,
  TTSConfig as TTSYaml,
  TlsConfig as TlsYaml,
  WebuiConfig as WebuiYaml,
} from "@sentient/config";
import { getLog } from "../logging/logger.ts";
import { loadGatewayConfig } from "./gateway-config.ts";
import { migrateOperatorConfigYamlSync } from "./operator-config-migrator.ts";

export interface LoggingConfig {
  logLevel: string;
  logDir: string;
  retentionDays: number;
  levelOverrides: Record<string, string>;
}

export interface StartupConfig {
  logging: LoggingConfig;

  port: number;
  host: string;
  maxSessions: number;
  authTimeoutMs: number;

  webDistDir: string | undefined;

  tls: TlsYaml & { certsDir: string };

  session: SessionYaml;

  /** Top-level language ("en" | "zh") mirrored from stt.language for ergonomics. */
  language: "en" | "zh";

  /** `undefined` when no stt block — voice STT disabled. Always defined in
   *  current config.yaml schema (stt is required), but kept optional for
   *  forward compatibility. */
  stt: STTYaml | undefined;

  /** `undefined` when no api key matches the configured `llm.provider`
   *  (OPENROUTER_API_KEY for openrouter, OLLAMA_API_KEY for ollama-cloud). */
  llm: (LLMYaml & { apiKey: string }) | undefined;

  /** TTS yaml block — always defined. The Fish Audio API key resolves
   *  lazily inside tts-factory from the wizard's SecretsStore (with the
   *  FISH_AUDIO_API_KEY env as a dev-only fallback), so we no longer gate
   *  service-enabled on a boot-time env presence. Per-cycle voice_id
   *  comes from PersonSession.voiceId; cfg.tts.voice_id is the fallback
   *  default for sessions with no profile-supplied voice. */
  tts: TTSYaml;

  cerebrum: CerebrumYaml;
  webui: WebuiYaml;
  hermes: HermesYaml | undefined;
  auth: AuthYaml;
  apply: ApplyYaml;
  providers: ProvidersYaml;
  sessions: SessionsYaml;
  companions: CompanionsYaml;
  mcpCatalog: McpCatalog;
  /** Per-tool descriptor list for Hermes built-in tools — surfaces the
   *  "Hermes built-ins" category on the webui Tools page. Operator-owned;
   *  zero runtime introspection of the Hermes image. */
  hermesBuiltinTools: HermesBuiltinTools;
  /** Optional managed-services map forwarded verbatim from YAML.
   *  Validated by the system orchestrator's own schema at runtime. */
  managedServices: Record<string, unknown> | undefined;
}

export function loadLoggingConfig(): LoggingConfig {
  const gatewayRoot = join(import.meta.dir, "..", "..");
  const configPath = process.env.GATEWAY_CONFIG_PATH ?? join(gatewayRoot, "config.yaml");
  migrateOperatorConfigYamlSync(configPath);
  const cfg = loadGatewayConfig(configPath);
  return {
    logLevel: cfg.logging.level,
    logDir: process.env.LOG_DIR ?? "logs",
    retentionDays: cfg.logging.retention_days,
    levelOverrides: cfg.logging.level_overrides,
  };
}

export function loadStartupConfig(): StartupConfig {
  const log = getLog(["sentient", "config"]);

  const gatewayRoot = join(import.meta.dir, "..", "..");
  const configPath = process.env.GATEWAY_CONFIG_PATH ?? join(gatewayRoot, "config.yaml");

  migrateOperatorConfigYamlSync(configPath);
  const cfg = loadGatewayConfig(configPath);
  log.info("config-loaded", { path: configPath });

  const openrouterApiKey = process.env.OPENROUTER_API_KEY ?? "";
  const ollamaApiKey = process.env.OLLAMA_API_KEY ?? "";
  const llmApiKey = cfg.llm.provider === "ollama-cloud" ? ollamaApiKey : openrouterApiKey;

  return {
    logging: {
      logLevel: cfg.logging.level,
      logDir: process.env.LOG_DIR ?? "logs",
      retentionDays: cfg.logging.retention_days,
      levelOverrides: cfg.logging.level_overrides,
    },

    port: cfg.port,
    host: cfg.host,
    maxSessions: cfg.max_sessions,
    authTimeoutMs: cfg.auth_timeout_ms,

    webDistDir: process.env.WEB_DIST_DIR,

    tls: { ...cfg.tls, certsDir: process.env.GATEWAY_CERTS_DIR ?? join(gatewayRoot, "certs") },

    session: cfg.session,

    language: cfg.stt.language,

    stt: cfg.stt,

    llm: llmApiKey ? { ...cfg.llm, apiKey: llmApiKey } : undefined,

    // TTS is always wired; the Fish Audio API key resolves lazily inside
    // tts-factory at synthesis time. SecretsStore (populated by the
    // wizard's voice step) is the source of truth; FISH_AUDIO_API_KEY env
    // is a dev-only fallback. A missing key only fails the synth call,
    // not boot.
    tts: cfg.tts,

    cerebrum: cfg.cerebrum,
    webui: cfg.webui,
    hermes: cfg.hermes,
    auth: cfg.auth,
    apply: cfg.apply,
    providers: cfg.providers,
    sessions: cfg.sessions,
    companions: cfg.companions,
    mcpCatalog: cfg.mcp_catalog,
    hermesBuiltinTools: cfg.hermes_builtin_tools,
    managedServices: cfg.managed_services,
  };
}
