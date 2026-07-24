const HTTP_NOT_FOUND = 404;
const API_V1 = "/api/v1";

export interface ApiRouterDeps {
  /** Serves the public /download/* page + artifacts. Returns null when the
   *  path is not under /download so normal routing proceeds. Public — no gate. */
  handleDownloads: (request: Request) => Promise<Response | null>;
  handleHealth: (request: Request) => Promise<Response>;
  handleReady: (request: Request) => Promise<Response>;
  /** Attempts WebSocket upgrade. Returns undefined on success — Bun's
   *  contract is that fetch must return undefined once server.upgrade()
   *  has taken over the socket. Returns a Response on upgrade failure. */
  handleWsUpgrade: (request: Request) => Response | undefined;
  /** Handles every `/api/v1/admin/*` path. Applies its own auth gate. */
  handleAdmin: (request: Request) => Promise<Response>;
  /** Handles every `/api/v1/admin/secrets*` path. Never-echo contract, requires bootstrap_complete. */
  handleSecrets: (request: Request) => Promise<Response>;
  /** Handles every `/api/v1/auth/*` path. Public endpoints — no global gate. */
  handleAuth: (request: Request) => Promise<Response>;
  /** Handles every `/api/v1/profile/*` path. Bearer auth applied per route. */
  handleProfile: (request: Request) => Promise<Response>;
  /** Handles every `/api/v1/providers/*` path. Bearer auth applied per route. */
  handleProviders: (request: Request) => Promise<Response>;
  /** Handles `/api/v1/mcp-catalog`. Bearer auth applied per route. */
  handleMcpCatalog: (request: Request) => Promise<Response>;
  /** Handles `GET /api/v1/install-state`. Public — no auth gate. */
  handleInstallState: (request: Request) => Promise<Response>;
  /** Handles `GET /api/v1/services/versions`. Requires bearer auth + bootstrap_complete. */
  handleServicesVersions: (request: Request) => Promise<Response>;
  /** Handles every `/api/v1/wizard/*` path. Mixed auth — unlock is public; others require unlock_verified. */
  handleWizard: (request: Request) => Promise<Response>;
  /** Handles `GET /api/v1/system/apply-status`. Public — no auth gate. */
  handleSystemStatus: (request: Request) => Promise<Response>;
  /** Handles `POST /api/v1/apply`. Bearer auth + RBAC applied per body. */
  handleApply: (request: Request) => Promise<Response>;
  /** Handles every `/api/v1/devices/*` path. Bearer auth applied per route. */
  handleDevices: (request: Request) => Promise<Response>;
  /** Handles every `/api/v1/voices*` path. Bearer auth per route. */
  handleVoices: (request: Request) => Promise<Response>;
  /** Handles `POST /api/v1/diagnostics/logs`. Bearer auth applied per route. */
  handleDiagnostics: (request: Request) => Promise<Response>;
  /** Serves a static file or the SPA fallback. Returns null when the path
   *  is unambiguously an API path that the static handler must not claim. */
  handleStatic: (request: Request) => Promise<Response | null>;
}

export type ApiRouter = (request: Request) => Promise<Response | undefined>;

export function createApiRouter(deps: ApiRouterDeps): ApiRouter {
  return async (request) => {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const downloadResponse = await deps.handleDownloads(request);
    if (downloadResponse) return downloadResponse;

    if (pathname.startsWith(`${API_V1}/admin/secrets`)) return deps.handleSecrets(request);
    if (pathname.startsWith(`${API_V1}/admin/`)) return deps.handleAdmin(request);
    if (pathname.startsWith(`${API_V1}/auth/`)) return deps.handleAuth(request);
    if (pathname.startsWith(`${API_V1}/profile/`)) return deps.handleProfile(request);
    if (pathname.startsWith(`${API_V1}/providers/`)) return deps.handleProviders(request);
    if (pathname.startsWith(`${API_V1}/wizard/`)) return deps.handleWizard(request);
    if (pathname === `${API_V1}/mcp-catalog`) return deps.handleMcpCatalog(request);
    if (pathname === `${API_V1}/install-state`) return deps.handleInstallState(request);
    if (pathname === `${API_V1}/services/versions`) return deps.handleServicesVersions(request);
    if (pathname === `${API_V1}/system/apply-status`) return deps.handleSystemStatus(request);
    if (pathname === `${API_V1}/apply`) return deps.handleApply(request);
    if (pathname.startsWith(`${API_V1}/devices`)) return deps.handleDevices(request);
    if (pathname.startsWith(`${API_V1}/voices`)) return deps.handleVoices(request);
    if (pathname.startsWith(`${API_V1}/diagnostics`)) return deps.handleDiagnostics(request);
    if (pathname === `${API_V1}/health`) return deps.handleHealth(request);
    if (pathname === `${API_V1}/ready`) return deps.handleReady(request);
    if (pathname === `${API_V1}/ws`) return deps.handleWsUpgrade(request);

    const staticResponse = await deps.handleStatic(request);
    if (staticResponse) return staticResponse;

    return new Response("Not Found", { status: HTTP_NOT_FOUND });
  };
}
