import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "mcp-host", "active-session-lookup"]);

/**
 * Resolves "which live connection belongs to this user?" for the gateway-hosted
 * MCP tools. A tool call arrives carrying only a userId (each per-user MCP
 * socket is bound to one), but `pause_audio` / `resume_audio` /
 * `update_user_settings` all act on a *connection*.
 *
 * This used to be `SessionRouter.findActiveSessionFor`, whose real job was
 * mapping a user to their per-user Hermes ACP worker port. That router is gone
 * with the daemon it addressed; this interface is the seam that outlives it.
 */
export interface ActiveSessionLookup {
  /** The live session bound to `userId`, or `null` when none can be acted on. */
  findActiveSessionFor(userId: string): string | null;
}

/**
 * The only implementation today: resolution is UNAVAILABLE, so the three tools
 * fail closed.
 *
 * Why that is deliberate rather than a missing feature — both consumer sides
 * are unwired. `main.ts` passes a no-op `pause`/`resume` pair (the audio
 * pipeline has no pause primitive; barge-in cancels, which is not the same),
 * and `SessionControlsRegistry.register` has zero production callers since the
 * legacy-brain purge stripped `ws-session-configure` to auth+hold. A lookup
 * that resolved a real sessionId would therefore hand the model a *success* for
 * work that silently did not happen — "audio paused" while TTS keeps playing,
 * "updated: ttsEnabled=false" while the user stays unmuted. Returning `null`
 * makes the tools answer "no active session", which is the truth.
 *
 * INVARIANT for whoever wires Plan 2's `SessionRuntime`: a real resolver lands
 * in the SAME change as the producers it depends on (an audio pause/resume
 * primitive and a `SessionControls` producer). Resolving first re-introduces
 * the success-lie above.
 */
export function createUnavailableSessionLookup(): ActiveSessionLookup {
  return {
    findActiveSessionFor(userId) {
      log.warn("lookup-unavailable", { userId, reason: "no-session-controls-producer" });
      return null;
    },
  };
}
