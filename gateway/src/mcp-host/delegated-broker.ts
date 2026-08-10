// The per-user `ToolBroker` a PROXIED call is mediated by.
//
// A delegated run has no WS session, so it has no session broker to borrow.
// This builds one per user — held by value, never resolved from an ambient
// "current user" (spec §2.1/L2) — with three deliberate differences from the
// session broker in `bootstrap/phase-services.ts`:
//
//   * NO BACKGROUND TOOLS. Without this the delegated agent could proxy its own
//     `delegateTask` and recurse. The empty map means `dispatch` can only ever
//     take the foreground branch.
//   * `requestConfirm` REJECTS with `ConfirmUnavailableError`. There is nobody
//     to prompt, and by the owner's Correction 2 the confirm gate for a
//     delegation is the ONE dialog shown before `delegateTask` runs — nothing
//     inside re-prompts, by design. The broker turns the rejection into a deny
//     whose message reaches the delegated model verbatim, so a confirm-tier
//     tool fails closed with an explanation rather than hanging.
//   * The principal's role is THE DELEGATOR'S OWN, read from the user store on
//     the way in. A delegated agent acts FOR its user, never above them, so
//     there is no delegated role constant any more — the one that used to live
//     in `external-tools/delegated-tool-tier.ts` is deleted, and so is the
//     advertisement role beside it: the proxied surface is selected by IMPACT
//     TIER now, which is a property of the tool and not of any role. `AccessManager.
//     grant` bakes this role into the capability below exactly as it does for
//     a real session's principal, no special-casing, which is what makes the
//     bound provable rather than asserted: the ONLY role a delegated broker can
//     ever hold is one that came out of `userStore.get(userId).role`, the same
//     record `ws-auth-gate.ts` reads for that user's own sessions. A delegation
//     therefore cannot exceed its delegator, and an unresolvable delegator
//     yields NO broker at all rather than a defaulted one.
//
// It shares the SESSION broker's per-tool permission reader for exactly that
// last reason: a tool its user set to Deny or Off must be refused here too, or
// "delegate it to Hermes" becomes the way around a setting. The reader is
// called per dispatch (inside `resolveDecision`) rather than snapshotted, so a
// settings change reaches an already-built delegated broker.
//
// THE CACHE IS KEYED ON THE ROLE, not just the user. A broker holds its role by
// value in an immutable capability, so a cached one built while its user was an
// adult would keep adult authority after a demotion — the cache would become
// the escalation the lookup exists to prevent. Re-resolving the role per call
// and rebuilding on a change costs one users.json read, which is what every
// login already pays.

import type { McpCatalog, OrchestratorConfig } from "@sentient/config";
import type { UserRole } from "@sentient/protocol";
import type { AccessManager } from "../access/access-manager.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import { getLog } from "../logging/logger.js";
import type { ProfileStore } from "../profile-store/profile-store.js";
import type { SessionStore } from "../store/session-store.js";
import type { McpClient } from "../tools/mcp-client.js";
import { type ToolBroker, createToolBroker } from "../tools/tool-broker.js";
import { ConfirmUnavailableError } from "../tools/tool-types.js";
import { createToolPermissionsReader } from "../tools/user-tool-permissions.js";
import type { UserStore } from "../user-auth/user-store.js";

const log = getLog(["sentient", "mcp-host", "delegated-broker"]);

/** Households are not modelled yet — `ws-auth-gate.ts` uses the same literal
 *  for every real session. Both move together when households land. */
const DELEGATED_HOUSEHOLD_ID = "home";

/** Model-facing copy. `tool-broker.ts` forwards a `ConfirmUnavailableError`'s
 *  message verbatim as the deny reason, so this is written for the delegated
 *  agent to act on, not for a log. */
const NO_CONFIRMER =
  "This tool needs a person's confirmation, and a delegated task runs with nobody attached to ask. Use a read-only tool or report back instead.";

