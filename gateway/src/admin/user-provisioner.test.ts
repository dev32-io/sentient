import type { Result } from "@sentient/protocol";
import { describe, expect, it } from "vitest";
import type { ProfileStore } from "../profile-store/profile-store.js";
import { PROFILE_SCHEMA_VERSION, type ProfileV1 } from "../profile-store/profile-types.js";
import type { UserRecord } from "../user-auth/types.js";
import type { UserStore } from "../user-auth/user-store.js";
import type { SupervisordControl, SupervisordError, UpsertInput } from "./supervisord-control.js";
import type { UserPortBinding, UserPortStore } from "./user-port-store.js";
import type { UserProvisioner, UserProvisionerDeps, UserSummary } from "./user-provisioner.js";
import { createUserProvisioner } from "./user-provisioner.js";

const ADMIN = "u_aaaaaaaa";
const OTHER = "u_bbbbbbbb";
const NEW_ID = "u_cccccccc";
const PORT_BASE = 8650;

type CallLog = { method: string; args: unknown[] };

function ok<T>(value: T): Result<T, never> {
  return { ok: true, value } as Result<T, never>;
}
const okVoid = ok(undefined);

function err<E>(error: E): Result<never, E> {
  return { ok: false, error } as Result<never, E>;
}

interface MockDeps {
  callLog: CallLog[];
  userStore: UserStore;
  profileStore: ProfileStore;
  userPortStore: UserPortStore;
  deps: UserProvisionerDeps;
  provisioner: UserProvisioner;
}

interface Overrides {
  initialBindings?: UserPortBinding[];
  addResult?: Result<void, "io-error" | "already-exists">;
  bindResult?: Result<UserPortBinding, "io-error" | "corrupt-file" | "port-allocation-failed">;
  saveResult?: Result<void, "io-error" | "validation-error">;
  upsertProgramResult?: Result<void, SupervisordError>;
  removeProgramResult?: Result<void, SupervisordError>;
  listUsers?: Result<UserRecord[], "io-error" | "corrupt-file">;
  resolvePort?: number | null;
  removeResult?: Result<void, "not-found" | "io-error">;
  updateResult?: Result<void, "not-found" | "io-error">;
  archiveResult?: Result<void, "io-error">;
  removeProfileResult?: Result<void, "not-found" | "io-error">;
  renderInnerProfileResult?: Result<void, "render-error" | "write-error">;
  bootstrapWorkerResult?: Result<"warm" | "dispatch-failed" | "deferred", "health-timeout">;
}

