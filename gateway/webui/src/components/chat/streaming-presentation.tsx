import type { JSX } from "preact";

export interface SpeakingWaveProps {
  active: boolean;
}

export function SpeakingWave({ active }: SpeakingWaveProps): JSX.Element | null {
  if (!active) return null;
  return <span class="bubble-speaking-wave" aria-hidden="true" />;
}

export function ThinkingPulse(): JSX.Element {
  return (
    <span class="bubble-text__pulse" aria-label="assistant is thinking" role="status">
      <span class="bubble-text__pulse-dot" />
      <span class="bubble-text__pulse-dot" />
      <span class="bubble-text__pulse-dot" />
    </span>
  );
}

export function StreamingCaret(): JSX.Element {
  return <span class="bubble-text__caret" aria-hidden="true" />;
}
