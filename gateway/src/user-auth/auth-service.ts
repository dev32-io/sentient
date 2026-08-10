import type { AuthConfig } from "@sentient/config";
import { DEFAULT_ROLE, type Result, type UserRole } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import { loadOrCreateAuthSecret } from "./auth-secret.js";
import { NEVER_REVOKED, createCredentialFloor } from "./credential-floor.js";
import { hashPin, verifyPin } from "./pin-service.js";
import { type TokenService, createTokenService } from "./token-service.js";
import type { AvatarTint, StoreResult, UserRecord } from "./types.js";
import { type UserStore, createUserStore } from "./user-store.js";

const log = getLog(["sentient", "gateway", "user-auth", "auth-service"]);

export interface CreateUserInput {
  userId: string;
  displayName: string;
  pin: string;
  /** Omitted means `adult` — the owner's default for a new household member.
   *  Never inferred from anything else; a caller that wants an operator asks
   *  for one by name. */
  role?: UserRole;
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
  const users = createUserStore();
  // The store is built FIRST because the token service now needs it: validity
  // is the record's answer, read per call through this port.
  const tokens = createTokenService({
    secret,
    ttlSeconds: authConfig.token_ttl_seconds,
    credentialFloor: createCredentialFloor(users),
  });

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
        role: input.role ?? DEFAULT_ROLE,
        avatarTint: input.avatarTint,
        createdAt: new Date().toISOString(),
        credentialsValidFrom: NEVER_REVOKED,
      };
      const r = await users.add(rec);
      if (!r.ok) {
        if (r.error === "already-exists") return { ok: false, error: "already-exists" };
        return { ok: false, error: "io-error" };
      }
      log.info("createUser", { userId: rec.userId, role: rec.role });
      return { ok: true, value: rec };
    },

    async authenticate(userId, pin) {
      const r = await users.get(userId);
      if (!r.ok || r.value === null) {
        // D20: a rejected credential is a security boundary decision, not a
        // debug trace — WARN so it survives at the running `info` level
        // (also the documented prod default). userId + reason are the whole
        // payload; the pin is NEVER logged, not even truncated.
        log.warn("authenticate.no-user", { userId, reason: "no such user" });
        return { ok: false, error: "invalid-credentials" };
      }
      const ok = await verifyPin(pin, r.value.pinHash);
      if (!ok) {
        log.warn("authenticate.wrong-pin", { userId, reason: "wrong pin" });
        return { ok: false, error: "invalid-credentials" };
      }
      // The token carries identity only — the role is resolved from this same
      // record at each authorization decision, never from the credential.
      const token = await tokens.issue({ userId: r.value.userId });
      log.info("authenticate.ok", { userId: r.value.userId, role: r.value.role });
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
      // OWNER RULING (2026-08-10 whole-branch review, I3): a PIN change moves the
      // credential floor. This is standard practice — changing your PIN
      // re-establishes the credential, so every token minted under the old PIN
      // (on this device AND every other one) is invalidated at the next check.
      // The UX cost is accepted: the user is kicked to login on the session they
      // changed the PIN from. Written in the SAME update as `pinHash` so the
      // hash and the floor move atomically. Mirror ruling at
      // `admin/user-provisioner.ts#resetPinFlow`.
      const r = await users.update(userId, {
        pinHash: newHash,
        credentialsValidFrom: new Date().toISOString(),
      });
      if (!r.ok) {
        log.warn("changePin.io-error", { userId });
        return { ok: false, error: "io-error" };
      }
      log.info("changePin.ok", { userId });
      return { ok: true, value: undefined };
    },
  };
}
