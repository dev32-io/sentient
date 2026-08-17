import { describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import type { UserRole } from "@sentient/protocol";
import type { UserPrincipal } from "../identity/user-principal.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { UserId } from "../user-auth/user-id.js";
import { createAccessManager } from "./access-manager.js";
import { capabilityCoversPath } from "./capability.js";

const ROOT = "/tmp/sentient-test-users";
const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
const bob = createUserPrincipal("u_bbbbbbbb", "adult", "home");

// Build a principal directly (bypassing assertUserId) so the brief's plain-string
// userIds like "kevin" are usable — grant() only reads userId/role/householdId.
const p = (over: { userId: string; householdId?: string; role?: UserRole }): UserPrincipal =>
  Object.freeze({
    userId: over.userId as UserId,
    role: over.role ?? "adult",
    householdId: over.householdId ?? "home",
  });

describe("AccessManager", () => {
  it("mints a capability confined to the principal's own home dir", () => {
    const am = createAccessManager({ userDataRoot: ROOT });
    const cap = am.grant(alice, "session-store");
    expect(cap.ownerUserId).toBe("u_aaaaaaaa");
    expect(cap.resource).toBe("session-store");
    expect(cap.rootPath).toBe(`${ROOT}/u_aaaaaaaa`);
  });

  it("SECURITY: one user's capability never covers another user's directory", () => {
    const am = createAccessManager({ userDataRoot: ROOT });
    const aliceCap = am.grant(alice, "file-scope");
    expect(capabilityCoversPath(aliceCap, `${ROOT}/u_aaaaaaaa/notes.md`)).toBe(true);
    expect(capabilityCoversPath(aliceCap, `${ROOT}/u_bbbbbbbb/notes.md`)).toBe(false);
    expect(capabilityCoversPath(aliceCap, am.userHomeDir(bob))).toBe(false);
  });

  it("SECURITY: traversal cannot escape the grant", () => {
    const am = createAccessManager({ userDataRoot: ROOT });
    const cap = am.grant(alice, "file-scope");
    expect(capabilityCoversPath(cap, `${ROOT}/u_aaaaaaaa/../u_bbbbbbbb/secret`)).toBe(false);
    expect(capabilityCoversPath(cap, "/etc/passwd")).toBe(false);
  });

  it("SECURITY: a sibling-prefix directory is not covered", () => {
    const am = createAccessManager({ userDataRoot: ROOT });
    const cap = am.grant(alice, "file-scope");
    // u_aaaaaaaa-evil shares a string prefix with the root but is a different dir
    expect(capabilityCoversPath(cap, `${ROOT}/u_aaaaaaaa-evil/x`)).toBe(false);
  });
});

describe("AccessManager — memory resource classes", () => {
  const userDataRoot = ROOT;
  const manager = createAccessManager({ userDataRoot });

  it("memory-private roots in the existing user home dir", () => {
    const cap = manager.grant(p({ userId: "kevin" }), "memory-private");
    expect(cap.resource).toBe("memory-private");
    expect(cap.rootPath).toBe(join(userDataRoot, "kevin"));
  });

  it("memory-household roots in the shared sibling dir keyed by householdId", () => {
    const cap = manager.grant(p({ userId: "kevin", householdId: "home" }), "memory-household");
    expect(cap.rootPath).toBe(join(dirname(userDataRoot), "shared", "home"));
  });

  it("memory-household honors an explicit sharedDataRoot when configured", () => {
    const shared = "/tmp/sentient-test-shared";
    const am = createAccessManager({ userDataRoot, sharedDataRoot: shared });
    const cap = am.grant(p({ userId: "kevin", householdId: "home" }), "memory-household");
    expect(cap.rootPath).toBe(join(shared, "home"));
  });

  it("SECURITY: a household capability is confined to its own household dir", () => {
    const cap = manager.grant(p({ userId: "kevin", householdId: "home" }), "memory-household");
    expect(capabilityCoversPath(cap, join(dirname(userDataRoot), "shared", "home", "note.md"))).toBe(true);
    expect(capabilityCoversPath(cap, join(dirname(userDataRoot), "shared", "other", "note.md"))).toBe(false);
  });

  it("calendar-private roots in the existing user home dir and preserves the role", () => {
    const cap = manager.grant(p({ userId: "kevin", role: "guest" }), "calendar-private");
    expect(cap.resource).toBe("calendar-private");
    expect(cap.rootPath).toBe(join(userDataRoot, "kevin"));
    expect(cap.role).toBe("guest");
  });

  it("calendar-household roots in the shared directory keyed by householdId", () => {
    const cap = manager.grant(p({ userId: "kevin", householdId: "home" }), "calendar-household");
    expect(cap.resource).toBe("calendar-household");
    expect(cap.rootPath).toBe(join(dirname(userDataRoot), "shared", "home"));
  });
});
