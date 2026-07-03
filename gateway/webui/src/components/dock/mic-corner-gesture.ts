// Gesture math for the corner mic control (hold-to-talk / drag-to-lock).
// Pure functions — the component owns pointer plumbing, this owns the FSM.

export type MicCornerMode = "idle" | "hold" | "locked";

/** Fraction of the travel that arms the lock when releasing from a hold. */
export const LOCK_THRESHOLD = 0.4;
/** Fraction of the travel a locked control must be dragged back below to release. */
export const UNLOCK_THRESHOLD = 0.5;

export interface ReleaseOutcome {
  readonly mode: MicCornerMode;
  readonly drag: number;
}

/** Clamp pointer movement into [0, travel] px toward the lock end (leftward). */
export function clampDrag(base: number, startX: number, currentX: number, travel: number): number {
  return Math.max(0, Math.min(travel, base + (startX - currentX)));
}

/** Resolve where the control settles when the pointer lifts. */
export function resolveRelease(origin: MicCornerMode, drag: number, travel: number): ReleaseOutcome {
  if (origin === "locked") {
    return drag <= travel * UNLOCK_THRESHOLD ? { mode: "idle", drag: 0 } : { mode: "locked", drag: travel };
  }
  return drag >= travel * LOCK_THRESHOLD ? { mode: "locked", drag: travel } : { mode: "idle", drag: 0 };
}

/** Whether the current drag position would arm the lock on release. */
export function isArmed(drag: number, travel: number): boolean {
  return drag >= travel * LOCK_THRESHOLD;
}
