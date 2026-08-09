import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import { writeFileAtomic } from "../user-auth/atomic-write.js";
import { getUserProfileDir } from "../user-auth/paths.js";
import { type ProfileV1, profileV1Schema } from "./profile-types.js";

const log = getLog(["sentient", "gateway", "profile-store"]);

export type ProfileStoreError = "not-found" | "io-error" | "corrupt-file" | "validation-error";

export interface ProfileStore {
  get(userId: string): Promise<Result<ProfileV1, ProfileStoreError>>;
  save(profile: ProfileV1): Promise<Result<void, ProfileStoreError>>;
  remove(userId: string): Promise<Result<void, ProfileStoreError>>;
}

const MEMORY_TOGGLES_DEFAULT = { spark: true, dreaming: true } as const;

function profilePath(userId: string): string {
  return join(getUserProfileDir(userId), "profile.json");
}

export function createProfileStore(): ProfileStore {
  return {
    async get(userId) {
      const path = profilePath(userId);
      let raw: string;
      try {
        raw = await fs.readFile(path, "utf8");
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return { ok: false, error: "not-found" };
        }
        log.warn("get.io-error", { userId, reason: (e as Error).message });
        return { ok: false, error: "io-error" };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        log.warn("get.corrupt-json", { userId });
        return { ok: false, error: "corrupt-file" };
      }
      const v = profileV1Schema.safeParse(parsed);
      if (!v.success) {
        log.warn("get.corrupt-schema", { userId, reason: v.error.message });
        return { ok: false, error: "corrupt-file" };
      }
      return { ok: true, value: v.data };
    },

    async save(profile) {
      const v = profileV1Schema.safeParse(profile);
      if (!v.success) {
        log.warn("save.validation-error", { userId: profile.userId, reason: v.error.message });
        return { ok: false, error: "validation-error" };
      }
      try {
        await writeFileAtomic(profilePath(profile.userId), JSON.stringify(v.data, null, 2), {
          mode: 0o600,
        });
        log.info("save", { userId: profile.userId });
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        log.warn("save.io-error", { userId: profile.userId, reason: (e as Error).message });
        return { ok: false, error: "io-error" };
      }
    },

    async remove(userId) {
      try {
        await fs.unlink(profilePath(userId));
        log.info("remove", { userId });
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return { ok: false, error: "not-found" };
        }
        log.warn("remove.io-error", { userId, reason: (e as Error).message });
        return { ok: false, error: "io-error" };
      }
    },
  };
}

/**
 * The two memory toggles (spark, dreaming) for a user, read at the moment a
 * caller is about to act on them — no snapshot, same rationale as
 * `UserAudioPolicy` (`session-handlers/user-audio-policy.ts`). Defaults to
 * `{spark: true, dreaming: true}` on any unreadable profile (missing,
 * corrupt, or a schema-valid profile predating this field) — a preference
 * that cannot be read must not silently turn a household feature off.
 *
 * A standalone function taking `store` rather than a fourth `ProfileStore`
 * interface method: `ProfileStore` is implemented ad hoc by dozens of test
 * doubles across the gateway (`{get, save, remove}` object literals) that
 * this task must not force open. `store.get` is already public, so nothing
 * new needs to be exposed to build this on top of it.
 */
export async function memoryTogglesFor(
  store: ProfileStore,
  userId: string,
): Promise<{ spark: boolean; dreaming: boolean }> {
  const result = await store.get(userId);
  if (!result.ok) {
    log.warn("memoryTogglesFor.fallback", {
      userId,
      reason: result.error,
      fallback: MEMORY_TOGGLES_DEFAULT,
    });
    return { ...MEMORY_TOGGLES_DEFAULT };
  }
  return result.value.memory;
}
