import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type Result, USER_ROLES } from "@sentient/protocol";
import { decrypt, encrypt } from "paseto-ts/v4";
import { z } from "zod";
import type { Capability } from "../access/capability.js";
import { type UserPrincipal, createUserPrincipal } from "../identity/user-principal.js";
import type { UserRecord } from "./types.js";
import type { UserStore } from "./user-store.js";

// Service contract v1. Human management and device execution use separate
// purposes. Only validate() mints immutable device execution authority.
const id = z.string().uuid();
const secret = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .refine((s) => Buffer.from(s, "base64url").toString("base64url") === s);
const binding = z
  .object({ version: z.literal(1), deviceId: id, attemptId: id, generation: z.number().int().positive() })
  .strict();
export const deviceBeginSchema = z
  .object({ version: z.literal(1), deviceId: id, attemptId: id, enrollmentSecret: secret, managerSecret: secret })
  .strict();
export const deviceRedeemSchema = binding.extend({ enrollmentSecret: secret, renewalSecret: secret }).strict();
export const deviceRenewSchema = binding.extend({ renewalSecret: secret }).strict();
export type DeviceBegin = z.infer<typeof deviceBeginSchema>;
export type DeviceProof = z.infer<typeof deviceRenewSchema>;
export type DeviceRedeem = z.infer<typeof deviceRedeemSchema>;
export type DeviceError = "invalid-request" | "denied" | "conflict" | "expired" | "escrow-unavailable";
type Outcome<T> = Result<T, DeviceError>;
const fail = (error: DeviceError): Outcome<never> => ({ ok: false, error });
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const PURPOSE = "sentient.device-session.v1";

const recordSchema = binding.extend({
  ownerId: z.string(),
  ownerCreatedAt: z.string(),
  ownerRole: z.enum(USER_ROLES),
  ownerRevision: z.string(),
  deviceClass: z.literal("cube"),
  status: z.enum(["pending", "committed", "active", "disabled"]),
  expiresAt: z.number(),
  enrollmentVerifier: z.string(),
  renewalVerifier: z.string().nullable(),
  escrow: z.string(),
});
type DeviceRecord = z.infer<typeof recordSchema>;
export type DeviceStatus = Pick<
  DeviceRecord,
  "version" | "deviceId" | "attemptId" | "generation" | "deviceClass" | "status" | "expiresAt"
>;
function status(r: DeviceRecord): DeviceStatus {
  const { version, deviceId, attemptId, generation, deviceClass, status, expiresAt } = r;
  return { version, deviceId, attemptId, generation, deviceClass, status, expiresAt };
}
function associatedData(r: z.infer<typeof binding> & { ownerId: string }): Buffer {
  return Buffer.from(JSON.stringify([r.version, r.ownerId, r.deviceId, r.attemptId, r.generation]));
}

export interface DeviceCredential {
  readonly principal: UserPrincipal;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** Synchronous registry/lifetime fence, including after async authorization. */
  live(): boolean;
  current(): Promise<boolean>;
}

export interface DeviceRegistryOptions {
  /** Runs synchronously BEFORE retiring registry authority; failures prevent mutation. */
  onRetire?: (principal: UserPrincipal) => void;

  path: string;
  users: Pick<UserStore, "get">;
  accessKey: Uint8Array;
  /** Separate protected 32-byte key. Never generate a replacement on read failure. */
  escrowKey: Uint8Array;
  accessTtlSeconds: number;
  attemptTtlSeconds: number;
}