function buildMocks(overrides?: Overrides): MockDeps {
  const callLog: CallLog[] = [];
  const log = (method: string, ...args: unknown[]) => callLog.push({ method, args });
  const bound: UserPortBinding[] = overrides?.initialBindings ? [...overrides.initialBindings] : [];

  const userStore: UserStore = {
    list: async () => {
      log("userStore.list");
      return overrides?.listUsers ?? ok([SAMPLE_ADMIN, SAMPLE_USER]);
    },
    get: async () => ok(null),
    add: async (rec: UserRecord) => {
      log("userStore.add", rec.userId);
      return overrides?.addResult ?? okVoid;
    },
    update: async (userId: string, patch: Record<string, unknown>) => {
      log("userStore.update", userId, patch);
      return overrides?.updateResult ?? okVoid;
    },
    remove: async (userId: string) => {
      log("userStore.remove", userId);
      return overrides?.removeResult ?? okVoid;
    },
  };

  const profileStore: ProfileStore = {
    get: async () => err("not-found" as const),
    save: async () => {
      log("profileStore.save");
      return overrides?.saveResult ?? okVoid;
    },
    remove: async (userId: string) => {
      log("profileStore.remove", userId);
      return overrides?.removeProfileResult ?? okVoid;
    },
  };

  const userPortStore: UserPortStore = {
    list: async () => ok(bound),
    bind: async (userId: string) => {
      log("userPortStore.bind", userId);
      if (overrides?.bindResult) return overrides.bindResult;
      const used = new Set(bound.map((b) => b.port));
      let port = PORT_BASE;
      while (used.has(port)) port++;
      const binding = { userId, port };
      bound.push(binding);
      return ok(binding);
    },
    unbind: async (userId: string) => {
      log("userPortStore.unbind", userId);
      const idx = bound.findIndex((b) => b.userId === userId);
      if (idx >= 0) bound.splice(idx, 1);
      return okVoid;
    },
    resolvePort: async (userId: string) => {
      log("userPortStore.resolvePort", userId);
      if (overrides && "resolvePort" in overrides) return overrides.resolvePort ?? null;
      return bound.find((b) => b.userId === userId)?.port ?? null;
    },
  };

  const supervisordControl: Pick<SupervisordControl, "upsertProgram" | "removeProgram"> = {
    upsertProgram: async (input: UpsertInput) => {
      log("supervisordControl.upsertProgram", input);
      return overrides?.upsertProgramResult ?? okVoid;
    },
    removeProgram: async (userId: string, _signalPaired: boolean) => {
      log("supervisordControl.removeProgram", userId);
      return overrides?.removeProgramResult ?? okVoid;
    },
  };

  const deps: UserProvisionerDeps = {
    userStore,
    profileStore,
    userPortStore,
    argon2Params: { memoryKb: 4096, iterations: 3, parallelism: 1 },
    hashPin: async () => "$argon2id$mock",
    makeUserId: () => NEW_ID,
    randomAvatarTint: () => "sage" as const,
    now: () => new Date("2026-01-01T00:00:00Z"),
    supervisordControl,
    internalSecrets: { getHermesAuthTokenSync: () => "internal-token-fingerprint" },
    resolveTimezone: () => "America/Los_Angeles",
    resolveHermesHome: (uid) => `/host/data/${uid}`,
    archiveUserDir: async (userId: string) => {
      log("archiveUserDir", userId);
      return overrides?.archiveResult ?? okVoid;
    },
    renderInnerProfile: async (userId: string) => {
      log("renderInnerProfile", userId);
      return overrides?.renderInnerProfileResult ?? okVoid;
    },
    chownUserDirToHermes: async (userId: string) => {
      log("chownUserDirToHermes", userId);
      return okVoid;
    },
    bootstrapWorker: async (userId: string, mode: "strict" | "lazy") => {
      log("bootstrapWorker", userId, mode);
      return overrides?.bootstrapWorkerResult ?? ok("warm" as const);
    },
    userLifecycle: {
      onCreated: () => {},
      onDeleted: () => {},
      emitCreated: async (userId: string) => {
        log("userLifecycle.emitCreated", userId);
      },
      emitDeleted: async (userId: string) => {
        log("userLifecycle.emitDeleted", userId);
      },
    },
  };

  const provisioner = createUserProvisioner(deps);

  return { callLog, userStore, profileStore, userPortStore, deps, provisioner };
}

/** Sample profile used in test fixtures — mirrors what the wizard would supply
 *  in the POST body. userId is overwritten by the provisioner. */
const BRIDGE_PROFILE: ProfileV1 = {
  schemaVersion: PROFILE_SCHEMA_VERSION,
  userId: "", // overwritten by provisioner
  model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
  voice: { provider: "fish-audio", id: "default" },
  audio: { ttsEnabled: true, channel: "voice" as const },
  persona: { template: "default", overrides: "" },
  tools: {
    enabled: { home_assistant: [], gateway: [], music_assistant: [], searxng: [], fetch: [] },
    toolsets: ["memory", "todo", "clarify", "skills", "session_search", "messaging"],
  },
  compression: { threshold: 0.5 },
  advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
};

const SAMPLE_ADMIN: UserRecord = {
  userId: ADMIN,
  displayName: "Admin",
  pinHash: "$argon2id$...",
  isAdmin: true,
  avatarTint: "terra",
  createdAt: "2026-01-01T00:00:00Z",
};

const SAMPLE_USER: UserRecord = {
  userId: OTHER,
  displayName: "Other",
  pinHash: "$argon2id$...",
  isAdmin: false,
  avatarTint: "amber",
  createdAt: "2026-01-01T00:00:00Z",
};

