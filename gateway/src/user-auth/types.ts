import type { Result, UserRole } from "@sentient/protocol";

/** Tint color for user avatar circles; matches webui avatar palette. */
export type AvatarTint = "terra" | "sage" | "amber" | "clay";

/** Persisted per-user record. `pinHash` is argon2id; never log it.
 *
 *  `role` REPLACED `isAdmin: boolean` in storage (plan
 *  2026-08-07-tool-permissions task 2b). It is the single source of truth for
 *  both halves of authority: which impact tier a tool call may reach
 *  (`canExecute`) and whether the admin REST surface opens. Records written
 *  before the change are migrated on read — see `user-record-migration.ts`.
 *
 *  `isAdmin` is still DERIVED onto the wire (`role === "admin"`) so the three
 *  clients keep compiling while they migrate; it must never be stored. */
export interface UserRecord {
  userId: string;
  displayName: string;
  pinHash: string;
  role: UserRole;
  avatarTint: AvatarTint;
  createdAt: string; // ISO-8601 UTC
}

export type UserStoreError = "not-found" | "already-exists" | "io-error" | "corrupt-file" | "last-admin-demotion";

export type TokenError = "malformed" | "expired" | "signature-invalid" | "wrong-purpose";

/** Argon2id tunables sourced from gateway config `auth:` section. */
export interface Argon2Params {
  memoryKb: number;
  iterations: number;
  parallelism: number;
}

export interface TokenPayload {
  userId: string;
  /** The role the token was MINTED with. A token issued before the claim
   *  existed has none and is refused outright — see `token-service.ts`. */
  role: UserRole;
  issuedAt: number; // unix seconds
  expiresAt: number; // unix seconds
}

export type StoreResult<T> = Result<T, UserStoreError>;
export type TokenResult<T> = Result<T, TokenError>;
