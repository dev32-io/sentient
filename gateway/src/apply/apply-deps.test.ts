import type { ApplyConfig, HermesConfig } from "@sentient/config";
import { describe, expect, it, vi } from "vitest";
import type { InternalSecretsStore } from "../admin/internal-secrets-store.ts";
import type { SupervisordControl, UpsertInput } from "../admin/supervisord-control.ts";
import type { UserPortStore } from "../admin/user-port-store.ts";
import type { ProfileV1 } from "../profile-store/profile-types.ts";
import { type ApplyDepsServices, createApplyDeps } from "./apply-deps.ts";

const APPLY_CONFIG: ApplyConfig = {
  docker_restart_timeout_ms: 30000,
  health_check_timeout_ms: 30000,
  health_poll_interval_ms: 1000,
  profile_restart_timeout_ms: 30000,
  profile_restart_poll_interval_ms: 250,
};

const FAKE_TOKEN = "a".repeat(64);
const FAKE_SEARXNG_SECRET = "b".repeat(64);
const ALICE = "u_aaaaaaaa";
const GHOST = "u_99999999";

function makeInternalSecretsStore(token = FAKE_TOKEN): InternalSecretsStore {
  return {
    loadOrInit: async () => ({ ok: true, value: { hermesAuthToken: token, searxngSecret: FAKE_SEARXNG_SECRET } }),
    getHermesAuthTokenSync: () => token,
    getSearxngSecretSync: () => FAKE_SEARXNG_SECRET,
  };
}

function makeUserPortStore(bindings: Map<string, number>): UserPortStore {
  return {
    list: async () => ({ ok: true, value: [...bindings].map(([userId, port]) => ({ userId, port })) }),
    bind: async (userId: string) => ({ ok: true, value: { userId, port: 8650 + bindings.size } }),
    unbind: async () => ({ ok: true, value: undefined }),
    resolvePort: async (userId: string) => bindings.get(userId) ?? null,
  };
}

function fullHermes(): HermesConfig {
  return {
    worker: {
      container_name: "sentient-hermes",
      url_template: "http://sentient-hermes:{port}",
      port_base: 8650,
    },
  } as unknown as HermesConfig;
}

function makeServices(hermes: HermesConfig | null, userPortStore: UserPortStore | null = null): ApplyDepsServices {
  return {
    applyConfig: APPLY_CONFIG,
    hermes,
    userPortStore,
    internalSecretsStore: makeInternalSecretsStore(),
    profileStore: {} as ApplyDepsServices["profileStore"],
    templateLoader: {
      loadOrBuiltinDefault: async () => ({ ok: true, value: "tpl" }),
    } as unknown as ApplyDepsServices["templateLoader"],
    healthPoller: {} as ApplyDepsServices["healthPoller"],
    sessionRouter: {} as ApplyDepsServices["sessionRouter"],
    supervisordControl: {
      restartProfile: async () => ({ ok: true, value: undefined }),
      upsertProgram: async () => ({ ok: true, value: undefined }),
    },
    resolveTimezone: () => "UTC",
    resolveHermesHome: (userId: string) => `/data/profiles/${userId}`,
    mcpCatalog: {},
    secretsStore: null,
  };
}

describe("createApplyDeps", () => {
  it("resolves container name from worker template", async () => {
    const deps = createApplyDeps(makeServices(fullHermes()));
    await expect(deps.resolveContainerName(ALICE)).resolves.toBe("sentient-hermes");
  });

  it("falls back to hermes-<userId> when hermes config is missing", async () => {
    const deps = createApplyDeps(makeServices(null));
    await expect(deps.resolveContainerName(GHOST)).resolves.toBe(`hermes-${GHOST}`);
  });

  it("resolves health URL from worker template + port store", async () => {
    const portStore = makeUserPortStore(new Map([[ALICE, 8650]]));
    const deps = createApplyDeps(makeServices(fullHermes(), portStore));
    await expect(deps.resolveHealthUrl(ALICE)).resolves.toBe("http://sentient-hermes:8650/health");
  });

  it("returns Authorization header with internal token when hermes present", async () => {
    const token = "b".repeat(64);
    const services = { ...makeServices(fullHermes()), internalSecretsStore: makeInternalSecretsStore(token) };
    const deps = createApplyDeps(services);
    await expect(deps.resolveHealthHeaders(ALICE)).resolves.toEqual({ Authorization: `Bearer ${token}` });
  });

  it("returns empty headers when hermes config is missing", async () => {
    const deps = createApplyDeps(makeServices(null));
    await expect(deps.resolveHealthHeaders(GHOST)).resolves.toEqual({});
  });

  it("maps applyConfig snake_case fields to orchestrator camelCase", () => {
    const deps = createApplyDeps(makeServices(null));
    expect(deps.config).toEqual({
      dockerRestartTimeoutMs: 30000,
      healthCheckTimeoutMs: 30000,
      healthPollIntervalMs: 1000,
    });
  });

  describe("refreshProgramEnv", () => {
    function profileWith(provider: ProfileV1["model"]["provider"]): ProfileV1 {
      return {
        schemaVersion: 1,
        userId: ALICE,
        model: { provider, id: "test-model" },
        voice: { provider: "local-tts", id: "voice-x" },
        audio: { ttsEnabled: true, channel: "voice" },
        persona: { template: "default", overrides: "" },
        tools: { enabled: {} },
        compression: { threshold: 0.5 },
        advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
      };
    }

    function servicesForRefresh(provider: ProfileV1["model"]["provider"], upsert: SupervisordControl["upsertProgram"]) {
      const portStore = makeUserPortStore(new Map([[ALICE, 8650]]));
      const profile = profileWith(provider);
      const base = makeServices(fullHermes(), portStore);
      return {
        ...base,
        profileStore: {
          get: vi.fn(async () => ({ ok: true as const, value: profile })),
          save: vi.fn(),
          remove: vi.fn(),
        } as unknown as ApplyDepsServices["profileStore"],
        supervisordControl: {
          restartProfile: async () => ({ ok: true as const, value: undefined }),
          upsertProgram: upsert,
        },
      };
    }

    it("calls supervisordControl.upsertProgram with the active provider from the profile", async () => {
      const upsert = vi.fn(async (_input: UpsertInput) => ({ ok: true as const, value: undefined }));
      const deps = createApplyDeps(servicesForRefresh("openrouter", upsert));

      const result = await deps.refreshProgramEnv(ALICE);

      expect(result.ok).toBe(true);
      expect(upsert).toHaveBeenCalledTimes(1);
      const arg = upsert.mock.calls[0]?.[0];
      expect(arg).toMatchObject({
        userId: ALICE,
        port: 8650,
        provider: "openrouter",
        timezone: "UTC",
        hermesHome: `/data/profiles/${ALICE}`,
        signalPaired: false,
      });
    });

    it("returns docker-restart-failed when upsertProgram fails", async () => {
      const upsert = vi.fn(async (_input: UpsertInput) => ({
        ok: false as const,
        error: { kind: "shell-failed" as const, reason: "supervisorctl-busy" },
      }));
      const deps = createApplyDeps(servicesForRefresh("openrouter", upsert));

      const result = await deps.refreshProgramEnv(ALICE);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("docker-restart-failed");
    });

    it("is a no-op when hermes config is missing (headless mode)", async () => {
      const deps = createApplyDeps(makeServices(null));
      const result = await deps.refreshProgramEnv(ALICE);
      expect(result.ok).toBe(true);
    });
  });
});
