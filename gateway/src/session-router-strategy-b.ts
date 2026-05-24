import { getLog } from "./logging/logger.js";

const log = getLog(["sentient", "gateway", "strategy-b"]);

/** Return userIds whose bindings exceed the idle threshold.
 *  Strategy B stub: full pause/unpause implementation ships post-v1. */
export function pauseIdleProfiles(
  now: number,
  bindings: ReadonlyArray<{ userId: string; lastActiveAtMs: number }>,
  idleAfterMs: number,
): string[] {
  const stale = bindings.filter((b) => now - b.lastActiveAtMs > idleAfterMs).map((b) => b.userId);
  if (stale.length > 0) log.debug("would-pause", { stale });
  return stale;
}
