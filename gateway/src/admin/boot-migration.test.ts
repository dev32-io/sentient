import type { Result } from "@sentient/protocol";
import { describe, expect, it } from "vitest";
import { PROFILE_SCHEMA_VERSION, type ProfileV1 } from "../profile-store/profile-types.js";
import type { UserRecord } from "../user-auth/types.js";
import {
  migrateUnboundUsers,
  renderConfigsForExistingUsers,
  renderProgramsForExistingUsers,
} from "./boot-migration.js";
import type { SupervisordError, UpsertInput } from "./supervisord-control.js";
import type { UserPortBinding } from "./user-port-store.js";

const PORT_BASE = 8650;

function ok<T>(value: T): Result<T, never> {
  return { ok: true as const, value };
}

function makeUserStore(users: UserRecord[]) {
  return { list: async () => ok(users) };
}

function makeUserPortStore(initial: UserPortBinding[]) {
  const bound: UserPortBinding[] = [...initial];
  return {
    bound,
    list: async () => ok(bound),
    bind: async (userId: string) => {
      const used = new Set(bound.map((b) => b.port));
      let port = PORT_BASE;
      while (used.has(port)) port++;
      const binding = { userId, port };
      bound.push(binding);
      return { ok: true as const, value: binding };
    },
  };
}

