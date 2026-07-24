import type { Result } from "@sentient/protocol";
import { describe, expect, it, vi } from "vitest";
import type { SupervisordControl, SupervisordError } from "../admin/supervisord-control.js";
import type { HealthPollError, HealthPoller } from "../infrastructure/health-poller.js";
import type { RenderedProfile } from "../profile-store/profile-renderer.js";
import type { ProfileStore, ProfileStoreError } from "../profile-store/profile-store.js";
import type { ProfileV1 } from "../profile-store/profile-types.js";
import type { TemplateError } from "../profile-store/template-loader.js";
import type { SessionRouter } from "../session-router.js";
import { type ApplyDeps, type ApplyError, runApply } from "./orchestrator.js";

function sampleProfile(userId = "alice"): ProfileV1 {
  return {
    schemaVersion: 1,
    userId,
    model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
    voice: { provider: "local-tts", id: "voice-abc" },
    audio: { ttsEnabled: true, channel: "voice" as const },
    persona: { template: "default", overrides: "" },
    tools: { enabled: {} },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
  };
}

function rendered(): RenderedProfile {
  return { soulMarkdown: "# alice\n", hermesConfigYaml: "model: {}\n" };
}

function makeProfileStore(profile: ProfileV1 = sampleProfile()): ProfileStore {
  const ok: Result<ProfileV1, ProfileStoreError> = { ok: true, value: profile };
  const okVoid: Result<void, ProfileStoreError> = { ok: true, value: undefined };
  return {
    get: vi.fn(async () => ok),
    save: vi.fn(async () => okVoid),
    remove: vi.fn(async () => okVoid),
  };
}

function makeSessionRouter(): SessionRouter {
  return {
    bind: vi.fn(),
    release: vi.fn(),
    get: vi.fn(),
    findActiveSessionFor: vi.fn(),
  } as unknown as SessionRouter;
}

function makeHealthPoller(pollResult: Result<void, HealthPollError> = { ok: true, value: undefined }): HealthPoller {
  return {
    pollUntilHealthy: vi.fn(async () => pollResult),
  };
}

function makeSupervisordControl(
  restartResult: Result<void, SupervisordError> = { ok: true, value: undefined },
): Pick<SupervisordControl, "restartProfile"> {
  return {
    restartProfile: vi.fn(async () => restartResult),
  };
}

function makeRefreshProgramEnv(
  result: Result<undefined, ApplyError> = { ok: true, value: undefined },
): (userId: string) => Promise<Result<undefined, ApplyError>> {
  return vi.fn(async () => result);
}

function makeDeps(overrides: Partial<ApplyDeps> = {}): ApplyDeps {
  const profileStore = overrides.profileStore ?? makeProfileStore();
  const sessionRouter = overrides.sessionRouter ?? makeSessionRouter();
  const healthPoller = overrides.healthPoller ?? makeHealthPoller();
  return {
    profileStore,
    sessionRouter,
    healthPoller,
    renderProfile: overrides.renderProfile ?? vi.fn(() => rendered()),
    writeRendered: overrides.writeRendered ?? vi.fn(async () => {}),
    loadTemplate:
      overrides.loadTemplate ??
      (vi.fn(async () => ({ ok: true, value: "template-body" })) as () => Promise<Result<string, TemplateError>>),
    resolveContainerName: overrides.resolveContainerName ?? vi.fn(async () => "sentient-hermes"),
    resolveHealthUrl: overrides.resolveHealthUrl ?? vi.fn(async () => "http://localhost:9999/health"),
    resolveHealthHeaders: overrides.resolveHealthHeaders ?? vi.fn(async () => ({ Authorization: "Bearer x" })),
    supervisordControl: overrides.supervisordControl ?? makeSupervisordControl(),
    refreshProgramEnv: overrides.refreshProgramEnv ?? makeRefreshProgramEnv(),
    config: overrides.config ?? {
      dockerRestartTimeoutMs: 1000,
      healthCheckTimeoutMs: 1000,
      healthPollIntervalMs: 50,
    },
  };
}

