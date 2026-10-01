import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { loadDeviceEscrowKey } from "./device-escrow-key.js";

let root: string;
let path: string;
let db: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "device-key-"));
  path = join(root, "device-escrow.key");
  db = join(root, "devices.db");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it("provisions a separate restricted durable key on first install and reuses it after registry exists", async () => {
  const key = await loadDeviceEscrowKey(path, db);
  expect(key.byteLength).toBe(32);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  writeFileSync(db, "established");
  expect(await loadDeviceEscrowKey(path, db)).toEqual(key);
  expect(readFileSync(path)).toEqual(Buffer.from(key));
});
it("never replaces a missing established, malformed, permissive or symlinked key", async () => {
  writeFileSync(db, "established");
  await expect(loadDeviceEscrowKey(path, db)).rejects.toThrow("restore original key");
  expect(existsSync(path)).toBe(false);
  writeFileSync(path, "bad", { mode: 0o600 });
  await expect(loadDeviceEscrowKey(path, db)).rejects.toThrow("32 bytes");
  expect(readFileSync(path, "utf8")).toBe("bad");
  writeFileSync(path, Buffer.alloc(32));
  chmodSync(path, 0o644);
  await expect(loadDeviceEscrowKey(path, db)).rejects.toThrow("0600");
  rmSync(path);
  symlinkSync(join(root, "missing-target"), path);
  await expect(loadDeviceEscrowKey(path, db)).rejects.toThrow();
  expect(existsSync(join(root, "missing-target"))).toBe(false);
});
