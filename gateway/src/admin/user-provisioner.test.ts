import type { Result } from "@sentient/protocol";
import { describe, expect, it } from "vitest";
import type { ProfileStore } from "../profile-store/profile-store.js";
import { PROFILE_SCHEMA_VERSION, type ProfileV1 } from "../profile-store/profile-types.js";
import type { UserRecord } from "../user-auth/types.js";
import type { UserStore } from "../user-auth/user-store.js";
import type { UserProvisioner, UserProvisionerDeps, UserSummary } from "./user-provisioner.js";
import { createUserProvisioner } from "./user-provisioner.js";

const ADMIN = "u_aaaaaaaa";
const OTHER = "u_bbbbbbbb";
const NEW_ID = "u_cccccccc";

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
  deps: UserProvisionerDeps;
  provisioner: UserProvisioner;
}

interface Overrides {
  addResult?: Result<void, "io-error" | "already-exists">;
  saveResult?: Result<void, "io-error" | "validation-error">;
  listUsers?: Result<UserRecord[], "io-error" | "corrupt-file">;
  removeResult?: Result<void, "not-found" | "io-error">;
  updateResult?: Result<void, "not-found" | "io-error">;
  archiveResult?: Result<void, "io-error">;
  removeProfileResult?: Result<void, "not-found" | "io-error">;
  renderInnerProfileResult?: Result<void, "render-error" | "write-error">;
  createHermesProfileResult?: Result<void, "cli-error">;
}

/** Sample profile used in test fixtures — mirrors what the wizard would supply
 *  in the POST body. userId is overwritten by the provisioner. */
