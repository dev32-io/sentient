import { homedir } from "node:os";
import type { Server, ServerWebSocket } from "bun";
import type { AdminDeps } from "./api/handlers/admin.ts";
import { createAdminHandler } from "./api/handlers/admin.ts";
import { type ApplyHandlerDeps, createApplyHandler } from "./api/handlers/apply.ts";
import { createAuthHandler } from "./api/handlers/auth.ts";
import { createDevicesHandler } from "./api/handlers/devices.ts";
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
import { createSecretsHandler } from "./api/handlers/secrets.ts";
import { createServicesVersionsHandler } from "./api/handlers/services-versions.ts";
import { createSessionsHttpHandler } from "./api/handlers/sessions.ts";
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
import { listSessionsForUser, resolvePluginClientForUser } from "./hermes-adapter-client/per-user-plugin.js";
import type { PerUserPluginDeps } from "./hermes-adapter-client/per-user-plugin.js";
import { getLog } from "./logging/logger.ts";
import {
  type ClientData,
  cleanupSession,
  handleWebSocketMessage,
  openSession,
} from "./session-handlers/ws-handlers.ts";
import { createTitleStore } from "./sessions/title-store.js";
import type { TokenService } from "./user-auth/token-service.ts";

export type { ClientData };
export type { GatewayTlsMaterial } from "./session-handlers/ws-handlers.ts";

const log = getLog(["sentient", "ws"]);

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

export function createGatewayServer(options: GatewayServerOptions): Server<ClientData> {
  const { services } = options;
  const adminToken = process.env.ADMIN_TOKEN;
  let activeConnections = 0;

  // Hoisted (request-stable) handler factories. Constructed once at server
  // start instead of per-request inside fetch(). Only handleWsUpgrade depends
  // on the Bun server instance (not stable until Bun.serve returns) and is
  // built per-request below.
  const handleHealth = createHealthHandler();
  const handleReady = createReadyHandler({ getActiveConnections: () => activeConnections });
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
    requireAdmin: buildRequireAdmin(services.auth.tokens, adminToken),
  });
  const handleAuth = createAuthHandler({
    auth: services.auth,
    ...(services.userProvisioner ? { userProvisioner: services.userProvisioner } : {}),
    ...(services.secretsStore ? { secretsStore: services.secretsStore } : {}),
    installState: services.installState,
  });
  const handleEdit = createProfileEditHandler({
    tokens: services.auth.tokens,
    buildPersonalityStore: services.buildPersonalityStore,
    resolveProfileDir: services.resolveProfileDir,
    restartOrchestrator: services.profileRestartOrchestrator,
    templateLoader: services.templateLoader,
  });
  const handleProfile = createProfileHandler({
    tokens: services.auth.tokens,
    profileStore: services.profileStore,
    runApply: (userId) => runApply(services.applyDeps, userId),
    handleEdit,
    refreshVoice: (userId) => services.personSessions.refreshVoice(userId),
  });
  const handleProviders = createProvidersHandler({
    tokens: services.auth.tokens,
    listModels: providersDeps.listModels,
  });
  const handleMcpCatalog = createMcpCatalogHandler({
    tokens: services.auth.tokens,
    catalog: services.mcpCatalog,
    hermesBuiltinTools: services.hermesBuiltinTools,
  });
  const handleServicesVersions = createServicesVersionsHandler({
    installState: services.installState,
    systemOrchestrator: services.systemOrchestrator,
    gatewayVersion: services.gatewayVersion,
    hermesVersionPath: services.hermesVersionPath,
    sttHealthUrl: services.sttHealthUrl,
    tokens: services.auth.tokens,
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
  const handleDevices = services.devicesHandlerDeps
    ? createDevicesHandler({ tokens: services.auth.tokens, ...services.devicesHandlerDeps })
    : async (_req: Request) => new Response("Service Unavailable", { status: 503 });
  const handleSessions = buildSessionsHandler(services);
  const handleVoices = createVoicesHandler({
    tokens: services.auth.tokens,
    profileStore: services.profileStore,
    refreshVoice: (userId) => services.personSessions.refreshVoice(userId),
    ttsUrl: services.ttsConfig.url,
    connectTimeoutMs: services.ttsConfig.connect_timeout_ms,
    opTimeoutMs: services.ttsConfig.voice_op_timeout_ms,
  });
  const handleDiagnostics = createDiagnosticsHandler({ tokens: services.auth.tokens });

  return Bun.serve<ClientData>({
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
        handleDevices,
        handleSessions,
        handleVoices,
        handleDiagnostics,
        handleStatic,
      });
      return router(request);
    },

    websocket: {
      open(ws: ServerWebSocket<ClientData>) {
        activeConnections++;
        log.info("client-connected");
        openSession(ws, services);
      },
      async message(ws: ServerWebSocket<ClientData>, message: string | Buffer) {
        await handleWebSocketMessage(ws, message, services);
      },
      close(ws: ServerWebSocket<ClientData>) {
        activeConnections--;
        log.info("client-disconnected");
        // Transport close: attempt resumable disconnect if the client
        // advertised stream.resume capability and a device buffer exists.
        // Falls through to full teardown when the capability is absent.
        cleanupSession(ws, services, { full: false });
      },
    },
  });
}

