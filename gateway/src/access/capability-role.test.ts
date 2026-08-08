import type { UserRole } from "@sentient/protocol";
import { USER_ROLES, canExecute } from "@sentient/protocol";
import { describe, expect, it } from "vitest";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { UserRecord } from "../user-auth/types.js";
import { createAccessManager } from "./access-manager.js";

// The chain this task exists to close (plan 2026-08-07-tool-permissions, 2b):
//
//   stored UserRecord.role → UserPrincipal.role → Capability.role → canExecute
//
// Every link but the first already existed; the first was `ws-auth-gate.ts`'s
// `DEFAULT_PRINCIPAL_ROLE = "adult"`, which made the whole chain a constant.
// These are the first assertions in the tree where two users differ, so they
// pin the WHOLE chain rather than any single link — a regression that
// re-hardcodes a role anywhere along it fails here.
//
// `canExecute` is asserted against `capability.role`, not called from runtime
// code: wiring the gate into `definitions()` / `resolveDecision` is task 4.

const HOUSEHOLD_ID = "home";
const manager = createAccessManager({ userDataRoot: "/tmp/sentient-capability-role-test" });

function record(userId: string, role: UserRole): UserRecord {
  return {
    userId,
    displayName: userId,
    pinHash: "$argon2id$fake",
    role,
    avatarTint: "terra",
    createdAt: "2026-08-07T00:00:00.000Z",
  };
}

/** Exactly what `ws-auth-gate.ts` does after this task: role off the record. */
function capabilityFor(stored: UserRecord) {
  return manager.grant(createUserPrincipal(stored.userId, stored.role, HOUSEHOLD_ID), "tool-broker");
}

describe("a capability carries the role its user record stores", () => {
  it("gives a guest's capability the guest role and an adult's the adult role", () => {
    expect(capabilityFor(record("u_11111111", "guest")).role).toBe("guest");
    expect(capabilityFor(record("u_22222222", "adult")).role).toBe("adult");
  });

  it("refuses a write-tier tool to a guest's capability while allowing an adult's", () => {
    const guest = capabilityFor(record("u_11111111", "guest"));
    const adult = capabilityFor(record("u_22222222", "adult"));
    expect(canExecute(guest.role, "write")).toBe(false);
    expect(canExecute(adult.role, "write")).toBe(true);
  });

  it("reaches the admin tier from an admin's capability and from no other role's", () => {
    const reach = USER_ROLES.filter((role) => canExecute(capabilityFor(record("u_33333333", role)).role, "admin"));
    expect(reach).toEqual(["admin"]);
  });

  it("keeps every role able to read, so no account is locked out of the assistant", () => {
    for (const role of USER_ROLES) {
      expect(canExecute(capabilityFor(record("u_44444444", role)).role, "read")).toBe(true);
    }
  });
});
