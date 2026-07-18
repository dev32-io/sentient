import type { Result } from "@sentient/protocol";
import { dispatchReset } from "../admin/dispatch-reset.js";
import type { SupervisordControl } from "../admin/supervisord-control.js";
import type { HealthPollError, HealthPoller } from "../infrastructure/health-poller.js";
import { getLog } from "../logging/logger.js";
import type { PersonSessionRegistry } from "../person-session/person-session-registry.js";
import type { RenderedProfile } from "../profile-store/profile-renderer.js";
import type { ProfileStore } from "../profile-store/profile-store.js";
import type { ProfileV1 } from "../profile-store/profile-types.js";
import type { TemplateError } from "../profile-store/template-loader.js";
import type { SessionRouter } from "../session-router.js";

const log = getLog(["sentient", "apply", "orchestrator"]);

export type ApplyState = "idle" | "writing-config" | "restarting" | "health-checking" | "ready" | "failed";

export type ApplyError =
  | { kind: "render-error"; reason: string }
  | { kind: "write-error"; reason: string }
  | { kind: "docker-restart-failed"; reason: string }
  | { kind: "health-check-timeout"; cause: HealthPollError }
  | { kind: "user-not-found"; userId: string };

export interface ApplyDeps {
  profileStore: ProfileStore;
  sessionRouter: SessionRouter;
  /** Per-user session registry — apply clears the resolved PersonSession's
   *  conversation anchors (see runApply) instead of going through
   *  SessionRouter, which no longer owns anchor state. */
  personSessions: PersonSessionRegistry;
  healthPoller: HealthPoller;
  // The MCP catalog is injected by the wrapper in apply-deps; orchestrator
  // hands the renderer no extra context — userId is already on the profile.
  renderProfile: (profile: ProfileV1, templateBody: string) => RenderedProfile;
  writeRendered: (userId: string, rendered: RenderedProfile, opts: { writeSoul: boolean }) => Promise<void>;
  loadTemplate: () => Promise<Result<string, TemplateError>>;
  resolveContainerName: (userId: string) => Promise<string>;
  resolveHealthUrl: (userId: string) => Promise<string>;
  resolveHealthHeaders: (userId: string) => Promise<Record<string, string>>;
  /** Restarts the per-user supervisord programs (both
   *  `hermes-<userId>-acp` and `hermes-<userId>-dashboard`). The error
   *  kind here is mapped to the existing `docker-restart-failed`
   *  outcome for stability. */
  supervisordControl: Pick<SupervisordControl, "restartProfile">;
  /** Re-upsert the supervisord program file with the current provider's
   *  env block. Required BEFORE restart on every apply — otherwise a
   *  provider switch (e.g. ollama-cloud → openrouter) rewrites config.yaml
   *  to reference `OPENROUTER_API_KEY` while the supervisord `environment=`
   *  block still carries the previous provider's keys, the worker boots
   *  with an empty `OPENROUTER_API_KEY`, and the next cycle fails with
   *  `RequestError: Internal error`. Failures map to the existing
   *  `docker-restart-failed` outcome. */
  refreshProgramEnv: (userId: string) => Promise<Result<undefined, ApplyError>>;
  config: {
    dockerRestartTimeoutMs: number;
    healthCheckTimeoutMs: number;
    healthPollIntervalMs: number;
  };
}

export interface ApplyOutcome {
  state: ApplyState;
  elapsedMs: number;
}

/** Render+write the per-user Hermes profile (config.yaml, and optionally
 *  SOUL.md) to the inner profile dir. Exposed so user-creation can write the
 *  inner config BEFORE supervisord boots the worker (otherwise the worker
 *  comes up with no model/agent config and the first cycle aborts).
 *  Re-used inside runApply via runWritingConfig.
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

async function runRestartAndHealth(
  deps: ApplyDeps,
  userId: string,
  signalPaired: boolean,
): Promise<Result<undefined, ApplyError>> {
  log.debug("apply.state", { userId, state: "restarting" });
  // NOTE: signal-cli + gateway health verification for paired users is out of
  // scope for the in-process healthcheck (deferred to operator-side Playwright
  // smoke, Task 23). acp running is a sufficient liveness signal here.
  const restartResult = await deps.supervisordControl.restartProfile(
    userId,
    deps.config.dockerRestartTimeoutMs,
    signalPaired,
  );
  if (!restartResult.ok) {
    const reason = restartResult.error.reason ?? restartResult.error.kind;
    log.warn("apply.dockerRestartFailed", { userId, reason });
    return {
      ok: false,
      error: { kind: "docker-restart-failed", reason },
    };
  }

  log.debug("apply.state", { userId, state: "health-checking" });
  const url = await deps.resolveHealthUrl(userId);
  const headers = await deps.resolveHealthHeaders(userId);
  const healthResult = await deps.healthPoller.pollUntilHealthy(
    url,
    headers,
    deps.config.healthCheckTimeoutMs,
    deps.config.healthPollIntervalMs,
  );
  if (!healthResult.ok) {
    log.warn("apply.healthCheckTimeout", { userId, url, cause: healthResult.error });
    return { ok: false, error: { kind: "health-check-timeout", cause: healthResult.error } };
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

  // Derive signal-pairing state from the profile so restartProfile targets the
  // correct set of supervisord programs (2 for unpaired, 4 for paired).
  const profileResult = await deps.profileStore.get(userId);
  const signalPaired = profileResult.ok ? profileResult.value.devices?.signal?.paired === true : false;

  // Re-upsert the supervisord program so its `environment=` block matches
  // the provider currently named in config.yaml. Without this step the conf
  // keeps the provider it had at last upsert (user-creation or boot-migration)
  // and a provider switch leaves the worker without the new provider's key.
  const refreshResult = await deps.refreshProgramEnv(userId);
  if (!refreshResult.ok) return refreshResult;

  // Clear conversationId BEFORE restart so any in-flight WS turn racing the
  // restart starts a fresh chain instead of continuing on the stale one.
  // Anchors now live on PersonSession (not SessionRouter) — no-op if the
  // user has no live PersonSession.
  deps.personSessions.get(userId)?.clearAllAnchors();

  const runResult = await runRestartAndHealth(deps, userId, signalPaired);
  if (!runResult.ok) return runResult;

  // After a fresh worker boot Hermes resumes the existing chat session and
  // reuses its cached system_prompt; under the legacy custom-WS adapter the
  // gateway used to fire `/reset` here to rotate session_id immediately.
  // ACP has no equivalent today (see dispatch-reset.ts), so this is a
  // logged no-op — operators who need an immediate fresh prompt can use
  // "+ New chat" from the drawer.
  dispatchReset({ log, source: "apply" }, userId);

  const elapsedMs = Date.now() - startedAt;
  log.info("apply.ready", { userId, elapsedMs });
  return { ok: true, value: { state: "ready", elapsedMs } };
}
