// gateway/webui/src/components/account-wizard/step-review.tsx
import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";
import type { DraftAccount } from "./AccountWizard.tsx";
import { Btn } from "../settings/primitives/btn.tsx";

const log = createLogger(["sentient", "webui", "account-wizard", "step-review"]);

// Label cycling for the submit spinner — 5s each, last one repeats.
const STAGE_LABELS = [
  "Creating profile…",
  "Starting your assistant…",
  "Verifying connection…",
] as const;

const STAGE_INTERVAL_MS = 5000;

export interface StepReviewProps {
  draft: DraftAccount;
  busy: boolean;
  stageLabel: string;
  error: string | null;
  onBack: () => void;
  onSubmit: () => void;
  onCancel?: () => void;
}

export function StepReview({
  draft,
  busy,
  stageLabel,
  error,
  onBack,
  onSubmit,
  onCancel,
}: StepReviewProps): JSX.Element {
  log.debug("render", { busy, hasError: !!error });

  return (
    <section class="aw-step aw-step-review">
      <h2 class="aw-step__title">Review &amp; create</h2>

      <div class="aw-fields">
        <p class="aw-fields__label">Account summary</p>
        <dl class="aw-review-dl">
          <dt>Display name</dt>
          <dd>{draft.displayName || <span class="aw-muted">—</span>}</dd>

          <dt>Role</dt>
          <dd>{draft.isAdmin ? "Admin" : "Member"}</dd>

          <dt>Provider</dt>
          <dd>{draft.profile.model.provider}</dd>

          <dt>Model</dt>
          <dd>
            <code class="aw-code">{draft.profile.model.id || <span class="aw-muted">—</span>}</code>
          </dd>

          <dt>Voice ID</dt>
          <dd>
            <code class="aw-code">{draft.profile.voice.id || <span class="aw-muted">—</span>}</code>
          </dd>
        </dl>
      </div>

      {error && (
        <div class="aw-error-banner" role="alert">
          {error}
        </div>
      )}

      {busy && (
        <div class="aw-spinner-row" aria-live="polite">
          <span class="aw-spinner" aria-hidden="true" />
          <span class="aw-spinner-label">{stageLabel}</span>
        </div>
      )}

      <footer class="aw-footer">
        {onCancel && (
          <Btn kind="ghost" disabled={busy} onClick={onCancel}>Cancel</Btn>
        )}
        <span class="aw-footer__spacer" />
        <Btn kind="secondary" disabled={busy} onClick={onBack}>Back</Btn>
        <Btn kind="primary" disabled={busy} onClick={onSubmit}>
          {busy ? "Creating…" : "Create account"}
        </Btn>
      </footer>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Exported helper — manages the staged spinner label for the caller.
// ---------------------------------------------------------------------------

export function buildStagedLabels(): () => string {
  let stage = 0;
  const last = STAGE_LABELS.length - 1;
  return function tick(): string {
    const label = STAGE_LABELS[Math.min(stage, last)] as string;
    if (stage < last) stage++;
    return label;
  };
}

export { STAGE_INTERVAL_MS };
