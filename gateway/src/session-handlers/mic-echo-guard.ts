// Mic echo guard — hard-mute the STT uplink for a cooldown window at TTS
// start so the client's WebRTC AEC converges on the initial burst.
// `stt.tts_echo_cooldown_ms` (config.yaml) is the window; residual echo past
// it is handled at the client edge (RNNoise + speech-prob gate), so there is
// no gateway-side energy gate.
//
// Implements runtime/turn-voice.ts's MicEchoGuard: the interface lives with
// its consumer (the runtime), the implementation with the resource it drives
// (the WS-layer STT session). Dependencies point inward.
//
// EVERY ATTACHED WINDOW'S MIC, not just one (session-model plan task 5). TTS
// fans out to every window of a session, so every window hears it — and a
// guard scoped to the connection that happened to build the session leaves the
// others' microphones open on the assistant's own voice, which is
// self-triggered barge-in and spurious transcripts. The suppression therefore
// applies to whichever STT sessions are live at the moment TTS starts, read
// lazily for the same reason it always was.

import { getLog } from "../logging/logger.js";
import type { MicEchoGuard } from "../runtime/turn-voice.js";
import type { SttSession } from "./stt-session.js";

const log = getLog(["sentient", "session-handlers", "mic-echo-guard"]);

const CLEAR_SUPPRESSION_MS = 0;

/**
 * @param getSttSessions read lazily and as a SET — a session's STT sessions are
 *                 minted per connection on its first `audio.start`, which may
 *                 be long after this guard is built, and a window can attach
 *                 later still. Empty is normal: a text-only session never
 *                 dials STT.
 * @param cooldownMs `null` when the gateway has no `stt:` config (nothing to
 *                 suppress); otherwise `stt.tts_echo_cooldown_ms`.
 */
export function createMicEchoGuard(
  getSttSessions: () => readonly SttSession[],
  cooldownMs: number | null,
  sessionId: string,
): MicEchoGuard {
  function suppressAll(ms: number): number {
    const sessions = getSttSessions();
    for (const stt of sessions) stt.suppressInputFor(ms);
    return sessions.length;
  }

  return {
    onTtsStart(turnId) {
      if (cooldownMs === null) return;
      const suppressed = suppressAll(cooldownMs);
      if (suppressed === 0) return;
      log.info("mic-suppress.tts-start", { sessionId, turnId, cooldownMs, windows: suppressed });
    },
    onTtsCancel(turnId) {
      const cleared = suppressAll(CLEAR_SUPPRESSION_MS);
      if (cleared === 0) return;
      log.info("mic-suppress.cleared", {
        sessionId,
        turnId,
        windows: cleared,
        reason: "tts cancelled — the user is speaking, their frames must reach STT now",
      });
    },
  };
}
