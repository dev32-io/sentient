import type {
  ApplyConfig,
  AuthConfig,
  CerebrumConfig,
  HermesBuiltinTools,
  HermesConfig,
  McpCatalog,
  ProvidersConfig,
  SessionConfig,
  SessionsConfig,
  TTSConfig,
  WebuiConfig,
} from "@sentient/config";
import type { InstallState } from "../admin/install-state.js";
import type { KeyRotationOrchestrator } from "../admin/key-rotation.js";
import type { ProfileRestartOrchestrator } from "../admin/profile-restart-orchestrator.js";
import type { SecretsStore } from "../admin/secrets-store.js";
import type { LlmProvider } from "../admin/secrets-store.js";
import type { UnlockCode } from "../admin/unlock-code.js";
import type { UserLifecycle } from "../admin/user-lifecycle.js";
import type { UserPortStore } from "../admin/user-port-store.js";
import type { UserProvisioner } from "../admin/user-provisioner.js";
import type { DevicesHandlerDeps } from "../api/handlers/devices.js";
import type { TestProviderResult } from "../api/wizard/index.ts";
import type { ApplyDeps } from "../apply/orchestrator.js";
import type { SessionManager } from "../auth/session-manager.ts";
import type { SalienceMap } from "../cerebrum/short-term-context-types.ts";
import type { StartupConfig } from "../config/startup-config.ts";
import type { HealthPoller } from "../infrastructure/health-poller.js";
import { getLog } from "../logging/logger.ts";
import type { PersonSessionRegistry } from "../person-session/person-session-registry.js";
import type { PersonalityStore } from "../profile-store/personality-store.js";
import type { ProfileStore } from "../profile-store/profile-store.ts";
import type { TemplateLoader } from "../profile-store/template-loader.ts";
import type { SessionControlsRegistry } from "../session-handlers/session-controls-registry.js";
import type { GatewayTlsMaterial } from "../session-handlers/ws-handlers.ts";
import type { SessionRouter } from "../session-router.js";
import type { SystemOrchestratorService } from "../system-orchestrator/index.js";
import type { TextStreamSynthesizer } from "../tts/text-stream-synthesizer.ts";
import { type AuthService, createAuthService } from "../user-auth/auth-service.ts";
import { getHermesProfileDir } from "../user-auth/paths.js";
import { runPhaseOrchestrator } from "./phase-orchestrator.ts";
import { runPhaseRoutes } from "./phase-routes.ts";
import { runPhaseServices } from "./phase-services.ts";
import { runPhaseState } from "./phase-state.ts";
import type { SttService } from "./stt-factory.ts";
import type { TtsService } from "./tts-factory.ts";

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
  readonly sessionRouter: SessionRouter;
  readonly personSessions: PersonSessionRegistry;
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
  readonly cerebrum: CerebrumConfig;
  readonly hermes: HermesConfig | null;
  readonly session: SessionConfig;
  readonly sessions: SessionsConfig;
  readonly salienceMap: SalienceMap;
  readonly persona: string;
  readonly systemPrompt: string;
  readonly webui: WebuiConfig;
  readonly auth: AuthService;
  readonly authConfig: AuthConfig;
  readonly profileStore: ProfileStore;
  readonly templateLoader: TemplateLoader;
  readonly healthPoller: HealthPoller;
  readonly applyConfig: ApplyConfig;
  readonly applyDeps: ApplyDeps;
  readonly providersConfig: ProvidersConfig;
  /** Fish Audio API key for the voice-browse proxy. Plain env var (not
   *  secretsStore) — never hardcode; resolves to null when unset, which the
   *  Fish fetcher treats as "send no Authorization header" (public browsing). */
  readonly fishApiKey: string | null;
  readonly mcpCatalog: McpCatalog;
  readonly hermesBuiltinTools: HermesBuiltinTools;
  readonly userPortStore: UserPortStore | null;
  readonly secretsStore: SecretsStore | null;
  readonly userProvisioner: UserProvisioner | null;
  readonly keyRotation: KeyRotationOrchestrator | null;
  readonly userLifecycle: UserLifecycle;
  readonly profileRestartOrchestrator: ProfileRestartOrchestrator;
  readonly buildPersonalityStore: (userId: string) => PersonalityStore;
  readonly systemOrchestrator: SystemOrchestratorService | null;
  /** Deps bag for the `/api/v1/devices*` handler. Null in headless / CI builds
   *  where hermes + supervisordControl are not configured. */
  readonly devicesHandlerDeps: DevicesHandlerDeps | null;
  /** Returns the shared Hermes bearer token used for per-user ACP / plugin auth. */
  readonly hermesApiKey: () => string;
  resolveProfileDir(userId: string): string;
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
    userPortStore,
    supervisordControl,
  } = state;

  const services = await runPhaseServices({
    cfg,
    auth,
    secretsStore,
    internalSecretsStore,
    userPortStore,
    supervisordControl,
  });

  const { systemOrchestrator } = await runPhaseOrchestrator({
    cfg,
    installState,
    secretsStore,
    internalSecretsStore,
    gatewayRuntimeDir: state.gatewayRuntimeDir,
    // Container-side path for seeding default service configs into the
    // host config dir BEFORE the orchestrator first recreates a container
    // whose template references ${HOST_CONFIG_DIR}/* bind mounts.
    // SENTIENT_HOME mirrors HOST_HOME/.sentient inside the container.
    hostConfigDirContainerPath: `${process.env.SENTIENT_HOME ?? "/sentient"}/gateway/config`,
  });

  const routes = runPhaseRoutes({
    cfg,
    personSessions: services.personSessions,
  });

  log.info("services-composed", {
    stt: services.stt !== null,
    tts: services.tts !== null,
    tls: services.tls !== undefined,
    language: cfg.language,
    systemOrchestrator: systemOrchestrator !== null,
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
    sessionRouter: services.sessionRouter,
    personSessions: routes.personSessions,
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
    cerebrum: services.cerebrumServices.cerebrumConfig,
    hermes: cfg.hermes ?? null,
    session: cfg.session,
    sessions: cfg.sessions,
    salienceMap: services.cerebrumServices.salienceMap,
    persona: services.cerebrumServices.persona,
    systemPrompt: services.cerebrumServices.systemPrompt,
    webui: cfg.webui,
    auth,
    authConfig: cfg.auth,
    profileStore: services.profileStore,
    templateLoader: services.templateLoader,
    healthPoller: services.healthPoller,
    applyDeps: services.applyDeps,
    applyConfig: cfg.apply,
    providersConfig: cfg.providers,
    fishApiKey: process.env.FISH_AUDIO_API_KEY ?? null,
    mcpCatalog: cfg.mcpCatalog,
    hermesBuiltinTools: cfg.hermesBuiltinTools,
    userPortStore,
    secretsStore,
    userProvisioner: services.userProvisioner,
    keyRotation: services.keyRotation,
    userLifecycle: services.userLifecycle,
    profileRestartOrchestrator: services.profileRestartOrchestrator,
    buildPersonalityStore: services.buildPersonalityStore,
    systemOrchestrator,
    devicesHandlerDeps: services.devicesHandlerDeps,
    hermesApiKey: () => internalSecretsStore.getHermesAuthTokenSync(),
    resolveProfileDir: getHermesProfileDir,
  };
}
