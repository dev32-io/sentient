import type { Result } from "@sentient/protocol";
import { reconcileSignalPaired } from "../devices/signal/boot-reconciler.js";
import { getLog } from "../logging/logger.js";
import type { ProfileStore } from "../profile-store/profile-store.js";
import type { UserStore } from "../user-auth/user-store.js";
import type { SupervisordControl } from "./supervisord-control.js";
import type { UserPortStore } from "./user-port-store.js";

const log = getLog(["sentient", "gateway", "admin", "boot-migration"]);

export interface MigrationDeps {
  userStore: Pick<UserStore, "list">;
  userPortStore: Pick<UserPortStore, "list" | "bind">;
}

/**
 * One-shot, idempotent boot migration: ensure every existing user has a port
 * binding in the user-port-store. Re-running after every user is bound is
 * a no-op. Does NOT trigger an apply for migrated users.
 */
export async function migrateUnboundUsers(deps: MigrationDeps): Promise<void> {
  const usersResult = await deps.userStore.list();
  if (!usersResult.ok) {
    log.warn("migration.user-store-error", { error: usersResult.error });
    return;
  }
  const users = usersResult.value;

  const bindingsResult = await deps.userPortStore.list();
  if (!bindingsResult.ok) {
    log.warn("migration.binding-store-error", { error: bindingsResult.error });
    return;
  }

  const boundUserIds = new Set(bindingsResult.value.map((b) => b.userId));
  const unbound = users.filter((u) => !boundUserIds.has(u.userId));

  if (unbound.length === 0) {
    log.debug("migration.noop", { totalUsers: users.length });
    return;
  }

  for (const user of unbound) {
    const r = await deps.userPortStore.bind(user.userId);
    if (!r.ok) {
      log.warn("migration.bind-failed", { userId: user.userId, error: r.error });
      continue;
    }
    log.info("migration.bound", { userId: user.userId, port: r.value.port });
  }
}

// ---------------------------------------------------------------------------
// renderProgramsForExistingUsers — Phase C boot step
// ---------------------------------------------------------------------------

export interface RenderProgramsDeps {
  userStore: Pick<UserStore, "list">;
  userPortStore: Pick<UserPortStore, "list">;
  supervisordControl: Pick<SupervisordControl, "upsertProgram">;
  internalSecrets: { getHermesAuthTokenSync(): string };
  /** Profile store used to read each user's model.provider for env block selection,
   *  and to persist any signal-paired reconciliation corrections. */
  profileStore: Pick<ProfileStore, "get" | "save">;
  resolveTimezone: () => string;
  /** Returns the host-side absolute path to a user's Hermes home directory.
   *  Hermes worker reads HERMES_HOME at this path; the docker-backend uses
   *  the same path when bind-mounting per-task sandbox dirs (DiD via socket
   *  requires host paths). MUST resolve identically inside sentient-hermes
   *  and on the Docker host. */
  resolveHermesHome: (userId: string) => string;
}

/**
 * After every user has a port binding, render a supervisord program for each.
 * Idempotent: same content rewrites are no-ops because supervisorctl
 * reread/update tracks file content. Best-effort: failures are logged but
 * do NOT short-circuit other users.
 */
