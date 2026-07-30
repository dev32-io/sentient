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
    handleDownloads: nullStatic,
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
    handleVoices: fallthrough,
    handleDiagnostics: fallthrough,
    handleStatic: nullStatic,
    ...overrides,
  };
}

describe("createApiRouter — voices route dispatch", () => {
  it("routes GET /api/v1/voices to handleVoices", async () => {
    const handleVoices = vi.fn().mockResolvedValue(sentinel);
    const router = createApiRouter(makeDeps({ handleVoices }));
    const res = await router(new Request("http://host/api/v1/voices"));
    expect(handleVoices).toHaveBeenCalledOnce();
    expect(res?.status).toBe(200);
  });

  it("routes DELETE /api/v1/voices/<id> to handleVoices", async () => {
    const handleVoices = vi.fn().mockResolvedValue(sentinel);
    const router = createApiRouter(makeDeps({ handleVoices }));
    await router(new Request("http://host/api/v1/voices/abc123", { method: "DELETE" }));
    expect(handleVoices).toHaveBeenCalledOnce();
  });

  it("does NOT route /api/v1/providers/ to handleVoices", async () => {
    const handleVoices = vi.fn().mockResolvedValue(sentinel);
    const handleProviders = vi.fn().mockResolvedValue(new Response("providers", { status: 200 }));
    const router = createApiRouter(makeDeps({ handleVoices, handleProviders }));
    await router(new Request("http://host/api/v1/providers/models"));
    expect(handleVoices).not.toHaveBeenCalled();
    expect(handleProviders).toHaveBeenCalledOnce();
  });
});
