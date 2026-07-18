import type { ApplyConfig, HermesConfig, McpCatalog } from "@sentient/config";
import type { InternalSecretsStore } from "../admin/internal-secrets-store.js";
import type { SecretsStore } from "../admin/secrets-store.js";
import type { SupervisordControl } from "../admin/supervisord-control.js";
import type { UserPortStore } from "../admin/user-port-store.js";
import type { HealthPoller } from "../infrastructure/health-poller.js";
import { getLog } from "../logging/logger.js";
import type { PersonSessionRegistry } from "../person-session/person-session-registry.js";
import { type ProviderBaseUrlAccessor, renderProfile, writeRendered } from "../profile-store/profile-renderer.js";
import type { ProfileStore } from "../profile-store/profile-store.js";
import type { ModelProvider } from "../profile-store/profile-types.js";
import type { TemplateLoader } from "../profile-store/template-loader.js";
import { renderWorkerUrl } from "../session-router.js";
import type { SessionRouter } from "../session-router.js";
import type { ApplyDeps, ApplyError } from "./orchestrator.js";

const log = getLog(["sentient", "gateway", "apply", "apply-deps"]);

/** Discrete dependency view consumed by `createApplyDeps`. */
export interface ApplyDepsServices {
  readonly profileStore: ProfileStore;
  readonly sessionRouter: SessionRouter;
  /** Per-user session registry. Apply clears the resolved PersonSession's
   *  conversation anchors before restart — must be the SAME registry
   *  instance the WS handlers attach live sessions to (see
   *  bootstrap/phase-services.ts), otherwise `.get(userId)` never finds
   *  the live session and the anchor clear silently no-ops. */
  readonly personSessions: PersonSessionRegistry;
  readonly healthPoller: HealthPoller;
  readonly templateLoader: TemplateLoader;
  readonly applyConfig: ApplyConfig;
  readonly hermes: HermesConfig | null;
  readonly userPortStore: UserPortStore | null;
  readonly internalSecretsStore: InternalSecretsStore;
  /** Restarts a single per-user supervisord program AND re-upserts its
   *  conf file. `upsertProgram` must be reachable so apply can refresh the
   *  `environment=` block on provider switches. */
  readonly supervisordControl: Pick<SupervisordControl, "restartProfile" | "upsertProgram">;
  /** Returns the timezone string written into per-user supervisord
   *  programs (TZ env var). Must match what the provisioner uses so a
   *  re-upsert during apply doesn't shift TZ out from under the worker. */
  readonly resolveTimezone: () => string;
  /** Returns the host-side absolute path to a user's Hermes home — the
   *  HERMES_HOME baked into the supervisord program. Must match the
   *  provisioner's resolver. */
  readonly resolveHermesHome: (userId: string) => string;
  /** Operator-managed MCP server inventory. Loaded once at boot from
   *  `gateway/config.yaml#mcp_catalog`; the renderer joins entries
   *  against `profile.tools.enabled[]` per-user with var substitution. */
  readonly mcpCatalog: McpCatalog;
  /** Secrets store for reading per-user provider configuration (e.g.
   *  base_url for the "custom" LLM provider). Must already be loaded
   *  (load() or setLlmProviderKey() called) before renderProfile runs.
   *  Null in headless/test setups where custom provider is not used. */
  readonly secretsStore: SecretsStore | null;
}

/** Adapts SecretsStore into the narrow ProviderBaseUrlAccessor interface
 *  used by the renderer, so the renderer has no direct SecretsStore dep. */
function makeProviderBaseUrlAccessor(store: SecretsStore | null): ProviderBaseUrlAccessor {
  return {
    getProviderBaseUrlSync(provider: ModelProvider): string | null {
      if (!store) return null;
      const llm = store.getActiveLlmSync();
      if (!llm || llm.provider !== provider) return null;
      return llm.baseUrl || null;
    },
  };
}