const BRIDGE_PROFILE: ProfileV1 = {
  schemaVersion: PROFILE_SCHEMA_VERSION,
  userId: "", // overwritten by provisioner
  model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
  voice: { provider: "local-tts", id: "default" },
  audio: { ttsEnabled: true, channel: "voice" as const },
  persona: { template: "default", overrides: "" },
  tools: {
    permissions: { home_assistant: {}, gateway: {}, music_assistant: {}, searxng: {}, fetch: {} },
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

function buildMocks(overrides?: Overrides): MockDeps {
  const callLog: CallLog[] = [];
  const log = (method: string, ...args: unknown[]) => callLog.push({ method, args });

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

  const deps: UserProvisionerDeps = {
    userStore,
    profileStore,
    argon2Params: { memoryKb: 4096, iterations: 3, parallelism: 1 },
    hashPin: async () => "$argon2id$mock",
    makeUserId: () => NEW_ID,
    randomAvatarTint: () => "sage" as const,
    now: () => new Date("2026-01-01T00:00:00Z"),
    archiveUserDir: async (userId: string) => {
      log("archiveUserDir", userId);
      return overrides?.archiveResult ?? okVoid;
    },
    renderInnerProfile: async (userId: string) => {
      log("renderInnerProfile", userId);
      return overrides?.renderInnerProfileResult ?? okVoid;
    },
    createHermesProfile: async (userId: string) => {
      log("createHermesProfile", userId);
      return overrides?.createHermesProfileResult ?? okVoid;
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

  return { callLog, userStore, profileStore, deps, provisioner };
}

describe("UserProvisioner", () => {
  // DELEGATION INVARIANT. `hermes -p <userId>` refuses to run at all until the
  // Hermes CLI has a profile REGISTERED under that name in its own store
  // (~/.hermes/profiles/<userId>) — a different tree from the gateway-side
  // render `renderInnerProfile` writes. The deleted supervisord program spec
  // was the only thing that ever ran `hermes profile create`, and the native
  // cutover removed it without a replacement, so every gateway-provisioned
  // user got `Profile '<userId>' does not exist` on its FIRST delegateTask —
  // for the whole life of the install. See
  // qa/web/evidence/2026-07-30-delegate-hermes-bg/README.md.
  it("createUser registers the user with the hermes CLI before announcing it", async () => {
    const { callLog, provisioner } = buildMocks();

    const result = await provisioner.createUser({
      displayName: "New",
      pin: "1234",
      isAdmin: false,
      profile: BRIDGE_PROFILE,
    });

    expect(result.ok).toBe(true);
    const cliIdx = callLog.findIndex((c) => c.method === "createHermesProfile");
    const emitIdx = callLog.findIndex((c) => c.method === "userLifecycle.emitCreated");
    expect(cliIdx).toBeGreaterThanOrEqual(0);
    expect(callLog[cliIdx]?.args[0]).toBe(NEW_ID);
    expect(cliIdx).toBeLessThan(emitIdx);
  });

  // FAIL-SOFT INVARIANT. Hermes is an OPTIONAL delegated agent, not part of
  // the gateway's own turn loop, and the operator may not have configured it
  // at all. A CLI failure must degrade `delegateTask` for that user, never
  // fail (or roll back) the user creation itself.
  it("createUser still succeeds when the hermes CLI registration fails", async () => {
    const { callLog, provisioner } = buildMocks({
      createHermesProfileResult: err("cli-error" as const),
    });

    const result = await provisioner.createUser({
      displayName: "New",
      pin: "1234",
      isAdmin: false,
      profile: BRIDGE_PROFILE,
    });

    expect(result.ok).toBe(true);
    expect(callLog.some((c) => c.method === "userStore.remove")).toBe(false);
    expect(callLog.some((c) => c.method === "userLifecycle.emitCreated")).toBe(true);
  });

  it("createUser renders the hermes profile BEFORE announcing the user", async () => {
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

    // Order matters: emitCreated opens this user's gateway-MCP socket, and the
    // profile dir hermes-runner uses as `cwd` must already exist by then.
    const renderIdx = callLog.findIndex((c) => c.method === "renderInnerProfile");
    const emitIdx = callLog.findIndex((c) => c.method === "userLifecycle.emitCreated");
    expect(renderIdx).toBeGreaterThanOrEqual(0);
    expect(renderIdx).toBeLessThan(emitIdx);
  });

  it("createUser save-fails — rolls the user record back and never renders", async () => {
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
    expect(callLog.some((c) => c.method === "renderInnerProfile")).toBe(false);
    expect(callLog.some((c) => c.method === "userStore.remove")).toBe(true);
  });

  it("createUser render-fails — rollback order: profile.remove BEFORE user.remove", async () => {
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

    const profileRemoveIdx = callLog.findIndex((c) => c.method === "profileStore.remove");
    const removeIdx = callLog.findIndex((c) => c.method === "userStore.remove");
    expect(profileRemoveIdx).toBeGreaterThanOrEqual(0);
    expect(profileRemoveIdx).toBeLessThan(removeIdx);
    // A user whose profile never rendered must not be announced as created.
    expect(callLog.some((c) => c.method === "userLifecycle.emitCreated")).toBe(false);
  });

  it("deleteUser archives BEFORE announcing the deletion", async () => {
    const { callLog, provisioner } = buildMocks();

    const result = await provisioner.deleteUser(OTHER);

    expect(result.ok).toBe(true);
    const archiveIdx = callLog.findIndex((c) => c.method === "archiveUserDir");
    const emitIdx = callLog.findIndex((c) => c.method === "userLifecycle.emitDeleted");
    expect(archiveIdx).toBeGreaterThanOrEqual(0);
    expect(archiveIdx).toBeLessThan(emitIdx);
  });

  it("deleteUser unknown userId — not-found, never reaches archive", async () => {
    const { callLog, provisioner } = buildMocks({ listUsers: ok([SAMPLE_ADMIN]) });

    const result = await provisioner.deleteUser(OTHER);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("not-found");
    expect(callLog.some((c) => c.method === "archiveUserDir")).toBe(false);
  });

  it("deleteUser last-admin — guard trips before archive", async () => {
    const { callLog, provisioner } = buildMocks({ listUsers: ok([SAMPLE_ADMIN]) });

    const result = await provisioner.deleteUser(ADMIN);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("last-admin");
    expect(callLog.some((c) => c.method === "archiveUserDir")).toBe(false);
  });

  it("setIsAdmin demote-only-admin — returns last-admin", async () => {
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
