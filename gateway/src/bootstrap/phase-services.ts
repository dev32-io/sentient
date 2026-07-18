import { ensureTlsMaterial } from "@sentient/tls";
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
import { type HealthPoller, createHealthPoller } from "../infrastructure/health-poller.js";
import { type Log, getLog } from "../logging/logger.ts";
import type { PersonSessionRegistry } from "../person-session/person-session-registry.js";
import { createPersonalityStore } from "../profile-store/personality-store.js";
import type { PersonalityStore } from "../profile-store/personality-store.js";
import { type ProfileStore, createProfileStore } from "../profile-store/profile-store.ts";
import { type TemplateLoader, createTemplateLoader } from "../profile-store/template-loader.ts";
import type { TTSProviderFactory } from "../providers/tts/tts-types.ts";
import type { GatewayTlsMaterial } from "../session-handlers/ws-handlers.ts";
import { createSessionRouter } from "../session-router.js";
import type { SessionRouter } from "../session-router.js";
import type { TextStreamSynthesizer } from "../tts/text-stream-synthesizer.ts";
import type { AuthService } from "../user-auth/auth-service.js";
import { getHermesProfileDir } from "../user-auth/paths.js";
import { hashPin } from "../user-auth/pin-service.js";
import { buildPersonSessionRegistry } from "./build-person-session-registry.ts";
import { createCerebrumServices } from "./cerebrum-factory.ts";
import type { CerebrumServices } from "./cerebrum-factory.ts";
import { createTextStreamSynthesizer } from "./content-tts-factory.ts";
import type { SttService } from "./stt-factory.ts";
import { createSttService } from "./stt-factory.ts";
import type { TtsService } from "./tts-factory.ts";
import { asStrictFactory, createTtsService } from "./tts-factory.ts";

const log = getLog(["sentient", "bootstrap", "phase-services"]);

// Fallback provider used in supervisord program env when a user's profile is
// unreadable (corruption case).
const FALLBACK_LLM_PROVIDER = "openrouter" as const;

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
  readonly cerebrumServices: CerebrumServices;
  readonly createSynthesizerFor: (getVoiceId: () => string | null) => TextStreamSynthesizer | null;
  readonly applyDeps: ApplyDeps;
  readonly profileStore: ProfileStore;
  readonly templateLoader: TemplateLoader;
  readonly healthPoller: HealthPoller;
  readonly sessionRouter: SessionRouter;
  /** Single per-user session registry shared with phase-routes (WS handlers)
   *  via personSessions passthrough in create-gateway-services.ts — apply
   *  and live sessions MUST resolve the same PersonSession instance, or
   *  runApply's `personSessions.get(userId)` never finds the live session
   *  and the pre-restart anchor clear silently no-ops. */
  readonly personSessions: PersonSessionRegistry;
  readonly userProvisioner: UserProvisioner | null;
  readonly keyRotation: KeyRotationOrchestrator | null;
  readonly userLifecycle: UserLifecycle;
  readonly profileRestartOrchestrator: ProfileRestartOrchestrator;
  readonly buildPersonalityStore: (userId: string) => PersonalityStore;
  /** Deps bag for `/api/v1/devices*` handlers. Null when hermes + supervisord
   *  are not configured (e.g. headless / CI builds). */
  readonly devicesHandlerDeps: DevicesHandlerDeps | null;
}

export async function runPhaseServices(input: PhaseServicesInput): Promise<PhaseServicesOutput> {
  const { cfg, auth, secretsStore, internalSecretsStore, userPortStore, supervisordControl } = input;

  const stt = cfg.stt ? createSttService(cfg) : null;
  const tts = createTtsService({ cfg });
  const tls = cfg.tls.enabled
    ? ensureTlsMaterial({ hostnames: cfg.tls.hostnames, certsDir: cfg.tls.certsDir, logTag: "gateway" })
    : undefined;
  const cerebrumServices = createCerebrumServices(cfg);

  const createSynthesizerFor = (getVoiceId: () => string | null): TextStreamSynthesizer | null => {
    const sessionFactory: TTSProviderFactory = asStrictFactory(tts, getVoiceId);
    return createTextStreamSynthesizer(cfg, sessionFactory);
  };

  const profileStore = createProfileStore();
  const templateLoader = createTemplateLoader();
  const healthPoller = createHealthPoller();
  const sessionRouter = buildSessionRouter(cfg, internalSecretsStore, userPortStore);
  const personSessions = buildPersonSessionRegistry(cfg, internalSecretsStore, profileStore, userPortStore);
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
    personSessions,
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
  });

  return {
    stt,
    tts,
    tls,
    cerebrumServices,
    createSynthesizerFor,
    applyDeps,
    profileStore,
    templateLoader,
    healthPoller,
    sessionRouter,
    personSessions,
    userProvisioner,
    keyRotation,
    userLifecycle,
    profileRestartOrchestrator,
    buildPersonalityStore,
    devicesHandlerDeps,
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
