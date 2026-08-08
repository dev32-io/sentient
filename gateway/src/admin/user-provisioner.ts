import { ADMIN_ROLE, type Result, type UserRole } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { ProfileStore } from "../profile-store/profile-store.js";
import { profileV1Schema } from "../profile-store/profile-types.js";
import type { ProfileV1 } from "../profile-store/profile-types.js";
import { NEVER_REVOKED } from "../user-auth/credential-floor.js";
import type { Argon2Params, AvatarTint, UserRecord } from "../user-auth/types.js";
import { assertUserId } from "../user-auth/user-id.js";
import type { UserStore } from "../user-auth/user-store.js";
import type { UserLifecycle } from "./user-lifecycle.js";

const log = getLog(["sentient", "gateway", "admin", "user-provisioner"]);

const AVATAR_TINTS: AvatarTint[] = ["terra", "sage", "amber", "clay"];

/** The owner's default for a new household member. */
const DEFAULT_ROLE: UserRole = "adult";

// --- Error types -----------------------------------------------------------

export type CreateError = "hash-error" | "io-error" | "apply-error" | "invalid-profile";
export type DeleteError = "not-found" | "last-admin" | "io-error";
export type ResetError = "hash-error" | "not-found" | "io-error";
export type SetRoleError = "last-admin" | "not-found" | "io-error";

// --- Result types ----------------------------------------------------------

/** The admin REST surface's user shape.
 *
 *  `isAdmin` is DERIVED from `role`, never stored — see `buildUserSummary`. It
 *  stays on the wire so webui / Android / iOS keep compiling and behaving
 *  correctly while they migrate to reading `role` (plan
 *  2026-08-07-tool-permissions tasks 6–9). Removing it is a follow-up. */
export interface UserSummary {
  userId: string;
  displayName: string;
  role: UserRole;
  isAdmin: boolean;
  avatarTint: AvatarTint;
  createdAt: string;
}

/** The ONE place `isAdmin` is derived for the admin surface. */
export function buildUserSummary(rec: UserRecord): UserSummary {
  return {
    userId: rec.userId,
    displayName: rec.displayName,
    role: rec.role,
    isAdmin: rec.role === ADMIN_ROLE,
    avatarTint: rec.avatarTint,
    createdAt: rec.createdAt,
  };
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
   *  (`getHermesProfileDir(userId)`). `hermes-runner` spawns
   *  `hermes -p <userId>` with `cwd` set to that dir, so the dir must exist
   *  before the first delegation. What it must NOT be assumed to do is bind the
   *  delegated agent's model or MCP tools: hermes reads its config.yaml from its
   *  own store, not from this one. Its TOOLS come from
   *  `external-tools/hermes-external-tool.ts` (`hermes mcp add`); its
   *  model/credential from `createHermesProfile`'s `--clone-from`. */
  renderInnerProfile: (userId: string) => Promise<Result<void, "render-error" | "write-error">>;
  /** Register the user with the Hermes CLI's OWN profile store, which is a
   *  different tree from the gateway-side render above. `hermes -p <userId>`
   *  refuses to start at all until that registration exists, so without this
   *  every gateway-provisioned user fails its first `delegateTask` with
   *  "Profile '<userId>' does not exist" — for the life of the install. The
   *  deleted supervisord program spec used to run it as a self-bootstrapping
   *  prefix; the native cutover removed the daemon and this replaces it. */
  createHermesProfile: (userId: string) => Promise<Result<void, "cli-error">>;
  /** Fan-out for user lifecycle events. McpHost subscribes here to add/remove
   *  per-user MCP sockets in lockstep with create/delete, and the credential
   *  revoker subscribes to delete/roleChanged to close that account's live
   *  sockets. Listener errors are swallowed and logged — they do NOT roll back
   *  the user op. */
  userLifecycle: UserLifecycle;
}

// --- Implementation --------------------------------------------------------

export interface UserProvisioner {
  createUser(input: CreateUserInput): Promise<Result<UserSummary, CreateError>>;
  deleteUser(userId: string): Promise<Result<void, DeleteError>>;
  resetPin(userId: string, newPin: string): Promise<Result<void, ResetError>>;
  /** Re-role an existing member. Refuses to leave the household with no admin
   *  — the same guard `deleteUser` applies, for the same reason. */
  setRole(userId: string, role: UserRole): Promise<Result<void, SetRoleError>>;
}

