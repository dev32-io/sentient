// Registers a gateway user with the Hermes CLI's own profile store.
//
// WHY THIS EXISTS. There are TWO profile trees:
//   1. the gateway-side render — `profile-store`'s `renderInnerProfile` writes
//      config.yaml + SOUL.md into `getHermesProfileDir(userId)`, which is the
//      `cwd` hermes-runner spawns `hermes -p <userId>` in;
//   2. Hermes's OWN profile registration, which `hermes profile create` makes.
// Writing (1) without (2) produces a directory that hermes will not use:
// `hermes -p <userId>` exits non-zero with "Profile '<userId>' does not exist.
// Create it with: hermes profile create <userId>" before it ever reads a
// prompt. The retired supervisord program spec carried `hermes profile create`
// as a self-bootstrapping prefix; the native cutover deleted the daemon and
// left nothing running it, so `delegateTask` failed for EVERY user on every
// fresh install (qa/web/evidence/2026-07-30-delegate-hermes-bg/README.md).
//
// Tree (1) is still NOT the tree hermes reads its config.yaml from — hermes
// reads its own store. What the delegated agent can CALL is therefore decided
// by `external-tools/hermes-external-tool.ts`, which registers the gateway's
// per-user MCP socket through `hermes mcp add`. This module owns only the
// profile's existence; that one owns its tools.
//
// WHY `--clone-from` RATHER THAN BINDING A MODEL + KEY OURSELVES. A bare
// `hermes profile create <userId>` is not enough either — the new profile has
// no model and no credential, so a one-shot answers `HTTP 401: User not found`
// (the second half of that same evidence note). `--clone-from <source>` is
// Hermes's own public API for "give this profile the same provider, model and
// credentials as that one", so the operator's already-configured profile is
// the single place a key lives. The gateway therefore never reads, writes, or
// holds a Hermes credential — which is both the project rule against reaching
// into Hermes internals and the smallest possible secret-handling surface.
// (The gateway's own `getActiveLlm()` key stays where it is: it configures the
// gateway's ReAct loop, a separate provider edge from the delegated agent's.)

import type { Result } from "@sentient/protocol";
import { type CliSpawnFn, HERMES_BIN, runHermesCli } from "../external-tools/hermes-cli.js";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "gateway", "admin", "hermes-profile"]);

export interface HermesProfileProvisionerDeps {
  /** `orchestrator.delegation.hermes_source_profile` — the operator's already
   *  configured Hermes profile that new per-user profiles inherit provider,
   *  model and credentials from. */
  sourceProfile: string;
  /** `orchestrator.delegation.hermes_profile_create_timeout_ms`. */
  timeoutMs: number;
  spawn?: CliSpawnFn;
}

export interface HermesProfileProvisioner {
  /** Idempotent from the caller's side: an already-registered profile comes
   *  back as a `cli-error` the caller logs and ignores, never a throw. */
  create(userId: string): Promise<Result<void, "cli-error">>;
}

export function createHermesProfileProvisioner(deps: HermesProfileProvisionerDeps): HermesProfileProvisioner {
  async function create(userId: string): Promise<Result<void, "cli-error">> {
    // `--no-alias` skips the wrapper script hermes would otherwise drop on
    // PATH per profile: a per-user shell shim is a shell surface nobody asked
    // for, and one per family member would accumulate forever.
    const argv = [HERMES_BIN, "profile", "create", userId, "--clone-from", deps.sourceProfile, "--no-alias"];
    log.info("hermes-profile.create.start", { userId, sourceProfile: deps.sourceProfile });

    const result = await runHermesCli({
      argv,
      timeoutMs: deps.timeoutMs,
      ...(deps.spawn ? { spawn: deps.spawn } : {}),
      step: "profile-create",
      userId,
    });
    if (!result.ok) {
      log.warn("hermes-profile.create.failed", { userId, reason: result.error });
      return { ok: false, error: "cli-error" };
    }
    log.info("hermes-profile.create.ok", { userId });
    return { ok: true, value: undefined };
  }

  return { create };
}
