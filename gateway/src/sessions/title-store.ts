import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "sessions", "title-store"]);

export interface TitleStore {
  getTitle(sessionId: string): Promise<string | undefined>;
  getTitlesFor(sessionIds: readonly string[]): Promise<Record<string, string>>;
  setTitle(sessionId: string, title: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export interface TitleStoreConfig {
  /**
   * Per-user, per-category data root. The store writes to
   * `<userDataRoot>/<userId>/sessions/titles.json`. The user dir is mode
   * 0700; the file is mode 0600.
   */
  readonly userDataRoot: string;
  /** Profile id this store binds to. Validated to prevent path traversal. */
  readonly userId: string;
}

const USERID_RE = /^[A-Za-z0-9_-]+$/;

export function createTitleStore(cfg: TitleStoreConfig): TitleStore {
  if (!USERID_RE.test(cfg.userId)) {
    throw new Error(`invalid userId: ${cfg.userId}`);
  }
  const userDir = join(cfg.userDataRoot, cfg.userId);
  const sessionsDir = join(userDir, "sessions");
  const filePath = join(sessionsDir, "titles.json");

  let cache: Record<string, string> | null = null;

  const load = async (): Promise<Record<string, string>> => {
    if (cache) return cache;
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        log.warn("malformed-shape", { filePath });
        cache = {};
      } else {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string") out[k] = v;
        }
        cache = out;
      }
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") {
        cache = {};
      } else {
        log.warn("read-failed", { filePath, code });
        cache = {};
      }
    }
    return cache;
  };

  const persist = async (): Promise<void> => {
    if (!cache) return;
    await mkdir(sessionsDir, { recursive: true });
    await chmod(userDir, 0o700);
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(cache), { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, filePath);
  };

  return {
    async getTitle(sessionId) {
      const c = await load();
      return c[sessionId];
    },
    async getTitlesFor(ids) {
      const c = await load();
      const out: Record<string, string> = {};
      for (const id of ids) if (c[id] !== undefined) out[id] = c[id];
      return out;
    },
    async setTitle(sessionId, title) {
      const c = await load();
      c[sessionId] = title;
      log.info("setTitle", { sessionId, len: title.length });
      await persist();
    },
    async delete(sessionId) {
      const c = await load();
      if (c[sessionId] !== undefined) {
        delete c[sessionId];
        log.info("delete", { sessionId });
        await persist();
      }
    },
  };
}
