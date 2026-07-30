import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { UserStore } from "../user-auth/user-store.js";

const log = getLog(["sentient", "gateway", "admin", "boot-migration"]);

// ---------------------------------------------------------------------------
// renderConfigsForExistingUsers — Phase F5 boot step
// ---------------------------------------------------------------------------

export interface RenderConfigsDeps {
  userStore: Pick<UserStore, "list">;
  /** Re-renders config.yaml + SOUL.md from the current template + per-user
   *  profile and writes both atomically. Idempotent — same content rewrites
   *  are no-ops (atomic write replaces the file with byte-identical content).
   *  Wired in phase-services from `renderAndWrite(applyDeps, userId)`. */
  renderInnerProfile: (userId: string) => Promise<Result<undefined, "render-error" | "write-error">>;
}

/**
 * On every gateway boot, re-render the inner Hermes profile (config.yaml +
 * SOUL.md) for every existing user. The renderer is a pure function of
 * (template, profile, mcp_catalog) — re-running it on every boot makes the
 * on-disk config track template changes (e.g. legacy `model: <id>` keys
 * picked up by upgrades that switched to `default: <id>`).
 *
 * Idempotent: identical output bytes are atomically rewritten — no semantic
 * change. Best-effort: per-user failures are logged but do NOT short-circuit
 * other users.
 *
 * Nothing needs restarting afterwards: Hermes is a one-shot exec
 * (`hermes -p <userId> -z <prompt>`, see tools/hermes-runner.ts) whose `cwd`
 * IS the profile dir, so every delegation re-reads whatever this wrote.
 */
export async function renderConfigsForExistingUsers(deps: RenderConfigsDeps): Promise<void> {
  const usersResult = await deps.userStore.list();
  if (!usersResult.ok) {
    log.warn("renderConfigs.user-store-error", { error: usersResult.error });
    return;
  }
  const users = usersResult.value;
  if (users.length === 0) {
    log.debug("renderConfigs.noop", { reason: "no-users" });
    return;
  }

  for (const user of users) {
    const r = await deps.renderInnerProfile(user.userId);
    if (!r.ok) {
      log.warn("renderConfigs.render-failed", { userId: user.userId, error: r.error });
      continue;
    }
    log.info("renderConfigs.rendered", { userId: user.userId });
  }
}
