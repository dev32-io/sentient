import { ADMIN_ROLE } from "@sentient/protocol";
import type { Server, ServerWebSocket } from "bun";
import type { AdminDeps } from "./api/handlers/admin.ts";
import { createAdminHandler } from "./api/handlers/admin.ts";
import { type ApplyHandlerDeps, createApplyHandler } from "./api/handlers/apply.ts";
import { createAuthHandler } from "./api/handlers/auth.ts";
import { createCalendarHandler } from "./api/handlers/calendar.ts";
import { createDiagnosticsHandler } from "./api/handlers/diagnostics.ts";
import { renderDownloadPage } from "./api/handlers/downloads-page.ts";
import { renderItmsPlist } from "./api/handlers/downloads-plist.ts";
import { createDownloadsHandler } from "./api/handlers/downloads.ts";
import { createHealthHandler } from "./api/handlers/health.ts";
import { createInstallStateHandler } from "./api/handlers/install-state.ts";
import { createMcpCatalogHandler } from "./api/handlers/mcp-catalog.ts";
import { createProfileEditHandler } from "./api/handlers/profile-edit.ts";
import { createProfileHandler } from "./api/handlers/profile.ts";
import { createProvidersHandler } from "./api/handlers/providers.ts";
import { createReadyHandler } from "./api/handlers/ready.ts";
import { type RequireAdminFn, createSecretsHandler } from "./api/handlers/secrets.ts";
import { createServicesVersionsHandler } from "./api/handlers/services-versions.ts";
import { createSessionsHandler } from "./api/handlers/sessions.ts";
import { createSystemStatusHandler } from "./api/handlers/system-status.ts";
import { createVoicesHandler } from "./api/handlers/voices.ts";
import { createWebuiHandler } from "./api/handlers/webui.ts";
import { createWsUpgradeHandler } from "./api/handlers/ws.ts";
import { createProvidersDeps } from "./api/providers-deps.ts";
import { createApiRouter } from "./api/router.ts";
import { createWizardHandler } from "./api/wizard/index.ts";
import { runApply } from "./apply/orchestrator.ts";
import type { RouterDeps } from "./apply/router.ts";
import { testProviderImpl } from "./bootstrap/create-gateway-services.ts";
import type { GatewayServices } from "./bootstrap/create-gateway-services.ts";
import { getLog } from "./logging/logger.ts";
import {
  type SessionData,
  cleanupSession,
  handleWebSocketMessage,
  openSession,
} from "./session-handlers/ws-handlers.ts";
import { errorMessage } from "./session-handlers/ws-helpers.ts";
import type { TokenService } from "./user-auth/token-service.ts";
import type { UserStore } from "./user-auth/user-store.ts";

export type { SessionData };
export type { GatewayTlsMaterial } from "./session-handlers/ws-handlers.ts";

const log = getLog(["sentient", "ws"]);

// RFC 6455 — 1011: server encountered an unexpected condition. Used only when
// a websocket.message handler throws; Bun's Bun.serve `error()` hook is
// fetch-only and is never invoked for WS message-handler exceptions, so an
// uncaught throw there otherwise crashes the whole process (exit 1, taking
// every connected user with it).
const WS_INTERNAL_ERROR = 1011;

function makeThrowProxy(name: string): never {
  return new Proxy(
    {},
    {
      get: () => {
        throw new Error(`${name} not available without hermes config`);
      },
    },
  ) as never;
}

export interface GatewayServerOptions {
  port: number;
  host: string;
  services: GatewayServices;
}

