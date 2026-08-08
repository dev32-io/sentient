import { describe, expect, it } from "vitest";
import { NEVER_REVOKED } from "../../user-auth/credential-floor.js";
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
        role: "adult",
        avatarTint: "terra",
        createdAt: "2026-01-01T00:00:00Z",
        credentialsValidFrom: NEVER_REVOKED,
      })),
    }),
  };
}

const CTX = { sessionId: null, userId: ALICE, sessionChannel: "voice" } as const;

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

// ---------------------------------------------------------------------------
// THE CHANNEL GUARD. `no_identify_user_outside_voice` is the one rule the
// retired `mcp-policy.yaml` carried that no permission table can express: it is
// conditioned on `session.channel`, which is per-SESSION, not per-user and not
// per-role. It moved HERE, into the tool that owns the constraint, rather than
// into either of the broker's two gates — so a later re-tiering or a permission
// change cannot silently drop it. This suite is what makes that a fact.
// ---------------------------------------------------------------------------

describe("identify_user is meaningful only on a voice channel", () => {
  const userStore = makeUserStore([
    { userId: ALICE, displayName: "Alice" },
    { userId: BOB, displayName: "Bob" },
  ]);
  const TEXT_CTX = { ...CTX, sessionChannel: "text" } as const;

  it("refuses in a text session, with a reason the model can act on", async () => {
    const t = createIdentifyUserTool({ userStore });

    const r = await t.run({ name: "bob" }, TEXT_CTX);

    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/voice/i);
    // The refusal must not leak the household roster: a text-channel caller
    // learns nothing about who exists that the voice path would have told them.
    expect(r.content[0]?.text).not.toMatch(/Bob/);
  });

  it("refuses BEFORE reading the user store at all", async () => {
    let listCalls = 0;
    const counting: Pick<UserStore, "list"> = {
      list: async () => {
        listCalls += 1;
        return userStore.list();
      },
    };

    await createIdentifyUserTool({ userStore: counting }).run({ name: "bob" }, TEXT_CTX);
    expect(listCalls).toBe(0);

    // …and the same call on the voice channel DOES read it, so the guard is
    // what stopped it rather than the tool being inert.
    await createIdentifyUserTool({ userStore: counting }).run({ name: "bob" }, CTX);
    expect(listCalls).toBe(1);
  });
});
