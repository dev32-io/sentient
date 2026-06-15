import { describe, expect, it, vi } from "vitest";
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

const fakeRouter = {
  bind: vi.fn(),
  release: vi.fn(),
  rebind: vi.fn(),
  get: vi.fn(),
  updateConversationId: vi.fn(),
  dropAnchor: vi.fn(),
  clearConversationIdForAllSessions: vi.fn(),
  findActiveSessionFor: vi.fn(),
};

describe("identify_user tool", () => {
  const userStore = makeUserStore([
    { userId: ALICE, displayName: "Alice" },
    { userId: BOB, displayName: "Bob" },
  ]);

  it("rejects missing name", async () => {
    const t = createIdentifyUserTool({ router: fakeRouter, userStore });
    const r = await t.run({}, { sessionId: null, userId: ALICE, role: "user", sessionChannel: "voice" });
    expect(r.isError).toBe(true);
  });

  it("rejects unknown name (not displayName, not userId)", async () => {
    const t = createIdentifyUserTool({ router: fakeRouter, userStore });
    const r = await t.run({ name: "carol" }, { sessionId: null, userId: ALICE, role: "user", sessionChannel: "voice" });
    expect(r.isError).toBe(true);
  });

  it("rejects when no socket userId", async () => {
    const t = createIdentifyUserTool({ router: fakeRouter, userStore });
    const r = await t.run({ name: "Bob" }, { sessionId: null, userId: null, role: "user", sessionChannel: "voice" });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/no user bound/);
  });

  it("errors when no active session for socket user", async () => {
    fakeRouter.findActiveSessionFor.mockReturnValue(null);
    const t = createIdentifyUserTool({ router: fakeRouter, userStore });
    const r = await t.run({ name: "Bob" }, { sessionId: null, userId: ALICE, role: "user", sessionChannel: "voice" });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/no active session/);
  });

  it("rebinds by displayName (case-insensitive)", async () => {
    fakeRouter.findActiveSessionFor.mockReturnValue("s1");
    fakeRouter.rebind.mockResolvedValue({ userId: BOB, url: "x", apiKey: "y", conversationId: null });
    const t = createIdentifyUserTool({ router: fakeRouter, userStore });
    const r = await t.run({ name: "bob" }, { sessionId: null, userId: ALICE, role: "user", sessionChannel: "voice" });
    expect(r.isError).toBeUndefined();
    expect(fakeRouter.rebind).toHaveBeenCalledWith("s1", BOB);
    expect(r.content[0]?.text).toBe("rebound to Bob");
  });

  it("rebinds by exact userId", async () => {
    fakeRouter.findActiveSessionFor.mockReturnValue("s2");
    fakeRouter.rebind.mockResolvedValue({ userId: BOB, url: "x", apiKey: "y", conversationId: null });
    const t = createIdentifyUserTool({ router: fakeRouter, userStore });
    const r = await t.run({ name: BOB }, { sessionId: null, userId: ALICE, role: "user", sessionChannel: "voice" });
    expect(r.isError).toBeUndefined();
    expect(fakeRouter.rebind).toHaveBeenCalledWith("s2", BOB);
  });
});
