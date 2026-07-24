import { describe, expect, it } from "bun:test";
import { createUserPrincipal } from "../identity/user-principal.js";
import { createAccessManager } from "./access-manager.js";
import { capabilityCoversPath } from "./capability.js";

const ROOT = "/tmp/sentient-test-users";
const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
const bob = createUserPrincipal("u_bbbbbbbb", "adult", "home");

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
