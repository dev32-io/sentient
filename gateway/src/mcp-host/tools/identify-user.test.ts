import { describe, expect, it } from "vitest";
import type { UserStore } from "../../user-auth/user-store.js";
import { createIdentifyUserTool } from "./identify-user.js";

const ALICE = "u_aaaaaaaa";
const BOB = "u_bbbbbbbb";

function makeUserStore(users: Array<{ userId: string; displayName: string }>): Pick<UserStore, "list"> {
  return {
    list: async () => ({
      ok: true,
      value: users.map((u) => ({
        userId: u.userId,
        displayName: u.displayName,
        pinHash: "x",
        isAdmin: false,
        avatarTint: "terra",
        createdAt: "2026-01-01T00:00:00Z",
      })),
    }),
  };
}

const CTX = { sessionId: null, userId: ALICE, role: "user", sessionChannel: "voice" } as const;

describe("identify_user tool (secure — never rebinds identity)", () => {
  const userStore = makeUserStore([
    { userId: ALICE, displayName: "Alice" },
    { userId: BOB, displayName: "Bob" },
  ]);

  it("rejects missing name", async () => {
    const t = createIdentifyUserTool({ userStore });
    const r = await t.run({}, CTX);
    expect(r.isError).toBe(true);
  });

  it("rejects unknown name (not displayName, not userId)", async () => {
    const t = createIdentifyUserTool({ userStore });
    const r = await t.run({ name: "carol" }, CTX);
    expect(r.isError).toBe(true);
  });

  it("for a known user (by displayName, case-insensitive), directs re-auth instead of switching", async () => {
    const t = createIdentifyUserTool({ userStore });
    const r = await t.run({ name: "bob" }, CTX);
    // Not an error, but it must NOT silently switch identity — it returns guidance
    // to log in as the target. The security invariant is that this tool can never
    // grant the current session another user's scope.
    expect(r.isError).toBeUndefined();
    expect(r.content[0]?.text).toMatch(/Bob/);
    expect(r.content[0]?.text).toMatch(/log (out|in)|sign in/i);
  });

  it("for a known user by exact userId, also directs re-auth (never switches)", async () => {
    const t = createIdentifyUserTool({ userStore });
    const r = await t.run({ name: BOB }, CTX);
    expect(r.isError).toBeUndefined();
    expect(r.content[0]?.text).toMatch(/Bob/);
  });
});