export function createGatewayServer(options: GatewayServerOptions): Server<SessionData> {
  const { services } = options;
  const adminToken = process.env.ADMIN_TOKEN;
  let activeConnections = 0;

  // Hoisted (request-stable) handler factories. Constructed once at server
  // start instead of per-request inside fetch(). Only handleWsUpgrade depends
  // on the Bun server instance (not stable until Bun.serve returns) and is
  // built per-request below.
  const handleHealth = createHealthHandler();
  const handleReady = createReadyHandler({
    getActiveConnections: () => activeConnections,
    getOrchestratorStatus: () => services.systemOrchestrator?.getStatus() ?? null,
  });
  const handleInstallState = createInstallStateHandler({
    installState: services.installState,
    currentVersion: services.gatewayVersion,
  });
  const providersDeps = createProvidersDeps({
    config: services.providersConfig,
    env: (name) => process.env[name],
    secretsStore: services.secretsStore ?? undefined,
  });
  const handleAdmin = createAdminHandler(buildAdminDeps(services, adminToken, services.auth.tokens));
  const handleSecrets = createSecretsHandler({
    installState: services.installState,
    secretsStore: services.secretsStore ?? makeThrowProxy("SecretsStore"),
    requireAdmin: buildRequireAdmin(services.auth.tokens, adminToken, services.auth.users),
  });
  const handleAuth = createAuthHandler({
    auth: services.auth,
    ...(services.userProvisioner ? { userProvisioner: services.userProvisioner } : {}),
    ...(services.secretsStore ? { secretsStore: services.secretsStore } : {}),
    installState: services.installState,
    mcpCatalog: services.mcpCatalog,
  });
  const handleEdit = createProfileEditHandler({
    tokens: services.auth.tokens,
    buildPersonalityStore: services.buildPersonalityStore,
    resolveProfileDir: services.resolveProfileDir,
    templateLoader: services.templateLoader,
  });
  const handleProfile = createProfileHandler({
    tokens: services.auth.tokens,
    profileStore: services.profileStore,
    users: services.auth.users,
    mcpCatalog: services.mcpCatalog,
    runApply: (userId) => runApply(services.applyDeps, userId),
    handleEdit,
  });
  const handleProviders = createProvidersHandler({
    tokens: services.auth.tokens,
    listModels: providersDeps.listModels,
    fishDeps: {
      tokens: services.auth.tokens,
      fishBrowseEnabled: services.providersConfig.fish_browse_enabled,
      fishApiKey: services.fishApiKey,
      timeoutMs: services.providersConfig.external_fetch_timeout_ms,
      cacheTtlMs: services.providersConfig.fish_cache_ttl_ms,
    },
    fishCloneDeps: {
      fishBrowseEnabled: services.providersConfig.fish_browse_enabled,
      fishApiKey: services.fishApiKey,
      externalFetchTimeoutMs: services.providersConfig.external_fetch_timeout_ms,
      profileStore: services.profileStore,
      ttsUrl: services.ttsConfig.url,
      connectTimeoutMs: services.ttsConfig.connect_timeout_ms,
      opTimeoutMs: services.ttsConfig.voice_op_timeout_ms,
      descriptionMaxLen: services.ttsConfig.voice_description_max_len,
      tagMaxLen: services.ttsConfig.voice_tag_max_len,
      maxTags: services.ttsConfig.voice_max_tags,
    },
  });
  const handleMcpCatalog = createMcpCatalogHandler({
    tokens: services.auth.tokens,
    catalog: services.mcpCatalog,
    hermesBuiltinTools: services.hermesBuiltinTools,
    users: services.auth.users,
    profileStore: services.profileStore,
  });
  const handleServicesVersions = createServicesVersionsHandler({
    installState: services.installState,
    systemOrchestrator: services.systemOrchestrator,
    gatewayVersion: services.gatewayVersion,
    hermesVersionPath: services.hermesVersionPath,
    sttHealthUrl: services.sttHealthUrl,
    ttsHealthUrl: services.ttsHealthUrl,
    tokens: services.auth.tokens,
    fishBrowseEnabled: services.providersConfig.fish_browse_enabled,
  });
  const handleStatic = createWebuiHandler({ distDir: services.webDistDir });
  const handleDownloads = createDownloadsHandler({
    artifactsDir: services.downloads.artifactsDir,
    publicBaseUrl: services.downloads.publicBaseUrl,
    renderLandingPage: () => renderDownloadPage(services.downloads.publicBaseUrl),
    renderPlist: (manifest) => renderItmsPlist(manifest, services.downloads.publicBaseUrl),
  });
  const handleWizard = createWizardHandler({
    installState: services.installState,
    unlockCode: services.unlockCode,
    secretsStore: services.secretsStore ?? makeThrowProxy("SecretsStore"),
    testProvider: testProviderImpl,
    listModels: providersDeps.listModels,
    systemOrchestrator: services.systemOrchestrator,
  });
  const handleSystemStatus = createSystemStatusHandler({
    systemOrchestrator: services.systemOrchestrator,
  });
  const handleApply = buildApplyHandler(services, services.auth.tokens);
  const handleVoices = createVoicesHandler({
    tokens: services.auth.tokens,
    profileStore: services.profileStore,
    ttsUrl: services.ttsConfig.url,
    connectTimeoutMs: services.ttsConfig.connect_timeout_ms,
    opTimeoutMs: services.ttsConfig.voice_op_timeout_ms,
    previewGreetings: services.ttsConfig.preview_greetings,
    previewTimeoutMs: services.ttsConfig.preview_timeout_ms,
    descriptionMaxLen: services.ttsConfig.voice_description_max_len,
    tagMaxLen: services.ttsConfig.voice_tag_max_len,
    maxTags: services.ttsConfig.voice_max_tags,
  });
  const handleDiagnostics = createDiagnosticsHandler({ tokens: services.auth.tokens });
  const handleCalendar = createCalendarHandler({
    tokens: services.auth.tokens,
    users: services.auth.users,
    accessManager: services.accessManager,
    ...(services.calendarConfig ? { calendarConfig: services.calendarConfig } : {}),
    ...(services.calendarHouseholdTimeZone ? { householdTimeZone: services.calendarHouseholdTimeZone } : {}),
  });
  const handleSessions = createSessionsHandler({
    tokens: services.auth.tokens,
    users: services.auth.users,
    accessManager: services.accessManager,
    dbFileName: services.dbFileName,
  });

  return Bun.serve<SessionData>({
    port: options.port,
    hostname: options.host,
    // Bun's idleTimeout is in whole seconds, capped at 255. Convert from the
    // ms YAML knob and round down so we never exceed the configured value.
    idleTimeout: Math.floor(services.session.ws_idle_timeout_ms / 1000),
    ...(services.tls ? { tls: services.tls } : {}),

    error(err: Error): Response {
      log.warn("server-error", { type: err.constructor.name, message: err.message });
      return new Response("Internal Server Error", { status: 500 });
    },

    async fetch(request, serverInstance) {
      const router = createApiRouter({
        handleDownloads,
        handleHealth,
        handleReady,
        handleWsUpgrade: createWsUpgradeHandler(serverInstance),
        handleAdmin,
        handleSecrets,
        handleAuth,
        handleProfile,
        handleProviders,
        handleMcpCatalog,
        handleInstallState,
        handleServicesVersions,
        handleWizard,
        handleSystemStatus,
        handleApply,
        handleVoices,
        handleDiagnostics,
        handleSessions,
        handleCalendar,
        handleStatic,
      });
      return router(request);
    },

    websocket: {
      open(ws: ServerWebSocket<SessionData>) {
        activeConnections++;
        log.info("client-connected");
        openSession(ws, services);
      },
      async message(ws: ServerWebSocket<SessionData>, message: string | Buffer) {
        // Bun's websocket.message handler has no equivalent of the fetch
        // error() hook — an unhandled rejection here terminates the whole
        // process (all connected users), not just this connection. Catch at
        // this boundary per .claude/rules/error-handling.md.
        try {
          await handleWebSocketMessage(ws, message, services);
        } catch (err: unknown) {
          log.warn("ws-message-handler-threw", {
            sessionId: ws.data.sessionId,
            reason: errorMessage(err, "unknown error"),
          });
          ws.close(WS_INTERNAL_ERROR, "internal error");
        }
      },
      close(ws: ServerWebSocket<SessionData>) {
        activeConnections--;
        log.info("client-disconnected");
        cleanupSession(ws, services);
      },
    },
  });
}

