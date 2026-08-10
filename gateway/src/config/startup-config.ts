import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AccessConfig as AccessYaml,
  AuthConfig as AuthYaml,
  CompanionsConfig as CompanionsYaml,
  DownloadsConfig as DownloadsYaml,
  HermesBuiltinTools,
  HermesConfig as HermesYaml,
  InboundProxyConfig as InboundProxyYaml,
  InboundScanConfig as InboundScanYaml,
  McpCatalog,
  OrchestratorConfig as OrchestratorYaml,
  ProvidersConfig as ProvidersYaml,
  STTConfig as STTYaml,
  SessionConfig as SessionYaml,
  StoreConfig as StoreYaml,
  SystemOrchestratorConfig as SystemOrchestratorYaml,
  TTSConfig as TTSYaml,
  TlsConfig as TlsYaml,
  WebuiConfig as WebuiYaml,
} from "@sentient/config";
import { getLog } from "../logging/logger.ts";
import { resolveWebDistDir } from "./asset-root.ts";
import { loadGatewayConfig } from "./gateway-config.ts";
import { flushMigrationLog, migrateOperatorConfigYamlSync } from "./operator-config-migrator.ts";

/**
 * Expand a single leading `~` path segment to the user's home directory.
 * Lexical only: a `~` that is not the whole path or immediately followed by
 * `/` is left untouched (e.g. `/opt/~backup` stays literal). `path.join`/
 * `path.resolve` do NOT do this expansion, so anything sourced from YAML
 * that may carry a leading `~` (e.g. access.user_data_root) must pass
 * through here before it is treated as absolute.
 */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return `${homedir()}/${p.slice(2)}`;
  return p;
}

/**
 * Root of the user-owned MUTABLE state tree (`~/.sentient`). Everything the
 * gateway writes at runtime — logs, certs, secrets, per-user data — lives under
 * here; code lives elsewhere and is root-owned and immutable.
 *
 * Every default derived from this MUST be absolute, and neither of the two
 * obvious ways of spelling "next to the code" survives the shipped shape:
 *   - a RELATIVE default ("logs") resolves against the process cwd, and launchd
 *     sets no WorkingDirectory — so it became "/logs" and the gateway
 *     crash-looped on EROFS before it could log why.
 *   - `join(import.meta.dir, "..", "..")` is no better: a compiled binary's
 *     import.meta.dir is the virtual bunfs root, so it resolves to "/" as well.
 * `os.homedir()` is the one anchor that is correct in a repo checkout AND in a
 * compiled binary under launchd. Mirrors phase-state.ts, which resolves the
 * same root for the rest of bootstrap.
 */
export function resolveSentientHome(): string {
  return process.env.SENTIENT_HOME ?? join(homedir(), ".sentient");
}

/** Absolute default for a writable gateway state dir, e.g. "logs" →
 *  `~/.sentient/gateway/logs`. Kept beside `resolveSentientHome` so no caller
 *  has to re-spell the anchor — every writable default the gateway ships MUST
 *  come from here, in this module or any other. `api/handlers/diagnostics.ts`
 *  is the cautionary tale: it defaulted the client-log dir to the container
 *  path "/app/clientLogs", which on the native stack is unwritable, so every
 *  mobile vitals upload 500'd on `EROFS: mkdir '/app'`. */
export function gatewayStateDir(...segments: string[]): string {
  return join(resolveSentientHome(), "gateway", ...segments);
}

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

  /** inbound-proxy — the public host/LAN entrance (design 2026-08-04 §2).
   *  `cert_dir` null means "use the gateway's own self-signed material";
   *  phase-orchestrator.ts resolves the actual fallback against `tls.certsDir`
   *  above at boot. */
  inboundProxy: InboundProxyYaml;

  session: SessionYaml;

  /** Access — capability minting + per-user physical isolation (spec §2.1,
   *  §2.5). `userDataRoot` is resolved to an absolute path here (a leading
   *  `~` in config.yaml is expanded via expandHome; path.* would not). */
  access: AccessYaml;

  /** Store — durable per-user session history (spec §3). Always defined;
   *  db_filename defaults to "sessions.db" when omitted from config.yaml. */
  store: StoreYaml;

  /** Orchestrator — the native LLM agent loop (spec §4/§5). `undefined` when
   *  no orchestrator block — mirrors `hermes` below. Not yet wired to a
   *  runtime consumer (Plan 2). The composition root that constructs the
   *  orchestrator runtime MUST fail loudly if this is absent when the
   *  orchestrator is enabled — do not add that check here. */
  orchestrator: OrchestratorYaml | undefined;

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

  webui: WebuiYaml;
  hermes: HermesYaml | undefined;
  auth: AuthYaml;
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
  /** Policy for the system orchestrator itself — health-watchdog cadence and
   *  back-off. Always defined (schema `.default({})`), unlike the map above. */
  systemOrchestrator: SystemOrchestratorYaml;
  /** Public /download page + mobile OTA artifact serving. Always present;
   *  defaults to the standard docker-compose layout when not overridden. */
  downloads: DownloadsYaml;

  /** Inbound prompt-injection scanning boundary (security/inbound-gate.ts).
   *  Always present (schema `.default({})`, every field secure-by-default true).
   *  Threaded so an operator's `security.inbound_scan` block in config.yaml —
   *  e.g. `channels.tool_result: false` — actually reaches the per-session gate
   *  and the `inbound-gate.composed` boot log, rather than being silently
   *  overridden by a code-side `parse({})`. */
  inboundScan: InboundScanYaml;
}

