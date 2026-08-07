// The in-flight turn, as a window that was not there needs to see it
// (session-model spec §7.2).
//
// THE PROBLEM THIS SOLVES. Clients build in-flight UI from TRANSIENT
// PREREQUISITE frames: `turn.started` before any delta, an audio bracket before
// any audio byte, a permission prompt before its resolution. A connection that
// attaches mid-turn with only the committed feed plus a cursor at the journal
// head receives deltas for a turn it never saw start — its Stop button never
// arms, its bubble never opens, and (as observed in task 5's live drive) an
// Interrupt indicator can stick until that window happens to drive a turn of its
// own.
//
// WHAT IT IS NOT. It is not journaled and it is not replayed. It is recomputed
// live at attach and written to ONE socket, outside the seq space, because the
// frames it reconstructs were already allocated once for the windows that were
// there. That is also why the replay invariant has the form it does (§7.2):
//
//   render(replay_from(seq)) == render(live_at(seq))   for any seq a client
//                                                       genuinely reached.
//
// A fresh joiner is NOT that case. It is `snapshot ∪ replay_from(watermark)` —
// a different, defined path, which CONVERGES with the committed projection once
// the in-flight turn commits. Asserting the first form for a joiner is what made
// the original claim false: a joiner's live view is snapshot + subsequent
// frames, while replaying from that same cursor later yields subsequent frames
// only. The two are tested apart, never conflated.
//
// HISTORICAL AUDIO IS NEVER RE-SENT. The bracket is (so the joiner attributes
// the REMAINING bytes to the right turn — binary frames carry no turnId), the
// bytes are not. Re-speaking what the user already heard is worse than joining
// mid-sentence, which is what being in the room sounds like anyway.
//
// HOW IT IS COLLECTED. A decorator over `TurnEmitter`: every prerequisite frame
// the session produces already passes through that seam, so observing it there
// is TOTAL by construction — there is no second place a turn can start, a delta
// can stream or a prompt can open. The alternative (asking the runtime, the
// voice pipeline and the permission broker each for their piece) is three
// sources that can disagree.

import type { TaskListItem, TurnAudioEncoding, TurnTrigger } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { DelegationProgress, PermissionRequest, PermissionResolution, TurnEmitter } from "./turn-emitter.js";

const log = getLog(["sentient", "runtime", "turn-state"]);

/** The outbound audio stream a turn is currently bracketing. */
export interface TurnStateAudio {
  readonly turnId: string;
  readonly encoding: TurnAudioEncoding;
  readonly sampleRate: number;
}

export interface TurnStateSnapshot {
  /** The turn currently in flight, or null when the session is idle. */
  readonly activeTurnId: string | null;
  /** What started that turn — null when there is none. */
  readonly trigger: TurnTrigger | null;
  /** Every text delta of the CURRENT REPLY, concatenated — not of the whole
   *  turn. A message the person sends mid-turn rotates the reply: the stretch
   *  before it is committed there and then, and arrives in the joiner's
   *  `conversation.snapshot`. Replaying it again as live text would show the
   *  joiner that stretch twice, once committed and once still streaming.
   *  Accumulation therefore restarts on every rotation, exactly like the
   *  client-side buffer it reconstructs. */
  readonly textSoFar: string;
  /** WHICH REPLY `textSoFar` belongs to — the key both SDKs group a live
   *  bubble by, and the one they suppress its committed twin by. It MUST ride
   *  the replayed `turn.text.delta`: a delta without it lands in a turn-keyed
   *  buffer that the next (stamped) delta then refuses to adopt, and the
   *  joiner opens two live bubbles for one reply. Null when no reply is
   *  streaming, or against a path that does not stamp deltas. */
  readonly replyId: string | null;
  /** Permission prompts still awaiting an answer. */
  readonly prompts: readonly PermissionRequest[];
  /** The audio bracket that is open, or null. Bytes are NEVER part of this. */
  readonly audio: TurnStateAudio | null;
}

/** What a session with no resident runtime, or no turn in flight, looks like.
 *  Empty BY DEFINITION — there is no in-flight turn to describe (spec §7.2). */
export const EMPTY_TURN_STATE: TurnStateSnapshot = {
  activeTurnId: null,
  trigger: null,
  textSoFar: "",
  replyId: null,
  prompts: [],
  audio: null,
};

export interface TurnStateTracker {
  /** Wrap a `TurnEmitter` so every frame it emits is observed on the way past.
   *  Pass-through in both directions: the returned emitter's behaviour is the
   *  wrapped one's, exactly. */
  wrap(emitter: TurnEmitter): TurnEmitter;
  /** The live in-flight state, as an immutable snapshot. */
  snapshot(): TurnStateSnapshot;
}

/** What `captureTurnStateSnapshot` reads. Declared structurally so this module
 *  owns no import edge to `session-runtime.ts` (which imports it). */
export interface TurnStateSource {
  readonly turnState: TurnStateSnapshot;
}

/**
 * The in-flight turn state of [source], as of now.
 *
 * `SessionRuntime` owns it — it is the object whose loop produces every frame
 * this describes — and satisfies `TurnStateSource` by shape.
 */
export function captureTurnStateSnapshot(source: TurnStateSource): TurnStateSnapshot {
  return source.turnState;
}

