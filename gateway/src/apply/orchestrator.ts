import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { RenderedProfile } from "../profile-store/profile-renderer.js";
import type { ProfileStore } from "../profile-store/profile-store.js";
import type { ProfileV1 } from "../profile-store/profile-types.js";
import type { TemplateError } from "../profile-store/template-loader.js";

const log = getLog(["sentient", "apply", "orchestrator"]);

// ---------------------------------------------------------------------------
// Per-user apply — render the user's Hermes profile and write it to disk.
//
// This used to be a four-state machine (write-config → restart → health-check
// → ready): it re-upserted the user's supervisord program, restarted the
// per-user Hermes daemon inside the `sentient-hermes` container, then polled
// that daemon's `/health`. None of those exist in the native stack. Hermes is
// a one-shot exec (`hermes -p <userId> -z <prompt>`, see
// tools/hermes-runner.ts) whose `cwd` IS the profile dir, so writing the file
// is the entire operation — the very next delegation reads it. There is no
// process to restart and nothing to wait for, which is why `restarting` /
// `health-checking` and the `docker-restart-failed` / `health-check-timeout`
// outcomes are gone rather than stubbed.
// ---------------------------------------------------------------------------

export type ApplyState = "idle" | "writing-config" | "ready" | "failed";

export type ApplyError =
  | { kind: "render-error"; reason: string }
  | { kind: "write-error"; reason: string }
  | { kind: "user-not-found"; userId: string };

export interface ApplyDeps {
  profileStore: ProfileStore;
  // The MCP catalog is injected by the wrapper in apply-deps; orchestrator
  // hands the renderer no extra context — userId is already on the profile.
  renderProfile: (profile: ProfileV1, templateBody: string) => RenderedProfile;
  writeRendered: (userId: string, rendered: RenderedProfile, opts: { writeSoul: boolean }) => Promise<void>;
  loadTemplate: () => Promise<Result<string, TemplateError>>;
}

export interface ApplyOutcome {
  state: ApplyState;
  elapsedMs: number;
}

/** Render+write the per-user Hermes profile (config.yaml, and optionally
 *  SOUL.md) to the inner profile dir. Exposed so user-creation can write the
 *  inner config BEFORE the first delegation (otherwise `hermes -p <userId>`
 *  runs in a profile dir with no model/agent config).
 *
 *  `opts.writeSoul`: see writeRendered docstring. Apply and boot-migration
 *  paths pass `false` so user-edited SOUL.md is preserved; provisioner
 *  passes `true` to seed the initial SOUL.md.
 */
export async function renderAndWrite(
  deps: ApplyDeps,
  userId: string,
  opts: { writeSoul: boolean } = { writeSoul: false },
): Promise<Result<undefined, ApplyError>> {
  log.debug("apply.state", { userId, state: "writing-config" });
  const profileResult = await deps.profileStore.get(userId);
  if (!profileResult.ok) {
    log.warn("apply.userNotFound", { userId, reason: profileResult.error });
    return { ok: false, error: { kind: "user-not-found", userId } };
  }

  const templateResult = await deps.loadTemplate();
  if (!templateResult.ok) {
    const reason = `template-${templateResult.error}`;
    log.warn("apply.renderError", { userId, reason });
    return { ok: false, error: { kind: "render-error", reason } };
  }

  let rendered: RenderedProfile;
  try {
    rendered = deps.renderProfile(profileResult.value, templateResult.value);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("apply.renderError", { userId, reason });
    return { ok: false, error: { kind: "render-error", reason } };
  }

  try {
    await deps.writeRendered(userId, rendered, opts);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("apply.writeError", { userId, reason });
    return { ok: false, error: { kind: "write-error", reason } };
  }

  return { ok: true, value: undefined };
}

export async function runApply(deps: ApplyDeps, userId: string): Promise<Result<ApplyOutcome, ApplyError>> {
  const startedAt = Date.now();
  log.info("apply.begin", { userId });

  // Apply path: regenerate config.yaml only. SOUL.md is user-editable
  // via the System Prompt pane and must NOT be clobbered here — see the
  // WriteRenderedOpts docstring in profile-renderer.ts.
  const writeResult = await renderAndWrite(deps, userId, { writeSoul: false });
  if (!writeResult.ok) return writeResult;

  const elapsedMs = Date.now() - startedAt;
  log.info("apply.ready", { userId, elapsedMs });
  return { ok: true, value: { state: "ready", elapsedMs } };
}