/** Compose a fully-wired ApplyDeps from the discrete services view. */
export function createApplyDeps(services: ApplyDepsServices): ApplyDeps {
  const providerBaseUrl = makeProviderBaseUrlAccessor(services.secretsStore);
  const renderWithCatalog: ApplyDeps["renderProfile"] = (profile, template) =>
    renderProfile(profile, template, { mcpCatalog: services.mcpCatalog, providerBaseUrl });
  return {
    profileStore: services.profileStore,
    sessionRouter: services.sessionRouter,
    personSessions: services.personSessions,
    healthPoller: services.healthPoller,
    renderProfile: renderWithCatalog,
    writeRendered,
    loadTemplate: () => services.templateLoader.loadOrBuiltinDefault(),
    resolveContainerName: async (userId) => containerNameFor(services, userId),
    resolveHealthUrl: async (userId) => healthUrlFor(services, userId),
    resolveHealthHeaders: async (userId) => healthHeadersFor(services, userId),
    supervisordControl: services.supervisordControl,
    refreshProgramEnv: (userId) => refreshProgramEnvFor(services, userId),
    config: applyConfigToOrchestratorConfig(services.applyConfig),
  };
}

/** Read the current profile + per-user port, then re-upsert the supervisord
 *  program so its `environment=` block reflects the active provider. Called
 *  by runApply after config.yaml is rewritten and before restartProfile. */
async function refreshProgramEnvFor(
  services: ApplyDepsServices,
  userId: string,
): Promise<{ ok: true; value: undefined } | { ok: false; error: ApplyError }> {
  if (!services.hermes || !services.userPortStore) {
    log.warn("apply.refreshProgramEnv.skipped", { userId, reason: "no-hermes-or-port-store" });
    return { ok: true, value: undefined };
  }
  const profileResult = await services.profileStore.get(userId);
  if (!profileResult.ok) {
    return { ok: false, error: { kind: "user-not-found", userId } };
  }
  const port = await services.userPortStore.resolvePort(userId);
  if (port === null) {
    const reason = "no-port-binding";
    log.warn("apply.refreshProgramEnv.no-port", { userId, reason });
    return { ok: false, error: { kind: "docker-restart-failed", reason } };
  }
  const profile = profileResult.value;
  const upsertResult = await services.supervisordControl.upsertProgram({
    userId,
    port,
    token: services.internalSecretsStore.getHermesAuthTokenSync(),
    timezone: services.resolveTimezone(),
    provider: profile.model.provider,
    hermesHome: services.resolveHermesHome(userId),
    signalPaired: profile.devices?.signal?.paired === true,
  });
  if (!upsertResult.ok) {
    const reason = upsertResult.error.reason ?? upsertResult.error.kind;
    log.warn("apply.refreshProgramEnv.upsert-failed", { userId, reason });
    return { ok: false, error: { kind: "docker-restart-failed", reason } };
  }
  log.info("apply.refreshProgramEnv.ok", { userId, provider: profile.model.provider });
  return { ok: true, value: undefined };
}

async function containerNameFor(services: ApplyDepsServices, userId: string): Promise<string> {
  if (!services.hermes) {
    log.warn("apply.deps.no-hermes", { userId, resolver: "containerName" });
    return `hermes-${userId}`;
  }
  return services.hermes.worker.container_name;
}

async function healthUrlFor(services: ApplyDepsServices, userId: string): Promise<string> {
  if (!services.hermes || !services.userPortStore) {
    log.warn("apply.deps.missing-deps", { userId, resolver: "healthUrl" });
    return `http://hermes-${userId}/health`;
  }
  const port = await services.userPortStore.resolvePort(userId);
  if (port === null) {
    log.warn("apply.deps.no-port", { userId, resolver: "healthUrl" });
    return `http://hermes-${userId}/health`;
  }
  // Worker URL template is `http://host:{port}` — health endpoint sits at
  // `/health`. Port substitution applies to URL templates too even though
  // they were defined for ws:// — the host:port shape is identical.
  const base = renderWorkerUrl(services.hermes.worker.url_template, port);
  return `${base.replace(/^ws:/, "http:").replace(/\/$/, "")}/health`;
}

async function healthHeadersFor(services: ApplyDepsServices, userId: string): Promise<Record<string, string>> {
  if (!services.hermes) {
    log.warn("apply.deps.no-hermes", { userId, resolver: "healthHeaders" });
    return {};
  }
  return { Authorization: `Bearer ${services.internalSecretsStore.getHermesAuthTokenSync()}` };
}

function applyConfigToOrchestratorConfig(cfg: ApplyConfig): ApplyDeps["config"] {
  return {
    dockerRestartTimeoutMs: cfg.docker_restart_timeout_ms,
    healthCheckTimeoutMs: cfg.health_check_timeout_ms,
    healthPollIntervalMs: cfg.health_poll_interval_ms,
  };
}