export function createDeviceRegistry(opts: DeviceRegistryOptions) {
  if (
    opts.accessKey.length !== 32 ||
    opts.escrowKey?.length !== 32 ||
    Buffer.from(opts.accessKey).equals(Buffer.from(opts.escrowKey))
  ) {
    throw new Error("device registry requires distinct 32-byte access and escrow keys");
  }
  for (const ttl of [opts.accessTtlSeconds, opts.attemptTtlSeconds]) {
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 604800) throw new Error("device TTL must be 1..604800 seconds");
  }
  const escrowKey = Buffer.from(opts.escrowKey);
  const localKey = `k4.local.${Buffer.from(opts.accessKey).toString("base64url")}`;
  mkdirSync(dirname(opts.path), { recursive: true, mode: 0o700 });
  const db = new Database(opts.path, { create: true });
  const read = (deviceId: string): DeviceRecord | null => {
    const row = db
      .query<{ record: string }, [string]>("SELECT record FROM devices_v1 WHERE device_id = ?")
      .get(deviceId);
    return row ? recordSchema.parse(JSON.parse(row.record)) : null;
  };
  const save = (r: DeviceRecord) => {
    db.query("INSERT INTO devices_v1 VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET record = excluded.record").run(
      r.deviceId,
      JSON.stringify(r),
    );
  };
  const seal = (r: DeviceRecord, plaintext: string): string => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", escrowKey, nonce);
    cipher.setAAD(associatedData(r));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url");
  };
  const open = (r: DeviceRecord): string => {
    const bytes = Buffer.from(r.escrow, "base64url");
    const cipher = createDecipheriv("aes-256-gcm", escrowKey, bytes.subarray(0, 12));
    cipher.setAAD(associatedData(r));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return secret.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8"));
  };
  try {
    chmodSync(opts.path, 0o600);
    // Single host database; synchronous transactions serialize claims across handles.
    db.exec("PRAGMA synchronous = FULL; PRAGMA busy_timeout = 1000; PRAGMA secure_delete = ON;");
    db.exec("CREATE TABLE IF NOT EXISTS devices_v1 (device_id TEXT PRIMARY KEY, record TEXT NOT NULL)");
    // Fence in-flight owner lookups that started before durable account deletion.
    // Device rows alone cannot fence a first enrollment that has not committed yet.
    db.exec("CREATE TABLE IF NOT EXISTS deleted_device_owners_v1 (owner_id TEXT PRIMARY KEY)");
    // Reject wrong backup keys and corrupt retained secrets before any lifecycle
    // method can issue access or seal another device under a different key.
    for (const row of db.query<{ record: string }, []>("SELECT record FROM devices_v1").all()) {
      const record = recordSchema.parse(JSON.parse(row.record));
      if (record.escrow) open(record); // Deleted-owner tombstones intentionally have no escrow.
    }
  } catch {
    db.close();
    throw new Error("device registry initialization failed");
  }
  const currentOwner = async (ownerId: string): Promise<UserRecord | null> => {
    const user = await opts.users.get(ownerId);
    return user.ok ? user.value : null;
  };
  const authorized = async (cap: Capability) => {
    if (cap.resource !== "device-registry" || cap.origin !== undefined) return null;
    const user = await currentOwner(cap.ownerUserId);
    return user && user.role === cap.role ? user : null;
  };
  const ownerMatches = (r: DeviceRecord, user: UserRecord | null) =>
    user !== null &&
    r.ownerId === user.userId &&
    r.ownerCreatedAt === user.createdAt &&
    r.ownerRole === user.role &&
    r.ownerRevision === (user.deviceAuthorityRevision ?? "0");
  const proofMatches = (r: DeviceRecord, p: DeviceProof) =>
    r.attemptId === p.attemptId && r.generation === p.generation && r.renewalVerifier === digest(p.renewalSecret);
  const access = (r: DeviceRecord) => {
    const now = Date.now();
    return {
      ...status(r),
      token: encrypt(
        localKey,
        {
          purpose: PURPOSE,
          sub: r.deviceId,
          generation: r.generation,
          iat: new Date(now).toISOString(),
          exp: new Date(now + opts.accessTtlSeconds * 1000).toISOString(),
        },
        { addIat: false, addExp: false },
      ),
    };
  };

  const authorityEpochs = new Map<string, number>();
  function retireOwner(principal: UserPrincipal): void {
    authorityEpochs.set(principal.userId, (authorityEpochs.get(principal.userId) ?? 0) + 1);
    const records = db
      .query<{ record: string }, []>("SELECT record FROM devices_v1")
      .all()
      .map((row) => recordSchema.parse(JSON.parse(row.record)))
      .filter((r) => r.ownerId === principal.userId);
    // No device grant ever existed: preserve ordinary users' storage behavior.
    // The epoch still fences a first enrollment lookup started before this hook.
    if (records.length === 0) return;
    opts.onRetire?.(principal);
    db.transaction(() => {
      for (const r of records) {
        if (r.status === "disabled") continue;
        r.status = "disabled";
        save(r);
      }
    }).immediate();
  }

  return {
    retireOwner,
    close() {
      db.close();
    },
    async begin(cap: Capability, input: DeviceBegin): Promise<Outcome<DeviceStatus>> {
      const parsed = deviceBeginSchema.safeParse(input);
      if (!parsed.success) return fail("invalid-request");
      const epoch = authorityEpochs.get(cap.ownerUserId) ?? 0;
      const user = await authorized(cap);
      if (!user) return fail("denied");
      const p = parsed.data;
      return db
        .transaction((): Outcome<DeviceStatus> => {
          if ((authorityEpochs.get(cap.ownerUserId) ?? 0) !== epoch) return fail("denied");
          if (db.query("SELECT 1 FROM deleted_device_owners_v1 WHERE owner_id = ?").get(user.userId))
            return fail("denied");
          const old = read(p.deviceId);
          if (old && (old.ownerId !== user.userId || old.ownerCreatedAt !== user.createdAt)) return fail("denied");
          if (old?.attemptId === p.attemptId) {
            if (!ownerMatches(old, user) || old.enrollmentVerifier !== digest(p.enrollmentSecret))
              return fail("conflict");
            if (old.status === "disabled") return fail("denied");
            if (old.status === "pending" && Date.now() >= old.expiresAt) return fail("expired");
            try {
              if (open(old) !== p.managerSecret) return fail("conflict");
            } catch {
              return fail("escrow-unavailable");
            }
            return ok(status(old));
          }
          // Fresh owner authorization cannot replace a live/pending transaction.
          // Explicit disable first; ownership is never released, including expiry.
          if (old && old.status !== "disabled") return fail("conflict");
          if (old) {
            // Re-enrollment is not manager rotation. Preserve offline BLE recovery
            // even if the replacement attempt never reaches the Cube.
            try {
              if (open(old) !== p.managerSecret) return fail("conflict");
            } catch {
              return fail("escrow-unavailable");
            }
          }
          const r: DeviceRecord = {
            version: 1,
            deviceId: p.deviceId,
            attemptId: p.attemptId,
            generation: (old?.generation ?? 0) + 1,
            ownerId: user.userId,
            ownerCreatedAt: user.createdAt,
            ownerRole: user.role,
            ownerRevision: user.deviceAuthorityRevision ?? "0",
            deviceClass: "cube",
            status: "pending",
            expiresAt: Date.now() + opts.attemptTtlSeconds * 1000,
            enrollmentVerifier: digest(p.enrollmentSecret),
            renewalVerifier: null,
            escrow: "",
          };
          r.escrow = seal(r, p.managerSecret);
          save(r);
          return ok(status(r));
        })
        .immediate();
    },
    async redeem(input: DeviceRedeem): Promise<Outcome<DeviceStatus>> {
      const parsed = deviceRedeemSchema.safeParse(input);
      if (!parsed.success) return fail("invalid-request");
      const p = parsed.data;
      const initial = read(p.deviceId);
      if (!initial) return fail("denied");
      const user = await currentOwner(initial.ownerId);
      return db
        .transaction((): Outcome<DeviceStatus> => {
          const r = read(p.deviceId);
          if (
            !r ||
            !ownerMatches(r, user) ||
            r.status === "disabled" ||
            r.attemptId !== p.attemptId ||
            r.generation !== p.generation ||
            r.enrollmentVerifier !== digest(p.enrollmentSecret)
          )
            return fail("denied");
          if (r.status !== "pending") return proofMatches(r, p) ? ok(status(r)) : fail("conflict");
          if (Date.now() >= r.expiresAt) return fail("expired");
          // Verifier and committed acknowledgement are one durable write. No token
          // before activation; a lost reply is recovered with the persisted proof.
          r.renewalVerifier = digest(p.renewalSecret);
          r.status = "committed";
          save(r);
          return ok(status(r));
        })
        .immediate();
    },
    async renew(input: DeviceProof): Promise<Outcome<DeviceStatus & { token?: string }>> {
      const parsed = deviceRenewSchema.safeParse(input);
      if (!parsed.success) return fail("invalid-request");
      const p = parsed.data;
      const initial = read(p.deviceId);
      if (!initial) return fail("denied");
      const user = await currentOwner(initial.ownerId);
      const r = read(p.deviceId);
      if (!r || !ownerMatches(r, user) || !proofMatches(r, p) || r.status === "disabled") return fail("denied");
      return ok(r.status === "active" ? access(r) : status(r));
    },
    // Cube sends only AFTER manager state and renewal proof are durable and
    // bootstrap access is retired. Matching attempt/generation is escrow version.
    async activate(input: DeviceProof): Promise<Outcome<DeviceStatus & { token: string }>> {
      const parsed = deviceRenewSchema.safeParse(input);
      if (!parsed.success) return fail("invalid-request");
      const p = parsed.data;
      const initial = read(p.deviceId);
      if (!initial) return fail("denied");
      const user = await currentOwner(initial.ownerId);
      return db
        .transaction((): Outcome<DeviceStatus & { token: string }> => {
          const r = read(p.deviceId);
          if (
            !r ||
            !ownerMatches(r, user) ||
            !proofMatches(r, p) ||
            (r.status !== "committed" && r.status !== "active")
          )
            return fail("denied");
          try {
            open(r);
          } catch {
            return fail("escrow-unavailable");
          }
          r.status = "active";
          save(r);
          return ok(access(r));
        })
        .immediate();
    },
    async validate(token: string) {
      try {
        const claims = z.object({
          purpose: z.literal(PURPOSE),
          sub: id,
          generation: z.number().int().positive(),
          iat: z.string().datetime(),
          exp: z.string().datetime(),
        });
        const p = claims.parse(decrypt(localKey, token).payload);
        const initial = read(p.sub);
        if (!initial) return fail("denied");
        const user = await currentOwner(initial.ownerId);
        const r = read(p.sub);
        if (!r || !ownerMatches(r, user) || r.generation !== p.generation || r.status !== "active")
          return fail("denied");
        if (!user || Date.now() >= Date.parse(p.exp)) return fail("denied");
        // Mint only from the current registry/owner check, never client metadata.
        const principal = Object.freeze({
          ...createUserPrincipal(user.userId, user.role, "home"),
          origin: Object.freeze({ kind: "cube" as const, deviceId: r.deviceId, generation: r.generation }),
        });
        const live = () => {
          try {
            const latest = read(p.sub);
            return (
              Date.now() < Date.parse(p.exp) &&
              latest !== null &&
              latest.status === "active" &&
              latest.generation === p.generation &&
              latest.ownerId === r.ownerId &&
              latest.ownerRevision === r.ownerRevision &&
              latest.ownerRole === r.ownerRole
            );
          } catch {
            return false;
          }
        };
        return ok(
          Object.freeze({
            principal,
            live,
            current: async () => {
              try {
                if (!live()) return false;
                const owner = await currentOwner(r.ownerId);
                return live() && ownerMatches(r, owner);
              } catch {
                return false;
              }
            },
            userId: user.userId,
            role: user.role,
            deviceId: r.deviceId,
            deviceClass: r.deviceClass,
            generation: r.generation,
            issuedAt: Date.parse(p.iat) / 1000,
            expiresAt: Date.parse(p.exp) / 1000,
          }),
        );
      } catch {
        return fail("denied");
      }
    },
    async list(cap: Capability): Promise<Outcome<DeviceStatus[]>> {
      const user = await authorized(cap);
      if (!user) return fail("denied");
      const rows = db.query<{ record: string }, []>("SELECT record FROM devices_v1").all();
      return ok(
        rows
          .map((row) => recordSchema.parse(JSON.parse(row.record)))
          .filter((r) => r.ownerId === user.userId && r.ownerCreatedAt === user.createdAt)
          .map(status),
      );
    },
    async recover(cap: Capability, deviceId: string): Promise<Outcome<DeviceStatus & { managerSecret: string }>> {
      const user = await authorized(cap);
      const r = read(deviceId);
      if (!user || !r || r.ownerId !== user.userId || r.ownerCreatedAt !== user.createdAt) return fail("denied");
      try {
        return ok({ ...status(r), managerSecret: open(r) });
      } catch {
        return fail("escrow-unavailable");
      }
    },
    async disable(cap: Capability, deviceId: string): Promise<Outcome<DeviceStatus>> {
      const user = await authorized(cap);
      if (!user) return fail("denied");
      return db
        .transaction((): Outcome<DeviceStatus> => {
          const r = read(deviceId);
          if (!r || r.ownerId !== user.userId || r.ownerCreatedAt !== user.createdAt) return fail("denied");
          opts.onRetire?.(createUserPrincipal(r.ownerId, r.ownerRole, "home"));
          if (r.status !== "disabled") {
            r.status = "disabled";
            save(r);
          }
          return ok(status(r));
        })
        .immediate();
    },
    /** Reconcile crashes between durable account deletion and lifecycle delivery. */
    async purgeDeletedOwners(): Promise<void> {
      const rows = db.query<{ record: string }, []>("SELECT record FROM devices_v1").all();
      const ownerIds = new Set(rows.map((row) => recordSchema.parse(JSON.parse(row.record)).ownerId));
      for (const ownerId of ownerIds) {
        const user = await opts.users.get(ownerId);
        if (!user.ok) throw new Error("device owner reconciliation unavailable");
        const records = rows
          .map((row) => recordSchema.parse(JSON.parse(row.record)))
          .filter((r) => r.ownerId === ownerId);
        const stale = records.find((r) => r.status === "active" && !ownerMatches(r, user.value));
        // Disabled records were fenced before their durable status changed. Do
        // not close a healthy sibling's newer daily history on every restart.
        if (stale) retireOwner(createUserPrincipal(ownerId, stale.ownerRole, "home"));
        if (user.value === null) {
          const result = await this.purgeDeletedOwner(ownerId);
          if (!result.ok) throw new Error("device owner purge unavailable");
        }
      }
    },
    /** Lifecycle adapter must call after durable account deletion. Retain claim
     * tombstones: deleting secrets must not make hardware transferable. */
    async purgeDeletedOwner(ownerId: string): Promise<Outcome<void>> {
      // An unreadable owner store is NOT proof of deletion.
      const user = await opts.users.get(ownerId);
      if (!user.ok || user.value !== null) return fail("denied");
      const owned = db
        .query<{ record: string }, []>("SELECT record FROM devices_v1")
        .all()
        .map((row) => recordSchema.parse(JSON.parse(row.record)))
        .find((r) => r.ownerId === ownerId);
      if (owned) opts.onRetire?.(createUserPrincipal(ownerId, owned.ownerRole, "home"));
      db.transaction(() => {
        db.query("INSERT OR IGNORE INTO deleted_device_owners_v1 (owner_id) VALUES (?)").run(ownerId);
        const rows = db.query<{ record: string }, []>("SELECT record FROM devices_v1").all();
        for (const row of rows) {
          const r = recordSchema.parse(JSON.parse(row.record));
          if (r.ownerId !== ownerId) continue;
          r.status = "disabled";
          r.escrow = "";
          r.renewalVerifier = null;
          r.enrollmentVerifier = "";
          save(r);
        }
      }).immediate();
      return ok(undefined);
    },
  };
}

export type DeviceRegistry = ReturnType<typeof createDeviceRegistry>;
