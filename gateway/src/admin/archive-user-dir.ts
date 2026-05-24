import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import { getArchiveDir, getGatewayRoot } from "../user-auth/paths.js";

const log = getLog(["sentient", "gateway", "admin", "archive-user-dir"]);

/**
 * Atomically rename a user directory to `_archive/<userId>-<isoTs>`.
 * ENOENT on the source dir maps to io-error (nothing to archive is still a
 * failure for the caller to decide on).
 */
export async function archiveUserDir(userId: string): Promise<Result<void, "io-error">> {
  const root = getGatewayRoot();
  const src = join(root, userId);
  const archiveDir = getArchiveDir();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(archiveDir, `${userId}-${ts}`);

  try {
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.rename(src, dest);
    log.info("archived", { userId, dest });
    return { ok: true, value: undefined };
  } catch (e: unknown) {
    log.warn("archive.io-error", { userId, reason: (e as Error).message });
    return { ok: false, error: "io-error" };
  }
}