/** Builds a requireAdmin function for the secrets handler from TokenService +
 *  static admin token.
 *
 *  EXPORTED FOR ITS TEST, not for reuse — it is the gate on the household's API
 *  keys and was the one admin resolver nothing constructed (`secrets.test.ts`
 *  stubs `requireAdmin` wholesale), so its fail-closed paths had never run. */
export function buildRequireAdmin(
  tokenService: TokenService,
  adminToken: string | undefined,
  userStore: Pick<UserStore, "get">,
): RequireAdminFn {
  const BEARER_PREFIX = "Bearer ";
  return async (req) => {
    const header = req.headers.get("Authorization") ?? "";
    if (!header.startsWith(BEARER_PREFIX)) return { ok: false };
    const token = header.slice(BEARER_PREFIX.length);
    // The static machine-to-machine token is the operator's own out-of-band
    // credential, not a user — there is no record behind it to resolve.
    if (adminToken && token === adminToken) return { ok: true, value: { role: ADMIN_ROLE } };
    const result = await tokenService.validate(token);
    if (!result.ok) return { ok: false };
    // The token said WHO. The record says WHAT THEY MAY DO, as of now — a
    // demoted account is refused on its next call with nothing to invalidate.
    const stored = await userStore.get(result.value.userId);
    if (!stored.ok || stored.value === null) {
      log.warn("require-admin.no-record", {
        userId: result.value.userId,
        reason: stored.ok ? "token names a user with no record" : stored.error,
      });
      return { ok: false };
    }
    return { ok: true, value: { role: stored.value.role } };
  };
}

