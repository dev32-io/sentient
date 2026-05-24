import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import { dispatchReset } from "./dispatch-reset.js";
import type { SupervisordControl, SupervisordError } from "./supervisord-control.js";

const log = getLog(["sentient", "gateway", "admin", "profile-restart-orchestrator"]);

// ---------------------------------------------------------------------------
// ProfileRestartOrchestrator — owns the supervisord-restart flow triggered
// by a SOUL or personality-structure edit.
//
// State machine: idle → restarting → ready | failed
//
// `restarting`: supervisord.restartProfile blocks until supervisorctl
//   returns. On non-zero exit we transition to `failed` immediately.
// `ready`: supervisord reports the per-user program back to RUNNING. We
//   no longer poll for WS readiness — under the ACP wire there is no
//   long-lived gateway-owned connection to re-attach. The next WS-session
//   bootstrap dials the freshly-restarted port on demand.
//
// TODO(acp-rewire): re-introduce a connected-state observability check
// (acp ping/pong, /healthz poll) so the orchestrator can confirm the
// dashboard sidecar + acp_ws_server have come back online before
// reporting ready. Tracked in
// docs/research/2026-05-08-apply-restart-acp-rewire-todo.md.
// ---------------------------------------------------------------------------

export type ProfileRestartState = "idle" | "restarting" | "ready" | "failed";

export type ProfileRestartError =
  | { kind: "supervisord-failed"; reason: string }
  | { kind: "ws-not-ready"; reason: string }
  | { kind: "resolve-failed"; reason: string };

export interface ProfileRestartOutcome {
  state: "ready" | "failed";
  elapsedMs: number;
}

export interface ProfileRestartConfig {
  /** Total wall time allowed for the restart phase. */
  restartTimeoutMs: number;
  /**
   * Cadence between WS-readiness checks during the polling phase. Currently
   * unused (no polling) but kept on the config so callers compile against
   * the same shape until the ACP-side observability rewrite lands.
   */
  pollIntervalMs: number;
}

export interface ProfileRestartDeps {
  supervisord: Pick<SupervisordControl, "restartProfile">;
  config: ProfileRestartConfig;
  /** Resolves whether the given user has a Signal device paired. Used to
   *  target the correct set of supervisord programs (2 or 4) on restart.
   *  Must return false when the profile is unavailable — the unpaired
   *  program set is always safe to restart. */
  resolveSignalPaired: (userId: string) => Promise<boolean>;
  /** Optional state-callback for tests + UI hooks. */
  onState?: (state: ProfileRestartState) => void;
  /** Override timer source for tests. */
  now?: () => number;
}

export interface ProfileRestartOrchestrator {
  restart(userId: string): Promise<Result<ProfileRestartOutcome, ProfileRestartError>>;
}

export function createProfileRestartOrchestrator(deps: ProfileRestartDeps): ProfileRestartOrchestrator {
  const now = deps.now ?? (() => Date.now());

  function transition(state: ProfileRestartState): void {
    if (deps.onState) deps.onState(state);
  }

  return {
    async restart(userId) {
      const startedAt = now();
      log.info("restart.begin", { userId });

      transition("restarting");
      const signalPaired = await deps.resolveSignalPaired(userId);
      const restartResult = await deps.supervisord.restartProfile(userId, deps.config.restartTimeoutMs, signalPaired);
      if (!restartResult.ok) {
        transition("failed");
        return failedFromSupervisord(userId, restartResult.error, now() - startedAt);
      }

      // Hermes persists its session on disk; bouncing the worker re-reads
      // SOUL.md / config.yaml but resumes the existing chat session. The
      // prompt rotation that used to happen via `/reset` over the legacy
      // custom-WS pool is a no-op under ACP today (see dispatch-reset.ts).
      dispatchReset({ log, source: "restart" }, userId);

      log.warn("restart.ready-without-ws-probe", {
        userId,
        reason: "ACP wire has no observability hook for connected-state — see acp-rewire-todo.md",
      });
      transition("ready");
      const elapsedMs = now() - startedAt;
      log.info("restart.ready", { userId, elapsedMs });
      return { ok: true, value: { state: "ready", elapsedMs } };
    },
  };
}

function failedFromSupervisord(
  userId: string,
  err: SupervisordError,
  elapsedMs: number,
): Result<ProfileRestartOutcome, ProfileRestartError> {
  const reason = err.reason || err.kind;
  log.warn("restart.supervisord-failed", { userId, reason, elapsedMs });
  return { ok: false, error: { kind: "supervisord-failed", reason } };
}
