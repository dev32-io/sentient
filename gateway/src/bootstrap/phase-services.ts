import { join } from "node:path";
import { riskConfigSchema } from "@sentient/config";
import type { OrchestratorConfig } from "@sentient/config";
import { ensureTlsMaterial } from "@sentient/tls";
import { type AccessManager, createAccessManager } from "../access/access-manager.js";
import { archiveUserDir } from "../admin/archive-user-dir.js";
import {
  migrateUnboundUsers,
  renderConfigsForExistingUsers,
  renderProgramsForExistingUsers,
} from "../admin/boot-migration.js";
import { chownUserDirToHermes } from "../admin/chown-hermes.js";
import type { InternalSecretsStore } from "../admin/internal-secrets-store.js";
import { type KeyRotationOrchestrator, createKeyRotation } from "../admin/key-rotation.js";
import {
  type ProfileRestartOrchestrator,
  createProfileRestartOrchestrator,
} from "../admin/profile-restart-orchestrator.js";
import type { SecretsStore } from "../admin/secrets-store.js";
import type { SupervisordControl } from "../admin/supervisord-control.js";
import { createUserLifecycle } from "../admin/user-lifecycle.js";
import type { UserLifecycle } from "../admin/user-lifecycle.js";
import type { UserPortStore } from "../admin/user-port-store.js";
import {
  type UserProvisioner,
  createUserProvisioner,
  makeUserId,
  randomAvatarTint,
} from "../admin/user-provisioner.js";
import { migrateWebToolsEnabled } from "../admin/web-tools-migrator.js";
import type { DevicesHandlerDeps } from "../api/handlers/devices.js";
import { createApplyDeps } from "../apply/apply-deps.js";
import type { ApplyDeps } from "../apply/orchestrator.js";
import { renderAndWrite } from "../apply/orchestrator.js";
import type { StartupConfig } from "../config/startup-config.ts";
import { SignalProvisioner } from "../devices/signal/signal-provisioner.js";
import type { UserPrincipal } from "../identity/user-principal.js";
import { type HealthPoller, createHealthPoller } from "../infrastructure/health-poller.js";
import { type Log, getLog } from "../logging/logger.ts";
import { createPersonalityStore } from "../profile-store/personality-store.js";
import type { PersonalityStore } from "../profile-store/personality-store.js";
import { type ProfileStore, createProfileStore } from "../profile-store/profile-store.ts";
import { type TemplateLoader, createTemplateLoader } from "../profile-store/template-loader.ts";
import { createOpenAIProvider } from "../provider/openai-provider.js";
import type { ProviderClient } from "../provider/provider-client.js";
import type { TTSProviderFactory } from "../providers/tts/tts-types.ts";
import { createSessionRuntime as buildSessionRuntime } from "../runtime/session-runtime.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import type { TurnEmitter } from "../runtime/turn-emitter.js";
import { createPolicyEngine } from "../security/policy-engine.js";
import type { PolicyEngine } from "../security/policy-engine.js";
import { loadMcpPolicy } from "../security/policy-loader.js";
import type { GatewayTlsMaterial } from "../session-handlers/ws-handlers.ts";
import { createSessionRouter } from "../session-router.js";
import type { SessionRouter } from "../session-router.js";
import type { SessionStore } from "../store/session-store.js";
import { createDelegateTaskRunner, delegateTaskDefinition } from "../tools/delegate-task.js";
import { createDelegationGuard, loadDelegationFrontmatterDir } from "../tools/delegation-guard.js";
import type { DelegationGuard } from "../tools/delegation-guard.js";
import { createHermesRunner } from "../tools/hermes-runner.js";
import type { HermesRunner } from "../tools/hermes-runner.js";
import { createMcpClient } from "../tools/mcp-client.js";
import type { McpClient } from "../tools/mcp-client.js";
import { createPromptClassifier } from "../tools/prompt-classifier.js";
import { createToolBroker } from "../tools/tool-broker.js";
import type { BackgroundToolRunner } from "../tools/tool-broker.js";
import type { TextStreamSynthesizer } from "../tts/text-stream-synthesizer.ts";
import type { AuthService } from "../user-auth/auth-service.js";
import { getHermesProfileDir } from "../user-auth/paths.js";
import { hashPin } from "../user-auth/pin-service.js";
import { createTextStreamSynthesizer } from "./content-tts-factory.ts";
import { resolveProviderConnection } from "./resolve-provider-connection.ts";
import type { SttService } from "./stt-factory.ts";
import { createSttService } from "./stt-factory.ts";
import type { TtsService } from "./tts-factory.ts";
import { asStrictFactory, createTtsService } from "./tts-factory.ts";