describe("runApply", () => {
  it("returns ready and calls each dependency once on the happy path", async () => {
    const deps = makeDeps();
    const result = await runApply(deps, "alice");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe("ready");
    expect(result.value.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(deps.profileStore.get).toHaveBeenCalledWith("alice");
    expect(deps.supervisordControl.restartProfile).toHaveBeenCalledWith("alice", 1000, false);
    expect(deps.healthPoller.pollUntilHealthy).toHaveBeenCalledTimes(1);
  });

  it("returns user-not-found when profileStore.get fails", async () => {
    const profileStore = makeProfileStore();
    profileStore.get = vi.fn(async () => ({ ok: false as const, error: "not-found" as const }));
    const deps = makeDeps({ profileStore });

    const result = await runApply(deps, "ghost");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("user-not-found");
    expect(deps.supervisordControl.restartProfile).not.toHaveBeenCalled();
  });

  it("returns render-error when loadTemplate fails", async () => {
    const loadTemplate: () => Promise<Result<string, TemplateError>> = async () => ({
      ok: false,
      error: "not-found",
    });
    const deps = makeDeps({ loadTemplate });

    const result = await runApply(deps, "alice");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("render-error");
    expect(deps.supervisordControl.restartProfile).not.toHaveBeenCalled();
  });

  it("returns render-error when renderProfile throws", async () => {
    const renderProfile = vi.fn(() => {
      throw new Error("template syntax broken");
    });
    const deps = makeDeps({ renderProfile });

    const result = await runApply(deps, "alice");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("render-error");
    expect(deps.supervisordControl.restartProfile).not.toHaveBeenCalled();
  });

  it("returns write-error when writeRendered throws", async () => {
    const writeRendered = vi.fn(async () => {
      throw new Error("EACCES");
    });
    const deps = makeDeps({ writeRendered });

    const result = await runApply(deps, "alice");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("write-error");
    expect(deps.supervisordControl.restartProfile).not.toHaveBeenCalled();
  });

  it("returns docker-restart-failed when supervisord.restartProfile fails", async () => {
    const supervisordControl = makeSupervisordControl({
      ok: false,
      error: { kind: "shell-failed", reason: "non-zero-exit" },
    });
    const deps = makeDeps({ supervisordControl });

    const result = await runApply(deps, "alice");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("docker-restart-failed");
    expect(deps.healthPoller.pollUntilHealthy).not.toHaveBeenCalled();
  });

  it("returns health-check-timeout when poller times out", async () => {
    const healthPoller = makeHealthPoller({
      ok: false,
      error: { kind: "timeout", afterMs: 1000 },
    });
    const deps = makeDeps({ healthPoller });

    const result = await runApply(deps, "alice");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("health-check-timeout");
  });

  it("calls refreshProgramEnv BEFORE supervisord.restartProfile (so the env block is current before restart)", async () => {
    const order: string[] = [];
    const refreshProgramEnv = vi.fn(async () => {
      order.push("refresh");
      return { ok: true as const, value: undefined };
    });
    const supervisordControl: Pick<SupervisordControl, "restartProfile"> = {
      restartProfile: vi.fn(async (_userId, _timeoutMs, _signalPaired) => {
        order.push("restart");
        return { ok: true as const, value: undefined };
      }),
    };
    const deps = makeDeps({ refreshProgramEnv, supervisordControl });

    const result = await runApply(deps, "alice");

    expect(result.ok).toBe(true);
    expect(order).toEqual(["refresh", "restart"]);
  });

  it("returns docker-restart-failed and skips restart when refreshProgramEnv fails", async () => {
    const refreshProgramEnv = makeRefreshProgramEnv({
      ok: false,
      error: { kind: "docker-restart-failed", reason: "upsert-failed" },
    });
    const supervisordControl = makeSupervisordControl();
    const deps = makeDeps({ refreshProgramEnv, supervisordControl });

    const result = await runApply(deps, "alice");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("docker-restart-failed");
    expect(supervisordControl.restartProfile).not.toHaveBeenCalled();
  });
});
