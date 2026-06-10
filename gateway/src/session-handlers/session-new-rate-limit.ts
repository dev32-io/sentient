/**
 * Per-connection min-interval decision for `session.new` frames. Pure — the
 * caller owns `lastSessionNewAtMs` on `ws.data` and updates it to `now` only
 * when this returns true.
 *
 * Admits when no prior `session.new` exists on the connection, or when at least
 * `minIntervalMs` has elapsed since the previous one. Blocks rapid-fire spam /
 * accidental double-fires without ever failing human-paced new-chat creation;
 * per connection (one client), NOT per user.
 */
export function shouldAdmitSessionNew(lastAtMs: number | null, now: number, minIntervalMs: number): boolean {
  return lastAtMs === null || now - lastAtMs >= minIntervalMs;
}
