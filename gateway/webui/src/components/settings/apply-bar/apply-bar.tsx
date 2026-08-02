// gateway/webui/src/components/settings/apply-bar/apply-bar.tsx
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { Btn } from "../primitives/btn.tsx";
import {
  applyButtonLabel,
  runApply,
  type ApplyBarState,
  type ApplyDeps,
  type PendingOpWithPayload,
} from "./apply-bar-machine.ts";

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

  const label = applyButtonLabel(pending);
  const isBusy = state.phase === "saving" || state.phase === "restarting";

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
    <div class="apply-bar" role="status" aria-live="polite">
      <div class="ab-text">
        <span class="ab-count">
          {pending.length} pending {pending.length === 1 ? "change" : "changes"}
        </span>
        <span class="ab-sub">{subtextFor(state)}</span>
      </div>
      <Btn kind="ghost" size="sm" onClick={onDiscard} disabled={isBusy}>
        Discard
      </Btn>
      <Btn kind="primary" size="sm" onClick={handleApply} disabled={isBusy}>
        {state.phase === "saving" && <><span class="spin-mini" /> Saving…</>}
        {state.phase === "restarting" && <><span class="spin-mini" /> Applying…</>}
        {state.phase === "ready" && <>Done</>}
        {state.phase === "failed" && <>Retry</>}
        {state.phase === "idle" && label}
      </Btn>
    </div>
  );
}

// Nothing restarts on apply — Hermes is a one-shot exec that reads its
// on-disk profile fresh on every delegation (gateway/src/apply/orchestrator.ts).
// Both branches read the same because there is no distinct slow-op UX left
// to describe; keep the phase-based failure branch since that IS distinct.
function subtextFor(state: ApplyBarState): string {
  if (state.phase === "failed") return state.errorMessage;
  return "Changes will apply instantly";
}
