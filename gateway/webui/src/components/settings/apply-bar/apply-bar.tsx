// gateway/webui/src/components/settings/apply-bar/apply-bar.tsx
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { ActionButton } from "../../common/foundation.tsx";
import { runApply, type ApplyBarState, type ApplyDeps, type PendingOpWithPayload } from "./apply-bar-machine.ts";

const log = createLogger(["sentient", "webui", "settings", "apply-bar"]);

export interface ApplyBarProps {
  pending: PendingOpWithPayload[];
  deps: ApplyDeps;
  onApplied: () => void; // parent clears dirty
  onDiscard: () => void;
}

export function ApplyBar({ pending, deps, onApplied, onDiscard }: ApplyBarProps): JSX.Element | null {
  const [state, setState] = useState<ApplyBarState>({ phase: "idle", pending });

  if (pending.length === 0 && state.phase === "idle") return null;

  // Always "Apply changes" — there is no restart to distinguish; a `slow`
  // op's extra profile rewrite is a background disk write (measured 8-12ms),
  // invisible to the user.
  const label = "Apply changes";
  const isBusy = state.phase === "saving" || state.phase === "restarting";
  const visualState = state.phase === "ready"
    ? "done"
    : isBusy
      ? "applying"
      : state.phase === "failed" || state.phase === "already-applying"
        ? "error"
        : "dirty";

  const handleApply = async () => {
    log.info("apply.start", { count: pending.length, hasSlow: pending.some((p) => p.kind === "slow") });
    const outcome = await runApply(pending, deps, setState);
    if (outcome.ok) {
      log.info("apply.ok");
      onApplied();
      // hold "ready" briefly, then return to idle
      setTimeout(() => setState({ phase: "idle", pending: [] }), 1500);
    } else {
      log.warn("apply.failed", { errorMessage: outcome.errorMessage });
    }
  };

  return (
    <div class="apply-bar" data-state={visualState} role="status" aria-live="polite">
      <div class="ab-copy">
        <i class="ab-marker" aria-hidden="true" />
        <div class="ab-text">
          <span class="ab-count">
            {state.phase === "ready"
              ? "Changes applied"
              : `${pending.length} unsaved ${pending.length === 1 ? "change" : "changes"}`}
          </span>
          <span class="ab-sub">{subtextFor(state)}</span>
        </div>
      </div>
      <div class="ab-actions">
        <ActionButton variant="quiet" onClick={onDiscard} disabled={isBusy}>
          Discard
        </ActionButton>
        <ActionButton variant="primary" onClick={() => void handleApply()} disabled={isBusy} loading={isBusy}>
          {state.phase === "saving" && <>Saving…</>}
          {state.phase === "restarting" && <>Applying…</>}
          {state.phase === "ready" && <>Applied</>}
          {state.phase === "already-applying" && <>Retry</>}
          {state.phase === "failed" && <>Retry</>}
          {state.phase === "idle" && label}
        </ActionButton>
      </div>
    </div>
  );
}

// Nothing restarts on apply — Hermes is a one-shot exec that reads its
// on-disk profile fresh on every delegation (gateway/src/apply/orchestrator.ts).
// Both branches read the same because there is no distinct slow-op UX left
// to describe; keep the phase-based failure branch since that IS distinct.
function subtextFor(state: ApplyBarState): string {
  if (state.phase === "already-applying") return "Another apply is already in progress";
  if (state.phase === "failed") return state.errorMessage;
  if (state.phase === "ready") return "The household preference is up to date.";
  return "Review before applying to the household.";
}
