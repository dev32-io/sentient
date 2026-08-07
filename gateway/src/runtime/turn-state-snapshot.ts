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
import type { ToolUpdate } from "./react-loop.js";
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
  /** Every text delta streamed for the active turn so far, concatenated. The
   *  committed half of it also arrives in `conversation.snapshot`; both SDKs
   *  fold a committed entry into the live bubble by `turnId`, which is what
   *  makes replaying the whole accumulation the faithful reconstruction rather
   *  than a duplicate. */
  readonly textSoFar: string;
  /** Tool calls still shown as running, in the order they started. */
  readonly tools: readonly ToolUpdate[];
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
  tools: [],
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
  let audio: TurnStateAudio | null = null;
  const tools = new Map<string, ToolUpdate>();
  const prompts = new Map<string, PermissionRequest>();

  /** A turn ended (completed or aborted). The audio bracket deliberately
   *  SURVIVES it: speech outlives its turn, and a joiner arriving while it
   *  drains still needs the bracket to attribute the remaining bytes. */
  function endTurn(turnId: string): void {
    if (activeTurnId !== turnId) return;
    activeTurnId = null;
    trigger = null;
    textSoFar = "";
    tools.clear();
  }

  return {
    wrap(emitter: TurnEmitter): TurnEmitter {
      return {
        turnStarted(turnId: string, t: TurnTrigger) {
          activeTurnId = turnId;
          trigger = t;
          textSoFar = "";
          tools.clear();
          emitter.turnStarted(turnId, t);
        },
        // EVERY parameter forwarded. A pass-through wrapper that declares fewer
        // parameters than the interface still satisfies TypeScript — a narrower
        // function is assignable to a wider one — so dropping an argument here
        // is silent at the type level and invisible until the wire is read.
        // That is exactly how `replyId` reached the client as null while the
        // gateway logged it correctly one layer up.
        textDelta(turnId: string, text: string, replyId?: string) {
          if (turnId === activeTurnId) textSoFar += text;
          emitter.textDelta(turnId, text, replyId);
        },
        toolUpdate(turnId: string, u: ToolUpdate) {
          if (u.status === "running") tools.set(u.toolCallId, u);
          else tools.delete(u.toolCallId);
          emitter.toolUpdate(turnId, u);
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
          // A background dispatch's tile never reaches a terminal
          // `turn.tool.update` — its completion arrives here instead — so
          // without this the joiner would see a finished delegation as still
          // running for the rest of the session.
          if (p.status !== "running") {
            for (const [toolCallId, u] of tools) {
              if (u.taskId === p.taskId) tools.delete(toolCallId);
            }
          }
          emitter.delegationProgress(p);
        },
        taskList(turnId: string | null, items: TaskListItem[]) {
          // Pass-through: the strip is its own full-state broadcast, not part
          // of the reconstructed in-flight-turn snapshot a joiner is handed.
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
        tools: [...tools.values()],
        prompts: [...prompts.values()],
        audio,
      };
      log.debug("turn-state.captured", {
        sessionId,
        turnId: activeTurnId,
        trigger,
        textLength: textSoFar.length,
        runningTools: snap.tools.length,
        openPrompts: snap.prompts.length,
        audioTurnId: audio?.turnId ?? null,
      });
      return snap;
    },
  };
}
