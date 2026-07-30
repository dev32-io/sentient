import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { ProfileStore } from "../profile-store/profile-store.js";
import { profileV1Schema } from "../profile-store/profile-types.js";
import type { ProfileV1 } from "../profile-store/profile-types.js";
import type { Argon2Params, AvatarTint, UserRecord } from "../user-auth/types.js";
import { assertUserId } from "../user-auth/user-id.js";
import type { UserStore } from "../user-auth/user-store.js";
import type { UserLifecycle } from "./user-lifecycle.js";

const log = getLog(["sentient", "gateway", "admin", "user-provisioner"]);

const AVATAR_TINTS: AvatarTint[] = ["terra", "sage", "amber", "clay"];

// --- Error types -----------------------------------------------------------

export type CreateError = "hash-error" | "io-error" | "apply-error" | "invalid-profile";
export type DeleteError = "not-found" | "last-admin" | "io-error";
export type ResetError = "hash-error" | "not-found" | "io-error";
export type AdminToggleError = "last-admin" | "not-found" | "io-error";

// --- Result types ----------------------------------------------------------

export interface UserSummary {
  userId: string;
  displayName: string;
  isAdmin: boolean;
  avatarTint: AvatarTint;
  createdAt: string;
}

// --- Dependencies ----------------------------------------------------------

export interface UserProvisionerDeps {
  userStore: UserStore;
  profileStore: ProfileStore;
  argon2Params: Argon2Params;
  hashPin: (pin: string, params: Argon2Params) => Promise<string>;
  makeUserId: () => string;
  randomAvatarTint: () => AvatarTint;
  now: () => Date;
  archiveUserDir: (userId: string) => Promise<Result<void, "io-error">>;
  /** Render config.yaml + SOUL.md to the inner Hermes profile dir
   *  (`<HERMES_HOME>/profiles/<userId>/`). Load-bearing for delegateTask:
   *  `hermes-runner` spawns `hermes -p <userId>` with `cwd` set to that dir,
   *  so it must exist and carry a model config before the first delegation. */
  renderInnerProfile: (userId: string) => Promise<Result<void, "render-error" | "write-error">>;
  /** Fan-out for user lifecycle events. McpHost subscribes here to add/remove
   *  per-user MCP sockets in lockstep with create/delete. Listener errors are
   *  swallowed and logged — they do NOT roll back the user op. */
  userLifecycle: UserLifecycle;
}

// --- Implementation --------------------------------------------------------

export interface UserProvisioner {
  createUser(input: CreateUserInput): Promise<Result<UserSummary, CreateError>>;
  deleteUser(userId: string): Promise<Result<void, DeleteError>>;
  resetPin(userId: string, newPin: string): Promise<Result<void, ResetError>>;
  setIsAdmin(userId: string, isAdmin: boolean): Promise<Result<void, AdminToggleError>>;
}

export interface CreateUserInput {
  displayName: string;
  pin: string;
  isAdmin: boolean;
  profile: ProfileV1;
}

export function createUserProvisioner(deps: UserProvisionerDeps): UserProvisioner {
  return {
    async createUser(input) {
      return createUserWithRollback(deps, input);
    },
    async deleteUser(userId) {
      assertUserId(userId);
      return deleteUserFlow(deps, userId);
    },
    async resetPin(userId, newPin) {
      assertUserId(userId);
      return resetPinFlow(deps, userId, newPin);
    },
    async setIsAdmin(userId, isAdmin) {
      assertUserId(userId);
      return setIsAdminFlow(deps, userId, isAdmin);
    },
  };
}

// --- createUser (5-step with rollback) -------------------------------------

async function createUserWithRollback(
  deps: UserProvisionerDeps,
  input: CreateUserInput,
): Promise<Result<UserSummary, CreateError>> {
  const hashed = await hashOrFail(deps, input.pin);
  if (!hashed.ok) return hashed;

  const userId = deps.makeUserId();
  assertUserId(userId);
  const avatarTint = deps.randomAvatarTint();
  const createdAt = deps.now().toISOString();

  const record: UserRecord = {
    userId,
    displayName: input.displayName,
    pinHash: hashed.value,
    isAdmin: input.isAdmin,
    avatarTint,
    createdAt,
  };
  const addResult = await deps.userStore.add(record);
  if (!addResult.ok) {
    log.warn("createUser.add-failed", { userId, error: addResult.error });
    return { ok: false, error: "io-error" };
  }

  // Splice the server-generated userId onto the caller's profile, then
  // validate the full shape. userId is generated above after input arrives
  // so the caller cannot know it in advance.
  let profile: ProfileV1;
  try {
    profile = profileV1Schema.parse({ ...input.profile, userId });
  } catch {
    log.warn("createUser.invalid-profile", { userId });
    await deps.userStore.remove(userId);
    return { ok: false, error: "invalid-profile" };
  }
  const saveResult = await deps.profileStore.save(profile);
  if (!saveResult.ok) {
    log.warn("createUser.save-failed", { userId, error: saveResult.error });
    await deps.userStore.remove(userId);
    return { ok: false, error: "io-error" };
  }

  // Render the inner Hermes profile dir. Load-bearing, not cosmetic:
  // `delegateTask` → hermes-runner spawns `hermes -p <userId>` with `cwd` set
  // to this dir, so a missing config.yaml means the very first delegation runs
  // with no model/agent config. There is no daemon to start afterwards — the
  // old order (render → chown to uid 10000 → supervisord upsertProgram →
  // bootstrapWorker health-poll) served a per-user Hermes child inside the
  // `sentient-hermes` container that no longer exists.
  const renderResult = await deps.renderInnerProfile(userId);
  if (!renderResult.ok) {
    log.warn("createUser.render-failed", { userId, error: renderResult.error });
    await rollbackProfileAndUser(deps, userId);
    return { ok: false, error: "apply-error" };
  }

  // Notify lifecycle subscribers (e.g. McpHost, which opens this user's
  // gateway-MCP socket) once the profile is on disk.
  await deps.userLifecycle.emitCreated(userId);

  log.info("createUser.success", { userId });
  return {
    ok: true,
    value: { userId, displayName: input.displayName, isAdmin: input.isAdmin, avatarTint, createdAt },
  };
}

