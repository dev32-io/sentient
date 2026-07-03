import type { JSX } from "preact";
import { useRef } from "preact/hooks";

// Decorative listening waveform — bar heights follow a fixed sine contour,
// the CSS animation adds life. Not driven by real mic levels.

const BAR_COUNT_WIDE = 52;
const BAR_COUNT_NARROW = 32;
const BAR_HEIGHT_BASE_PCT = 20;
const BAR_HEIGHT_SPAN_PCT = 64;
const BAR_PHASE_STEP = 0.7;
const BAR_DELAY_CYCLE = 13;
const BAR_DELAY_STEP_S = 0.06;
const NARROW_VIEWPORT_QUERY = "(max-width: 620px)";

function isNarrowViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(NARROW_VIEWPORT_QUERY).matches
  );
}

export function PttWave(): JSX.Element {
  // Stable per mount — matched once, like the composer's placeholder width check.
  const count = useRef(isNarrowViewport() ? BAR_COUNT_NARROW : BAR_COUNT_WIDE);

  return (
    <div class="ptt-bigwave" aria-hidden="true">
      {Array.from({ length: count.current }).map((_, i) => {
        const height =
          BAR_HEIGHT_BASE_PCT + Math.round(BAR_HEIGHT_SPAN_PCT * Math.abs(Math.sin(i * BAR_PHASE_STEP)));
        const delay = (i % BAR_DELAY_CYCLE) * BAR_DELAY_STEP_S;
        return <i key={i} style={`height: ${height}%; animation-delay: ${delay}s;`} />;
      })}
    </div>
  );
}
