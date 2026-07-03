import { createLogger } from "@sentient/web-sdk";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../common/icon.tsx";
import { clampDrag, isArmed, type MicCornerMode, resolveRelease } from "./mic-corner-gesture.ts";

const log = createLogger(["sentient", "webui", "mic-corner"]);

export interface MicCornerProps {
  /**
   * Mirrors `voiceMode === "active"`. When the mic is torn down externally
   * (disconnect, cleanup) the control resets itself to idle without calling
   * `onStop` again.
   */
  active: boolean;
  /** Composer takeover (waveform, hidden buttons) follows the reported mode. */
  onModeChange(mode: MicCornerMode): void;
  /** Start voice mode. Rejection resets the control to idle. */
  onStart(): Promise<void>;
  /** Stop voice mode. */
  onStop(): void;
}

const HAPTIC_LOCK_MS = 18;
const HAPTIC_RELEASE_MS = 12;
/** Used until the wrap is measured; real travel = wrap width − button width. */
const FALLBACK_TRAVEL_PX = 62;
const MIN_TRAVEL_PX = 36;

function buzz(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // vibration unsupported — visual feedback carries the interaction
  }
}

export function MicCorner(props: MicCornerProps): JSX.Element {
  const { active, onModeChange, onStart, onStop } = props;

  const [mode, setModeState] = useState<MicCornerMode>("idle");
  const [drag, setDragState] = useState(0);
  const [dragging, setDragging] = useState(false);

  const modeRef = useRef<MicCornerMode>("idle");
  const dragRef = useRef(0);
  const originRef = useRef<MicCornerMode>("idle");
  const startXRef = useRef(0);
  const baseRef = useRef(0);
  const travelRef = useRef(FALLBACK_TRAVEL_PX);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const prevActiveRef = useRef(active);

  function setDrag(px: number): void {
    dragRef.current = px;
    setDragState(px);
  }

  function resetToIdle(trigger: string): void {
    const prev = modeRef.current;
    modeRef.current = "idle";
    setModeState("idle");
    setDrag(0);
    onModeChange("idle");
    log.info("mode-change", { from: prev, to: "idle", trigger });
  }

  function setMode(next: MicCornerMode, trigger: string): void {
    const prev = modeRef.current;
    if (prev === next) return;
    modeRef.current = next;
    setModeState(next);
    onModeChange(next);
    log.info("mode-change", { from: prev, to: next, trigger });
    if (prev === "idle") {
      onStart().catch((err: unknown) => {
        log.warn("mic-start-failed", { reason: String(err) });
        resetToIdle("start-failed");
      });
    } else if (next === "idle") {
      onStop();
    }
  }

  // External teardown (disconnect, cleanup) while held/locked → snap back to
  // idle. Only reacts to a true→false edge so it never races the optimistic
  // hold that begins before `active` propagates.
  useEffect(() => {
    const was = prevActiveRef.current;
    prevActiveRef.current = active;
    if (was && !active && modeRef.current !== "idle" && !dragging) {
      resetToIdle("external-off");
    }
  }, [active, dragging]);

  function measureTravel(): number {
    const wrap = wrapRef.current;
    const button = buttonRef.current;
    if (wrap && button) {
      travelRef.current = Math.max(MIN_TRAVEL_PX, wrap.clientWidth - button.offsetWidth);
    }
    return travelRef.current;
  }

  function handlePointerDown(e: PointerEvent): void {
    e.preventDefault();
    buttonRef.current?.setPointerCapture(e.pointerId);
    const travel = measureTravel();
    if (modeRef.current === "locked") {
      originRef.current = "locked";
      baseRef.current = travel;
    } else {
      originRef.current = "idle";
      baseRef.current = 0;
      setMode("hold", "pointer-down");
    }
    startXRef.current = e.clientX;
    setDrag(baseRef.current);
    setDragging(true);
  }

  function handlePointerMove(e: PointerEvent): void {
    if (!dragging) return;
    setDrag(clampDrag(baseRef.current, startXRef.current, e.clientX, travelRef.current));
  }

  function handlePointerUp(): void {
    if (!dragging) return;
    const travel = travelRef.current;
    const outcome = resolveRelease(originRef.current, dragRef.current, travel);
    log.debug("release", {
      origin: originRef.current,
      drag: Math.round(dragRef.current),
      travel,
      outcome: outcome.mode,
    });
    setDrag(outcome.drag);
    setDragging(false);
    if (outcome.mode === "locked" && originRef.current === "idle") buzz(HAPTIC_LOCK_MS);
    if (outcome.mode === "idle" && originRef.current === "locked") buzz(HAPTIC_RELEASE_MS);
    setMode(outcome.mode, "pointer-up");
  }

  // Keyboard can't drag — Enter/Space toggles hands-free lock directly.
  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (modeRef.current === "locked") {
      setDrag(0);
      setMode("idle", "keyboard");
    } else {
      setDrag(measureTravel());
      setMode("locked", "keyboard");
    }
  }

  const railShown = dragging || mode === "locked";
  const armed = isArmed(drag, travelRef.current);
  const progress = travelRef.current > 0 ? Math.min(1, drag / travelRef.current) : 0;
  const classes = [
    "mic-corner-wrap",
    `mic-corner-wrap--${mode}`,
    dragging && "mic-corner-wrap--dragging",
    railShown && "mic-corner-wrap--rail",
    armed && "mic-corner-wrap--armed",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={wrapRef} class={classes} style={`--mic-drag-progress: ${progress.toFixed(3)};`}>
      <span class="mic-corner-wrap__trail" aria-hidden="true" />
      <span class="mic-corner-wrap__detent" aria-hidden="true" />
      <button
        ref={buttonRef}
        type="button"
        class="mic-corner"
        style={`transform: translateX(${-drag}px);`}
        role="switch"
        aria-checked={mode === "locked"}
        aria-label={
          mode === "locked"
            ? "Hands-free listening on — drag back to stop"
            : "Hold to talk; slide to lock hands-free"
        }
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
      >
        <span class="mic-corner__body" aria-hidden="true" />
        <span class="mic-corner__ripple" aria-hidden="true" />
        <span class="mic-corner__face">
          <Icon name="mic" size={16} />
        </span>
      </button>
    </div>
  );
}
