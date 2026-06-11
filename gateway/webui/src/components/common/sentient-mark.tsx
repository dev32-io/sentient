import type { JSX } from "preact";

export type SentientMarkMode = "idle" | "thinking" | "speaking" | "listening";

export interface SentientMarkProps {
  size?: number;
  mode?: SentientMarkMode;
  className?: string;
}

/**
 * The Sentient brand atom — the ONE shared static asset (public/sentient-mark.svg,
 * the same SVG mobile renders). ALWAYS static.
 *
 * The "Sentient is active" ripple is NOT part of the mark — it lives on the chat
 * assistant avatar wrapper (.avatar--active). The top bar / any other mark stays
 * static. `mode` is accepted for call-site compatibility but does not affect
 * rendering (the old electron-spin / halo-nucleus keyframes are gone).
 */
export function SentientMark({ size = 26, mode: _mode = "idle", className = "" }: SentientMarkProps): JSX.Element {
  return (
    <span
      class={`sentient-mark${className ? ` ${className}` : ""}`}
      style={{ width: `${size}px`, height: `${size}px` }}
      aria-hidden="true"
    >
      <img src="/sentient-mark.svg" width={size} height={size} alt="" />
    </span>
  );
}
