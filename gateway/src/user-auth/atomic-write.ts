import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "gateway", "user-auth", "atomic-write"]);

export interface AtomicWriteOptions {
  mode?: number;
}

/**
 * Atomic file write: write to `<path>.tmp`, fsync, then rename.
 * No torn files on crash. Mode (if given) is applied before rename.
 */
export async function writeFileAtomic(
  path: string,
  content: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const tmp = `${path}.tmp`;
  await fs.mkdir(dirname(path), { recursive: true });
  const handle = await fs.open(tmp, "w", opts.mode ?? 0o644);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (opts.mode !== undefined) {
    await fs.chmod(tmp, opts.mode);
  }
  await fs.rename(tmp, path);
  log.debug("write-atomic", { path, bytes: content.length, mode: opts.mode });
}
