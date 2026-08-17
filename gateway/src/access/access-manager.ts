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
  /**
   * Root under which each user gets <root>/<userId>/.
   *
   * Must be ABSOLUTE — the composition root is contractually responsible for
   * passing an already-expanded absolute path here. `gateway/config.yaml#access.
   * user_data_root` is declared in `gatewayConfigSchema` and may ship a leading
   * `~`; the load boundary runs `expandHome` on it (see user-auth/paths.ts for
   * the `os.homedir()` precedent) before this config reaches `createAccessManager`,
   * so by the time this value lands here it is always absolute. This module
   * itself does no expansion — a caller that skips the load-boundary step and
   * passes a raw `~`-prefixed path will land data under `<cwd>/~/` instead of
   * `$HOME`, since neither `path.join` nor `path.resolve` expands `~`.
   */
  userDataRoot: string;
  /**
   * Root under which each household gets <root>/<householdId>/ for shared
   * (household-scoped) memory. Sibling of `userDataRoot` by convention: mirrors
   * `access.shared_data_root` in `gateway/config.yaml`. Absolute, same
   * load-boundary contract as `userDataRoot`.
   *
   * Optional: when absent it is derived as `join(dirname(userDataRoot),
   * "shared")` so household grants work whether or not the operator has set the
   * config key. If `userDataRoot` is `~/.sentient/gateway/users`, the derived
   * shared root is `~/.sentient/gateway/shared`.
   */
  sharedDataRoot?: string;
}

export interface AccessManager {
  /** Mint an attenuated capability for this principal + resource class. */
  grant(principal: UserPrincipal, resource: ResourceClass): Capability;
  /** Absolute home directory owned by this principal. */
  userHomeDir(principal: UserPrincipal): string;
}

export function createAccessManager(config: AccessManagerConfig): AccessManager {
  const userHomeDir = (principal: UserPrincipal): string => path.join(config.userDataRoot, principal.userId);

  // Sibling of userDataRoot when the operator has not set `access.shared_data_root`.
  const sharedDataRoot = config.sharedDataRoot ?? path.join(path.dirname(config.userDataRoot), "shared");

  // Where a given resource class confines its grant. Private resources root at
  // the principal's own home dir; household resources root at the shared,
  // householdId-keyed dir so members of one household share a scope no other
  // household can reach.
  const rootPathFor = (principal: UserPrincipal, resource: ResourceClass): string =>
    resource === "memory-household" || resource === "calendar-household"
      ? path.join(sharedDataRoot, principal.householdId)
      : userHomeDir(principal);

  return {
    userHomeDir,
    grant(principal, resource) {
      const cap: Capability = Object.freeze({
        ownerUserId: principal.userId,
        resource,
        rootPath: rootPathFor(principal, resource),
        // Baked in at mint, not read again later — this IS the principal
        // becoming authority (spec §2.1/L1). See Capability.role's doc comment.
        role: principal.role,
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
