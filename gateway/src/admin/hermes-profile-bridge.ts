// Fail-loud detector for D11: the gateway renders a per-user Hermes profile
// into a directory the spawned `hermes` process does not read.
//
// THE FAULT. `profile-store`'s `renderInnerProfile` writes config.yaml
// (`mcp_servers`, `enabled_toolsets`, model) + SOUL.md into
// `getHermesProfileDir(userId)` = `<getUserProfileDir(userId)>/profiles/<userId>/`.
// Hermes resolves its OWN profile store from `$HERMES_HOME/profiles/<userId>/`.
// The two were bridged by `HERMES_HOME` in the retired supervisord program env
// — one env value per per-user container. The native cutover deleted the daemon,
// and `tools/hermes-runner.ts` spawns with `cwd` but NO `env`, so the child just
// inherits ours. With `HERMES_HOME` unset, hermes reads its default store and
// the gateway's whole render is dead output: the delegated agent gets none of
// the gateway/HA/MA/searxng MCP tools the render declares. Proven live in
// `qa/web/evidence/2026-07-30-t9c-verification-gaps/README.md` (§D11).
//
// WHY THIS ONLY DETECTS AND LOGS. Closing D11 needs a design decision that is
// the human's to make, not an agent's (register the gateway MCP through
// hermes's own `mcp add` at provision only, vs reconcile on every profile
// change; gateway MCP only, vs the user's whole enabled catalog). Both of the
// alternatives to detecting — refusing to provision, or refusing delegation —
// would trade a delegateTask that currently works for one that does not, which
// is exactly the decision being reserved. So the contract this module enforces
// is the weaker, safe one: the degraded shape may ship, but it may not ship
// SILENTLY. `hermes-profile.bridge.not-live` is the grep handle.
//
// Note the structural half of the problem, because it rules out "just set
// HERMES_HOME": it is ONE process-wide variable and the rendered root is
// per-user, so a single value can be correct for at most one user. The per-user
// HERMES_HOME model died with the per-user container.

import { getUserProfileDir } from "../user-auth/paths.js";

/** The env var hermes resolves its profile store from. */
const HERMES_HOME_ENV = "HERMES_HOME";

/** Defect id in the NM-T9b/T9c defect ledger, carried on the log line so the
 *  symptom ("delegated agent has no gateway tools") is one grep from the
 *  written-up root cause instead of being re-diagnosed a third time. */
export const HERMES_PROFILE_BRIDGE_DEFECT = "D11";

/** What an operator loses while the bridge is broken — logged verbatim so the
 *  consequence is in the log line, not only in a QA note. */
export const HERMES_PROFILE_BRIDGE_CONSEQUENCE =
  "rendered mcp_servers/enabled_toolsets are dead output; the delegated agent gets no gateway MCP tools";

export type HermesProfileBridge =
  | { readonly isLive: true; readonly hermesHome: string }
  | {
      readonly isLive: false;
      /** `hermes-home-unset` — nothing bridges the two trees at all (the
       *  shipped native default). `hermes-home-elsewhere` — something set it,
       *  but not to this user's rendered root. */
      readonly reason: "hermes-home-unset" | "hermes-home-elsewhere";
      readonly hermesHome: string | null;
      readonly renderedRoot: string;
    };

/**
 * Is the per-user profile the gateway renders the same one the spawned hermes
 * reads? `env` is injected so this is a pure function of its inputs; the
 * default is the gateway's own env, which is what the child inherits.
 */
export function checkHermesProfileBridge(
  userId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): HermesProfileBridge {
  const renderedRoot = getUserProfileDir(userId);
  const hermesHome = env[HERMES_HOME_ENV] ?? "";
  if (hermesHome.length === 0) {
    return { isLive: false, reason: "hermes-home-unset", hermesHome: null, renderedRoot };
  }
  if (hermesHome !== renderedRoot) {
    return { isLive: false, reason: "hermes-home-elsewhere", hermesHome, renderedRoot };
  }
  return { isLive: true, hermesHome };
}