export function createTurnStateTracker(sessionId: string): TurnStateTracker {
  let activeTurnId: string | null = null;
  let trigger: TurnTrigger | null = null;
  let textSoFar = "";
  let replyId: string | null = null;
  let audio: TurnStateAudio | null = null;
  const prompts = new Map<string, PermissionRequest>();

  /** A turn ended (completed or aborted). The audio bracket deliberately
   *  SURVIVES it: speech outlives its turn, and a joiner arriving while it
   *  drains still needs the bracket to attribute the remaining bytes. */
  function endTurn(turnId: string): void {
    if (activeTurnId !== turnId) return;
    activeTurnId = null;
    trigger = null;
    textSoFar = "";
    replyId = null;
  }

  /** Fold one delta of the active turn into the live-bubble accumulation.
   *
   *  ROTATION RESTARTS IT. `session-runtime.ts` mints a new `replyId` inside
   *  one turn when a person types mid-reply; the stretch before that point is
   *  already a committed entry by the time any joiner asks, so carrying it
   *  here too would replay it as live text beside its own committed row. */
  function accumulate(text: string, deltaReplyId: string | null): void {
    if (deltaReplyId !== replyId) {
      replyId = deltaReplyId;
      textSoFar = "";
    }
    textSoFar += text;
  }

  return {
    wrap(emitter: TurnEmitter): TurnEmitter {
      return {
        turnStarted(turnId: string, t: TurnTrigger) {
          activeTurnId = turnId;
          trigger = t;
          textSoFar = "";
          replyId = null;
          emitter.turnStarted(turnId, t);
        },
        // FORWARDED AS A WHOLE ARGUMENT LIST, deliberately. A pass-through
        // wrapper that declares fewer parameters than the interface still
        // satisfies TypeScript — a narrower function is assignable to a wider
        // one — so naming them one by one makes a dropped argument silent at
        // the type level and invisible until the wire is read. `...args` cannot
        // drop one; adding a parameter to `TurnEmitter.textDelta` forwards it
        // here for free.
        //
        // That covers the FORWARD. The ACCUMULATOR below is the second half of
        // the same lesson and the one this seam actually got wrong: it read
        // `text` and threw `replyId` away into a flat string, so the replayed
        // delta reached a mid-turn joiner unstamped. Destructure everything the
        // snapshot describes, not just what it concatenates.
        textDelta(...args: Parameters<TurnEmitter["textDelta"]>) {
          const [turnId, text, deltaReplyId] = args;
          if (turnId === activeTurnId) accumulate(text, deltaReplyId ?? null);
          emitter.textDelta(...args);
        },
        turnCompleted(turnId: string) {
          endTurn(turnId);
          emitter.turnCompleted(turnId);
        },
        turnAborted(turnId, cutoff) {
          endTurn(turnId);
          emitter.turnAborted(turnId, cutoff);
        },
        playbackStop(turnId, reason) {
          // The client just dropped everything queued for this turn; a window
          // joining afterwards must not be handed a bracket for audio nobody
          // is still playing.
          audio = null;
          emitter.playbackStop(turnId, reason);
        },
        conversationSnapshot(items) {
          emitter.conversationSnapshot(items);
        },
        conversationEntry(item, turnId, replyId) {
          emitter.conversationEntry(item, turnId, replyId);
        },
        audioStart(turnId: string, encoding: TurnAudioEncoding, sampleRate: number) {
          audio = { turnId, encoding, sampleRate };
          emitter.audioStart(turnId, encoding, sampleRate);
        },
        audioFrame(turnId, bytes) {
          emitter.audioFrame(turnId, bytes);
        },
        audioDone(turnId: string) {
          if (audio?.turnId === turnId) audio = null;
          emitter.audioDone(turnId);
        },
        permissionRequest(req: PermissionRequest) {
          prompts.set(req.requestId, req);
          emitter.permissionRequest(req);
        },
        permissionResolved(res: PermissionResolution) {
          prompts.delete(res.requestId);
          emitter.permissionResolved(res);
        },
        delegationProgress(p: DelegationProgress) {
          emitter.delegationProgress(p);
        },
        taskList(turnId: string | null, items: TaskListItem[]) {
          // Pass-through: the strip is its own full-state broadcast, re-sent to
          // a joining window by ws-session-configure.ts, not part of the
          // reconstructed in-flight-turn snapshot.
          emitter.taskList(turnId, items);
        },
        sessionTitle(title, provenance) {
          // Pass-through: a title is session METADATA, not turn state — a
          // window joining mid-turn gets the title from its sessions list, not
          // from the turn-state snapshot.
          emitter.sessionTitle(title, provenance);
        },
      };
    },

    snapshot(): TurnStateSnapshot {
      const snap: TurnStateSnapshot = {
        activeTurnId,
        trigger,
        textSoFar,
        replyId,
        prompts: [...prompts.values()],
        audio,
      };
      log.debug("turn-state.captured", {
        sessionId,
        turnId: activeTurnId,
        replyId,
        trigger,
        textLength: textSoFar.length,
        openPrompts: snap.prompts.length,
        audioTurnId: audio?.turnId ?? null,
      });
      return snap;
    },
  };
}
