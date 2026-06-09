import { describe, expect, it, vi } from "vitest";
import { type ApiRouterDeps, createApiRouter } from "./router.js";

// ---------------------------------------------------------------------------
// Minimal stub for each dep slot — only the dep under test returns a real
// response; everything else returns 200 "ok" so dispatch assertions are clear.
// ---------------------------------------------------------------------------

const sentinel = new Response("sentinel", { status: 200 });
const fallthrough = async (_req: Request) => new Response("ok", { status: 200 });
const nullStatic = async (_req: Request) => null as Response | null;

function makeDeps(overrides: Partial<ApiRouterDeps> = {}): ApiRouterDeps {
  return {
    handleHealth: fallthrough,
    handleReady: fallthrough,
    handleWsUpgrade: (_req) => undefined,
    handleAdmin: fallthrough,
    handleSecrets: fallthrough,
    handleAuth: fallthrough,
    handleProfile: fallthrough,
    handleProviders: fallthrough,
    handleMcpCatalog: fallthrough,
    handleInstallState: fallthrough,
    handleServicesVersions: fallthrough,
    handleWizard: fallthrough,
    handleSystemStatus: fallthrough,
    handleApply: fallthrough,
    handleDevices: fallthrough,
    handleSessions: fallthrough,
    handleStatic: nullStatic,
    ...overrides,
  };
}

describe("createApiRouter — sessions route dispatch", () => {
  it("routes GET /api/v1/sessions to handleSessions", async () => {
    const handleSessions = vi.fn().mockResolvedValue(sentinel);
    const router = createApiRouter(makeDeps({ handleSessions }));
    const res = await router(new Request("http://host/api/v1/sessions"));
    expect(handleSessions).toHaveBeenCalledOnce();
    expect(res?.status).toBe(200);
  });

  it("routes GET /api/v1/sessions/search to handleSessions", async () => {
    const handleSessions = vi.fn().mockResolvedValue(sentinel);
    const router = createApiRouter(makeDeps({ handleSessions }));
    await router(new Request("http://host/api/v1/sessions/search?q=hi"));
    expect(handleSessions).toHaveBeenCalledOnce();
  });

  it("routes GET /api/v1/sessions/<id>/messages to handleSessions", async () => {
    const handleSessions = vi.fn().mockResolvedValue(sentinel);
    const router = createApiRouter(makeDeps({ handleSessions }));
    await router(new Request("http://host/api/v1/sessions/abc-123/messages"));
    expect(handleSessions).toHaveBeenCalledOnce();
  });

  it("routes DELETE /api/v1/sessions/<id> to handleSessions", async () => {
    const handleSessions = vi.fn().mockResolvedValue(sentinel);
    const router = createApiRouter(makeDeps({ handleSessions }));
    await router(new Request("http://host/api/v1/sessions/abc-123", { method: "DELETE" }));
    expect(handleSessions).toHaveBeenCalledOnce();
  });

  it("routes PATCH /api/v1/sessions/<id> to handleSessions", async () => {
    const handleSessions = vi.fn().mockResolvedValue(sentinel);
    const router = createApiRouter(makeDeps({ handleSessions }));
    await router(new Request("http://host/api/v1/sessions/s-1", { method: "PATCH" }));
    expect(handleSessions).toHaveBeenCalledOnce();
  });

  it("does NOT route /api/v1/health to handleSessions", async () => {
    const handleSessions = vi.fn().mockResolvedValue(sentinel);
    const handleHealth = vi.fn().mockResolvedValue(new Response("health", { status: 200 }));
    const router = createApiRouter(makeDeps({ handleSessions, handleHealth }));
    await router(new Request("http://host/api/v1/health"));
    expect(handleSessions).not.toHaveBeenCalled();
    expect(handleHealth).toHaveBeenCalledOnce();
  });
});
