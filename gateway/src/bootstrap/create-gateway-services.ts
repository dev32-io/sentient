import { join } from "node:path";
import type {
  AuthConfig,
  HermesBuiltinTools,
  HermesConfig,
  McpCatalog,
  ProvidersConfig,
  SessionConfig,
  TTSConfig,
  WebuiConfig,
} from "@sentient/config";
import type { AccessManager } from "../access/access-manager.js";
import type { InstallState } from "../admin/install-state.js";
import type { SecretsStore } from "../admin/secrets-store.js";
import type { LlmProvider } from "../admin/secrets-store.js";
import type { UnlockCode } from "../admin/unlock-code.js";
import type { UserLifecycle } from "../admin/user-lifecycle.js";
import type { UserProvisioner } from "../admin/user-provisioner.js";
import type { TestProviderResult } from "../api/wizard/index.ts";
import type { ApplyDeps } from "../apply/orchestrator.js";
import type { SessionManager } from "../auth/session-manager.ts";
import type { StartupConfig } from "../config/startup-config.ts";
import type { ExternalToolSlot } from "../external-tools/external-tool-slot.js";
import { getLog } from "../logging/logger.ts";
import type { PersonalityStore } from "../profile-store/personality-store.js";
import type { ProfileStore } from "../profile-store/profile-store.ts";
import type { TemplateLoader } from "../profile-store/template-loader.ts";
import type { CreateSessionRuntime } from "../runtime/session-handles.js";
import { type ReplayRegistry, createReplayRegistry } from "../session-handlers/replay-registry.js";
import type { SessionControlsRegistry } from "../session-handlers/session-controls-registry.js";
import { type SessionRegistry, createSessionRegistry } from "../session-handlers/session-registry.js";
import type { GatewayTlsMaterial } from "../session-handlers/ws-handlers.ts";
import type { SystemOrchestratorService } from "../system-orchestrator/index.js";
import type { OrchestratorStatus } from "../system-orchestrator/types.js";
import type { McpClient } from "../tools/mcp-client.js";
import type { TextStreamSynthesizer } from "../tts/text-stream-synthesizer.ts";
import { type AuthService, createAuthService } from "../user-auth/auth-service.ts";
import { getHermesProfileDir } from "../user-auth/paths.js";
import { runPhaseOrchestrator } from "./phase-orchestrator.ts";
import { runPhaseRoutes } from "./phase-routes.ts";
import { runPhaseServices } from "./phase-services.ts";
import { runPhaseState } from "./phase-state.ts";
import type { SttService } from "./stt-factory.ts";
import type { TtsService } from "./tts-factory.ts";
import type { UserModelProvider } from "./user-model-provider.ts";

const log = getLog(["sentient", "bootstrap"]);
const TEST_PROVIDER_TIMEOUT_MS = 5000;

