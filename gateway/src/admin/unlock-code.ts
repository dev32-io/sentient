// gateway/src/admin/unlock-code.ts
import { randomInt, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "gateway", "admin", "unlock-code"]);

const CODE_LENGTH = 6;
const CODE_FILE_MODE = 0o600;

export interface UnlockCodeConfig {
  codePath: string;
}

export interface UnlockCode {
  ensure(): Promise<string>;
  verify(input: string): Promise<boolean>;
  clear(): Promise<void>;
}

function generate(): string {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) s += String(randomInt(0, 10));
  return s;
}

export function createUnlockCode(cfg: UnlockCodeConfig): UnlockCode {
  async function readExisting(): Promise<string | null> {
    try {
      const raw = await fs.readFile(cfg.codePath, "utf8");
      const trimmed = raw.trim();
      return /^\d{6}$/.test(trimmed) ? trimmed : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  return {
    async ensure() {
      const existing = await readExisting();
      if (existing) return existing;
      const code = generate();
      await fs.mkdir(dirname(cfg.codePath), { recursive: true });
      const handle = await fs.open(cfg.codePath, "w", CODE_FILE_MODE);
      try {
        await handle.write(code);
        await handle.chmod(CODE_FILE_MODE);
      } finally {
        await handle.close();
      }
      log.info("unlock-code.generated", { path: cfg.codePath });
      log.info("unlock-code.banner", {
        message: "Sentient bootstrap unlock code",
        code,
        location: cfg.codePath,
      });
      return code;
    },

    async verify(input) {
      const existing = await readExisting();
      if (!existing) return false;
      if (input.length !== existing.length) return false;
      return timingSafeEqual(Buffer.from(input), Buffer.from(existing));
    },

    async clear() {
      try {
        await fs.unlink(cfg.codePath);
        log.info("unlock-code.cleared");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },
  };
}