export interface CreateUserInput {
  displayName: string;
  pin: string;
  /** Omitted means `adult`. */
  role?: UserRole;
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
    async setRole(userId, role) {
      assertUserId(userId);
      return setRoleFlow(deps, userId, role);
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
    role: input.role ?? DEFAULT_ROLE,
    avatarTint,
    createdAt,
    credentialsValidFrom: NEVER_REVOKED,
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

  // Register the user with the Hermes CLI itself. FAIL-SOFT, deliberately:
  // Hermes is an optional DELEGATED agent, not part of the gateway's own turn
  // loop, and the operator may never have configured it. A failure here must
  // degrade `delegateTask` for this user, never fail or roll back the user.
  const hermesResult = await deps.createHermesProfile(userId);
  if (!hermesResult.ok) {
    log.warn("createUser.hermes-profile-failed", {
      userId,
      reason: hermesResult.error,
      degrades: "delegateTask",
    });
  }

  // Notify lifecycle subscribers (e.g. McpHost, which opens this user's
  // gateway-MCP socket) once the profile is on disk.
  await deps.userLifecycle.emitCreated(userId);

  log.info("createUser.success", { userId, role: record.role });
  return { ok: true, value: buildUserSummary(record) };
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
  if (target.role === ADMIN_ROLE && isOnlyAdmin(listResult.value)) {
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

  // THE CREDENTIAL FLOOR DOES NOT MOVE HERE, and that is deliberate rather
  // than an oversight — OPEN QUESTION, owner's call (plan
  // 2026-08-07-tool-permissions task 2c review).
  //
  // The field is named `credentialsValidFrom`, so the next reader will assume a
  // PIN reset revokes the tokens issued under the old PIN. It does not: this
  // write is `pinHash` alone, and every session that account already holds
  // stays live. That matters because an operator resets a PIN precisely when
  // they think a credential leaked.
  //
  // It is not a one-line fix. The floor is PER-USER and GLOBAL, so moving it
  // here also kicks the person who just changed their own PIN straight back to
  // the login screen (`changePin`, user-auth/auth-service.ts, has the same
  // shape). Whether that is the right trade is a UX decision, not one to make
  // silently inside a store write.
  const updateResult = await deps.userStore.update(userId, { pinHash });
  if (!updateResult.ok) {
    return updateResult.error === "not-found" ? { ok: false, error: "not-found" } : { ok: false, error: "io-error" };
  }

  log.info("resetPin.success", { userId });
  return { ok: true, value: undefined };
}

// --- setRole ---------------------------------------------------------------

async function setRoleFlow(
  deps: UserProvisionerDeps,
  userId: string,
  role: UserRole,
): Promise<Result<void, SetRoleError>> {
  const listResult = await deps.userStore.list();
  if (!listResult.ok) return { ok: false, error: "io-error" };

  // Demoting the last admin locks the household out of its own admin surface —
  // and now, additionally, out of every `admin`-tier tool. Refused for ANY
  // target role that is not admin, not just the old boolean's `false`.
  if (role !== ADMIN_ROLE && isOnlyAdmin(listResult.value)) {
    const target = listResult.value.find((u) => u.userId === userId);
    if (target?.role === ADMIN_ROLE) return { ok: false, error: "last-admin" };
  }

  // ONE WRITE, both fields. A role change REVOKES this account's credentials
  // (plan 2026-08-07-tool-permissions task 2c): the floor moves to now, so
  // every token issued before this moment stops validating. Splitting it into
  // two `update()` calls would leave a crash window in which the role had
  // changed and the old credentials still worked — the exact failure the
  // revocation exists to prevent — and `user-store.ts` has no lock across its
  // read-modify-write, so a second round trip is not free either.
  const updateResult = await deps.userStore.update(userId, {
    role,
    credentialsValidFrom: deps.now().toISOString(),
  });
  if (!updateResult.ok) {
    return updateResult.error === "not-found" ? { ok: false, error: "not-found" } : { ok: false, error: "io-error" };
  }

  // AFTER the write, never before: the revoker closes this account's live
  // sockets, and kicking a user whose role never actually persisted would be a
  // logout for nothing.
  await deps.userLifecycle.emitRoleChanged(userId);

  log.info("setRole.success", { userId, role });
  return { ok: true, value: undefined };
}

// --- Helpers ---------------------------------------------------------------

function isOnlyAdmin(users: UserRecord[]): boolean {
  return users.filter((u) => u.role === ADMIN_ROLE).length <= 1;
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
