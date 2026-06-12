import { getLog } from "../../logging/logger.js";

const log = getLog(["sentient", "session", "activity-clock"]);

/**
 * The two live boundaries of a session, both directions. "Idle" = no touch
 * from any of these for the idle window. Transport ping/pong is NOT a source —
 * keepalive is not activity (see ws-handlers + the spec).
 */
export type ActivitySource = "ws.in" | "ws.out" | "acp.out" | "acp.in";

/**
 * Single source of truth for "when did anything last happen" on a device's
 * session. Lives on the per-device buffer entry so it survives a brief
 * disconnect (resumable reconnect) and stays warm across a backgrounded socket
 * while an in-flight cycle is still streaming ACP events.
 */
export interface ActivityClock {
  touch(source: ActivitySource): void;
  /** ms since the last touch (or construction). */
  idleMs(nowMs: number): number;
  /** raw last-activity timestamp. */
  lastActivityMs(): number;
}

export function createActivityClock(now: () => number = Date.now): ActivityClock {
  let last = now();
  return {
    touch(source: ActivitySource): void {
      last = now();
      log.debug("touch", { source });
    },
    idleMs(nowMs: number): number {
      return nowMs - last;
    },
    lastActivityMs(): number {
      return last;
    },
  };
}
