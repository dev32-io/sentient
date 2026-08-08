import type { Result, UserRole } from "@sentient/protocol";
import { describe, expect, it } from "vitest";
import type { UserRecord } from "../user-auth/types.js";
import { renderConfigsForExistingUsers } from "./boot-migration.js";

function ok<T>(value: T): Result<T, never> {
  return { ok: true as const, value };
}

function makeUserStore(users: UserRecord[]) {
  return { list: async () => ok(users) };
}

function user(id: string, role: UserRole = "adult"): UserRecord {
  return {
    userId: id,
    displayName: id,
    pinHash: "x",
    role,
    avatarTint: "terra",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

const U1 = "u_11111111";
const U2 = "u_22222222";
const U3 = "u_33333333";

describe("renderConfigsForExistingUsers", () => {
  it("is a no-op when there are no users", async () => {
    const userStore = makeUserStore([]);
    const calls: string[] = [];
    await renderConfigsForExistingUsers({
      userStore,
      createHermesProfile: async () => ({ ok: true as const, value: undefined }),
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
      createHermesProfile: async () => ({ ok: true as const, value: undefined }),
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
      createHermesProfile: async () => ({ ok: true as const, value: undefined }),
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
