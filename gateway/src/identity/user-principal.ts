// The immutable identity anchor (spec §2.1, L0).
//
// Minted exactly once, at the auth gate, from a validated token. There is no
// setter and no rebind: switching accounts means re-authenticating, which
// mints a fresh principal. Every downstream operation takes a principal as an
// explicit parameter — never an ambient "current user" lookup.

import { type UserId, assertUserId } from "../user-auth/user-id.js";

export type PrincipalRole = "adult" | "child" | "guest";

export interface UserPrincipal {
  readonly userId: UserId;
  readonly role: PrincipalRole;
  readonly householdId: string;
}

export function createUserPrincipal(userId: string, role: PrincipalRole, householdId: string): UserPrincipal {
  assertUserId(userId);
  return Object.freeze({ userId, role, householdId });
}