export async function testProviderImpl(
  provider: LlmProvider,
  apiKey: string | null,
  baseUrl: string | null,
): Promise<TestProviderResult> {
  const url = baseUrl ?? (provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://ollama.com/v1");
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TEST_PROVIDER_TIMEOUT_MS);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${url}/models`, { headers, signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    const models = body.data ?? [];
    return { ok: true, modelCount: models.length, sampleModels: models.slice(0, 3).map((m) => m.id) };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface GatewayServices {
  readonly installState: InstallState;
  readonly hermesVersionPath: string;
  readonly sttHealthUrl: string;
  readonly ttsHealthUrl: string;
  readonly unlockCode: UnlockCode;
  readonly unlockCodePath: string;
  readonly gatewayVersion: string;
  readonly sessionManager: SessionManager;
  readonly sessionControls: SessionControlsRegistry;
  readonly stt: SttService | null;
  readonly tts: TtsService | null;
  readonly createSynthesizerFor: (getVoiceId: () => string | null) => TextStreamSynthesizer | null;
  /** Raw `tts:` config block — needed by the voices handler (Fix C) for its
   *  own short-lived voice-mgmt WS ops, which bypass the TtsService/provider
   *  abstraction entirely. */
  readonly ttsConfig: TTSConfig;
  readonly language: "en" | "zh";
  readonly tls: GatewayTlsMaterial | undefined;
  readonly webDistDir: string | undefined;
  readonly downloads: { artifactsDir: string; publicBaseUrl: string };
  readonly hermes: HermesConfig | null;
  readonly session: SessionConfig;
  /** Per-surface outbound frame journals, keyed `${userId}::${surfaceId}`
   *  (Plan 3 Task 10, spec §11 slice 6). Deliberately NOT per-connection:
   *  the journal must survive the socket that filled it so a reconnecting
   *  client can replay the frames it missed. Built here rather than in a
   *  phase because it depends on nothing but `cfg.session`. */
  readonly replayRegistry: ReplayRegistry;
  /** The resident sessions: exactly one `SessionRuntime` per durable session,
   *  with the set of connections attached to it. Sits beside `replayRegistry`
   *  because it answers the same overlapping-connection question for the
   *  other shared resource — the store partition — though with the opposite
   *  remedy: connections JOIN a session rather than take it over. Depends on
   *  no config at all. */
  readonly sessionRegistry: SessionRegistry;
  readonly webui: WebuiConfig;
  readonly auth: AuthService;
  readonly authConfig: AuthConfig;
  readonly profileStore: ProfileStore;
  readonly templateLoader: TemplateLoader;
  readonly applyDeps: ApplyDeps;
  readonly providersConfig: ProvidersConfig;
  /** Fish Audio API key for the voice-browse proxy. Plain env var (not
   *  secretsStore) — never hardcode; resolves to null when unset, which the
   *  Fish fetcher treats as "send no Authorization header" (public browsing). */
  readonly fishApiKey: string | null;
  readonly mcpCatalog: McpCatalog;
  readonly hermesBuiltinTools: HermesBuiltinTools;
  readonly secretsStore: SecretsStore | null;
  readonly userProvisioner: UserProvisioner | null;
  readonly userLifecycle: UserLifecycle;
  readonly buildPersonalityStore: (userId: string) => PersonalityStore;
  readonly systemOrchestrator: SystemOrchestratorService | null;
  /** Apply-complete signal for the boot reconcile — see phase-orchestrator.ts.
   *  `null` when no reconcile ran. Startup steps that write configuration
   *  pointing at an addon MUST wait on this or skip. */
  readonly bootReconcile: Promise<OrchestratorStatus> | null;
  /** Returns the shared Hermes bearer token used for per-user ACP / plugin auth. */
  readonly hermesApiKey: () => string;
  resolveProfileDir(userId: string): string;

  // --- Native orchestrator composition root (spec §2.6, Plan 2 Task 9) ------
  /** L1 capability minter (spec §2.1) — always present. */
  readonly accessManager: AccessManager;
  /** Shared MCP client dialing `mcp_catalog` — always present (a no-op with
   *  an empty catalog). */
  readonly mcpClient: McpClient;
  /** Mints the orchestrator's OpenAI-compatible client for one user, resolving
   *  that user's own selected model (`profile.json#model`) against the
   *  operator's ACTIVE secrets-store connection (never an env var). A factory
   *  rather than one client because the KEY is household-wide and the MODEL is
   *  not — see bootstrap/user-model-provider.ts. `null` when `orchestrator:` is
   *  absent from config, or present with no active key configured yet — either
   *  way the gateway still boots. */
  readonly provider: UserModelProvider | null;
  /** Per-session runtime factory. Takes a `SessionRuntimeRequest`, whose two
   *  ids are named apart on purpose — `conversationId` is the durable store
   *  partition, `connectionId` is this socket and only ever reaches logs.
   *  Returns the connection-scoped `SessionHandles` pair (runtime + its
   *  permission broker, Plan 3 Task 6), both torn down together in
   *  `cleanupSession`. `null` only when `orchestrator:` is absent from
   *  config.yaml. When present but `provider` is null, calling it throws a
   *  clear error rather than the gateway failing to boot. */
  readonly createSessionRuntime: CreateSessionRuntime | null;
  /** Late-bound holder for the delegated worker's own configuration
   *  (`external-tools/external-tool-slot.ts`). Settled in `main.ts` right after
   *  the MCP host exists — the host is what knows the delegated tool surface —
   *  and BEFORE the server accepts a connection. Resolved per dispatch by
   *  `delegateTask`'s setup phase. */
  readonly delegatedExternalTool: ExternalToolSlot;
}

