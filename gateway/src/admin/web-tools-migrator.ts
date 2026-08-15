import type { ToolPermission, ToolPermissionMap } from "@sentient/config";
import { getLog } from "../logging/logger.js";
import type { ProfileStore } from "../profile-store/profile-store.js";
import type { ProfileV1 } from "../profile-store/profile-types.js";
import type { UserStore } from "../user-auth/user-store.js";

const log = getLog(["sentient", "gateway", "admin", "product-tool-migrator"]);

export interface WebToolsMigrationDeps {
  userStore: Pick<UserStore, "list">;
  profileStore: Pick<ProfileStore, "get" | "save">;
}

const LEGACY_GROUPS: Readonly<Record<string, string>> = {
  duckduckgo: "web",
  fetch: "web",
  searxng: "web",
  home_assistant: "home",
  music_assistant: "music",
};
const RESTRICTIVENESS: Readonly<Record<ToolPermission, number>> = {
  allow: 0,
  ask: 1,
  deny: 2,
  off: 3,
};

function conservativeMerge(a: ToolPermission | undefined, b: ToolPermission): ToolPermission {
  if (a === undefined) return b;
  return RESTRICTIVENESS[a] >= RESTRICTIVENESS[b] ? a : b;
}

function nativeGroup(toolName: string): string | null {
  if (toolName.startsWith("skill_")) return "skills";
  if (toolName.startsWith("memory_")) return "memory";
  if (toolName === "delegateTask") return "delegation";
  return null;
}

/** Pure migration used by fixtures and the boot migrator. Absent and empty
 * maps remain distinct. Collisions choose the more restrictive value. Unknown
 * native entries are retained in a diagnostic quarantine group so restrictive
 * intent is never silently widened or discarded. */
export function migrateLegacyToolPermissions(permissions: ToolPermissionMap | undefined): {
  permissions: ToolPermissionMap | undefined;
  changed: boolean;
  unmappable: number;
} {
  if (permissions === undefined) return { permissions: undefined, changed: false, unmappable: 0 };
  const next: ToolPermissionMap = {};
  let changed = false;
  let unmappable = 0;

  const write = (group: string, tool: string, value: ToolPermission) => {
    const target = next[group] ?? {};
    target[tool] = conservativeMerge(target[tool], value);
    next[group] = target;
  };

  for (const [legacyGroup, tools] of Object.entries(permissions)) {
    const mapped = LEGACY_GROUPS[legacyGroup];
    if (mapped) {
      changed = true;
      for (const [tool, value] of Object.entries(tools)) write(mapped, tool, value);
      // Preserve an explicitly empty legacy section as an explicitly present
      // product section (present-empty and absent are intentionally distinct).
      next[mapped] ??= {};
      continue;
    }
    if (legacyGroup === "native") {
      changed = true;
      for (const [tool, value] of Object.entries(tools)) {
        if (tool === "*") {
          // One legacy wildcard governed unrelated native families. Copying it
          // to each known family is the only conservative, deterministic split.
          for (const group of ["skills", "memory", "delegation"]) write(group, tool, value);
          continue;
        }
        const group = nativeGroup(tool);
        if (group) write(group, tool, value);
        else {
          write("legacy_unmapped", `native.${tool}`, value);
          unmappable += 1;
        }
      }
      continue;
    }
    // Already-product-keyed and third-party groups pass through unchanged.
    for (const [tool, value] of Object.entries(tools)) write(legacyGroup, tool, value);
    next[legacyGroup] ??= {};
  }
  return { permissions: next, changed, unmappable };
}

/** One-shot idempotent boot migration from transport/native keys to product
 * groups. Best effort per user; diagnostics contain counts and ids only. */
export async function migrateWebToolsEnabled(deps: WebToolsMigrationDeps): Promise<void> {
  const usersResult = await deps.userStore.list();
  if (!usersResult.ok) {
    log.warn("migration.user-store-error", { error: usersResult.error });
    return;
  }
  let migrated = 0;
  let skipped = 0;
  for (const user of usersResult.value) {
    const profileResult = await deps.profileStore.get(user.userId);
    if (!profileResult.ok) {
      log.warn("migration.profile-load-error", { userId: user.userId, error: profileResult.error });
      skipped += 1;
      continue;
    }
    const profile = profileResult.value;
    const result = migrateLegacyToolPermissions(profile.tools.permissions);
    if (!result.changed) continue;
    if (result.unmappable > 0) {
      log.warn("migration.unmappable-native-permissions", {
        userId: user.userId,
        count: result.unmappable,
        outcome: "retained-restrictively",
      });
    }
    const updated: ProfileV1 = { ...profile, tools: { ...profile.tools, permissions: result.permissions } };
    const saved = await deps.profileStore.save(updated);
    if (!saved.ok) {
      log.warn("migration.save-error", { userId: user.userId, error: saved.error });
      skipped += 1;
      continue;
    }
    migrated += 1;
  }
  log.info("migration.complete", { migrated, skipped, total: usersResult.value.length });
}
