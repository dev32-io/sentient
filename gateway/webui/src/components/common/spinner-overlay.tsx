import type { JSX } from "preact";

export interface SpinnerOverlayProps {
  open: boolean;
  heading: string;
  body?: string;
}

export function SpinnerOverlay({ open, heading, body }: SpinnerOverlayProps): JSX.Element | null {
  if (!open) return null;
  return (
    <div class="spinner-overlay" role="alertdialog" aria-modal="true" aria-live="assertive">
      <div class="spinner-overlay__card">
        <div class="spinner-overlay__spinner" aria-hidden="true" />
        <h2 class="spinner-overlay__heading">{heading}</h2>
        {body && <p class="spinner-overlay__body">{body}</p>}
      </div>
    </div>
  );
}
