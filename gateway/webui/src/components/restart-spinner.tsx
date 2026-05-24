import type { JSX } from "preact";

// ---------------------------------------------------------------------------
// RestartSpinner — inline progress UI for self-service profile edits.
//
//   idle       hidden
//   saving     small spinner + "Saving…"
//   restarting larger ribbon + "Restarting your assistant…"
//   ready      green check + "Ready" (auto-hide handled by parent)
//   failed     red banner with reason + Retry button
//
// Purely presentational. Parent owns the FSM (see apply-machine.ts pattern).
// ---------------------------------------------------------------------------

export type RestartSpinnerState = "idle" | "saving" | "restarting" | "ready" | "failed";

export interface RestartSpinnerProps {
  state: RestartSpinnerState;
  /** Elapsed ms from the gateway's restart result, shown on `ready`. */
  elapsedMs?: number | undefined;
  /** Human-readable error message, shown on `failed`. */
  errorMessage?: string | undefined;
  onRetry?: (() => void) | undefined;
}

export function RestartSpinner({
  state,
  elapsedMs,
  errorMessage,
  onRetry,
}: RestartSpinnerProps): JSX.Element | null {
  if (state === "idle") return null;
  if (state === "saving") return renderSaving();
  if (state === "restarting") return renderRestarting();
  if (state === "ready") return renderReady(elapsedMs);
  return renderFailed(errorMessage, onRetry);
}

function renderSaving(): JSX.Element {
  return (
    <div class="restart-spinner restart-spinner--saving" role="status" aria-live="polite">
      <span class="restart-spinner__dot" aria-hidden="true" />
      <span class="restart-spinner__text">Saving…</span>
    </div>
  );
}

function renderRestarting(): JSX.Element {
  return (
    <div class="restart-spinner restart-spinner--restarting" role="status" aria-live="polite">
      <span class="restart-spinner__spinner" aria-hidden="true" />
      <span class="restart-spinner__text">Restarting your assistant…</span>
    </div>
  );
}

function renderReady(elapsedMs?: number): JSX.Element {
  const detail = typeof elapsedMs === "number" ? ` (${formatElapsed(elapsedMs)})` : "";
  return (
    <div class="restart-spinner restart-spinner--ready" role="status" aria-live="polite">
      <span class="restart-spinner__check" aria-hidden="true">
        ✓
      </span>
      <span class="restart-spinner__text">Ready{detail}</span>
    </div>
  );
}

function renderFailed(errorMessage: string | undefined, onRetry?: () => void): JSX.Element {
  return (
    <div class="restart-spinner restart-spinner--failed" role="alert">
      <span class="restart-spinner__warn" aria-hidden="true">
        !
      </span>
      <span class="restart-spinner__text">{errorMessage ?? "Something went wrong."}</span>
      {onRetry && (
        <button type="button" class="restart-spinner__retry settings-ghost-btn" onClick={onRetry}>
          Retry
        </button>
      )}
      <a class="restart-spinner__logs" href="#logs" aria-label="View logs">
        View logs
      </a>
    </div>
  );
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
