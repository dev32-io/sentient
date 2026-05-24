import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { getLog } from "../logging/logger.js";
import { writeFileAtomic } from "./atomic-write.js";
import { getAuthSecretPath } from "./paths.js";

const log = getLog(["sentient", "gateway", "user-auth", "auth-secret"]);

const SECRET_KEY_BYTES = 32;
const ENV_OVERRIDE = "SENTIENT_AUTH_SECRET_KEY_BASE64";

function decodeBase64Strict(b64: string): Uint8Array {
  const buf = Buffer.from(b64, "base64");
  if (buf.toString("base64").replace(/=+$/, "") !== b64.replace(/=+$/, "")) {
    throw new Error(`${ENV_OVERRIDE}: not valid base64`);
  }
  return new Uint8Array(buf);
}

/**
 * Load the PASETO v4.local symmetric key.
 * Order of precedence:
 *   1. SENTIENT_AUTH_SECRET_KEY_BASE64 env var (32-byte base64).
 *   2. ~/.sentient/gateway/auth-secret.key (chmod 0600).
 *   3. Generate new 32 random bytes and persist at (2).
 */
export async function loadOrCreateAuthSecret(): Promise<Uint8Array> {
  const envValue = process.env[ENV_OVERRIDE];
  if (envValue !== undefined && envValue.length > 0) {
    const decoded = decodeBase64Strict(envValue);
    if (decoded.length !== SECRET_KEY_BYTES) {
      throw new Error(`${ENV_OVERRIDE}: expected ${SECRET_KEY_BYTES} bytes, got ${decoded.length}`);
    }
    log.info("load.env-override");
    return decoded;
  }

  const path = getAuthSecretPath();
  try {
    const raw = await fs.readFile(path);
    if (raw.length !== SECRET_KEY_BYTES) {
      throw new Error(`${path}: expected ${SECRET_KEY_BYTES} bytes, got ${raw.length}`);
    }
    log.info("load.from-disk", { path });
    return new Uint8Array(raw);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw err;
  }

  const fresh = new Uint8Array(randomBytes(SECRET_KEY_BYTES));
  await writeFileAtomic(path, fresh, { mode: 0o600 });
  log.info("generate.persisted", { path });
  return fresh;
}