export interface DelegatedBrokerFactoryDeps {
  mcp: McpClient;
  /** `config.yaml#mcp_catalog`. The broker builds the DELEGATOR's role
   *  permission template from it, so a proxied call resolves against exactly
   *  the floor that user's own session would. */
  catalog: McpCatalog;
  /** `orchestrator.tools` — only `max_concurrent_background_tasks` is read, and
   *  only on a branch this broker cannot reach (see the file header). */
  toolsConfig: OrchestratorConfig["tools"];
  /** Mints this broker's authorization capability (spec §3.2) — same role
   *  `bootstrap/phase-services.ts`'s session broker gives its AccessManager,
   *  just for a synthetic delegated principal instead of a real session's. */
  accessManager: AccessManager;
  /** Reads the delegating user's own `profile.tools.permissions`, so a
   *  delegated call is bound by the same per-tool settings a foreground one
   *  is. See the file header. */
  profileStore: ProfileStore;
  /** Resolves the DELEGATOR's role — the same record `ws-auth-gate.ts` reads
   *  when that user opens a session of their own. This is the entire bound on
   *  a delegation's authority: no other value can reach the capability. */
  userStore: Pick<UserStore, "get">;
}

/**
 * `ToolBrokerDeps.store` is interface-parity only — `tool-broker.ts` never
 * reads it (the ReAct loop owns turnId and does all appending). A delegated
 * broker has no conversation at all, so rather than open a partition that
 * cannot be correct, hand it a stub that throws loudly if anything ever does
 * read it. Same call as the session broker's, for the same reason.
 */
function unusedStore(): SessionStore {
  const refuse = (): never => {
    throw new Error("ToolBroker.store is interface-parity only and must not be used by a delegated broker");
  };
  return {
    append: refuse,
    readSession: refuse,
    readSince: refuse,
    findByPendingId: refuse,
    listSessions: refuse,
    createSession: refuse,
    findSessionByMintKey: refuse,
    getSession: refuse,
    listSessionsWithMetadata: refuse,
    setTitle: refuse,
    close: () => {},
  };
}

/** ASYNC because resolving the delegator's role is a store read, and there is
 *  no correct synchronous answer to substitute for it. Callers are already in
 *  an async tool handler (`proxied-catalog-tool.ts`). */
export type DelegatedBrokerFactory = (userId: string) => Promise<ToolBroker | null>;

interface CachedBroker {
  /** The role the cached broker's capability was minted with. A mismatch with
   *  the store means the user was re-roled and the broker must be rebuilt. */
  readonly role: UserRole;
  readonly broker: ToolBroker;
}

export function createDelegatedBrokerFactory(deps: DelegatedBrokerFactoryDeps): DelegatedBrokerFactory {
  const brokers = new Map<string, CachedBroker>();

  async function resolveRole(userId: string): Promise<UserRole | null> {
    const stored = await deps.userStore.get(userId);
    if (!stored.ok || stored.value === null) {
      // FAIL CLOSED. No record means no delegator to act for, so there is no
      // authority to attenuate — the caller turns a null broker into a legible
      // "the gateway cannot mediate this call right now".
      log.warn("delegated-broker.no-delegator", {
        userId,
        reason: stored.ok ? "no such user record" : stored.error,
      });
      return null;
    }
    return stored.value.role;
  }

  return async (userId: string): Promise<ToolBroker | null> => {
    const role = await resolveRole(userId);
    if (role === null) return null;

    const cached = brokers.get(userId);
    if (cached) {
      if (cached.role === role) return cached.broker;
      log.info("delegated-broker.role-changed", {
        userId,
        from: cached.role,
        to: role,
        reason: "capability holds its role by value; rebuilding rather than serving stale authority",
      });
    }

    let broker: ToolBroker;
    try {
      const principal = createUserPrincipal(userId, role, DELEGATED_HOUSEHOLD_ID);
      const capability = deps.accessManager.grant(principal, "tool-broker");
      broker = createToolBroker({
        mcp: deps.mcp,
        store: unusedStore(),
        capability,
        catalog: deps.catalog,
        // Log correlation only. Named apart from a connection id on purpose:
        // every line from this broker is a delegated call, not a socket's.
        sessionId: `delegated:${userId}`,
        backgroundTools: new Map(),
        config: deps.toolsConfig,
        requestConfirm: () => Promise.reject(new ConfirmUnavailableError(NO_CONFIRMER)),
        toolPermissions: createToolPermissionsReader({
          profileStore: deps.profileStore,
          userId: capability.ownerUserId,
        }),
      });
    } catch (err: unknown) {
      // `createUserPrincipal` asserts the canonical user-id shape. A stored id
      // that fails it means no broker, which means the proxied tools fail
      // closed for that user — never an unmediated fallback.
      log.warn("delegated-broker.build-failed", {
        userId,
        reason: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    brokers.set(userId, { role, broker });
    log.info("delegated-broker.created", { userId, role });
    return broker;
  };
}
