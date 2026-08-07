// The composition roots' implementation of `ToolBrokerDeps.toolPermissions`
// (see tool-broker.ts): one person's `profile.tools.permissions`, read from the
// profile store at the moment the broker asks for it.
//
// WHY A READER AND NOT A VALUE. A permission table read once at session
// construction would take effect on the next RECONNECT, and Settings' Apply
// does not reopen the WS — which is the same "I changed it and nothing
// happened" surprise `bootstrap/user-model-provider.ts` exists to remove, one
// layer down. The broker calls this per turn (`ready()`) and per dispatch
// (`resolveDecision`); the read is a small local JSON file against an LLM round
// trip of hundreds of ms.
//
// WHY IT FAILS CLOSED. An unreadable profile returns the last table this reader
// successfully read, never an empty one. A settings read that fails must not be
// able to grant more than it granted a moment ago — the alternative is that
// making `profile.json` unreadable silently re-enables every tool the person
// switched off.

import type { ToolPermissionMap } from "@sentient/config";
import { getLog } from "../logging/logger.js";
import type { ProfileStore } from "../profile-store/profile-store.js";

const log = getLog(["sentient", "tools", "user-tool-permissions"]);

export interface ToolPermissionsReaderDeps {
  readonly profileStore: ProfileStore;
  /** Whose settings these are. Bound by value at construction, never resolved
   *  from an ambient "current user" — the same L2 rule the broker's own
   *  capability follows (spec §2.1). */
  readonly userId: string;
}

/** Builds the `() => Promise<ToolPermissionMap>` getter a `ToolBroker` holds. */
export function createToolPermissionsReader(deps: ToolPermissionsReaderDeps): () => Promise<ToolPermissionMap> {
  const { profileStore, userId } = deps;
  let lastKnownGood: ToolPermissionMap = {};

  return async (): Promise<ToolPermissionMap> => {
    const got = await profileStore.get(userId);
    if (!got.ok) {
      log.warn("user-tool-permissions.profile-unreadable", {
        userId,
        reason: got.error,
        servers: Object.keys(lastKnownGood).length,
        fallback: "last known table — an unreadable profile never widens what a tool is allowed to do",
      });
      return lastKnownGood;
    }
    const permissions = got.value.tools.permissions;
    log.debug("user-tool-permissions.read", {
      userId,
      servers: Object.keys(permissions).length,
      explicitTools: Object.values(permissions).reduce((n, perServer) => n + Object.keys(perServer).length, 0),
    });
    lastKnownGood = permissions;
    return permissions;
  };
}
