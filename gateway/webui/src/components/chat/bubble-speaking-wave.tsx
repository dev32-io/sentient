import type { JSX } from "preact";

export interface BubbleSpeakingWaveProps {
  active: boolean;
}

export function BubbleSpeakingWave({ active }: BubbleSpeakingWaveProps): JSX.Element | null {
  if (!active) return null;
  return <span class="bubble-speaking-wave" aria-hidden="true" />;
}
