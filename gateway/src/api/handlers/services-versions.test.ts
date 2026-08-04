import { describe, expect, it } from "vitest";
import type { InstallState, InstallStateData } from "../../admin/install-state.js";
import type { ServiceVersionRecord, SystemOrchestratorService } from "../../system-orchestrator/index.js";
import type { TokenService } from "../../user-auth/token-service.js";
import { createServicesVersionsHandler } from "./services-versions.js";

const VALID_TOKEN = "valid-token";
const INVALID_TOKEN = "invalid-token";

function makeTokens(): Pick<TokenService, "validate"> {
  return {
    validate: async (token) => {
      if (token === VALID_TOKEN) {
        return { ok: true, value: { userId: "test-user", isAdmin: false, issuedAt: 0, expiresAt: 9999999999 } };
      }
      return { ok: false, error: "signature-invalid" };
    },
  };
}

function makeState(overrides: Partial<InstallStateData> = {}): InstallStateData {
  return {
    schema_version: "1.0.0",
    installed_version: "1.0.0",
    last_upgraded_from: null,
    last_upgraded_at: null,
    bootstrap_complete: true,
    wizard_cursor: "finish",
    unlock_verified: true,
    ...overrides,
  };
}

function makeInstallState(data: InstallStateData): InstallState {
  return {
    load: async () => data,
    advanceCursor: async () => ({ ok: true, value: undefined }),
    retreatCursor: async () => ({ ok: true, value: undefined }),
    setUnlockVerified: async () => ({ ok: true, value: undefined }),
    finish: async () => ({ ok: true, value: undefined }),
  };
}

function makeOrchestrator(versions: ServiceVersionRecord): SystemOrchestratorService {
  return {
    registry: new Map(),
    applyAll: async () => ({ state: "ready", services: [], startedAt: null, finishedAt: null }),
    applySubset: async () => ({ state: "ready", services: [], startedAt: null, finishedAt: null }),
    getStatus: () => ({ state: "ready", services: [], startedAt: null, finishedAt: null }),
    reconcile: async () => ({ state: "ready", services: [], startedAt: null, finishedAt: null }),
    reconcileInfraOnly: async () => ({ state: "ready", services: [], startedAt: null, finishedAt: null }),
    stopHealthWatch: () => {},
    getRequiredServicesStatus: async () => versions,
  };
}

function makeRequest(opts: { method?: string; token?: string | null } = {}): Request {
  const { method = "GET", token } = opts;
  const headers = new Headers();
  if (token != null) headers.set("authorization", `Bearer ${token}`);
  return new Request("http://localhost/api/v1/services/versions", { method, headers });
}

const DEFAULT_VERSIONS: ServiceVersionRecord = {
  gateway: "1.2.3",
  hermes: "v2026.4.23",
  stt_service: "0.9.0",
  tts_service: "1.0.0",
};
const GATEWAY_VERSION = "1.2.3";
const HERMES_VERSION_PATH = "/data/supervisor/.versions/hermes";
const STT_HEALTH_URL = "http://sentient-stt-service:8767/health";
const TTS_HEALTH_URL = "http://host.docker.internal:8771/health";

