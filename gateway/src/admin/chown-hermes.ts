import { promises as fs, type Dirent } from "node:fs";
import { join } from "node:path";
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import { getUserProfileDir } from "../user-auth/paths.js";

const log = getLog(["sentient", "gateway", "admin", "chown-hermes"]);

/** UID/GID the hermes overlay container runs as. The image declares
 *  `USER hermes` (uid=10000) — see `deploy/hermes-overlay/Dockerfile`. The
 *  gateway runs as root inside its own container; without chown, files it
 *  writes into the per-user data dir end up owned by root and the hermes
 *  container can't open per-user log files (EACCES on supervisord spawn).
 *  Override via env if a deploy uses a different uid mapping. */
const DEFAULT_HERMES_UID = 10000;
const DEFAULT_HERMES_GID = 10000;

function hermesUid(): number {
  const raw = process.env.SENTIENT_HERMES_UID;
  if (raw === undefined || raw === "") return DEFAULT_HERMES_UID;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_HERMES_UID;
}

function hermesGid(): number {
  const raw = process.env.SENTIENT_HERMES_GID;
  if (raw === undefined || raw === "") return DEFAULT_HERMES_GID;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_HERMES_GID;
}

async function chownRecursive(path: string, uid: number, gid: number): Promise<void> {
  await fs.chown(path, uid, gid);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(path, { withFileTypes: true });
  } catch {
    return; // not a directory, or unreadable — nothing further to walk
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await chownRecursive(child, uid, gid);
    } else {
      await fs.chown(child, uid, gid);
    }
  }
}

/** Hand ownership of a user's gateway-data dir tree to the hermes container's
 *  uid/gid. MUST run BEFORE supervisord upserts the per-user program — the
 *  hermes container's supervisord opens stdout/stderr log files inside the
 *  user dir on spawn, and EACCES makes the program enter FATAL state.
 *  Chown errors are logged but non-fatal: on hosts where the gateway lacks
 *  CAP_CHOWN (rare in docker), or where the underlying FS doesn't honour
 *  uid changes (some Docker Desktop variants), we proceed and let the
 *  caller's own write attempts surface concrete errors. */
export async function chownUserDirToHermes(userId: string): Promise<Result<void, "chown-error">> {
  const dir = getUserProfileDir(userId);
  const uid = hermesUid();
  const gid = hermesGid();
  try {
    await chownRecursive(dir, uid, gid);
    log.info("chown-user-dir.ok", { userId, dir, uid, gid });
    return { ok: true, value: undefined };
  } catch (err: unknown) {
    log.warn("chown-user-dir.failed", {
      userId,
      dir,
      uid,
      gid,
      reason: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "chown-error" };
  }
}