async function hashOrFail(deps: UserProvisionerDeps, pin: string): Promise<Result<string, CreateError>> {
  try {
    return { ok: true, value: await deps.hashPin(pin, deps.argon2Params) };
  } catch {
    log.warn("createUser.hash-error");
    return { ok: false, error: "hash-error" };
  }
}

// --- deleteUser (5-step, no rollback needed) -------------------------------

async function deleteUserFlow(deps: UserProvisionerDeps, userId: string): Promise<Result<void, DeleteError>> {
  // Existence check. This used to be "does the user hold a port binding?" —
  // the port store was the de-facto user index. With ports gone the user store
  // itself answers it, which is also the record `last-admin` is decided from.
  const listResult = await deps.userStore.list();
  if (!listResult.ok) return { ok: false, error: "io-error" };
  const target = listResult.value.find((u) => u.userId === userId);
  if (!target) return { ok: false, error: "not-found" };
  if (target.isAdmin && isOnlyAdmin(listResult.value)) {
    return { ok: false, error: "last-admin" };
  }

  const archiveResult = await deps.archiveUserDir(userId);
  if (!archiveResult.ok) return { ok: false, error: "io-error" };

  const removeResult = await deps.userStore.remove(userId);
  if (!removeResult.ok) log.warn("deleteUser.remove-failed", { userId, error: removeResult.error });

  await deps.userLifecycle.emitDeleted(userId);

  log.info("deleteUser.success", { userId });
  return { ok: true, value: undefined };
}

// --- resetPin --------------------------------------------------------------

async function resetPinFlow(
  deps: UserProvisionerDeps,
  userId: string,
  newPin: string,
): Promise<Result<void, ResetError>> {
  let pinHash: string;
  try {
    pinHash = await deps.hashPin(newPin, deps.argon2Params);
  } catch {
    log.warn("resetPin.hash-error", { userId });
    return { ok: false, error: "hash-error" };
  }

  const updateResult = await deps.userStore.update(userId, { pinHash });
  if (!updateResult.ok) {
    return updateResult.error === "not-found" ? { ok: false, error: "not-found" } : { ok: false, error: "io-error" };
  }

  log.info("resetPin.success", { userId });
  return { ok: true, value: undefined };
}

// --- setIsAdmin ------------------------------------------------------------

async function setIsAdminFlow(
  deps: UserProvisionerDeps,
  userId: string,
  isAdmin: boolean,
): Promise<Result<void, AdminToggleError>> {
  const listResult = await deps.userStore.list();
  if (!listResult.ok) return { ok: false, error: "io-error" };

  if (!isAdmin && isOnlyAdmin(listResult.value)) {
    const target = listResult.value.find((u) => u.userId === userId);
    if (target?.isAdmin) return { ok: false, error: "last-admin" };
  }

  const updateResult = await deps.userStore.update(userId, { isAdmin });
  if (!updateResult.ok) {
    return updateResult.error === "not-found" ? { ok: false, error: "not-found" } : { ok: false, error: "io-error" };
  }

  log.info("setIsAdmin.success", { userId, isAdmin });
  return { ok: true, value: undefined };
}

// --- Helpers ---------------------------------------------------------------

function isOnlyAdmin(users: UserRecord[]): boolean {
  return users.filter((u) => u.isAdmin).length <= 1;
}

async function rollbackProfileAndUser(deps: UserProvisionerDeps, userId: string): Promise<void> {
  const removeProfileResult = await deps.profileStore.remove(userId);
  if (!removeProfileResult.ok) log.warn("rollback.profile-remove-failed", { userId, error: removeProfileResult.error });
  await deps.userStore.remove(userId);
}

/** Random avatar tint picker — used as default injection. */
export function randomAvatarTint(): AvatarTint {
  return AVATAR_TINTS[Math.floor(Math.random() * AVATAR_TINTS.length)] as AvatarTint;
}

/** User ID generator — used as default injection. Format: u_<8hex>.
 *  crypto.randomUUID() returns "xxxxxxxx-xxxx-..."; first 8 chars are
 *  always 8 lowercase hex digits, matching USER_ID_RE in user-id.ts. */
export function makeUserId(): string {
  return `u_${crypto.randomUUID().slice(0, 8)}`;
}