const log = getLog(["sentient", "bootstrap", "phase-services"]);

// Fallback provider used in supervisord program env when a user's profile is
// unreadable (corruption case).
const FALLBACK_LLM_PROVIDER = "openrouter" as const;

// Gateway project root (gateway/) — mirrors startup-config.ts's own
// computation. `orchestrator.delegation.frontmatter_dir` ships as a relative
// path (e.g. "./config/delegation") and needs resolving against this, not
// against `process.cwd()`, which varies by launcher.
const GATEWAY_ROOT = join(import.meta.dir, "..", "..");

// Plan 2 walking-skeleton system prompt — deliberately minimal (a real
// prompt-assembly layer, persona/profile-aware, is Plan 3's job; see
// clean-code.md's rule on loading large prompt content from .md files,
// which does not yet apply to this one-liner placeholder).
const DEFAULT_SYSTEM_PROMPT = "You are Sentient, a helpful family assistant.";

export interface PhaseServicesInput {
  readonly cfg: StartupConfig;
  readonly auth: AuthService;
  readonly secretsStore: SecretsStore | null;
  readonly internalSecretsStore: InternalSecretsStore;
  readonly userPortStore: UserPortStore | null;
  readonly supervisordControl: SupervisordControl | null;
}

export interface PhaseServicesOutput {
  readonly stt: SttService | null;
  readonly tts: TtsService | null;
  readonly tls: GatewayTlsMaterial | undefined;
  readonly createSynthesizerFor: (getVoiceId: () => string | null) => TextStreamSynthesizer | null;
  readonly applyDeps: ApplyDeps;
  readonly profileStore: ProfileStore;
  readonly templateLoader: TemplateLoader;
  readonly healthPoller: HealthPoller;
  readonly sessionRouter: SessionRouter;
  readonly userProvisioner: UserProvisioner | null;
  readonly keyRotation: KeyRotationOrchestrator | null;
  readonly userLifecycle: UserLifecycle;
  readonly profileRestartOrchestrator: ProfileRestartOrchestrator;
  readonly buildPersonalityStore: (userId: string) => PersonalityStore;
  /** Deps bag for `/api/v1/devices*` handlers. Null when hermes + supervisord
   *  are not configured (e.g. headless / CI builds). */
  readonly devicesHandlerDeps: DevicesHandlerDeps | null;

  // --- Native orchestrator composition root (spec §2.6, Plan 2 Task 9) ------
  // App-lifetime singletons + a per-session factory. See the header comment
  // above `buildOrchestratorServices` below for the full wiring rationale.

  /** L1 capability minter (spec §2.1) — always constructed, independent of
   *  whether the orchestrator itself is enabled. */
  readonly accessManager: AccessManager;
  /** Shared MCP client (spec §5.3) — dials every `mcp_catalog` entry lazily
   *  per-server; always constructed (harmless/no-op with an empty catalog). */
  readonly mcpClient: McpClient;
  /** The native orchestrator's OpenAI-compatible provider, built from the
   *  operator's ACTIVE secrets-store LLM (never an env var — see
   *  resolve-provider-connection.ts). `null` when `orchestrator:` is absent
   *  from config, OR it's present but no active LLM key is configured yet —
   *  either way the gateway still boots; only a session that actually needs
   *  the orchestrator fails, at construction, with a clear error. */
  readonly provider: ProviderClient | null;
  /** Per-session runtime factory. `null` when `orchestrator:` is absent from
   *  config (the whole native-orchestrator feature is off). Present-but-
   *  no-provider is a DIFFERENT state (see `provider` above) — the factory
   *  itself still exists in that case, and throws when actually invoked. */
  readonly createSessionRuntime:
    | ((principal: UserPrincipal, sessionId: string, emitter: TurnEmitter) => SessionRuntime)
    | null;
}

