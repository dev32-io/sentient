import type { JSX } from "preact";
import { ActionButton } from "../common/foundation.tsx";
import { classes } from "../common/foundation/utils.ts";
import "./stale-banner.css";

export interface StaleBannerProps {
  checking: boolean;
  onRetry(): void;
  className?: string | undefined;
}

export function StaleBanner({ checking, onRetry, className }: StaleBannerProps): JSX.Element {
  return (
    <section
      class={classes("snt-plate", "snt-stale-banner", className)}
      data-state={checking ? "checking" : undefined}
      role="alert"
      aria-busy={checking || undefined}
    >
      <div class="snt-stale-banner__content">
        <span>
          <strong>Showing saved results</strong>
          <small>Couldn’t refresh just now.</small>
        </span>
        <ActionButton
          variant="quiet"
          className="snt-stale-banner__retry"
          disabled={checking}
          onClick={onRetry}
        >
          {checking ? "Checking…" : "Retry"}
        </ActionButton>
      </div>
    </section>
  );
}
