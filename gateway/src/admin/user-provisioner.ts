import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { ProfileStore } from "../profile-store/profile-store.js";
import { profileV1Schema } from "../profile-store/profile-types.js";
import type { ProfileV1 } from "../profile-store/profile-types.js";
import type { Argon2Params, AvatarTint, UserRecord } from "../user-auth/types.js";
import { assertUserId } from "../user-auth/user-id.js";
import type { UserStore } from "../user-auth/user-store.js";
import type { SupervisordControl, SupervisordError } from "./supervisord-control.js";
import type { UserLifecycle } from "./user-lifecycle.js";
import type { UserPortStore } from "./user-port-store.js";

/** Outcome of `bootstrapWorker`.
 *  - "warm"          — health passed, pool upserted, ping→pong confirmed.
 *  - "dispatch-failed" — health passed and pool upserted, but ping→pong timed out.
 *  - "deferred"      — hermes not configured; no check performed (legacy/lazy path).
 *
 *  When mode is "strict" (account creation) only "warm" is a success — any other
 *  outcome triggers rollback and a "worker-not-ready" error to the caller.
 *  When mode is "lazy" (existing callers) health-timeout is non-fatal. */
export type BootstrapWarmStatus = "warm" | "dispatch-failed" | "deferred";

const log = getLog(["sentient", "gateway", "admin", "user-provisioner"]);

const AVATAR_TINTS: AvatarTint[] = ["terra", "sage", "amber", "clay"];

// --- Error types -----------------------------------------------------------

export type CreateError = "hash-error" | "io-error" | "apply-error" | "invalid-profile" | "worker-not-ready";
export type DeleteError = "not-found" | "last-admin" | "io-error";
export type ResetError = "hash-error" | "not-found" | "io-error";
export type AdminToggleError = "last-admin" | "not-found" | "io-error";

// --- Result types ----------------------------------------------------------

export interface UserSummary {
  userId: string;
  displayName: string;
  isAdmin: boolean;
  avatarTint: AvatarTint;
  port: number;
  createdAt: string;
}

// --- Dependencies ----------------------------------------------------------

/** Subset of InternalSecretsStore consumed by the provisioner — kept narrow so
 *  Phase H's rename to `getSentientGatewayTokenSync` is a single-line change. */
export interface InternalSecretsForProvisioner {
  getHermesAuthTokenSync(): string;
}

export interface UserProvisionerDeps {
  userStore: UserStore;
  profileStore: ProfileStore;
  userPortStore: UserPortStore;
  argon2Params: Argon2Params;
  hashPin: (pin: string, params: Argon2Params) => Promise<string>;
  makeUserId: () => string;
  randomAvatarTint: () => AvatarTint;
  now: () => Date;
  supervisordControl: Pick<SupervisordControl, "upsertProgram" | "removeProgram">;
  internalSecrets: InternalSecretsForProvisioner;
  resolveTimezone: () => string;
  /** Returns the host-side absolute path to a user's Hermes home directory.
   *  Threaded into the supervisord program env (HERMES_HOME) and used by
   *  the Hermes docker-backend when bind-mounting per-task sandbox dirs. */
  resolveHermesHome: (userId: string) => string;
  archiveUserDir: (userId: string) => Promise<Result<void, "io-error">>;
  /** Render config.yaml + SOUL.md to the inner Hermes profile dir
   *  (`<HERMES_HOME>/profiles/<userId>/`). MUST run BEFORE the supervisord
   *  program is upserted — otherwise the worker boots without a model
   *  config and the first cycle aborts. */
  renderInnerProfile: (userId: string) => Promise<Result<void, "render-error" | "write-error">>;
  /** Hand ownership of `<userDir>` and its rendered children to the hermes
   *  container's uid (default 10000). MUST run AFTER renderInnerProfile (so
   *  every freshly-written file is covered) and BEFORE upsertProgram (so
   *  supervisord can open per-user log files when it spawns the worker).
   *  Errors here are non-fatal — the user-provisioner logs and proceeds.
   *  See `gateway/src/admin/chown-hermes.ts`. */
  chownUserDirToHermes: (userId: string) => Promise<Result<void, "chown-error">>;
  /** Wait for the just-started worker to accept auth, then warm the
   *  connection pool and (in strict mode) confirm dispatch readiness via a
   *  ping→pong round-trip. In lazy mode a health-timeout is non-fatal;
   *  in strict mode only "warm" is success — anything else triggers rollback. */
  bootstrapWorker: (userId: string, mode: "strict" | "lazy") => Promise<Result<BootstrapWarmStatus, "health-timeout">>;
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

  const bindResult = await deps.userPortStore.bind(userId);
  if (!bindResult.ok) {
    log.warn("createUser.port-bind-failed", { userId, error: bindResult.error });
    await deps.userStore.remove(userId);
    return { ok: false, error: "io-error" };
  }
  const port = bindResult.value.port;

  // Splice the server-generated userId onto the caller's profile, then
  // validate the full shape. userId is generated above after input arrives
  // so the caller cannot know it in advance.
  let profile: ProfileV1;
  try {
    profile = profileV1Schema.parse({ ...input.profile, userId });
  } catch {
    log.warn("createUser.invalid-profile", { userId });
    await rollbackPortAndUser(deps, userId);
    return { ok: false, error: "invalid-profile" };
  }
  const saveResult = await deps.profileStore.save(profile);
  if (!saveResult.ok) {
    log.warn("createUser.save-failed", { userId, error: saveResult.error });
    await rollbackPortAndUser(deps, userId);
    return { ok: false, error: "io-error" };
  }

