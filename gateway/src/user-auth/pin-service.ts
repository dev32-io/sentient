import { getLog } from "../logging/logger.js";
import type { Argon2Params } from "./types.js";

const log = getLog(["sentient", "gateway", "user-auth", "pin-service"]);

/** Hash a PIN with argon2id. Rejects empty pin. */
export async function hashPin(pin: string, params: Argon2Params): Promise<string> {
  if (pin.length === 0) {
    throw new Error("hashPin: empty pin");
  }
  const hash = await Bun.password.hash(pin, {
    algorithm: "argon2id",
    memoryCost: params.memoryKb,
    timeCost: params.iterations,
  });
  log.debug("hash", { memoryKb: params.memoryKb, iterations: params.iterations });
  return hash;
}

/** Verify a PIN against a stored argon2id hash. Returns false on any error. */
export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  if (pin.length === 0) return false;
  try {
    return await Bun.password.verify(pin, hash);
  } catch (e: unknown) {
    log.debug("verify.reject", { reason: (e as Error).message });
    return false;
  }
}
