import { constants } from "node:fs";
import { access, chmod, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "sessions", "storage-migrator"]);

export interface MigrateLegacyTitlesArgs {
  /** Legacy: <legacyDir>/<userId>.json. */
  readonly legacyDir: string;
  /** New root: <newRoot>/<userId>/sessions/titles.json. */
  readonly newRoot: string;
  /** Profile id this migrator runs for. */
  readonly userId: string;
}

const USERID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * One-shot migrator: moves the legacy per-profile titles JSON
 * (`<legacyDir>/<userId>.json`) to the new per-user, per-category layout
 * (`<newRoot>/<userId>/sessions/titles.json`). Idempotent: if the new file
 * already exists, returns without touching anything. If the legacy file
 * does not exist, returns without creating the new layout.
 *
 * Sets the user dir to mode 0700 and the migrated file to 0600.
 */
export async function migrateLegacyTitles(args: MigrateLegacyTitlesArgs): Promise<void> {
  if (!USERID_RE.test(args.userId)) {
    throw new Error(`invalid userId: ${args.userId}`);
  }
  const legacyFile = join(args.legacyDir, `${args.userId}.json`);
  const userDir = join(args.newRoot, args.userId);
  const newDir = join(userDir, "sessions");
  const newFile = join(newDir, "titles.json");

  try {
    await access(legacyFile, constants.F_OK);
  } catch {
    log.debug("no-legacy-file", { legacyFile });
    return;
  }

  try {
    await access(newFile, constants.F_OK);
    log.info("already-migrated", { newFile });
    return;
  } catch {
    // newFile does not exist — proceed
  }

  await mkdir(newDir, { recursive: true });
  await chmod(userDir, 0o700);
  await rename(legacyFile, newFile);
  await chmod(newFile, 0o600);
  log.info("migrated", { from: legacyFile, to: newFile });
}
