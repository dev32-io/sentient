import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PushBinding, PushRegistrationRequest, PushRevokeRequest } from "@sentient/protocol";
import type { PrivatePushResource } from "../access/private-push-resource.js";
import type { UserId } from "../user-auth/user-id.js";
import type {
  IssuedPushRegistration,
  PushBindingDestination,
  PushBindingDirectory,
  PushDeliveryReceipt,
  PushRegistrationAuthority,
  PushResult,
  PushRevocationAuthority,
} from "./contracts.js";

interface BindingRow {
  binding_id: string;
  generation: number;
  owner_user_id: string;
  installation_id: string;
  token: string;
  state: "active" | "disabled" | "pending-old-binding-disable";
  enabled: number;
  preview_mode: "hidden" | "content";
  revision: number;
  replaces_binding_id: string | null;
  replaces_generation: number | null;
  credential_verifier: string;
  credential_expires_at: string;
  created_at: string;
  updated_at: string;
}
interface IdempotencyRow {
  binding_id: string;
  generation: number;
  fingerprint: string;
}
interface FenceRow {
  binding_id: string;
  generation: number;
}
interface RevokeRow {
  binding_id: string;
  generation: number;
  status: "revoked" | "already-revoked";
  acknowledged_at: string;
  fingerprint: string;
}
interface RevocationAuthorityRow {
  credential_expires_at: string;
}

export interface PushReceiptStore {
  read(deliveryId: string, bindingId: string, generation: number): Promise<PushDeliveryReceipt | null>;
  record(deliveryId: string, bindingId: string, generation: number, receipt: PushDeliveryReceipt): Promise<void>;
}

export interface PushTokenInvalidator {
  disableDestination(bindingId: string, generation: number, at: Date): Promise<void>;
}

export interface PushStore
  extends PushRegistrationAuthority,
    PushRevocationAuthority,
    PushBindingDirectory,
    PushReceiptStore,
    PushTokenInvalidator {
  close(): void;
}

export interface PushStoreOptions {
  revocationTtlMs: number;
  randomCredential?: () => string;
  randomBindingId?: () => string;
}

const DDL = `
CREATE TABLE IF NOT EXISTS push_bindings (
 binding_id TEXT NOT NULL, generation INTEGER NOT NULL, owner_user_id TEXT NOT NULL,
 installation_id TEXT NOT NULL, token TEXT NOT NULL, state TEXT NOT NULL,
 enabled INTEGER NOT NULL, preview_mode TEXT NOT NULL, revision INTEGER NOT NULL,
 replaces_binding_id TEXT, replaces_generation INTEGER, credential_verifier TEXT NOT NULL,
 credential_expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(binding_id, generation)
);
CREATE TABLE IF NOT EXISTS push_installation_fences (
 installation_id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, generation INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_registration_idempotency (
 owner_user_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
 binding_id TEXT NOT NULL, generation INTEGER NOT NULL,
 PRIMARY KEY(owner_user_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS push_revocation_idempotency (
 idempotency_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, binding_id TEXT NOT NULL,
 generation INTEGER NOT NULL, status TEXT NOT NULL, acknowledged_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_revocation_authorities (
 binding_id TEXT NOT NULL, generation INTEGER NOT NULL, credential_verifier TEXT NOT NULL,
 credential_expires_at TEXT NOT NULL,
 PRIMARY KEY(binding_id, generation, credential_verifier)
);
CREATE TABLE IF NOT EXISTS push_delivery_receipts (
 delivery_id TEXT NOT NULL, binding_id TEXT NOT NULL, generation INTEGER NOT NULL,
 provider_message_id TEXT, accepted_at TEXT NOT NULL,
 PRIMARY KEY(delivery_id, binding_id, generation)
);
CREATE INDEX IF NOT EXISTS push_bindings_owner_active ON push_bindings(owner_user_id, state);
`;

