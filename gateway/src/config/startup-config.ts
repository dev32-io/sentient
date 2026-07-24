import { join } from "node:path";
import type {
  ApplyConfig as ApplyYaml,
  AuthConfig as AuthYaml,
  CerebrumConfig as CerebrumYaml,
  CompanionsConfig as CompanionsYaml,
  DownloadsConfig as DownloadsYaml,
  HermesBuiltinTools,
  HermesConfig as HermesYaml,
  McpCatalog,
  ProvidersConfig as ProvidersYaml,
  STTConfig as STTYaml,
  SessionConfig as SessionYaml,
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

  /** Top-level language ("auto" | "en" | "zh") mirrored from stt.language for
   * ergonomics. "auto" = Whisper autodetects (bilingual households). */
  language: "auto" | "en" | "zh";

  /** `undefined` when no stt block — voice STT disabled. Always defined in
   *  current config.yaml schema (stt is required), but kept optional for
   *  forward compatibility. */
  stt: STTYaml | undefined;

  /** TTS yaml block — always defined. tts-factory builds a local-tts
   *  (LocalTTSService) provider from `tts.url` — no API key needed, so
   *  a provider is always constructed (no boot-time or key-presence gate).
   *  cfg.tts.voice_id is the gateway-wide default voice; a future
   *  per-session voice override is Plan 2's concern (SessionRuntime). */
  tts: TTSYaml;

  cerebrum: CerebrumYaml;
  webui: WebuiYaml;
  hermes: HermesYaml | undefined;
  auth: AuthYaml;
  apply: ApplyYaml;
  providers: ProvidersYaml;
  companions: CompanionsYaml;
  mcpCatalog: McpCatalog;
  /** Per-tool descriptor list for Hermes built-in tools — surfaces the
   *  "Hermes built-ins" category on the webui Tools page. Operator-owned;
   *  zero runtime introspection of the Hermes image. */
  hermesBuiltinTools: HermesBuiltinTools;
  /** Optional managed-services map forwarded verbatim from YAML.
   *  Validated by the system orchestrator's own schema at runtime. */
  managedServices: Record<string, unknown> | undefined;
  /** Public /download page + mobile OTA artifact serving. Always present;
   *  defaults to the standard docker-compose layout when not overridden. */
  downloads: DownloadsYaml;
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

    // TTS is always wired to the local-tts (LocalTTSService) provider —
    // no API key required, so nothing here gates on secret presence. A
    // down/unreachable service degrades gracefully at synth time, not boot.
    tts: cfg.tts,

    cerebrum: cfg.cerebrum,
    webui: cfg.webui,
    hermes: cfg.hermes,
    auth: cfg.auth,
    apply: cfg.apply,
    providers: cfg.providers,
    companions: cfg.companions,
    mcpCatalog: cfg.mcp_catalog,
    hermesBuiltinTools: cfg.hermes_builtin_tools,
    managedServices: cfg.managed_services,
    downloads: cfg.downloads,
  };
}