export async function renderProgramsForExistingUsers(deps: RenderProgramsDeps): Promise<void> {
  const usersResult = await deps.userStore.list();
  if (!usersResult.ok) {
    log.warn("renderPrograms.user-store-error", { error: usersResult.error });
    return;
  }
  const users = usersResult.value;
  if (users.length === 0) {
    log.debug("renderPrograms.noop", { reason: "no-users" });
    return;
  }

  const bindingsResult = await deps.userPortStore.list();
  if (!bindingsResult.ok) {
    log.warn("renderPrograms.binding-store-error", { error: bindingsResult.error });
    return;
  }
  const portByUser = new Map<string, number>();
  for (const b of bindingsResult.value) portByUser.set(b.userId, b.port);

  const token = deps.internalSecrets.getHermesAuthTokenSync();
  const timezone = deps.resolveTimezone();

  for (const user of users) {
    const port = portByUser.get(user.userId);
    if (typeof port !== "number") {
      log.warn("renderPrograms.no-binding", { userId: user.userId });
      continue;
    }
    // Resolve this user's model provider from their profile.
    // If the profile is missing or unreadable, this is a corruption case
    // (a user in users.yaml must have had a wizard-supplied profile saved at
    // creation time). Log a warn and skip — synthesizing a profile here would
    // silently paper over data loss and boot with wrong provider credentials.
    const profileResult = await deps.profileStore.get(user.userId);
    if (!profileResult.ok) {
      log.warn("renderPrograms.missing-profile", {
        userId: user.userId,
        reason: profileResult.error,
      });
      continue;
    }
    const hermesHome = deps.resolveHermesHome(user.userId);
    const rawProfile = profileResult.value;
    const profile = await reconcileSignalPaired(rawProfile, hermesHome);
    if (profile !== rawProfile) {
      const saveResult = await deps.profileStore.save(profile);
      if (!saveResult.ok) {
        log.warn("renderPrograms.reconcile-save-failed", {
          userId: user.userId,
          error: saveResult.error,
        });
      }
    }
    const r = await deps.supervisordControl.upsertProgram({
      userId: user.userId,
      port,
      token,
      timezone,
      provider: profile.model.provider,
      hermesHome,
      signalPaired: profile.devices?.signal?.paired === true,
    });
    if (!r.ok) {
      log.warn("renderPrograms.upsert-failed", {
        userId: user.userId,
        kind: r.error.kind,
        reason: r.error.reason,
      });
      continue;
    }
    log.info("renderPrograms.upserted", { userId: user.userId, port });
  }
}

// ---------------------------------------------------------------------------
// renderConfigsForExistingUsers — Phase F5 boot step
// ---------------------------------------------------------------------------

export interface RenderConfigsDeps {
  userStore: Pick<UserStore, "list">;
  /** Re-renders config.yaml + SOUL.md from the current template + per-user
   *  profile and writes both atomically. Idempotent — same content rewrites
   *  are no-ops (atomic write replaces the file with byte-identical content).
   *  Wired in phase-services from `renderAndWrite(applyDeps, userId)`. */
  renderInnerProfile: (userId: string) => Promise<Result<undefined, "render-error" | "write-error">>;
}

/**
 * On every gateway boot, re-render the inner Hermes profile (config.yaml +
 * SOUL.md) for every existing user. The renderer is a pure function of
 * (template, profile, mcp_catalog) — re-running it on every boot makes the
 * on-disk config track template changes (e.g. legacy `model: <id>` keys
 * picked up by upgrades that switched to `default: <id>`).
 *
 * Idempotent: identical output bytes are atomically rewritten — no semantic
 * change. Best-effort: per-user failures are logged but do NOT short-circuit
 * other users.
 *
 * Does NOT restart the worker. The Hermes ACP adapter re-reads the profile
 * config on each `_make_agent` call, so the next dispatch picks up new
 * content automatically.
 */
export async function renderConfigsForExistingUsers(deps: RenderConfigsDeps): Promise<void> {
  const usersResult = await deps.userStore.list();
  if (!usersResult.ok) {
    log.warn("renderConfigs.user-store-error", { error: usersResult.error });
    return;
  }
  const users = usersResult.value;
  if (users.length === 0) {
    log.debug("renderConfigs.noop", { reason: "no-users" });
    return;
  }

  for (const user of users) {
    const r = await deps.renderInnerProfile(user.userId);
    if (!r.ok) {
      log.warn("renderConfigs.render-failed", { userId: user.userId, error: r.error });
      continue;
    }
    log.info("renderConfigs.rendered", { userId: user.userId });
  }
}
