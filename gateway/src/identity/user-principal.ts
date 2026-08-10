// The immutable identity anchor (spec §2.1, L0).
//
// Minted exactly once, at the auth gate, from a validated token. There is no
// setter and no rebind: switching accounts means re-authenticating, which
// mints a fresh principal. Every downstream operation takes a principal as an
// explicit parameter — never an ambient "current user" lookup.

import type { UserRole } from "@sentient/protocol";
import { type UserId, assertUserId } from "../user-auth/user-id.js";

// The role is `UserRole` from @sentient/protocol — the SAME vocabulary the
// user record stores and `canExecute` gates on. This file used to declare its
// own structurally-identical `PrincipalRole`, which only ever assigned cleanly
// because the two literal unions happened to match; adding `admin` to one and
// not the other would have been a silent divergence at every call site. One
// vocabulary, one place (plan 2026-08-07-tool-permissions task 2b).

export interface UserPrincipal {
  readonly userId: UserId;
  readonly role: UserRole;
  readonly householdId: string;
}

export function createUserPrincipal(userId: string, role: UserRole, householdId: string): UserPrincipal {
  assertUserId(userId);
  return Object.freeze({ userId, role, householdId });
}