export async function createGatewayServices(cfg: StartupConfig): Promise<GatewayServices> {
  const [auth, state] = await Promise.all([createAuthService(cfg.auth), runPhaseState(cfg)]);

  const {
    installState,
    unlockCode,
    unlockCodePath,
    gatewayVersion,
    hermesVersionPath,
    secretsStore,
    internalSecretsStore,
  } = state;

  const services = await runPhaseServices({ cfg, auth, secretsStore });

  const { systemOrchestrator, bootReconcile } = await runPhaseOrchestrator({
    cfg,
    installState,
    secretsStore,
    internalSecretsStore,
    gatewayRuntimeDir: state.gatewayRuntimeDir,
    sentientHome: state.sentientHome,
    // Where default service configs are seeded before the orchestrator first
    // recreates a container whose template references ${HOST_CONFIG_DIR}/*
    // bind mounts. Reuses the state root phase-state already resolved, rather
    // than re-reading SENTIENT_HOME with a DIFFERENT fallback: the old default
    // here was a literal "/sentient", a path that only ever existed inside the
    // retired gateway container and is unwritable on a native host.
    hostConfigDirContainerPath: join(state.sentientHome, "gateway", "config"),
  });

  const routes = runPhaseRoutes({ cfg });

  log.info("services-composed", {
    stt: services.stt !== null,
    tts: services.tts !== null,
    tls: services.tls !== undefined,
    language: cfg.language,
    systemOrchestrator: systemOrchestrator !== null,
    orchestrator: cfg.orchestrator !== undefined,
    orchestratorProvider: services.provider !== null,
  });

  return {
    installState,
    hermesVersionPath,
    sttHealthUrl: cfg.companions.stt_health_url,
    ttsHealthUrl: cfg.companions.tts_health_url,
    unlockCode,
    unlockCodePath,
    gatewayVersion,
    sessionManager: routes.sessionManager,
    sessionControls: routes.sessionControls,
    stt: services.stt,
    tts: services.tts,
    createSynthesizerFor: services.createSynthesizerFor,
    ttsConfig: cfg.tts,
    // "auto" is a decode-only sentinel; UX/prompt language needs a concrete
    // value, so fall back to "en" when the operator chose autodetect.
    language: cfg.language === "auto" ? "en" : cfg.language,
    tls: services.tls,
    webDistDir: cfg.webDistDir,
    downloads: { artifactsDir: cfg.downloads.artifacts_dir, publicBaseUrl: cfg.downloads.public_base_url },
    hermes: cfg.hermes ?? null,
    session: cfg.session,
    replayRegistry: createReplayRegistry({
      maxBytesPerSurface: cfg.session.replay_journal_max_bytes,
      retentionMs: cfg.session.replay_journal_retention_ms,
    }),
    sessionRegistry: createSessionRegistry(),
    webui: cfg.webui,
    auth,
    authConfig: cfg.auth,
    profileStore: services.profileStore,
    templateLoader: services.templateLoader,
    applyDeps: services.applyDeps,
    providersConfig: cfg.providers,
    fishApiKey: process.env.FISH_AUDIO_API_KEY ?? null,
    mcpCatalog: cfg.mcpCatalog,
    hermesBuiltinTools: cfg.hermesBuiltinTools,
    secretsStore,
    userProvisioner: services.userProvisioner,
    userLifecycle: services.userLifecycle,
    buildPersonalityStore: services.buildPersonalityStore,
    systemOrchestrator,
    bootReconcile,
    hermesApiKey: () => internalSecretsStore.getHermesAuthTokenSync(),
    resolveProfileDir: getHermesProfileDir,
    accessManager: services.accessManager,
    mcpClient: services.mcpClient,
    provider: services.provider,
    createSessionRuntime: services.createSessionRuntime,
    delegatedExternalTool: services.delegatedExternalTool,
  };
}