export function loadLoggingConfig(): LoggingConfig {
  const gatewayRoot = join(import.meta.dir, "..", "..");
  const configPath = process.env.GATEWAY_CONFIG_PATH ?? join(gatewayRoot, "config.yaml");
  migrateOperatorConfigYamlSync(configPath);
  const cfg = loadGatewayConfig(configPath);
  return {
    logLevel: cfg.logging.level,
    logDir: process.env.LOG_DIR ?? gatewayStateDir("logs"),
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
  // THE MIGRATION ALREADY RAN, back in `loadLoggingConfig` — which main.ts
  // calls BEFORE `createGatewayLogger`, so every line it logged reached nothing
  // at all. The call above is a no-op (the version is bumped), so this is the
  // only place those lines can still be emitted. Anything deploy/README.md
  // tells an operator to grep for depends on it.
  flushMigrationLog();
  log.info("config-loaded", { path: configPath });

  return {
    logging: {
      logLevel: cfg.logging.level,
      logDir: process.env.LOG_DIR ?? gatewayStateDir("logs"),
      retentionDays: cfg.logging.retention_days,
      levelOverrides: cfg.logging.level_overrides,
    },

    port: cfg.port,
    host: cfg.host,
    maxSessions: cfg.max_sessions,
    authTimeoutMs: cfg.auth_timeout_ms,

    // Derived from the asset root so an installed release and a repo checkout
    // both work with no env var. WEB_DIST_DIR remains an override, handled
    // inside resolveWebDistDir — it was previously the ONLY source, and being
    // set nowhere in the repo is why prod served no UI at all.
    webDistDir: resolveWebDistDir(),

    tls: { ...cfg.tls, certsDir: process.env.GATEWAY_CERTS_DIR ?? gatewayStateDir("certs") },

    // `cert_dir` is YAML-sourced and may carry a leading `~` (the operator
    // comment in config.yaml uses exactly that shape) — expand it here, same
    // as access.user_data_root above, or a literal `~` reaches existsSync()
    // in phase-orchestrator.ts, always resolves false, and the real acme.sh
    // cert silently never gets served.
    inboundProxy: {
      ...cfg.inbound_proxy,
      cert_dir: cfg.inbound_proxy.cert_dir === null ? null : expandHome(cfg.inbound_proxy.cert_dir),
    },

    session: cfg.session,

    // Both roots are YAML-sourced and may carry a leading `~` (the operator
    // comment in config.yaml uses exactly that shape). Expand each here — a raw
    // `~` reaching the AccessManager lands data under `<cwd>/~/`, since `path.*`
    // never expands it. `shared_data_root` is optional (household scope, spec
    // §2): expand it only when the operator set it, or the derived sibling
    // default in the AccessManager applies. Conditional spread, not an explicit
    // `undefined`, under `exactOptionalPropertyTypes`.
    access: {
      ...cfg.access,
      user_data_root: expandHome(cfg.access.user_data_root),
      ...(cfg.access.shared_data_root !== undefined
        ? { shared_data_root: expandHome(cfg.access.shared_data_root) }
        : {}),
    },
    store: cfg.store,
    orchestrator: cfg.orchestrator,

    language: cfg.stt.language,

    stt: cfg.stt,

    // TTS is always wired to the local-tts (LocalTTSService) provider —
    // no API key required, so nothing here gates on secret presence. A
    // down/unreachable service degrades gracefully at synth time, not boot.
    tts: cfg.tts,

    webui: cfg.webui,
    hermes: cfg.hermes,
    auth: cfg.auth,
    providers: cfg.providers,
    companions: cfg.companions,
    mcpCatalog: cfg.mcp_catalog,
    hermesBuiltinTools: cfg.hermes_builtin_tools,
    managedServices: cfg.managed_services,
    systemOrchestrator: cfg.system_orchestrator,
    downloads: cfg.downloads,
    inboundScan: cfg.security.inbound_scan,
  };
}