  // Render the inner Hermes profile dir BEFORE supervisord starts the worker.
  // The worker reads `<HERMES_HOME>/profiles/<userId>/config.yaml` on boot;
  // if missing, it comes up with no model/agent config and the first cycle
  // aborts. Order: render → upsertProgram → bootstrapWorker.
  const renderResult = await deps.renderInnerProfile(userId);
  if (!renderResult.ok) {
    log.warn("createUser.render-failed", { userId, error: renderResult.error });
    await rollbackProfilePortAndUser(deps, userId);
    return { ok: false, error: "apply-error" };
  }

  // Hand the just-written user dir to the hermes container's uid before
  // supervisord starts the worker. Without this, supervisord (running as
  // hermes uid=10000) hits EACCES when opening the per-user stdout/stderr
  // log files and the program enters FATAL state — surfaces to the user
  // as "worker-not-ready" on Account creation. Chown errors are non-fatal:
  // on FS layers that don't honour uid changes the worker may still boot.
  const chownResult = await deps.chownUserDirToHermes(userId);
  if (!chownResult.ok) {
    log.warn("createUser.chown-failed", { userId, error: chownResult.error });
  }

  const upsertResult = await deps.supervisordControl.upsertProgram({
    userId,
    port,
    token: deps.internalSecrets.getHermesAuthTokenSync(),
    timezone: deps.resolveTimezone(),
    provider: profile.model.provider,
    hermesHome: deps.resolveHermesHome(userId),
    signalPaired: profile.devices?.signal?.paired === true,
  });
  if (!upsertResult.ok) {
    log.warn("createUser.supervisord-upsert-failed", {
      userId,
      kind: upsertResult.error.kind,
      reason: upsertResult.error.reason,
    });
    await rollbackProfilePortAndUser(deps, userId);
    return { ok: false, error: "apply-error" };
  }

  // Notify lifecycle subscribers (e.g. McpHost) BEFORE warming the worker.
  // The hermes worker boots immediately after `upsertProgram` and probes its
  // gateway-MCP socket within ~1s; if the socket isn't ready by then it
  // exhausts its retries and runs without gateway tools for its lifetime.
  await deps.userLifecycle.emitCreated(userId);

  // Strict bootstrap: poll worker health, upsert pool entry, then confirm
  // dispatch readiness via a ping→pong round-trip. Account creation blocks
  // until the worker is truly ready — the HTTP response only resolves once
  // the spinner represents real readiness, not just /health 200.
  const warmResult = await deps.bootstrapWorker(userId, "strict");
  if (!warmResult.ok || warmResult.value === "dispatch-failed") {
    const reason = warmResult.ok ? "dispatch-failed" : warmResult.error;
    log.warn("createUser.worker-not-ready", { userId, reason });
    await rollbackProfilePortAndUser(deps, userId);
    return { ok: false, error: "worker-not-ready" };
  }
  log.info("createUser.bootstrap-ok", { userId, status: warmResult.value });

  log.info("createUser.success", { userId, port });
  return {
    ok: true,
    value: { userId, displayName: input.displayName, isAdmin: input.isAdmin, avatarTint, port, createdAt },
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
  const port = await deps.userPortStore.resolvePort(userId);
  if (port === null) return { ok: false, error: "not-found" };

  const listResult = await deps.userStore.list();
  if (!listResult.ok) return { ok: false, error: "io-error" };
  const target = listResult.value.find((u) => u.userId === userId);
  if (target?.isAdmin && isOnlyAdmin(listResult.value)) {
    return { ok: false, error: "last-admin" };
  }

  // Resolve signal-pairing state BEFORE archive: the profile dir may be moved
  // on archive, making profileStore.get unavailable afterward. false is safe
  // here — extra stop targets are non-fatal (supervisorctl logs and continues).
  const profileResult = await deps.profileStore.get(userId);
  const signalPaired = profileResult.ok ? profileResult.value.devices?.signal?.paired === true : false;

  const archiveResult = await deps.archiveUserDir(userId);
  if (!archiveResult.ok) return { ok: false, error: "io-error" };

  // Best-effort: remove the supervisord program. User is already archived;
  // a stale program file is undesirable but not fatal.
  const removeProgramResult = await deps.supervisordControl.removeProgram(userId, signalPaired);
  if (!removeProgramResult.ok) {
    log.warn("deleteUser.supervisord-remove-failed", {
      userId,
      port,
      kind: removeProgramResult.error.kind,
      reason: removeProgramResult.error.reason,
    });
  }

  const unbindResult = await deps.userPortStore.unbind(userId);
  if (!unbindResult.ok) log.warn("deleteUser.unbind-failed", { userId, error: unbindResult.error });

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

async function rollbackPortAndUser(deps: UserProvisionerDeps, userId: string): Promise<void> {
  await deps.userPortStore.unbind(userId);
  await deps.userStore.remove(userId);
}

async function rollbackProfilePortAndUser(deps: UserProvisionerDeps, userId: string): Promise<void> {
  const removeProfileResult = await deps.profileStore.remove(userId);
  if (!removeProfileResult.ok) log.warn("rollback.profile-remove-failed", { userId, error: removeProfileResult.error });
  await rollbackPortAndUser(deps, userId);
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

// Re-export for ergonomic consumption from bootstrap.
export type { SupervisordError };
