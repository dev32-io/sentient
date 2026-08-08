// Capability tokens (spec §2.1, L1→L2).
//
// A capability is authority-by-value: whoever holds it may act within its
// grant, and nothing else. Resource handles accept a Capability instead of a
// principal, which is what removes ambient authority — there is no "current
// user" for a confused deputy to be confused about.

import path from "node:path";
import type { UserRole } from "@sentient/protocol";
import type { UserId } from "../user-auth/user-id.js";

export type ResourceClass = "session-store" | "file-scope" | "tool-broker";

export interface Capability {
  /** Whose authority this grant derives from. Stamped at mint, never rewritten. */
  readonly ownerUserId: UserId;
  readonly resource: ResourceClass;
  /** Absolute filesystem root this grant is confined to. */
  readonly rootPath: string;
  /**
   * The owning principal's role, baked in at mint (spec §5.3, plan
   * 2026-08-07-tool-permissions task 2). This is what lets an L2 holder — the
   * `ToolBroker` today — decide a role-gated question from the capability it
   * already holds by value, instead of reaching for an ambient `principal`
   * alongside it. A role is not user content: logging it is fine.
   */
  readonly role: UserRole;
}

/**
 * True iff `candidatePath` resolves inside the capability's root.
 *
 * Resolves both sides before comparing so that `..` traversal, symlink-ish
 * relative segments, and missing separators cannot escape the grant. A path
 * equal to the root itself is covered.
 */
export function capabilityCoversPath(cap: Capability, candidatePath: string): boolean {
  const root = path.resolve(cap.rootPath);
  const candidate = path.resolve(candidatePath);
  if (candidate === root) return true;
  return candidate.startsWith(root + path.sep);
}
