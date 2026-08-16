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

const LEGACY_GROUPS: Readonly<Record<string, string>> = { duckduckgo: "web" };

interface LegacyToolTarget {
  readonly group: "web" | "home" | "music";
  readonly tools: readonly string[];
  /** Old MA classified several mutations as reads. An explicit allow must not
   * become an unprompted native write merely because the sidecar got it wrong. */
  readonly promptFloor?: true;
}

const LEGACY_CORE_TOOLS: Readonly<Record<string, Readonly<Record<string, LegacyToolTarget>>>> = {
  fetch: {
    fetch: { group: "web", tools: ["fetch_content"] },
  },
  searxng: {
    search_web: { group: "web", tools: ["web_search"] },
  },
  home_assistant: {
    ha_get_overview: { group: "home", tools: ["home_overview"] },
    ha_get_state: { group: "home", tools: ["home_state"] },
    ha_search: { group: "home", tools: ["home_search"] },
    ha_get_history: { group: "home", tools: ["home_history"] },
    ha_get_operation_status: { group: "home", tools: ["home_operation"] },
    ha_list_floors_areas: { group: "home", tools: ["home_locations"] },
    ha_get_camera_image: { group: "home", tools: ["home_camera"] },
    ha_call_service: { group: "home", tools: ["home_control"] },
    ha_bulk_control: { group: "home", tools: ["home_control"] },
    ha_get_todo: { group: "home", tools: ["home_get_todos"] },
    ha_set_todo_item: {
      group: "home",
      tools: ["home_add_todo", "home_update_todo"],
    },
    ha_remove_todo_item: { group: "home", tools: ["home_remove_todo"] },
    ha_config_get_calendar_events: {
      group: "home",
      tools: ["home_get_calendar_events"],
    },
    ha_config_set_calendar_event: {
      group: "home",
      tools: ["home_create_calendar_event", "home_update_calendar_event"],
    },
    ha_config_remove_calendar_event: {
      group: "home",
      tools: ["home_remove_calendar_event"],
    },
  },
  music_assistant: {
    ma_search: { group: "music", tools: ["music_search"] },
    ma_browse: { group: "music", tools: ["music_browse"] },
    ma_list_players: {
      group: "music",
      tools: ["music_players", "music_status"],
    },
    ma_queue: { group: "music", tools: ["music_queue"] },
    ma_volume: { group: "music", tools: ["music_volume"], promptFloor: true },
    ma_group: { group: "music", tools: ["music_group"], promptFloor: true },
    ma_playback: {
      group: "music",
      tools: ["music_transport"],
      promptFloor: true,
    },
    ma_play_media: {
      group: "music",
      tools: ["music_play_media", "music_play"],
      promptFloor: true,
    },
    ma_queue_item: {
      group: "music",
      tools: ["music_play_media"],
      promptFloor: true,
    },
    ma_transfer_queue: {
      group: "music",
      tools: ["music_transfer"],
      promptFloor: true,
    },
  },
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
    const coreTools = LEGACY_CORE_TOOLS[legacyGroup];
    if (coreTools) {
      changed = true;
      const group =
        Object.values(coreTools)[0]?.group ??
        (legacyGroup === "home_assistant" ? "home" : legacyGroup === "music_assistant" ? "music" : "web");
      next[group] ??= {};
      for (const [tool, value] of Object.entries(tools)) {
        const target = coreTools[tool];
        if (target) {
          const migratedValue = target.promptFloor && value === "allow" ? "ask" : value;
          for (const nativeTool of target.tools) write(target.group, nativeTool, migratedValue);
          continue;
        }
        // A restrictive value with no semantic native equivalent must still
        // bite. Apply it to the destination wildcard and quarantine the source
        // for diagnostics; permissive unknowns are retained only diagnostically.
        if (value !== "allow") write(group, "*", value);
        write("legacy_unmapped", `${legacyGroup}.${tool}`, value);
        unmappable += 1;
      }
      continue;
    }
    const mapped = LEGACY_GROUPS[legacyGroup];
    if (mapped) {
      changed = true;
      for (const [tool, value] of Object.entries(tools)) write(mapped, tool, value);
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
      log.warn("migration.profile-load-error", {
        userId: user.userId,
        error: profileResult.error,
      });
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
    const updated: ProfileV1 = {
      ...profile,
      tools: { ...profile.tools, permissions: result.permissions },
    };
    const saved = await deps.profileStore.save(updated);
    if (!saved.ok) {
      log.warn("migration.save-error", {
        userId: user.userId,
        error: saved.error,
      });
      skipped += 1;
      continue;
    }
    migrated += 1;
  }
  log.info("migration.complete", {
    migrated,
    skipped,
    total: usersResult.value.length,
  });
}
