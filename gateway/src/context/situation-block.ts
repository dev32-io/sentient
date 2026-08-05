// The `<situation>` block — state that CHANGES while a session runs and appears
// nowhere in the message history.
//
// TIER 5, and always the tail: re-rendered every turn and emitted after the
// history, so nothing downstream of it can be invalidated by it (see
// session-block.ts for the full cascade). Putting per-turn text anywhere
// earlier would break the cached prefix on every single call.
//
// DELIBERATELY NOT TIME. The first draft of this block carried `now` and
// `since_last_user_message`, and both are derivable: every stimulus in the
// history is stamped, so the model can read the current moment off the message
// it is answering and subtract two stamps for the gap. What belongs here is
// only what CANNOT be derived from the transcript:
//
//   - whether this reply will be spoken. The system prompt states flatly that
//     every reply is "shown as text and spoken aloud", which is false whenever
//     the user has TTS off — so the model formats for the wrong medium and
//     never knows it. This alone justifies the block.
//   - how many windows are attached. A session is N connections, and whether
//     markdown renders at all depends on which of them are listening.
//   - background work still running. The model dispatched a `delegateTask`, got
//     a task id, and the turn ended; that task is not in the history, so
//     without this the model cannot answer "is that still going?" and may
//     re-delegate the same work.
//
// Sensor readings, presence and the household's current location join here when
// they exist — each as one more collaborator, same as session-block.ts.

import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "context", "situation-block"]);

/** Whether the reply about to be composed will actually be spoken. Resolved
 *  against the same authority `TurnVoice` asks at drain time
 *  (session-handlers/user-audio-policy.ts), so the block cannot claim one thing
 *  while the audio path does another. */
export interface SpeechRouting {
  spoken(): Promise<boolean>;
}

/** How many windows are attached to this session right now. */
export interface AttachedSurfaces {
  count(): number;
}

/** Background tasks dispatched by this session that have not settled. */
export interface InFlightWork {
  backgroundTaskCount(): number;
}

export interface SituationBlockRenderer {
  /** The block, or null when nothing volatile is worth saying — a `<situation>`
   *  with no content costs tokens and tells the model nothing. */
  render(): Promise<string | null>;
}

export interface SituationBlockDeps {
  readonly speech: SpeechRouting;
  readonly surfaces: AttachedSurfaces;
  readonly work: InFlightWork;
  readonly sessionId: string;
}

export function createSituationBlockRenderer(deps: SituationBlockDeps): SituationBlockRenderer {
  return {
    async render() {
      const lines: string[] = [];

      // A failed read must not silence the whole block: the other lines are
      // still true, and a missing delivery line is better than no situation.
      try {
        const spoken = await deps.speech.spoken();
        lines.push(
          spoken
            ? "delivery: shown as text AND spoken aloud — favour sentences that read well out loud"
            : "delivery: shown as text only, NOT spoken — markdown structure is worth using",
        );
      } catch (err: unknown) {
        log.warn("situation-block.speech-routing-unavailable", {
          sessionId: deps.sessionId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }

      const windows = deps.surfaces.count();
      if (windows > 1) lines.push(`windows: ${windows} of this person's screens are showing this conversation`);

      const running = deps.work.backgroundTaskCount();
      if (running > 0) {
        lines.push(`background tasks: ${running} still running — their results will arrive as system messages`);
      }

      if (lines.length === 0) {
        log.debug("situation-block.empty", { sessionId: deps.sessionId, reason: "nothing volatile to report" });
        return null;
      }

      log.debug("situation-block.rendered", { sessionId: deps.sessionId, lineCount: lines.length });
      return `<situation>\n${lines.join("\n")}\n</situation>`;
    },
  };
}
