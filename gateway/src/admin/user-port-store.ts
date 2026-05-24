import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Result } from "@sentient/protocol";
import { z } from "zod";
import { getLog } from "../logging/logger.js";
import { writeFileAtomic } from "../user-auth/atomic-write.js";
import { assertUserId } from "../user-auth/user-id.js";

const log = getLog(["sentient", "gateway", "admin", "user-port-store"]);

const BindingSchema = z.object({
  userId: z.string().min(1),
  port: z.number().int().positive(),
});
export type UserPortBinding = z.infer<typeof BindingSchema>;

const FileSchema = z.array(BindingSchema);

/** Legacy schema — `slot-bindings.json` had `slotKey` column. We project away. */
const LegacyBindingSchema = z.object({
  userId: z.string().min(1),
  port: z.number().int().positive(),
  slotKey: z.string().optional(),
});
const LegacyFileSchema = z.array(LegacyBindingSchema);

export type UserPortError = "io-error" | "corrupt-file" | "port-allocation-failed";

export interface UserPortStore {
  list(): Promise<Result<UserPortBinding[], UserPortError>>;
  /** Allocate next free port at-or-above `portBase` and persist binding. */
  bind(userId: string): Promise<Result<UserPortBinding, UserPortError>>;
  unbind(userId: string): Promise<Result<void, UserPortError>>;
  resolvePort(userId: string): Promise<number | null>;
}

export interface UserPortStoreConfig {
  rootDir: string;
  portBase: number;
}

export function createUserPortStore(cfg: UserPortStoreConfig): UserPortStore {
  const filePath = join(cfg.rootDir, "user-ports.json");
  const legacyPath = join(cfg.rootDir, "slot-bindings.json");

  async function read(): Promise<Result<UserPortBinding[], UserPortError>> {
    const fromNew = await readFile(filePath);
    if (fromNew.kind === "ok") return { ok: true, value: fromNew.value };
    if (fromNew.kind === "corrupt") return { ok: false, error: "corrupt-file" };
    if (fromNew.kind === "io-error") return { ok: false, error: "io-error" };
    // fromNew.kind === "missing" — fall through to legacy migration

    const fromLegacy = await readLegacy(legacyPath);
    if (fromLegacy.kind === "missing") return { ok: true, value: [] };
    if (fromLegacy.kind === "corrupt") return { ok: false, error: "corrupt-file" };
    if (fromLegacy.kind === "io-error") return { ok: false, error: "io-error" };

    log.info("migrate.from-legacy", { count: fromLegacy.value.length, legacyPath });
    const w = await write(fromLegacy.value);
    if (!w.ok) return w;
    return { ok: true, value: fromLegacy.value };
  }

  async function write(items: UserPortBinding[]): Promise<Result<void, UserPortError>> {
    try {
      await writeFileAtomic(filePath, JSON.stringify(items, null, 2), { mode: 0o600 });
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      log.warn("write.io-error", { reason: (e as Error).message });
      return { ok: false, error: "io-error" };
    }
  }

  return {
    async list() {
      return read();
    },

    async bind(userId) {
      assertUserId(userId);
      const r = await read();
      if (!r.ok) return r;
      const existing = r.value.find((b) => b.userId === userId);
      if (existing) {
        log.info("bind.idempotent", { userId, port: existing.port });
        return { ok: true, value: existing };
      }
      const port = nextFreePort(cfg.portBase, r.value);
      const binding: UserPortBinding = { userId, port };
      const next = [...r.value, binding];
      log.info("bind", { userId, port });
      const w = await write(next);
      if (!w.ok) return w;
      return { ok: true, value: binding };
    },

    async unbind(userId) {
      assertUserId(userId);
      const r = await read();
      if (!r.ok) return r;
      log.info("unbind", { userId });
      return write(r.value.filter((b) => b.userId !== userId));
    },

    async resolvePort(userId) {
      if (!/^u_[a-f0-9]{8}$/.test(userId)) return null;
      const r = await read();
      if (!r.ok) return null;
      return r.value.find((b) => b.userId === userId)?.port ?? null;
    },
  };
}

/**
 * Pure: lowest port at-or-above `base` not present in `bindings`. Monotonic,
 * unbounded — no pool cap, no slot index.
 */
export function nextFreePort(base: number, bindings: readonly UserPortBinding[]): number {
  const used = new Set(bindings.map((b) => b.port));
  let p = base;
  while (used.has(p)) p++;
  return p;
}

type ReadOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "missing" }
  | { kind: "corrupt"; reason: string }
  | { kind: "io-error"; reason: string };

async function readFile(path: string): Promise<ReadOutcome<UserPortBinding[]>> {
  try {
    const raw = await fs.readFile(path, "utf8");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { kind: "corrupt", reason: "invalid JSON" };
    }
    const parsed = FileSchema.safeParse(json);
    if (!parsed.success) return { kind: "corrupt", reason: parsed.error.message };
    return { kind: "ok", value: parsed.data };
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "io-error", reason: (e as Error).message };
  }
}

async function readLegacy(path: string): Promise<ReadOutcome<UserPortBinding[]>> {
  try {
    const raw = await fs.readFile(path, "utf8");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { kind: "corrupt", reason: "invalid JSON" };
    }
    const parsed = LegacyFileSchema.safeParse(json);
    if (!parsed.success) return { kind: "corrupt", reason: parsed.error.message };
    const projected: UserPortBinding[] = parsed.data
      .filter((row) => typeof row.port === "number")
      .map((row) => ({ userId: row.userId, port: row.port as number }));
    return { kind: "ok", value: projected };
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "io-error", reason: (e as Error).message };
  }
}