describe("services-versions handler", () => {
  it("rejects request with no Authorization header", async () => {
    const handler = createServicesVersionsHandler({
      installState: makeInstallState(makeState()),
      systemOrchestrator: makeOrchestrator(DEFAULT_VERSIONS),
      gatewayVersion: GATEWAY_VERSION,
      hermesVersionPath: HERMES_VERSION_PATH,
      sttHealthUrl: STT_HEALTH_URL,
      ttsHealthUrl: TTS_HEALTH_URL,
      tokens: makeTokens(),
      fishBrowseEnabled: true,
    });
    const res = await handler(makeRequest({ token: null }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
  });

  it("rejects request with invalid token", async () => {
    const handler = createServicesVersionsHandler({
      installState: makeInstallState(makeState()),
      systemOrchestrator: makeOrchestrator(DEFAULT_VERSIONS),
      gatewayVersion: GATEWAY_VERSION,
      hermesVersionPath: HERMES_VERSION_PATH,
      sttHealthUrl: STT_HEALTH_URL,
      ttsHealthUrl: TTS_HEALTH_URL,
      tokens: makeTokens(),
      fishBrowseEnabled: true,
    });
    const res = await handler(makeRequest({ token: INVALID_TOKEN }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
  });

  it("rejects when bootstrap_complete is false", async () => {
    const handler = createServicesVersionsHandler({
      installState: makeInstallState(makeState({ bootstrap_complete: false })),
      systemOrchestrator: makeOrchestrator(DEFAULT_VERSIONS),
      gatewayVersion: GATEWAY_VERSION,
      hermesVersionPath: HERMES_VERSION_PATH,
      sttHealthUrl: STT_HEALTH_URL,
      ttsHealthUrl: TTS_HEALTH_URL,
      tokens: makeTokens(),
      fishBrowseEnabled: true,
    });
    const res = await handler(makeRequest({ token: VALID_TOKEN }));
    expect(res.status).toBe(412);
    const body = await res.json();
    expect(body.error).toBe("bootstrap-incomplete");
  });

  it("returns versions from orchestrator when authorized and bootstrap complete", async () => {
    const handler = createServicesVersionsHandler({
      installState: makeInstallState(makeState()),
      systemOrchestrator: makeOrchestrator(DEFAULT_VERSIONS),
      gatewayVersion: GATEWAY_VERSION,
      hermesVersionPath: HERMES_VERSION_PATH,
      sttHealthUrl: STT_HEALTH_URL,
      ttsHealthUrl: TTS_HEALTH_URL,
      tokens: makeTokens(),
      fishBrowseEnabled: true,
    });
    const res = await handler(makeRequest({ token: VALID_TOKEN }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      gateway: "1.2.3",
      hermes: "v2026.4.23",
      stt_service: "0.9.0",
      tts_service: "1.0.0",
      features: { fish_browse_enabled: true },
    });
  });

  it("returns features.fish_browse_enabled false when the flag is disabled", async () => {
    const handler = createServicesVersionsHandler({
      installState: makeInstallState(makeState()),
      systemOrchestrator: makeOrchestrator(DEFAULT_VERSIONS),
      gatewayVersion: GATEWAY_VERSION,
      hermesVersionPath: HERMES_VERSION_PATH,
      sttHealthUrl: STT_HEALTH_URL,
      ttsHealthUrl: TTS_HEALTH_URL,
      tokens: makeTokens(),
      fishBrowseEnabled: false,
    });
    const res = await handler(makeRequest({ token: VALID_TOKEN }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.features).toEqual({ fish_browse_enabled: false });
  });

  it("returns fallback versions with gateway-only when orchestrator is null", async () => {
    const handler = createServicesVersionsHandler({
      installState: makeInstallState(makeState()),
      systemOrchestrator: null,
      gatewayVersion: GATEWAY_VERSION,
      hermesVersionPath: HERMES_VERSION_PATH,
      sttHealthUrl: STT_HEALTH_URL,
      ttsHealthUrl: TTS_HEALTH_URL,
      tokens: makeTokens(),
      fishBrowseEnabled: true,
    });
    const res = await handler(makeRequest({ token: VALID_TOKEN }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      gateway: "1.2.3",
      hermes: "unknown",
      stt_service: "unknown",
      tts_service: "unknown",
      features: { fish_browse_enabled: true },
    });
  });

  it("rejects non-GET requests with 405", async () => {
    const handler = createServicesVersionsHandler({
      installState: makeInstallState(makeState()),
      systemOrchestrator: makeOrchestrator(DEFAULT_VERSIONS),
      gatewayVersion: GATEWAY_VERSION,
      hermesVersionPath: HERMES_VERSION_PATH,
      sttHealthUrl: STT_HEALTH_URL,
      ttsHealthUrl: TTS_HEALTH_URL,
      tokens: makeTokens(),
      fishBrowseEnabled: true,
    });
    const res = await handler(makeRequest({ method: "POST", token: VALID_TOKEN }));
    expect(res.status).toBe(405);
  });
});
