import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Delete `*.log` files in `dir` whose mtime is older than
 * `retentionDays` days ago. No-op when `retentionDays <= 0` or
 * when the directory does not exist (ENOENT). Other directory-level
 * errors (e.g. EACCES) propagate so misconfiguration surfaces. Per-file
 * errors are swallowed so one bad file never aborts the pass.
 */
export async function pruneOldLogs(dir: string, retentionDays: number): Promise<void> {
  if (retentionDays <= 0) return;
  const cutoffMs = Date.now() - retentionDays * MS_PER_DAY;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  for (const name of entries) {
    if (!name.endsWith(".log")) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (info.mtimeMs < cutoffMs) {
        await unlink(path);
      }
    } catch {
      // Per-file failure must not abort the prune pass.
    }
  }
}
