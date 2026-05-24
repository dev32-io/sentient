import { getLog } from "../logging/logger.js";
import type { ProfileStore } from "../profile-store/profile-store.js";
import type { ProfileV1 } from "../profile-store/profile-types.js";
import type { UserStore } from "../user-auth/user-store.js";

const log = getLog(["sentient", "gateway", "admin", "web-tools-migrator"]);

export interface WebToolsMigrationDeps {
  userStore: Pick<UserStore, "list">;
  profileStore: Pick<ProfileStore, "get" | "save">;
}

/**
 * One-shot, idempotent boot migration: rename per-user
 * `tools.enabled.duckduckgo` to `tools.enabled.searxng` + `tools.enabled.fetch`
 * (both initialized to `[]`, meaning "inherit catalog defaults").
 *
 * No-op for users whose profile already has the new keys. Best-effort:
 * per-user failures log and continue.
 */
export async function migrateWebToolsEnabled(deps: WebToolsMigrationDeps): Promise<void> {
  const usersResult = await deps.userStore.list();
  if (!usersResult.ok) {
    log.warn("migration.user-store-error", { error: usersResult.error });
    return;
  }
  const users = usersResult.value;

  let migrated = 0;
  let skipped = 0;
  for (const user of users) {
    const profileResult = await deps.profileStore.get(user.userId);
    if (!profileResult.ok) {
      log.warn("migration.profile-load-error", { userId: user.userId, error: profileResult.error });
      skipped++;
      continue;
    }
    const profile = profileResult.value;
    const enabled = profile.tools.enabled;
    const hasLegacy = "duckduckgo" in enabled;
    if (!hasLegacy) {
      log.debug("migration.noop", { userId: user.userId });
      continue;
    }

    const { duckduckgo: _dropped, ...rest } = enabled;
    const next: Record<string, string[]> = rest;
    if (!("searxng" in next)) next.searxng = [];
    if (!("fetch" in next)) next.fetch = [];

    const updated: ProfileV1 = { ...profile, tools: { ...profile.tools, enabled: next } };
    const saveResult = await deps.profileStore.save(updated);
    if (!saveResult.ok) {
      log.warn("migration.save-error", { userId: user.userId, error: saveResult.error });
      continue;
    }
    log.info("migration.web-tools-renamed", {
      userId: user.userId,
      from: "duckduckgo",
      to: ["searxng", "fetch"],
    });
    migrated++;
  }
  log.info("migration.complete", { migrated, skipped, total: users.length });
}
