import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

/** First-install provisioning only. An established registry must never get a
 * replacement key. Back up this file separately from devices.db. */
export async function loadDeviceEscrowKey(path: string, registryPath: string): Promise<Uint8Array> {
  try {
    const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("device escrow key requires mode 0600");
      const key = await file.readFile();
      if (key.length !== 32) throw new Error("device escrow key must contain 32 bytes");
      return key;
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await fs.lstat(registryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Exclusive creation: never overwrite another startup's key, even on retry.
    const key = randomBytes(32);
    let file: FileHandle;
    try {
      file = await fs.open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return loadDeviceEscrowKey(path, registryPath);
      throw error;
    }
    try {
      await file.writeFile(key);
      await file.sync();
    } finally {
      await file.close();
    }
    const dir = await fs.open(dirname(path), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    return key;
  }
  throw new Error("device escrow key missing for established registry; restore original key from backup");
}