function user(id: string, isAdmin = false): UserRecord {
  return {
    userId: id,
    displayName: id,
    pinHash: "x",
    isAdmin,
    avatarTint: "terra",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

const U1 = "u_11111111";
const U2 = "u_22222222";
const U3 = "u_33333333";

/** Minimal test profile for a given userId. */
function stubProfile(userId: string): ProfileV1 {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION as 1,
    userId,
    model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
    voice: { provider: "fish-audio", id: "default" },
    audio: { ttsEnabled: true, channel: "voice" as const },
    persona: { template: "default", overrides: "" },
    tools: { enabled: {}, toolsets: [] },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
  };
}

function profileMapFor(...userIds: string[]): Map<string, ProfileV1> {
  return new Map(userIds.map((id) => [id, stubProfile(id)]));
}

describe("migrateUnboundUsers", () => {
  it("is a no-op when there are no users", async () => {
    const userStore = makeUserStore([]);
    const userPortStore = makeUserPortStore([]);
    await migrateUnboundUsers({ userStore, userPortStore });
    expect(userPortStore.bound).toEqual([]);
  });

  it("binds one unbound user — assigns port_base", async () => {
    const userStore = makeUserStore([user(U1, true)]);
    const userPortStore = makeUserPortStore([]);
    await migrateUnboundUsers({ userStore, userPortStore });
    expect(userPortStore.bound).toEqual([{ userId: U1, port: PORT_BASE }]);
  });

  it("skips already-bound users and only binds the unbound one", async () => {
    const userStore = makeUserStore([user(U1, true), user(U2)]);
    const userPortStore = makeUserPortStore([{ userId: U1, port: PORT_BASE }]);
    await migrateUnboundUsers({ userStore, userPortStore });
    expect(userPortStore.bound).toEqual([
      { userId: U1, port: PORT_BASE },
      { userId: U2, port: PORT_BASE + 1 },
    ]);
  });
});

interface UpsertCall {
  input: UpsertInput;
}

function makeSupervisord(failures?: Map<string, SupervisordError>) {
  const calls: UpsertCall[] = [];
  return {
    calls,
    supervisordControl: {
      upsertProgram: async (input: UpsertInput) => {
        calls.push({ input });
        const failure = failures?.get(input.userId);
        if (failure) return { ok: false as const, error: failure };
        return { ok: true as const, value: undefined };
      },
    },
  };
}

function makeProfileStore(profiles?: Map<string, ProfileV1>) {
  return {
    get: async (userId: string) => {
      const profile = profiles?.get(userId);
      if (profile) return { ok: true as const, value: profile };
      return { ok: false as const, error: "not-found" as const };
    },
    save: async (_profile: ProfileV1) => ({ ok: true as const, value: undefined }),
  };
}

describe("renderProgramsForExistingUsers", () => {
  it("renders 0 programs when there are no users", async () => {
    const userStore = makeUserStore([]);
    const userPortStore = makeUserPortStore([]);
    const sup = makeSupervisord();
    await renderProgramsForExistingUsers({
      userStore,
      userPortStore,
      supervisordControl: sup.supervisordControl,
      internalSecrets: { getHermesAuthTokenSync: () => "tok" },
      resolveTimezone: () => "UTC",
      profileStore: makeProfileStore(),
      resolveHermesHome: (uid) => `/host/data/${uid}`,
    });
    expect(sup.calls).toHaveLength(0);
  });

  it("renders 3 programs for 3 users — passes port from binding", async () => {
    const userStore = makeUserStore([user(U1), user(U2), user(U3)]);
    const userPortStore = makeUserPortStore([
      { userId: U1, port: PORT_BASE },
      { userId: U2, port: PORT_BASE + 1 },
      { userId: U3, port: PORT_BASE + 2 },
    ]);
    const sup = makeSupervisord();
    await renderProgramsForExistingUsers({
      userStore,
      userPortStore,
      supervisordControl: sup.supervisordControl,
      internalSecrets: { getHermesAuthTokenSync: () => "tok" },
      resolveTimezone: () => "America/Los_Angeles",
      profileStore: makeProfileStore(profileMapFor(U1, U2, U3)),
      resolveHermesHome: (uid) => `/host/data/${uid}`,
    });
    expect(sup.calls).toHaveLength(3);
    expect(sup.calls[0]?.input).toEqual({
      userId: U1,
      port: PORT_BASE,
      token: "tok",
      timezone: "America/Los_Angeles",
      provider: "openrouter",
      hermesHome: `/host/data/${U1}`,
      signalPaired: false,
    });
    expect(sup.calls[2]?.input.userId).toBe(U3);
    expect(sup.calls[2]?.input.port).toBe(PORT_BASE + 2);
  });

  it("skips users without a binding (warns) — others still rendered", async () => {
    const userStore = makeUserStore([user(U1), user("u_orphannn"), user(U3)]);
    const userPortStore = makeUserPortStore([
      { userId: U1, port: PORT_BASE },
      { userId: U3, port: PORT_BASE + 2 },
    ]);
    const sup = makeSupervisord();
    await renderProgramsForExistingUsers({
      userStore,
      userPortStore,
      supervisordControl: sup.supervisordControl,
      internalSecrets: { getHermesAuthTokenSync: () => "tok" },
      resolveTimezone: () => "UTC",
      profileStore: makeProfileStore(profileMapFor(U1, U3)),
      resolveHermesHome: (uid) => `/host/data/${uid}`,
    });
    expect(sup.calls.map((c) => c.input.userId)).toEqual([U1, U3]);
  });

  it("continues past per-user upsert failures", async () => {
    const userStore = makeUserStore([user(U1), user(U2)]);
    const userPortStore = makeUserPortStore([
      { userId: U1, port: PORT_BASE },
      { userId: U2, port: PORT_BASE + 1 },
    ]);
    const failures = new Map<string, SupervisordError>([[U1, { kind: "shell-failed", reason: "boom" }]]);
    const sup = makeSupervisord(failures);
    await renderProgramsForExistingUsers({
      userStore,
      userPortStore,
      supervisordControl: sup.supervisordControl,
      internalSecrets: { getHermesAuthTokenSync: () => "tok" },
      resolveTimezone: () => "UTC",
      profileStore: makeProfileStore(profileMapFor(U1, U2)),
      resolveHermesHome: (uid) => `/host/data/${uid}`,
    });
    expect(sup.calls.map((c) => c.input.userId)).toEqual([U1, U2]);
  });
});

describe("renderConfigsForExistingUsers", () => {
  it("is a no-op when there are no users", async () => {
    const userStore = makeUserStore([]);
    const calls: string[] = [];
    await renderConfigsForExistingUsers({
      userStore,
      renderInnerProfile: async (userId) => {
        calls.push(userId);
        return { ok: true as const, value: undefined };
      },
    });
    expect(calls).toEqual([]);
  });

  it("re-renders the inner profile for every existing user", async () => {
    const userStore = makeUserStore([user(U1), user(U2), user(U3)]);
    const calls: string[] = [];
    await renderConfigsForExistingUsers({
      userStore,
      renderInnerProfile: async (userId) => {
        calls.push(userId);
        return { ok: true as const, value: undefined };
      },
    });
    expect(calls).toEqual([U1, U2, U3]);
  });

  it("continues past per-user render failures", async () => {
    const userStore = makeUserStore([user(U1), user(U2), user(U3)]);
    const calls: string[] = [];
    await renderConfigsForExistingUsers({
      userStore,
      renderInnerProfile: async (userId) => {
        calls.push(userId);
        if (userId === U2) return { ok: false as const, error: "render-error" };
        return { ok: true as const, value: undefined };
      },
    });
    // U1 + U3 still get attempted even though U2 failed.
    expect(calls).toEqual([U1, U2, U3]);
  });
});
