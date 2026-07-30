// Registers a gateway user with the Hermes CLI's own profile store.
//
// WHY THIS EXISTS. There are TWO profile trees, and the gateway used to write
// only one of them:
//   1. the gateway-side render — `profile-store`'s `renderInnerProfile` writes
//      config.yaml + SOUL.md into `getHermesProfileDir(userId)`, which is the
//      `cwd` hermes-runner spawns `hermes -p <userId>` in;
//   2. Hermes's OWN profile registration, which `hermes profile create` makes.
// Tree (1) is NOT the tree hermes reads its config.yaml from — that is the open
// defect D11; `hermes-profile-bridge.ts` carries the root cause and this module
// logs its detector below. Do not read the first bullet as "hermes picks the
// render up"; two waves of defect-chasing already read it that way.
// Writing (1) without (2) produces a directory that hermes will not use:
// `hermes -p <userId>` exits non-zero with "Profile '<userId>' does not exist.
// Create it with: hermes profile create <userId>" before it ever reads a
// prompt. The retired supervisord program spec carried `hermes profile create`
// as a self-bootstrapping prefix; the native cutover deleted the daemon and
// left nothing running it, so `delegateTask` failed for EVERY user on every
// fresh install (qa/web/evidence/2026-07-30-delegate-hermes-bg/README.md).
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
import { getLog } from "../logging/logger.js";
import {
  HERMES_PROFILE_BRIDGE_CONSEQUENCE,
  HERMES_PROFILE_BRIDGE_DEFECT,
  checkHermesProfileBridge,
} from "./hermes-profile-bridge.js";

const log = getLog(["sentient", "gateway", "admin", "hermes-profile"]);

const HERMES_BIN = "hermes";
/**
 * Truncate captured CLI output before it reaches a log line or an error. 120 is
 * the project-wide preview cap (`.claude/rules/logging.md`); this used to sit at
 * 300 in the one function whose own comment says the logged text is where a
 * credential would appear.
 *
 * Truncation is NOT the control that protects the credential, and must not be
 * mistaken for one: it bounds VOLUME, and a key at char 10 survives any cap.
 * The content control is `logging/log-sanitizer.ts`, which now scrubs inline
 * `api_key: …` assignments (the shape a dumped profile config has) and bare
 * provider key prefixes before anything is written. Both apply here: the
 * sanitizer removes the secret, the cap keeps a multi-KB config dump out of the
 * log file.
 */
const OUTPUT_PREVIEW_MAX = 120;

/** The subset of a spawned process this module touches — narrowed so the unit
 *  test never spawns a real `hermes`. Mirrors `tools/hermes-runner.ts`. */
export interface CliProcess {
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array> | string;
  readonly stderr: ReadableStream<Uint8Array> | string;
  kill(): void;
}

export type CliSpawnFn = (argv: readonly string[], options: { stdout: "pipe"; stderr: "pipe" }) => CliProcess;

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

function truncate(text: string): string {
  return text.length > OUTPUT_PREVIEW_MAX ? `${text.slice(0, OUTPUT_PREVIEW_MAX)}…` : text;
}

export function createHermesProfileProvisioner(deps: HermesProfileProvisionerDeps): HermesProfileProvisioner {
  const spawn = deps.spawn ?? ((argv, options) => Bun.spawn([...argv], options) as unknown as CliProcess);

  async function create(userId: string): Promise<Result<void, "cli-error">> {
    // Runs on user creation AND on every boot for every existing user (the
    // backfill in admin/boot-migration.ts), which is exactly the cadence a
    // still-open environment fault should be re-announced at. Checked before
    // the spawn: the bridge is a property of the environment, so it is worth
    // saying even on an install where the hermes binary is missing entirely.
    const bridge = checkHermesProfileBridge(userId);
    if (!bridge.isLive) {
      log.warn("hermes-profile.bridge.not-live", {
        userId,
        reason: bridge.reason,
        renderedRoot: bridge.renderedRoot,
        hermesHome: bridge.hermesHome,
        defect: HERMES_PROFILE_BRIDGE_DEFECT,
        consequence: HERMES_PROFILE_BRIDGE_CONSEQUENCE,
      });
    }

    // `--no-alias` skips the wrapper script hermes would otherwise drop on
    // PATH per profile: a per-user shell shim is a shell surface nobody asked
    // for, and one per family member would accumulate forever.
    const argv = [HERMES_BIN, "profile", "create", userId, "--clone-from", deps.sourceProfile, "--no-alias"];
    const startedAt = Date.now();
    log.info("hermes-profile.create.start", { userId, sourceProfile: deps.sourceProfile });

    let proc: CliProcess;
    try {
      proc = spawn(argv, { stdout: "pipe", stderr: "pipe" });
    } catch (err) {
      log.warn("hermes-profile.create.spawn-failed", {
        userId,
        reason: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, error: "cli-error" };
    }

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      log.warn("hermes-profile.create.timeout", { userId, timeoutMs: deps.timeoutMs });
      proc.kill();
    }, deps.timeoutMs);

    try {
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const elapsedMs = Date.now() - startedAt;
      if (timedOut) return { ok: false, error: "cli-error" };
      if (code !== 0) {
        // Preview only, never the whole output: `hermes profile create`
        // prints the profile's resolved config, and a cloned profile's config
        // is exactly where a credential would show up.
        log.warn("hermes-profile.create.non-zero-exit", {
          userId,
          code,
          elapsedMs,
          preview: truncate(stderr || stdout),
        });
        return { ok: false, error: "cli-error" };
      }
      log.info("hermes-profile.create.ok", { userId, elapsedMs });
      return { ok: true, value: undefined };
    } finally {
      clearTimeout(timeout);
    }
  }

  return { create };
}