describe("UserProvisioner", () => {
  it("createUser happy — port_base assigned; supervisord.upsertProgram called with port+token+timezone", async () => {
    const { callLog, provisioner } = buildMocks();

    const result = await provisioner.createUser({
      displayName: "New",
      pin: "1234",
      isAdmin: false,
      profile: BRIDGE_PROFILE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary: UserSummary = result.value;
    expect(summary.userId).toBe(NEW_ID);
    expect(summary.port).toBe(PORT_BASE);

    const bindEntry = callLog.find((c) => c.method === "userPortStore.bind");
    expect(bindEntry?.args).toEqual([NEW_ID]);

    const upsertEntry = callLog.find((c) => c.method === "supervisordControl.upsertProgram");
    expect(upsertEntry?.args[0]).toEqual({
      userId: NEW_ID,
      port: PORT_BASE,
      token: "internal-token-fingerprint",
      timezone: "America/Los_Angeles",
      provider: "openrouter",
      hermesHome: `/host/data/${NEW_ID}`,
      signalPaired: false,
    });
  });

  it("createUser allocates next free port for second user", async () => {
    const { callLog, provisioner } = buildMocks({
      initialBindings: [{ userId: ADMIN, port: PORT_BASE }],
    });

    const result = await provisioner.createUser({
      displayName: "New",
      pin: "1234",
      isAdmin: false,
      profile: BRIDGE_PROFILE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.port).toBe(PORT_BASE + 1);

    const upsertEntry = callLog.find((c) => c.method === "supervisordControl.upsertProgram");
    expect((upsertEntry?.args[0] as UpsertInput).port).toBe(PORT_BASE + 1);
  });

  it("createUser save-fails — rollback: unbind + remove (no supervisord interaction)", async () => {
    const { callLog, provisioner } = buildMocks({
      saveResult: err("io-error" as const),
    });

    const result = await provisioner.createUser({
      displayName: "New",
      pin: "1234",
      isAdmin: false,
      profile: BRIDGE_PROFILE,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("io-error");
    expect(callLog.some((c) => c.method === "supervisordControl.upsertProgram")).toBe(false);

    const unbindIdx = callLog.findIndex((c) => c.method === "userPortStore.unbind");
    const removeIdx = callLog.findIndex((c) => c.method === "userStore.remove");
    expect(unbindIdx).toBeLessThan(removeIdx);
    expect(unbindIdx).toBeGreaterThanOrEqual(0);
  });

  it("createUser render-fails — rollback: profile.remove → unbind → user.remove (apply-error); supervisord NOT called", async () => {
    const { callLog, provisioner } = buildMocks({
      renderInnerProfileResult: err("render-error" as const),
    });

    const result = await provisioner.createUser({
      displayName: "New",
      pin: "1234",
      isAdmin: false,
      profile: BRIDGE_PROFILE,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("apply-error");

    expect(callLog.some((c) => c.method === "supervisordControl.upsertProgram")).toBe(false);
    const profileRemoveIdx = callLog.findIndex((c) => c.method === "profileStore.remove");
    const unbindIdx = callLog.findIndex((c) => c.method === "userPortStore.unbind");
    const removeIdx = callLog.findIndex((c) => c.method === "userStore.remove");
    expect(profileRemoveIdx).toBeLessThan(unbindIdx);
    expect(unbindIdx).toBeLessThan(removeIdx);
  });

  it("createUser bootstrapWorker health-timeout — returns worker-not-ready and rollbacks", async () => {
    const { callLog, provisioner } = buildMocks({
      bootstrapWorkerResult: err("health-timeout" as const),
    });

    const result = await provisioner.createUser({
      displayName: "New",
      pin: "1234",
      isAdmin: false,
      profile: BRIDGE_PROFILE,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("worker-not-ready");
    expect(callLog.some((c) => c.method === "bootstrapWorker")).toBe(true);
    // Rollback must have run
    expect(callLog.some((c) => c.method === "userPortStore.unbind")).toBe(true);
    expect(callLog.some((c) => c.method === "userStore.remove")).toBe(true);
  });

  it("createUser bootstrapWorker dispatch-failed — returns worker-not-ready and rollbacks", async () => {
    const { callLog, provisioner } = buildMocks({
      bootstrapWorkerResult: ok("dispatch-failed" as const),
    });

    const result = await provisioner.createUser({
      displayName: "New",
      pin: "1234",
      isAdmin: false,
      profile: BRIDGE_PROFILE,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("worker-not-ready");
    expect(callLog.some((c) => c.method === "bootstrapWorker")).toBe(true);
    // Rollback must have run
    expect(callLog.some((c) => c.method === "userPortStore.unbind")).toBe(true);
    expect(callLog.some((c) => c.method === "userStore.remove")).toBe(true);
  });

  it("createUser order: renderInnerProfile BEFORE supervisord.upsertProgram BEFORE bootstrapWorker", async () => {
    const { callLog, provisioner } = buildMocks();

    await provisioner.createUser({ displayName: "New", pin: "1234", isAdmin: false, profile: BRIDGE_PROFILE });

    const renderIdx = callLog.findIndex((c) => c.method === "renderInnerProfile");
    const upsertIdx = callLog.findIndex((c) => c.method === "supervisordControl.upsertProgram");
    const bootIdx = callLog.findIndex((c) => c.method === "bootstrapWorker");
    expect(renderIdx).toBeGreaterThanOrEqual(0);
    expect(renderIdx).toBeLessThan(upsertIdx);
    expect(upsertIdx).toBeLessThan(bootIdx);
  });

  it("createUser supervisord-fails — rollback: profile.remove → unbind → user.remove (apply-error)", async () => {
    const { callLog, provisioner } = buildMocks({
      upsertProgramResult: err({ kind: "shell-failed", reason: "supervisorctl exit 1" } as SupervisordError),
    });

    const result = await provisioner.createUser({
      displayName: "New",
      pin: "1234",
      isAdmin: false,
      profile: BRIDGE_PROFILE,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("apply-error");

    const profileRemoveIdx = callLog.findIndex((c) => c.method === "profileStore.remove");
    const unbindIdx = callLog.findIndex((c) => c.method === "userPortStore.unbind");
    const removeIdx = callLog.findIndex((c) => c.method === "userStore.remove");
    expect(profileRemoveIdx).toBeLessThan(unbindIdx);
    expect(unbindIdx).toBeLessThan(removeIdx);
  });

  it("deleteUser happy — calls supervisordControl.removeProgram(userId) after archive", async () => {
    const { callLog, provisioner } = buildMocks({
      initialBindings: [{ userId: OTHER, port: PORT_BASE + 1 }],
    });

    const result = await provisioner.deleteUser(OTHER);

    expect(result.ok).toBe(true);
    const archiveIdx = callLog.findIndex((c) => c.method === "archiveUserDir");
    const removeProgramIdx = callLog.findIndex((c) => c.method === "supervisordControl.removeProgram");
    expect(archiveIdx).toBeLessThan(removeProgramIdx);
    const removeProgramEntry = callLog.find((c) => c.method === "supervisordControl.removeProgram");
    expect(removeProgramEntry?.args[0]).toBe(OTHER);
  });

  it("deleteUser succeeds even when supervisord.removeProgram fails (best-effort)", async () => {
    const { provisioner } = buildMocks({
      initialBindings: [{ userId: OTHER, port: PORT_BASE + 1 }],
      removeProgramResult: err({ kind: "shell-failed", reason: "container down" } as SupervisordError),
    });

    const result = await provisioner.deleteUser(OTHER);

    expect(result.ok).toBe(true);
  });

  it("deleteUser 404 — resolvePort returns null; supervisord.removeProgram never called", async () => {
    const { callLog, provisioner } = buildMocks({ resolvePort: null });

    const result = await provisioner.deleteUser(OTHER);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("not-found");
    expect(callLog.some((c) => c.method === "supervisordControl.removeProgram")).toBe(false);
  });

  it("deleteUser last-admin — guard trips before archive/removeProgram", async () => {
    const { callLog, provisioner } = buildMocks({
      listUsers: ok([SAMPLE_ADMIN]),
      resolvePort: PORT_BASE,
    });

    const result = await provisioner.deleteUser(ADMIN);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("last-admin");
    expect(callLog.some((c) => c.method === "supervisordControl.removeProgram")).toBe(false);
  });

  it("setIsAdmin demote-only-admin — returns 422 last-admin", async () => {
    const { provisioner } = buildMocks({ listUsers: ok([SAMPLE_ADMIN]) });
    const result = await provisioner.setIsAdmin(ADMIN, false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("last-admin");
  });

  it("rejects malformed userId at boundary", async () => {
    const { provisioner } = buildMocks();
    await expect(provisioner.deleteUser("admin")).rejects.toThrow(/invalid userId/);
  });
});
