// The per-user `ToolBroker` a PROXIED call is mediated by.
//
// A delegated run has no WS session, so it has no session broker to borrow.
// This builds one per user — held by value, never resolved from an ambient
// "current user" (spec §2.1/L2) — with three deliberate differences from the
// session broker in `bootstrap/phase-services.ts`:
//
//   * NO BACKGROUND TOOLS. `delegateTask` is `allow`-tiered, so without this
//     the delegated agent could proxy its own delegation and recurse. The empty
//     map means `dispatch` can only ever take the foreground branch.
//   * `requestConfirm` REJECTS with `ConfirmUnavailableError`. There is nobody
//     to prompt, and by the owner's Correction 2 the confirm gate for a
//     delegation is the ONE dialog shown before `delegateTask` runs — nothing
//     inside re-prompts, by design. The broker turns the rejection into a deny
//     whose message reaches the delegated model verbatim, so a confirm-tier
//     tool fails closed with an explanation rather than hanging.
//   * The principal's role is `DELEGATED_PRINCIPAL_ROLE` — the same default a
//     real session gets. A delegated agent acts FOR its user, never above them.
//
// It shares the SESSION broker's per-tool permission reader for exactly that
// last reason: a tool its user set to Deny or Off must be refused here too, or
// "delegate it to Hermes" becomes the way around a setting. This broker is
// cached for the process lifetime, so the reader is called per dispatch (inside
// `resolveDecision`) rather than snapshotted — a settings change reaches an
// already-built delegated broker.

import type { OrchestratorConfig } from "@sentient/config";
import type { AccessManager } from "../access/access-manager.js";
import { DELEGATED_PRINCIPAL_ROLE, PROXIED_TOOL_CONTEXT } from "../external-tools/delegated-tool-tier.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import { getLog } from "../logging/logger.js";
import type { ProfileStore } from "../profile-store/profile-store.js";
import type { PolicyEngine } from "../security/policy-engine.js";
import type { SessionStore } from "../store/session-store.js";
import type { McpClient } from "../tools/mcp-client.js";
import { type ToolBroker, createToolBroker } from "../tools/tool-broker.js";
import { ConfirmUnavailableError } from "../tools/tool-types.js";
import { createToolPermissionsReader } from "../tools/user-tool-permissions.js";

const log = getLog(["sentient", "mcp-host", "delegated-broker"]);

/** Households are not modelled yet — `ws-auth-gate.ts` uses the same literal
 *  for every real session. Both move together when the role model lands. */
const DELEGATED_HOUSEHOLD_ID = "home";

/** Model-facing copy. `tool-broker.ts` forwards a `ConfirmUnavailableError`'s
 *  message verbatim as the deny reason, so this is written for the delegated
 *  agent to act on, not for a log. */
const NO_CONFIRMER =
  "This tool needs a person's confirmation, and a delegated task runs with nobody attached to ask. Use a read-only tool or report back instead.";

export interface DelegatedBrokerFactoryDeps {
  mcp: McpClient;
  policy: PolicyEngine;
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

export type DelegatedBrokerFactory = (userId: string) => ToolBroker | null;

export function createDelegatedBrokerFactory(deps: DelegatedBrokerFactoryDeps): DelegatedBrokerFactory {
  const brokers = new Map<string, ToolBroker>();

  return (userId: string): ToolBroker | null => {
    const cached = brokers.get(userId);
    if (cached) return cached;

    let broker: ToolBroker;
    try {
      const principal = createUserPrincipal(userId, DELEGATED_PRINCIPAL_ROLE, DELEGATED_HOUSEHOLD_ID);
      const capability = deps.accessManager.grant(principal, "tool-broker");
      broker = createToolBroker({
        mcp: deps.mcp,
        policy: deps.policy,
        store: unusedStore(),
        principal,
        capability,
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

    brokers.set(userId, broker);
    log.info("delegated-broker.created", {
      userId,
      role: PROXIED_TOOL_CONTEXT.role,
      sessionChannel: PROXIED_TOOL_CONTEXT.sessionChannel,
    });
    return broker;
  };
}
