import type { Result } from "@sentient/protocol";

/** Tint color for user avatar circles; matches webui avatar palette. */
export type AvatarTint = "terra" | "sage" | "amber" | "clay";

/** Persisted per-user record. `pinHash` is argon2id; never log it. */
export interface UserRecord {
  userId: string;
  displayName: string;
  pinHash: string;
  isAdmin: boolean;
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
  isAdmin: boolean;
  issuedAt: number; // unix seconds
  expiresAt: number; // unix seconds
}

export type StoreResult<T> = Result<T, UserStoreError>;
export type TokenResult<T> = Result<T, TokenError>;
