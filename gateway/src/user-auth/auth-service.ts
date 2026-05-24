import type { AuthConfig } from "@sentient/config";
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import { loadOrCreateAuthSecret } from "./auth-secret.js";
import { hashPin, verifyPin } from "./pin-service.js";
import { type TokenService, createTokenService } from "./token-service.js";
import type { AvatarTint, StoreResult, UserRecord } from "./types.js";
import { type UserStore, createUserStore } from "./user-store.js";

const log = getLog(["sentient", "gateway", "user-auth", "auth-service"]);

export interface CreateUserInput {
  userId: string;
  displayName: string;
  pin: string;
  isAdmin: boolean;
  avatarTint: AvatarTint;
}

export type CreateUserError = "already-exists" | "io-error";
export type AuthError = "invalid-credentials";
export type UpdateDisplayNameError = "not-found" | "io-error";
export type ChangePinError = "wrong-pin" | "not-found" | "io-error";

export interface PublicUser {
  userId: string;
  displayName: string;
  avatarTint: AvatarTint;
}

export interface AuthService {
  users: UserStore;
  tokens: TokenService;
  config: AuthConfig;
  createUser(input: CreateUserInput): Promise<Result<UserRecord, CreateUserError>>;
  authenticate(userId: string, pin: string): Promise<Result<{ token: string; user: UserRecord }, AuthError>>;
  listUsersPublic(): Promise<StoreResult<PublicUser[]>>;
  isFirstRun(): Promise<boolean>;
  updateDisplayName(userId: string, displayName: string): Promise<Result<UserRecord, UpdateDisplayNameError>>;
  changePin(userId: string, currentPin: string, newPin: string): Promise<Result<void, ChangePinError>>;
}

export async function createAuthService(authConfig: AuthConfig): Promise<AuthService> {
  const secret = await loadOrCreateAuthSecret();
  const tokens = createTokenService({ secret, ttlSeconds: authConfig.token_ttl_seconds });
  const users = createUserStore();

  const argon2Params = {
    memoryKb: authConfig.argon2_memory_kb,
    iterations: authConfig.argon2_iterations,
    parallelism: authConfig.argon2_parallelism,
  };

  return {
    users,
    tokens,
    config: authConfig,

    async createUser(input) {
      const pinHash = await hashPin(input.pin, argon2Params);
      const rec: UserRecord = {
        userId: input.userId,
        displayName: input.displayName,
        pinHash,
        isAdmin: input.isAdmin,
        avatarTint: input.avatarTint,
        createdAt: new Date().toISOString(),
      };
      const r = await users.add(rec);
      if (!r.ok) {
        if (r.error === "already-exists") return { ok: false, error: "already-exists" };
        return { ok: false, error: "io-error" };
      }
      log.info("createUser", { userId: rec.userId, isAdmin: rec.isAdmin });
      return { ok: true, value: rec };
    },

    async authenticate(userId, pin) {
      const r = await users.get(userId);
      if (!r.ok || r.value === null) {
        log.debug("authenticate.no-user", { userId });
        return { ok: false, error: "invalid-credentials" };
      }
      const ok = await verifyPin(pin, r.value.pinHash);
      if (!ok) {
        log.debug("authenticate.wrong-pin", { userId });
        return { ok: false, error: "invalid-credentials" };
      }
      const token = await tokens.issue({ userId: r.value.userId, isAdmin: r.value.isAdmin });
      log.info("authenticate.ok", { userId: r.value.userId });
      return { ok: true, value: { token, user: r.value } };
    },

    async listUsersPublic() {
      const r = await users.list();
      if (!r.ok) return r;
      return {
        ok: true,
        value: r.value.map((u) => ({
          userId: u.userId,
          displayName: u.displayName,
          avatarTint: u.avatarTint,
        })),
      };
    },

    async isFirstRun() {
      const r = await users.list();
      return r.ok && r.value.length === 0;
    },

    async updateDisplayName(userId, displayName) {
      const r = await users.update(userId, { displayName });
      if (!r.ok) {
        if (r.error === "not-found") return { ok: false, error: "not-found" };
        log.warn("updateDisplayName.io-error", { userId });
        return { ok: false, error: "io-error" };
      }
      const got = await users.get(userId);
      if (!got.ok || !got.value) {
        log.warn("updateDisplayName.read-after-write-failed", { userId });
        return { ok: false, error: "io-error" };
      }
      log.info("updateDisplayName.ok", { userId });
      return { ok: true, value: got.value };
    },

    async changePin(userId, currentPin, newPin) {
      const got = await users.get(userId);
      if (!got.ok || !got.value) {
        log.debug("changePin.not-found", { userId });
        return { ok: false, error: "not-found" };
      }
      const pinOk = await verifyPin(currentPin, got.value.pinHash);
      if (!pinOk) {
        log.debug("changePin.wrong-pin", { userId });
        return { ok: false, error: "wrong-pin" };
      }
      const newHash = await hashPin(newPin, argon2Params);
      const r = await users.update(userId, { pinHash: newHash });
      if (!r.ok) {
        log.warn("changePin.io-error", { userId });
        return { ok: false, error: "io-error" };
      }
      log.info("changePin.ok", { userId });
      return { ok: true, value: undefined };
    },
  };
}
