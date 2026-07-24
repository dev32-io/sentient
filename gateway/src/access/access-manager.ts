// AccessManager (spec §2.1, L1) — the ONLY place a principal becomes authority.
//
// Everywhere else in the system holds capabilities, not principals. Keeping
// minting in one module means the principal→authority mapping has exactly one
// audit point, and no component can widen its own grant.

import path from "node:path";

import type { UserPrincipal } from "../identity/user-principal.js";
import type { Capability, ResourceClass } from "./capability.js";

import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "access", "access-manager"]);

export interface AccessManagerConfig {
  /** Root under which each user gets <root>/<userId>/. */
  userDataRoot: string;
}

export interface AccessManager {
  /** Mint an attenuated capability for this principal + resource class. */
  grant(principal: UserPrincipal, resource: ResourceClass): Capability;
  /** Absolute home directory owned by this principal. */
  userHomeDir(principal: UserPrincipal): string;
}

export function createAccessManager(config: AccessManagerConfig): AccessManager {
  const userHomeDir = (principal: UserPrincipal): string => path.join(config.userDataRoot, principal.userId);

  return {
    userHomeDir,
    grant(principal, resource) {
      const cap: Capability = Object.freeze({
        ownerUserId: principal.userId,
        resource,
        rootPath: userHomeDir(principal),
      });
      log.debug("capability.minted", {
        userId: principal.userId,
        role: principal.role,
        resource,
      });
      return cap;
    },
  };
}