export async function runPhaseServices(input: PhaseServicesInput): Promise<PhaseServicesOutput> {
  const { cfg, auth, secretsStore, internalSecretsStore, userPortStore, supervisordControl } = input;

  const stt = cfg.stt ? createSttService(cfg) : null;
  const tts = createTtsService({ cfg });
  const tls = cfg.tls.enabled
    ? ensureTlsMaterial({ hostnames: cfg.tls.hostnames, certsDir: cfg.tls.certsDir, logTag: "gateway" })
    : undefined;

  const createSynthesizerFor = (getVoiceId: () => string | null): TextStreamSynthesizer | null => {
    const sessionFactory: TTSProviderFactory = asStrictFactory(tts, getVoiceId);
    return createTextStreamSynthesizer(cfg, sessionFactory);
  };

  const { accessManager, mcpClient, provider, createSessionRuntime } = await buildOrchestratorServices(
    cfg,
    secretsStore,
  );

  const profileStore = createProfileStore();
  const templateLoader = createTemplateLoader();
  const healthPoller = createHealthPoller();
  const sessionRouter = buildSessionRouter(cfg, internalSecretsStore, userPortStore);
  const supervisordForApply: Pick<SupervisordControl, "restartProfile" | "upsertProgram"> = supervisordControl ?? {
    restartProfile: async (_userId, _timeoutMs, _signalPaired) => ({
      ok: false,
      error: { kind: "shell-failed", reason: "no hermes config" },
    }),
    upsertProgram: async (_input) => ({
      ok: false,
      error: { kind: "shell-failed", reason: "no hermes config" },
    }),
  };
  const tzForPrograms = (): string => process.env.TZ ?? "UTC";
  const hostDataDir = process.env.SENTIENT_HOST_GATEWAY_DATA_DIR ?? "/data/profiles";
  const resolveHermesHomeFor = (userId: string): string => `${hostDataDir.replace(/\/+$/, "")}/${userId}`;

  const applyDeps: ApplyDeps = createApplyDeps({
    profileStore,
    sessionRouter,
    healthPoller,
    templateLoader,
    applyConfig: cfg.apply,
    hermes: cfg.hermes ?? null,
    userPortStore,
    internalSecretsStore,
    supervisordControl: supervisordForApply,
    resolveTimezone: tzForPrograms,
    resolveHermesHome: resolveHermesHomeFor,
    mcpCatalog: cfg.mcpCatalog,
    secretsStore: secretsStore ?? null,
  });

  // Two flavors:
  //   - …Config   → config.yaml only; safe for apply + boot-migration.
  //   - …Initial  → config.yaml + SOUL.md; used once at user creation.
  const renderInnerProfileFor = buildRenderInnerProfile(applyDeps, { writeSoul: false });
  const renderInitialInnerProfileFor = buildRenderInnerProfile(applyDeps, { writeSoul: true });
  const bootstrapWorkerFor = buildBootstrapWorker(cfg, userPortStore, applyDeps, healthPoller, log);
  const userLifecycle = createUserLifecycle();

  let userProvisioner: UserProvisioner | null = null;
  if (cfg.hermes && userPortStore && secretsStore && supervisordControl) {
    userProvisioner = createUserProvisioner({
      userStore: auth.users,
      profileStore,
      userPortStore,
      argon2Params: {
        memoryKb: cfg.auth.argon2_memory_kb,
        iterations: cfg.auth.argon2_iterations,
        parallelism: cfg.auth.argon2_parallelism,
      },
      hashPin,
      makeUserId,
      randomAvatarTint,
      now: () => new Date(),
      supervisordControl,
      internalSecrets: internalSecretsStore,
      resolveTimezone: tzForPrograms,
      resolveHermesHome: resolveHermesHomeFor,
      archiveUserDir,
      renderInnerProfile: renderInitialInnerProfileFor,
      chownUserDirToHermes,
      bootstrapWorker: bootstrapWorkerFor,
      userLifecycle,
    });
  }

  let keyRotation: KeyRotationOrchestrator | null = null;
  if (cfg.hermes && userPortStore && supervisordControl) {
    keyRotation = buildKeyRotation(
      cfg,
      userPortStore,
      supervisordControl,
      profileStore,
      internalSecretsStore,
      tzForPrograms,
      resolveHermesHomeFor,
    );
  }

  // Boot migration: bind any existing users that lack a port binding.
  if (cfg.hermes && userPortStore) {
    await migrateUnboundUsers({ userStore: auth.users, userPortStore });
  }

  // Boot migration: rename per-user tools.enabled.duckduckgo →
  // tools.enabled.searxng + tools.enabled.fetch. Idempotent.
  if (cfg.hermes) {
    await migrateWebToolsEnabled({ userStore: auth.users, profileStore });
  }

  // Re-render the inner Hermes profile (config.yaml + SOUL.md) for every
  // existing user. Idempotent — picks up template changes (e.g. model
  // section schema bumps) without an explicit migration. Runs BEFORE
  // renderProgramsForExistingUsers so the program upsert sees the latest
  // provider, mirroring the user-creation order.
  if (cfg.hermes) {
    await renderConfigsForExistingUsers({
      userStore: auth.users,
      renderInnerProfile: renderInnerProfileFor,
    });
  }

  // Render supervisord programs for every existing user. Idempotent.
  if (cfg.hermes && userPortStore && supervisordControl) {
    await renderProgramsForExistingUsers({
      userStore: auth.users,
      userPortStore,
      supervisordControl,
      internalSecrets: internalSecretsStore,
      profileStore,
      resolveTimezone: tzForPrograms,
      resolveHermesHome: resolveHermesHomeFor,
    });
  }

  const profileRestartOrchestrator = createProfileRestartOrchestrator({
    supervisord: supervisordForApply,
    config: {
      restartTimeoutMs: cfg.apply.profile_restart_timeout_ms,
      pollIntervalMs: cfg.apply.profile_restart_poll_interval_ms,
    },
    resolveSignalPaired: async (userId) => {
      const r = await profileStore.get(userId);
      return r.ok ? r.value.devices?.signal?.paired === true : false;
    },
  });

  const buildPersonalityStore = (userId: string): PersonalityStore =>
    createPersonalityStore({ profileDir: getHermesProfileDir(userId) });

  const devicesHandlerDeps = buildDevicesHandlerDeps(
    profileStore,
    userPortStore,
    supervisordControl,
    internalSecretsStore,
    tzForPrograms,
    resolveHermesHomeFor,
  );

  log.info("phase-services-complete", {
    stt: stt !== null,
    tts: tts !== null,
    tls: tls !== undefined,
    language: cfg.language,
    orchestrator: cfg.orchestrator !== undefined,
    provider: provider !== null,
  });

  return {
    stt,
    tts,
    tls,
    createSynthesizerFor,
    applyDeps,
    profileStore,
    templateLoader,
    healthPoller,
    sessionRouter,
    userProvisioner,
    keyRotation,
    userLifecycle,
    profileRestartOrchestrator,
    buildPersonalityStore,
    devicesHandlerDeps,
    accessManager,
    mcpClient,
    provider,
    createSessionRuntime,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSessionRouter(
  cfg: StartupConfig,
  secrets: InternalSecretsStore,
  userPortStore: UserPortStore | null,
): SessionRouter {
  if (!cfg.hermes) throw new Error("hermes config is required for session router");
  if (!userPortStore) throw new Error("user-port-store is required for session router");
  return createSessionRouter({
    hermes: cfg.hermes,
    userPortStore,
    apiKeyResolver: () => secrets.getHermesAuthTokenSync(),
  });
}

// SOUL.md is user-editable via the System Prompt pane (writes the file
// directly). Apply + boot-migration paths must regenerate config.yaml only;
// the provisioner is the lone caller that seeds the initial SOUL.md.
function buildRenderInnerProfile(
  applyDeps: ApplyDeps,
  opts: { writeSoul: boolean },
): (userId: string) => Promise<{ ok: true; value: undefined } | { ok: false; error: "render-error" | "write-error" }> {
  return async (userId: string) => {
    const r = await renderAndWrite(applyDeps, userId, opts);
    if (r.ok) return { ok: true, value: undefined };
    if (r.error.kind === "render-error" || r.error.kind === "user-not-found") {
      return { ok: false, error: "render-error" };
    }
    return { ok: false, error: "write-error" };
  };
}

function buildBootstrapWorker(
  cfg: StartupConfig,
  userPortStore: UserPortStore | null,
  applyDeps: ApplyDeps,
  healthPoller: HealthPoller,
  log: Log,
): (
  userId: string,
  mode?: "strict" | "lazy",
) => Promise<{ ok: true; value: "warm" | "dispatch-failed" | "deferred" } | { ok: false; error: "health-timeout" }> {
  // The legacy custom-WS path used to ping/pong over a pooled connection
  // here to confirm dispatch-readiness before returning. Under the ACP wire
  // there is no long-lived gateway-owned connection — every WS-session
  // dials the per-profile port on demand. We rely on supervisord reporting
  // RUNNING + the per-profile /healthz responding to declare the worker
  // warm; the first user message proves dispatch end-to-end.
  // TODO(acp-rewire): wire an ACP `initialize` round-trip + `session/list`
  // ping here so strict-mode account creation surfaces a `dispatch-failed`
  // outcome on a broken worker. See acp-rewire-todo.md.
  return async (userId, _mode = "lazy") => {
    if (!cfg.hermes || !userPortStore) return { ok: true, value: "deferred" };
    try {
      const url = await applyDeps.resolveHealthUrl(userId);
      const headers = await applyDeps.resolveHealthHeaders(userId);
      const pollResult = await healthPoller.pollUntilHealthy(
        url,
        headers,
        cfg.apply.health_check_timeout_ms,
        cfg.apply.health_poll_interval_ms,
      );
      if (!pollResult.ok) {
        log.warn("createUser.health-timeout", { userId, url, cause: pollResult.error });
        return { ok: false, error: "health-timeout" };
      }
      log.info("createUser.health-ok", { userId, url });
      log.warn("createUser.dispatch-ready-without-acp-probe", {
        userId,
        reason: "ACP wire has no eager ping — see acp-rewire-todo.md",
      });
      return { ok: true, value: "warm" };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn("createUser.bootstrap-error", { userId, reason });
      return { ok: false, error: "health-timeout" };
    }
  };
}

function buildDevicesHandlerDeps(
  profileStore: ProfileStore,
  userPortStore: UserPortStore | null,
  supervisordControl: SupervisordControl | null,
  internalSecretsStore: InternalSecretsStore,
  tzForPrograms: () => string,
  resolveHermesHomeFor: (userId: string) => string,
): DevicesHandlerDeps | null {
  if (!userPortStore || !supervisordControl) return null;

  const provisioner = new SignalProvisioner({
    async getProfile(userId) {
      const r = await profileStore.get(userId);
      if (!r.ok) throw new Error(`profile not found: ${r.error}`);
      return r.value;
    },
    async setProfile(profile) {
      const r = await profileStore.save(profile);
      if (!r.ok) throw new Error(`profile save failed: ${r.error}`);
    },
    getHermesHome: resolveHermesHomeFor,
    async renderAndWrite(userId) {
      const port = await userPortStore.resolvePort(userId);
      if (port === null) throw new Error(`no port binding for user ${userId}`);
      const profileResult = await profileStore.get(userId);
      if (!profileResult.ok) throw new Error(`profile not found: ${profileResult.error}`);
      const profile = profileResult.value;
      const r = await supervisordControl.upsertProgram({
        userId,
        port,
        token: internalSecretsStore.getHermesAuthTokenSync(),
        timezone: tzForPrograms(),
        provider: profile.model.provider,
        hermesHome: resolveHermesHomeFor(userId),
        signalPaired: profile.devices?.signal?.paired === true,
      });
      if (!r.ok) throw new Error(`upsertProgram failed: ${r.error.reason}`);
    },
    async supervisorReread() {
      // reread+update is triggered by upsertProgram already; this is a
      // no-op pass-through that allows the provisioner to issue an extra
      // reread after profile mutation without re-rendering.
      // We call upsertProgram with the latest profile to stay idempotent —
      // a standalone reread call would require a new SupervisordControl method.
      // The provisioner only calls supervisorReread() immediately after
      // renderAndWrite(), so the extra upsertProgram is harmless (idempotent).
    },
    async supervisorRestart(programs) {
      const r = await supervisordControl.restartPrograms(programs);
      if (!r.ok) throw new Error(`restartPrograms failed: ${r.error.reason}`);
    },
    async supervisorStopRemove(programs) {
      const r = await supervisordControl.stopRemovePrograms(programs);
      if (!r.ok) throw new Error(`stopRemovePrograms failed: ${r.error.reason}`);
    },
  });

  return {
    async getUserProfile(userId) {
      const r = await profileStore.get(userId);
      if (!r.ok) return {};
      return r.value;
    },
    provisionSignalCli: (userId) => provisioner.provision(userId),
    waitForSignalCliHealth: (userId) => provisioner.waitForHealth(userId),
    finalizePair: (userId, account) => provisioner.finalize(userId, account),
    cleanupOnFail: (userId) => provisioner.cleanup(userId),
    unpair: (userId) => provisioner.unpair(userId),
  };
}

function buildKeyRotation(
  cfg: StartupConfig,
  userPortStore: UserPortStore,
  supervisordControl: SupervisordControl,
  profileStore: ProfileStore,
  internalSecretsStore: InternalSecretsStore,
  tzForPrograms: () => string,
  resolveHermesHomeFor: (userId: string) => string,
): KeyRotationOrchestrator {
  return createKeyRotation({
    async listUsers() {
      const r = await userPortStore.list();
      if (!r.ok) return [];
      return r.value.map((b) => b.userId);
    },
    async reprovisionUser(userId) {
      const port = await userPortStore.resolvePort(userId);
      if (port === null) return { ok: false, reason: "no-port-binding" };
      const profileResult = await profileStore.get(userId);
      const provider = profileResult.ok ? profileResult.value.model.provider : FALLBACK_LLM_PROVIDER;
      const signalPaired = profileResult.ok ? profileResult.value.devices?.signal?.paired === true : false;
      const upsertResult = await supervisordControl.upsertProgram({
        userId,
        port,
        token: internalSecretsStore.getHermesAuthTokenSync(),
        timezone: tzForPrograms(),
        provider,
        hermesHome: resolveHermesHomeFor(userId),
        signalPaired,
      });
      if (!upsertResult.ok) return { ok: false, reason: upsertResult.error.reason };
      const restartResult = await supervisordControl.restartProfile(
        userId,
        cfg.apply.profile_restart_timeout_ms,
        signalPaired,
      );
      if (!restartResult.ok) return { ok: false, reason: restartResult.error.reason };
      return { ok: true };
    },
  });
}

// ---------------------------------------------------------------------------
// Native orchestrator composition root (Plan 2 Task 9, spec §2.6)
// ---------------------------------------------------------------------------
//
// Builds the app-lifetime singletons (AccessManager, McpClient, the shared
// PolicyEngine/DelegationGuard/HermesRunner) once, resolves the orchestrator's
// ProviderClient from the operator's 1.0 secrets store, and returns a
// per-session `createSessionRuntime` factory closure that mints a fresh
// ToolBroker (+ its own delegateTask runner bound to that session's userId)
// on every call — mirroring `createSynthesizerFor` above. Everything here
// no-ops (`provider: null`, `createSessionRuntime: null`) when
// `cfg.orchestrator` is absent: the native orchestrator is an OPTIONAL
// subsystem and must never block gateway boot.

export interface OrchestratorServices {
  accessManager: AccessManager;
  mcpClient: McpClient;
  provider: ProviderClient | null;
  createSessionRuntime: ((principal: UserPrincipal, sessionId: string, emitter: TurnEmitter) => SessionRuntime) | null;
}

/**
 * Exported (beyond this file's own use in `runPhaseServices`) so
 * `tests/integration/native-brain-text.test.ts` (Plan 2 Task 10's `@live`
 * gate) can construct the exact same real composition-root primitives —
 * `AccessManager`, `McpClient`, the resolved `ProviderClient`, and the
 * per-session `createSessionRuntime` factory — WITHOUT going through the
 * full `createGatewayServices()` boot chain, which (via `runPhaseServices`'s
 * Hermes-migration tail: `migrateUnboundUsers` /
 * `renderConfigsForExistingUsers` / `renderProgramsForExistingUsers`) would
 * mutate this machine's real supervisord/user state as a side effect of
 * running the test suite. This function itself has no such side effect
 * (only `warmMcpClient`'s network I/O, which never throws) — see Task 9's
 * own header comment on `buildOrchestratorServices` below.
 */
export async function buildOrchestratorServices(
  cfg: StartupConfig,
  secretsStore: SecretsStore | null,
): Promise<OrchestratorServices> {
  const accessManager = createAccessManager({ userDataRoot: cfg.access.user_data_root });
  const mcpClient = createMcpClient(cfg.mcpCatalog, {});

  // MCP-warm-before-first-call (Task 4 residual — see tool-broker.ts's
  // `ensureMcpWarm` doc comment and Task 4's own report: "a residual for
  // Task 6/9/10 to confirm the composition root gives the warm-up time to
  // land before the very first LLM call"). Chosen fix: warm the SHARED
  // McpClient's per-server transport connections once here, at boot — the
  // slow part (network handshake to each configured MCP server) is done
  // before any session exists. Each session still builds its OWN ToolBroker
  // (spec §5.3: no cross-session tool state), so its own `ensureMcpWarm()`
  // still re-lists tools once — but against already-connected transports, a
  // fast local round trip instead of a cold dial. This narrows the
  // `definitions()` synchronous-read race (Task 4's residual) to something
  // Task 10's real WS round trip (session creation → first user message)
  // comfortably outlasts in practice; a hard guarantee would require making
  // this factory async, which the locked signature
  // (`createSessionRuntime(principal, sessionId, emitter): SessionRuntime`)
  // does not allow. Noted as a residual, not silently dropped.
  await warmMcpClient(mcpClient);

  if (!cfg.orchestrator) {
    log.info("orchestrator.disabled", { reason: "no orchestrator: block in config.yaml" });
    return { accessManager, mcpClient, provider: null, createSessionRuntime: null };
  }

  const orchestratorCfg = cfg.orchestrator;
  const provider = await buildOrchestratorProvider(orchestratorCfg, secretsStore);

  const policyEngine = createPolicyEngine(loadMcpPolicy());
  const frontmatterDir = resolveDelegationFrontmatterDir(orchestratorCfg.delegation.frontmatter_dir);
  const delegationFrontmatter = loadDelegationFrontmatterDir(frontmatterDir);
  const promptClassifier = createPromptClassifier({ riskConfig: riskConfigSchema.parse({}) });
  const delegationGuard = createDelegationGuard({ frontmatter: delegationFrontmatter, classifier: promptClassifier });
  const hermesRunner = createHermesRunner({
    resolveProfileDir: getHermesProfileDir,
    timeoutMs: orchestratorCfg.delegation.hermes_timeout_ms,
  });

  const createSessionRuntime = buildCreateSessionRuntime({
    orchestratorCfg,
    accessManager,
    provider,
    mcpClient,
    policyEngine,
    delegationGuard,
    hermesRunner,
  });

  return { accessManager, mcpClient, provider, createSessionRuntime };
}

/** Warms the shared MCP client's per-server transport connections. Never
 *  throws — `McpClient.listTools()` already catches/logs/skips a single
 *  unreachable server internally; this try/catch is belt-and-braces against
 *  a future change to that contract, not a sign it can currently reject. */
async function warmMcpClient(mcpClient: McpClient): Promise<void> {
  try {
    const tools = await mcpClient.listTools();
    log.info("mcp-client.warmup.ok", { toolCount: tools.length });
  } catch (err) {
    log.warn("mcp-client.warmup.failed", { reason: err instanceof Error ? err.message : String(err) });
  }
}

/** `orchestrator.delegation.frontmatter_dir` ships relative
 *  (`./config/delegation`) — resolve against the gateway project root, not
 *  `process.cwd()` (which varies by launcher). Absolute overrides pass
 *  through untouched. */
function resolveDelegationFrontmatterDir(frontmatterDir: string): string {
  return frontmatterDir.startsWith("/") ? frontmatterDir : join(GATEWAY_ROOT, frontmatterDir);
}

/** Resolves the orchestrator's live `ProviderClient` from the operator's 1.0
 *  secrets store — see resolve-provider-connection.ts's header for why this
 *  is NEVER `process.env`. `null` covers every "not ready yet" case: no
 *  secrets store at all (hermes not configured), an unreadable keys.yaml, or
 *  an active provider with no key set — the gateway boots regardless; only a
 *  session that actually needs the orchestrator fails later, loudly, at
 *  construction (`buildCreateSessionRuntime` below). */
async function buildOrchestratorProvider(
  orchestratorCfg: OrchestratorConfig,
  secretsStore: SecretsStore | null,
): Promise<ProviderClient | null> {
  if (!secretsStore) {
    log.warn("orchestrator.provider.no-secrets-store", {
      reason: "secrets store absent (hermes not configured) — orchestrator provider unavailable",
    });
    return null;
  }

  const activeLlm = await secretsStore.getActiveLlm();
  if (!activeLlm.ok) {
    log.warn("orchestrator.provider.secrets-read-failed", { reason: activeLlm.error.kind });
    return null;
  }

  const conn = resolveProviderConnection(activeLlm.value, orchestratorCfg.provider);
  if (!conn) {
    log.warn("orchestrator.provider.no-active-key", {
      activeProvider: activeLlm.value.provider,
      hasKey: activeLlm.value.apiKey !== "",
      hasSecretsBaseUrl: activeLlm.value.baseUrl !== "",
      hasConfigBaseUrl: orchestratorCfg.provider.base_url !== "",
    });
    return null;
  }

  log.info("orchestrator.provider.resolved", {
    provider: conn.provider,
    baseUrlHost: safeUrlHost(conn.baseUrl),
    hasKey: true, // presence only — NEVER log conn.apiKey
    model: orchestratorCfg.provider.model,
  });
  return createOpenAIProvider({ ...orchestratorCfg.provider, base_url: conn.baseUrl }, conn.apiKey);
}

/** Host only — never log a full URL that might (in a future provider) carry
 *  query-string credentials. */
function safeUrlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

interface CreateSessionRuntimeFactoryDeps {
  orchestratorCfg: OrchestratorConfig;
  accessManager: AccessManager;
  provider: ProviderClient | null;
  mcpClient: McpClient;
  policyEngine: PolicyEngine;
  delegationGuard: DelegationGuard;
  hermesRunner: HermesRunner;
}

/** The per-session factory itself. Synchronous (matches the locked
 *  `GatewayServices.createSessionRuntime` signature) — everything it does is
 *  either pure construction or fire-and-forget (`broker.definitions()`'s
 *  warm-up kick-off). Throws when `provider` is null: `cfg.orchestrator` was
 *  present at boot but no active LLM key resolved — a genuine misconfig for
 *  a caller that specifically asked for a session runtime, never a reason to
 *  fail the whole gateway boot (that check lives HERE, at the point of
 *  actual use, not in `buildOrchestratorServices` above). */
function buildCreateSessionRuntime(
  deps: CreateSessionRuntimeFactoryDeps,
): (principal: UserPrincipal, sessionId: string, emitter: TurnEmitter) => SessionRuntime {
  const { orchestratorCfg, accessManager, provider, mcpClient, policyEngine, delegationGuard, hermesRunner } = deps;

  return (principal, sessionId, emitter) => {
    if (!provider) {
      log.error("session-runtime.factory.no-provider", {
        userId: principal.userId,
        sessionId,
        reason: "orchestrator configured but no active LLM key resolved from the secrets store",
      });
      throw new Error(
        "orchestrator provider unavailable — no active LLM key configured in the secrets store (admin > secrets)",
      );
    }

    const backgroundTools = new Map<string, BackgroundToolRunner>();
    backgroundTools.set(
      delegateTaskDefinition.name,
      createDelegateTaskRunner({ guard: delegationGuard, hermesRunner, userId: principal.userId }),
    );

    // `ToolBrokerDeps.store` is interface-parity only — tool-broker.ts never
    // reads it (the ReAct loop owns turnId and does all appending). Opening a
    // real per-session SQLite handle for a field that is never touched would
    // leak one fd triple (db + WAL + SHM) per session for the process lifetime
    // — unbounded on a long-running family gateway. Pass a stub that throws if
    // anything ever calls it, so a future read surfaces loudly instead of
    // silently corrupting isolation. Dropping `store` from ToolBrokerDeps is
    // the real fix, but that is Task 4's locked interface — tracked as a
    // follow-up.
    const brokerStore: SessionStore = {
      append: () => {
        throw new Error("ToolBroker.store is interface-parity only and must not be used");
      },
      readSession: () => {
        throw new Error("ToolBroker.store is interface-parity only and must not be used");
      },
      readSince: () => {
        throw new Error("ToolBroker.store is interface-parity only and must not be used");
      },
      listSessions: () => {
        throw new Error("ToolBroker.store is interface-parity only and must not be used");
      },
      close: () => {},
    };

    const broker = createToolBroker({
      mcp: mcpClient,
      policy: policyEngine,
      store: brokerStore,
      principal,
      sessionId,
      backgroundTools,
      config: orchestratorCfg.tools,
      // Plan 2 default: deny every unconfirmed side-effecting call. Plan 3
      // wires a real client permission-prompt UI without touching this file
      // (mirrors tool-broker.ts's own header note on the same contract).
      requestConfirm: async () => false,
    });
    void broker.definitions(); // kick off this session's own MCP list-tools warm-up now, not on the first turn.

    log.info("session-runtime.factory.build", { userId: principal.userId, sessionId });

    const runtime = buildSessionRuntime({
      principal,
      sessionId,
      accessManager,
      provider,
      broker,
      emitter,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      config: orchestratorCfg,
    });

    // Closes the delegateTask fire-and-steer loop (spec §5.2/§5.4): the
    // broker is necessarily built BEFORE this runtime (it's a runtime
    // constructor dep), so the completion sink can't be wired until now,
    // right after `runtime` exists. A background tool's settled result
    // (e.g. delegateTask's Hermes one-shot output) becomes a
    // `background-completion` stimulus — SessionRuntime maps that to a
    // fresh `trigger` entry and fires/steers the next turn. See
    // tool-broker.ts's `setBackgroundCompletionSink` doc comment and
    // delegate-task.ts's file header for the full mechanism.
    broker.setBackgroundCompletionSink((result) => {
      const note = result.isError
        ? `Delegated task ${result.taskId} (${result.toolName}) failed: ${result.content}`
        : `Delegated task ${result.taskId} (${result.toolName}) completed: ${result.content}`;
      runtime.submit({ kind: "background-completion", note });
    });

    return runtime;
  };
}
