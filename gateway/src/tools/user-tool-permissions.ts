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
// WHY IT FAILS CLOSED, and why the error CLASS decides how. A failed read must
// never be able to grant more than the previous read granted — otherwise making
// `profile.json` unreadable is a way to re-enable every tool somebody switched
// off. But "unreadable" is two different facts:
//
//   not-found                          → there is no profile, so there is no
//                                        table, so nothing was ever set. Report
//                                        UNSET and let mcp-policy.yaml decide,
//                                        which is what it decided anyway.
//   corrupt-file / io-error /          → a table may well exist and say `deny`
//   validation-error                     or `off`; this reader simply cannot see
//                                        it. Report DENY_EVERY_SERVER, never
//                                        unset.
//
// Once a read HAS succeeded, every later failure returns that last-known table
// regardless of class — a profile cannot un-say what it already said.

import type { ToolPermissionMap } from "@sentient/config";
import { getLog } from "../logging/logger.js";
import type { ProfileStore, ProfileStoreError } from "../profile-store/profile-store.js";

const log = getLog(["sentient", "tools", "user-tool-permissions"]);

/** A table that exists and names no server — so every server is absent, and the
 *  broker's server-level rule turns every catalog tool off. NOT the same value
 *  as `undefined`, which means "never set → inherit"; that distinction is the
 *  whole reason `ProfileV1["tools"]["permissions"]` is optional rather than
 *  `.default({})`. Gateway-native background tools (`delegateTask`) belong to no
 *  server and are unaffected, so a corrupt profile degrades to "no MCP tools",
 *  not to "no assistant". */
const DENY_EVERY_SERVER: ToolPermissionMap = Object.freeze({});

export interface ToolPermissionsReaderDeps {
  readonly profileStore: ProfileStore;
  /** Whose settings these are. Bound by value at construction, never resolved
   *  from an ambient "current user" — the same L2 rule the broker's own
   *  capability follows (spec §2.1). */
  readonly userId: string;
}

/** Builds the `() => Promise<ToolPermissionMap | undefined>` getter a
 *  `ToolBroker` holds. `undefined` means the person never set a table. */
export function createToolPermissionsReader(
  deps: ToolPermissionsReaderDeps,
): () => Promise<ToolPermissionMap | undefined> {
  const { profileStore, userId } = deps;
  let lastKnownGood: ToolPermissionMap | undefined;

  /** EXHAUSTIVE over `ProfileStoreError`, no `default:` arm — a new error class
   *  must be classified as "nothing was ever set" or "a setting exists and I
   *  cannot see it" by whoever adds it, never inherit one by accident. */
  function fallbackFor(error: ProfileStoreError): ToolPermissionMap | undefined {
    switch (error) {
      case "not-found":
        return undefined;
      case "corrupt-file":
        return DENY_EVERY_SERVER;
      case "io-error":
        return DENY_EVERY_SERVER;
      case "validation-error":
        return DENY_EVERY_SERVER;
    }
  }

  return async (): Promise<ToolPermissionMap | undefined> => {
    const got = await profileStore.get(userId);
    if (!got.ok) {
      // A table already seen outranks the error class: a profile cannot un-say
      // what it already said, whatever went wrong reading it this time.
      const fallback = lastKnownGood ?? fallbackFor(got.error);
      log.warn("user-tool-permissions.profile-unreadable", {
        userId,
        reason: got.error,
        source: lastKnownGood !== undefined ? "last-known-table" : "error-class-default",
        outcome: fallback === undefined ? "unset-inherit" : "table",
        servers: fallback === undefined ? 0 : Object.keys(fallback).length,
      });
      return fallback;
    }
    const permissions = got.value.tools.permissions;
    log.debug("user-tool-permissions.read", {
      userId,
      set: permissions !== undefined,
      servers: permissions === undefined ? 0 : Object.keys(permissions).length,
      explicitTools:
        permissions === undefined
          ? 0
          : Object.values(permissions).reduce((n, perServer) => n + Object.keys(perServer).length, 0),
    });
    // Only a SUCCESSFUL read updates the anchor — and an unset field genuinely
    // is the current answer, so it clears it rather than pinning a stale table.
    lastKnownGood = permissions;
    return permissions;
  };
}