/** Builds the unified POST /api/v1/apply handler, wiring RouterDeps from
 *  GatewayServices and a PASETO bearer authenticate callback. */
function buildApplyHandler(
  services: GatewayServices,
  tokenService: Pick<TokenService, "validate">,
): (req: Request) => Promise<Response> {
  const BEARER_PREFIX = "Bearer ";

  const routerDeps: RouterDeps = {
    // Resolved from the RECORD, not the caller's token: a system-level apply is
    // the highest-authority thing the REST surface does, so it reads the
    // household's current answer rather than whatever a possibly-stale token
    // was minted with.
    roleOf: async (uid) => {
      const r = await services.auth.users.get(uid);
      if (!r.ok || !r.value) return null;
      return r.value.role;
    },
    diffSecrets: (s) => {
      const store = services.secretsStore;
      if (!store) return Promise.resolve([]);
      return store.diffPaths(s);
    },
    perUserApply: async (userId, _profile) => {
      // The profile is already on disk (profile-store is the source of truth).
      // The per-user apply reads it fresh via profileStore.get().
      return runApply(services.applyDeps, userId);
    },
    systemOrchestrator: services.systemOrchestrator ?? {
      applySubset: async () => ({ state: "idle", services: [], startedAt: null, finishedAt: null }) as never,
    },
    registry: services.systemOrchestrator?.registry ?? new Map(),
  };

  const applyHandlerDeps: ApplyHandlerDeps = {
    routerDeps,
    authenticate: async (req) => {
      const header = req.headers.get("Authorization") ?? "";
      if (!header.startsWith(BEARER_PREFIX)) return { ok: false };
      const token = header.slice(BEARER_PREFIX.length);
      const result = await tokenService.validate(token);
      if (!result.ok) return { ok: false };
      return { ok: true, userId: result.value.userId };
    },
  };

  return createApplyHandler(applyHandlerDeps);
}

/** Builds AdminDeps from GatewayServices. Nullable admin stores are stubbed
 *  with throw-on-access proxies — unreached in deployments with hermes
 *  configured (the only path where admin features are exposed). */
function buildAdminDeps(
  services: GatewayServices,
  adminToken: string | undefined,
  tokenService: TokenService,
): AdminDeps {
  return {
    adminToken,
    tokenService,
    provisioner: services.userProvisioner ?? makeThrowProxy("UserProvisioner"),
    userStore: services.auth.users,
    mcpCatalog: services.mcpCatalog,
  };
}