function fail<T>(code: Parameters<typeof failure>[0], retryable = false): PushResult<T> {
  return { ok: false, error: failure(code, retryable) };
}
function failure(
  code:
    | "validation"
    | "forbidden"
    | "not_found"
    | "conflict"
    | "idempotency_conflict"
    | "invalid_revocation_authority"
    | "expired_revocation_authority"
    | "binding_generation_mismatch"
    | "old_binding_active"
    | "provider_unavailable"
    | "internal",
  retryable = false,
) {
  return { code, retryable } as const;
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function fingerprint(value: unknown): string {
  return digest(JSON.stringify(value));
}
function credentialMatches(candidate: string, verifier: string): boolean {
  const actual = Buffer.from(digest(candidate), "hex");
  const expected = Buffer.from(verifier, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function rowBinding(row: BindingRow): PushBinding {
  const common = {
    bindingId: row.binding_id,
    installationId: row.installation_id,
    platform: "ios" as const,
    generation: row.generation,
    preferences: { enabled: row.enabled === 1, previewMode: row.preview_mode, revision: row.revision },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.state === "disabled") return { ...common, state: "disabled" };
  if (row.state === "pending-old-binding-disable" && row.replaces_binding_id && row.replaces_generation)
    return {
      ...common,
      state: "pending-old-binding-disable",
      replaces: { bindingId: row.replaces_binding_id, generation: row.replaces_generation },
    };
  return row.replaces_binding_id && row.replaces_generation
    ? {
        ...common,
        state: "active",
        replaces: { bindingId: row.replaces_binding_id, generation: row.replaces_generation },
      }
    : { ...common, state: "active" };
}

export function openPushStore(databasePath: string, options: PushStoreOptions): PushStore {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new Database(databasePath, { create: true, strict: true });
  try {
    chmodSync(databasePath, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(DDL);
  const randomCredential = options.randomCredential ?? (() => randomBytes(32).toString("base64url"));
  const randomBindingId = options.randomBindingId ?? (() => `bind_${crypto.randomUUID()}`);

  const binding = (id: string, generation: number): BindingRow | null =>
    db
      .query("SELECT * FROM push_bindings WHERE binding_id = ? AND generation = ?")
      .get(id, generation) as BindingRow | null;

  function transact<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    async issue(resource: PrivatePushResource, request: PushRegistrationRequest, now: Date) {
      const owner = resource.ownerUserId;
      const requestFingerprint = fingerprint(request);
      const credential = randomCredential();
      const expiresAt = new Date(now.getTime() + options.revocationTtlMs).toISOString();
      try {
        return transact<PushResult<IssuedPushRegistration>>(() => {
          const replay = db
            .query(
              "SELECT binding_id, generation, fingerprint FROM push_registration_idempotency WHERE owner_user_id = ? AND idempotency_key = ?",
            )
            .get(owner, request.idempotencyKey) as IdempotencyRow | null;
          if (replay) {
            if (replay.fingerprint !== requestFingerprint) return fail("idempotency_conflict");
            let row = binding(replay.binding_id, replay.generation);
            if (!row) return fail("internal");
            if (row.state === "pending-old-binding-disable" && row.replaces_binding_id && row.replaces_generation) {
              const old = binding(row.replaces_binding_id, row.replaces_generation);
              if (old?.state !== "active") {
                db.query(
                  "UPDATE push_bindings SET state = 'active', updated_at = ? WHERE binding_id = ? AND generation = ? AND state = 'pending-old-binding-disable'",
                ).run(now.toISOString(), row.binding_id, row.generation);
                row = binding(row.binding_id, row.generation);
                if (!row) return fail("internal");
              }
            }
            // Registration retries may race and responses may arrive out of order. Keep
            // every verifier issued for this exact binding valid instead of rotating the
            // previous revoke-only authority out from under an earlier response.
            db.query("INSERT OR IGNORE INTO push_revocation_authorities VALUES (?, ?, ?, ?)").run(
              row.binding_id,
              row.generation,
              digest(credential),
              expiresAt,
            );
            return {
              ok: true,
              value: {
                binding: rowBinding(row),
                revocation: { bindingId: row.binding_id, generation: row.generation, credential, expiresAt },
                replayed: true,
              },
            };
          }
          const fence = db
            .query("SELECT binding_id, generation FROM push_installation_fences WHERE installation_id = ?")
            .get(request.installationId) as FenceRow | null;
          const current = db
            .query(
              "SELECT * FROM push_bindings WHERE installation_id = ? AND state = 'active' ORDER BY generation DESC LIMIT 1",
            )
            .get(request.installationId) as BindingRow | null;
          if (
            request.replaces &&
            (!current ||
              request.replaces.bindingId !== current.binding_id ||
              request.replaces.generation !== current.generation)
          )
            return fail("binding_generation_mismatch");
          if (current && current.owner_user_id !== owner && !request.replaces) return fail("old_binding_active");
          const timestamp = now.toISOString();
          const replacementPending = Boolean(current && current.owner_user_id !== owner);
          // Cross-account identifiers are not authority. Such a replacement is
          // pending until the old exact binding is revoked with its credential.
          if (current?.state === "active" && !replacementPending)
            db.query(
              "UPDATE push_bindings SET state = 'disabled', enabled = 0, updated_at = ?, revision = revision + 1 WHERE binding_id = ? AND generation = ? AND state = 'active'",
            ).run(timestamp, current.binding_id, current.generation);
          // Only the newest request may remain an activation candidate. This
          // closes the concurrent replacement race without trusting installationId.
          db.query(
            "UPDATE push_bindings SET state = 'disabled', enabled = 0, updated_at = ?, revision = revision + 1 WHERE installation_id = ? AND state = 'pending-old-binding-disable'",
          ).run(timestamp, request.installationId);
          const generation = (fence?.generation ?? 0) + 1;
          const bindingId = randomBindingId();
          const state = replacementPending ? "pending-old-binding-disable" : "active";
          db.query(`INSERT INTO push_bindings VALUES (?, ?, ?, ?, ?, ?, 1, 'hidden', 1, ?, ?, ?, ?, ?, ?)`).run(
            bindingId,
            generation,
            owner,
            request.installationId,
            request.apnsDeviceToken,
            state,
            request.replaces?.bindingId ?? null,
            request.replaces?.generation ?? null,
            digest(credential),
            expiresAt,
            timestamp,
            timestamp,
          );
          db.query(
            "INSERT INTO push_installation_fences VALUES (?, ?, ?) ON CONFLICT(installation_id) DO UPDATE SET binding_id=excluded.binding_id, generation=excluded.generation",
          ).run(request.installationId, bindingId, generation);
          db.query("INSERT INTO push_registration_idempotency VALUES (?, ?, ?, ?, ?)").run(
            owner,
            request.idempotencyKey,
            requestFingerprint,
            bindingId,
            generation,
          );
          const row = binding(bindingId, generation);
          if (!row) return fail("internal");
          return {
            ok: true,
            value: {
              binding: rowBinding(row),
              revocation: { bindingId, generation, credential, expiresAt },
              replayed: false,
            },
          };
        });
      } catch {
        return fail("internal", true);
      }
    },

    async readPreferences(resource, installationId) {
      try {
        const row = db
          .query(
            "SELECT * FROM push_bindings WHERE installation_id = ? AND owner_user_id = ? AND state IN ('active', 'pending-old-binding-disable') ORDER BY generation DESC LIMIT 1",
          )
          .get(installationId, resource.ownerUserId) as BindingRow | null;
        if (!row) return fail("not_found");
        return { ok: true, value: rowBinding(row) };
      } catch {
        return fail("internal", true);
      }
    },

    async updatePreferences(resource, bindingId, generation, expectedRevision, changes) {
      try {
        return transact<PushResult<PushBinding>>(() => {
          const row = binding(bindingId, generation);
          if (!row) return fail("not_found");
          if (row.owner_user_id !== resource.ownerUserId) return fail("not_found");
          if (row.state === "disabled") return fail("binding_generation_mismatch");
          if (row.revision !== expectedRevision) return fail("conflict");
          const enabled = changes.enabled === undefined ? row.enabled : changes.enabled ? 1 : 0;
          const preview = changes.previewMode ?? row.preview_mode;
          const updatedAt = new Date().toISOString();
          db.query(
            "UPDATE push_bindings SET enabled = ?, preview_mode = ?, revision = revision + 1, updated_at = ? WHERE binding_id = ? AND generation = ? AND revision = ?",
          ).run(enabled, preview, updatedAt, bindingId, generation, expectedRevision);
          const updated = binding(bindingId, generation);
          return updated ? { ok: true, value: rowBinding(updated) } : fail("internal");
        });
      } catch {
        return fail("internal", true);
      }
    },

    async revoke(request: PushRevokeRequest, now: Date) {
      const requestFingerprint = fingerprint(request);
      try {
        return transact(() => {
          const replay = db
            .query("SELECT * FROM push_revocation_idempotency WHERE idempotency_key = ?")
            .get(request.idempotencyKey) as RevokeRow | null;
          if (replay) {
            if (replay.fingerprint !== requestFingerprint) return fail("idempotency_conflict");
            return {
              ok: true as const,
              value: {
                bindingId: replay.binding_id,
                generation: replay.generation,
                status: replay.status,
                acknowledgedAt: replay.acknowledged_at,
              },
            };
          }
          const row = binding(request.bindingId, request.generation);
          if (!row) return fail("invalid_revocation_authority");
          const primaryAuthorityMatches = credentialMatches(request.revocationCredential, row.credential_verifier);
          const replayAuthority = primaryAuthorityMatches
            ? null
            : (db
                .query(
                  "SELECT credential_expires_at FROM push_revocation_authorities WHERE binding_id = ? AND generation = ? AND credential_verifier = ?",
                )
                .get(
                  row.binding_id,
                  row.generation,
                  digest(request.revocationCredential),
                ) as RevocationAuthorityRow | null);
          if (!replayAuthority && !primaryAuthorityMatches) return fail("invalid_revocation_authority");
          const credentialExpiresAt = replayAuthority?.credential_expires_at ?? row.credential_expires_at;
          if (now.getTime() > Date.parse(credentialExpiresAt)) return fail("expired_revocation_authority");
          const status = row.state === "disabled" ? ("already-revoked" as const) : ("revoked" as const);
          const acknowledgedAt = now.toISOString();
          if (row.state !== "disabled")
            db.query(
              "UPDATE push_bindings SET state = 'disabled', enabled = 0, revision = revision + 1, updated_at = ? WHERE binding_id = ? AND generation = ? AND state != 'disabled'",
            ).run(acknowledgedAt, row.binding_id, row.generation);
          db.query("INSERT INTO push_revocation_idempotency VALUES (?, ?, ?, ?, ?, ?)").run(
            request.idempotencyKey,
            requestFingerprint,
            row.binding_id,
            row.generation,
            status,
            acknowledgedAt,
          );
          return {
            ok: true as const,
            value: { bindingId: row.binding_id, generation: row.generation, status, acknowledgedAt },
          };
        });
      } catch {
        return fail("internal", true);
      }
    },

    async activeForUser(ownerUserId: UserId) {
      try {
        const rows = db
          .query(
            "SELECT * FROM push_bindings WHERE owner_user_id = ? AND state = 'active' AND enabled = 1 ORDER BY created_at",
          )
          .all(ownerUserId) as BindingRow[];
        return {
          ok: true,
          value: rows.map(
            (row): PushBindingDestination => ({
              bindingId: row.binding_id,
              generation: row.generation,
              ownerUserId,
              installationId: row.installation_id,
              apnsDeviceToken: row.token,
              enabled: true,
              previewMode: row.preview_mode,
            }),
          ),
        };
      } catch {
        return fail("internal", true);
      }
    },

    async disableDestination(bindingId, generation, at) {
      db.query(
        "UPDATE push_bindings SET state = 'disabled', enabled = 0, revision = revision + 1, updated_at = ? WHERE binding_id = ? AND generation = ? AND state = 'active'",
      ).run(at.toISOString(), bindingId, generation);
    },

    async read(deliveryId, bindingId, generation) {
      const row = db
        .query(
          "SELECT provider_message_id, accepted_at FROM push_delivery_receipts WHERE delivery_id = ? AND binding_id = ? AND generation = ?",
        )
        .get(deliveryId, bindingId, generation) as { provider_message_id: string | null; accepted_at: string } | null;
      return row
        ? {
            ...(row.provider_message_id ? { providerMessageId: row.provider_message_id } : {}),
            acceptedAt: row.accepted_at,
          }
        : null;
    },
    async record(deliveryId, bindingId, generation, receipt) {
      db.query("INSERT OR IGNORE INTO push_delivery_receipts VALUES (?, ?, ?, ?, ?)").run(
        deliveryId,
        bindingId,
        generation,
        receipt.providerMessageId ?? null,
        receipt.acceptedAt,
      );
    },
    close() {
      db.close();
    },
  };
}