/** Builds a requireAdmin function for the secrets handler from TokenService + static admin token. */
function buildRequireAdmin(
  tokenService: TokenService,
  adminToken: string | undefined,
): (req: Request) => Promise<{ ok: true; value: { isAdmin: boolean } } | { ok: false }> {
  const BEARER_PREFIX = "Bearer ";
  return async (req) => {
    const header = req.headers.get("Authorization") ?? "";
    if (!header.startsWith(BEARER_PREFIX)) return { ok: false };
    const token = header.slice(BEARER_PREFIX.length);
    if (adminToken && token === adminToken) return { ok: true, value: { isAdmin: true } };
    const result = await tokenService.validate(token);
    if (result.ok) return { ok: true, value: { isAdmin: result.value.isAdmin } };
    return { ok: false };
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
    isAdmin: async (uid) => {
      const r = await services.auth.users.get(uid);
      if (!r.ok || !r.value) return false;
      return r.value.isAdmin;
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

/** Builds the `/api/v1/sessions*` handler from GatewayServices.
 *
 * Per-user resolution:
 *   resolvePluginClient — derives http base URL (hermes + userPortStore),
 *     shifts port by DASHBOARD_PORT_OFFSET to reach the sentient-plugin sidecar,
 *     constructs a SentientPluginClient with the shared Hermes bearer token.
 *   listSessions — acquires the per-user ACP wire from the shared registry
 *     (reuses a live wire if the same user has an active WS session, dials on
 *     first REST-only access), calls session/list, releases the ref in finally.
 *   resolveTitleStore — creates a per-user TitleStore scoped to the user's data
 *     dir; each call for the same userId within a request returns a fresh
 *     instance (stateless file-backed store — no identity requirement).
 *
 * Falls back to a 503 handler when hermes or userPortStore is absent (headless
 * / CI builds where Hermes is not configured). */
function buildSessionsHandler(services: GatewayServices): (req: Request) => Promise<Response> {
  if (!services.hermes || !services.userPortStore) {
    return async (_req: Request) => new Response("Service Unavailable", { status: 503 });
  }
  const pluginDeps: PerUserPluginDeps = {
    hermes: services.hermes,
    userPortStore: services.userPortStore,
    acpWireRegistry: services.acpWireRegistry,
    hermesApiKey: services.hermesApiKey,
    timeoutMs: services.sessions.hermes_http_timeout_ms,
    acpOpenTimeoutMs: services.hermes.acp_wire.open_timeout_ms,
  };
  const userDataRoot = expandHome(services.sessions.user_data_root);
  return createSessionsHttpHandler({
    tokens: services.auth.tokens,
    resolvePluginClient: (userId) => resolvePluginClientForUser(userId, pluginDeps),
    listSessions: (userId) => listSessionsForUser(userId, pluginDeps),
    resolveTitleStore: (userId) => createTitleStore({ userDataRoot, userId }),
  });
}

// TODO(cleanup): dedup expandHome into a shared gateway/src/util path helper (also in ws-session-configure.ts).
/** Expands a leading `~` to the OS home directory. Absolute and env-derived
 *  paths are returned unchanged. */
function expandHome(rawPath: string): string {
  if (rawPath === "~") return homedir();
  if (rawPath.startsWith("~/")) return `${homedir()}/${rawPath.slice(2)}`;
  return rawPath;
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
    userPortStore: services.userPortStore ?? makeThrowProxy("UserPortStore"),
  };
}
