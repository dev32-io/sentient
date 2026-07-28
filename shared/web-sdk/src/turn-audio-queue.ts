import { createLogger } from "./logger.ts";

const log = createLogger(["sentient", "sdk", "turn-audio-queue"]);

/**
 * Narrow playback port the queue drives. Deliberately smaller than
 * `AudioPlaybackAdapter`: the queue needs exactly three operations, so any
 * platform adapter (web AudioWorklet today, native later) can satisfy it
 * without the queue knowing anything about gain, AEC, or audio contexts.
 */
export interface TurnAudioPlayback {
  /** Hand Float32 samples to the output pipeline for immediate playback. */
  enqueue(samples: Float32Array): void;
  /** Drop everything queued or playing right now. No fade. */
  clear(): void;
  /** Fires when the output pipeline has physically drained. Returns unsubscribe. */
  onDrain(handler: () => void): () => void;
}

export interface TurnAudioQueueOptions {
  playback: TurnAudioPlayback;
}

/**
 * Strict sequential FIFO of assistant TTS audio, keyed by turnId (spec §7.2).
 *
 * INVARIANT — the whole point of this module: a new turnId NEVER cancels,
 * fades, or replaces in-flight audio. It is appended and plays only after the
 * current turn has physically drained. The gateway never stops its own audio
 * (§4.7), so `cancelAll()` — driven exclusively by barge-in (mic onset) or
 * interrupt (UI Stop) — is the ONLY flush path in this module.
 *
 * This replaces the retired webui `cycle-audio-queue`, whose ActiveCycle /
 * PendingCycle + `schedulePreempt` / `fadeOutAndClear` policy did the exact
 * opposite: it cut the running turn off once `minEagerEndMs` elapsed. There
 * are no tunables here — sequential playback has nothing to tune.
 */
export interface TurnAudioQueue {
  /** `turn.audio.start` — reserve this turn's slot at the tail of the FIFO. */
  onAudioStart(turnId: string): void;
  /** One audio frame for `turnId`. Plays now if head, buffers otherwise. */
  onAudioFrame(turnId: string, samples: Float32Array): void;
  /** `turn.audio.done` — no more frames will arrive for `turnId`. */
  onAudioDone(turnId: string): void;
  /** Barge-in / interrupt ONLY. Drops every turn and clears playback (no fade). */
  cancelAll(): void;
  /** FIFO depth, head included. Diagnostics + tests. */
  depth(): number;
  /** Release the playback drain subscription. */
  dispose(): void;
}

interface TurnSlot {
  readonly turnId: string;
  /** Frames received while this turn was NOT the head. Emptied on promotion. */
  buffered: Float32Array[];
  /** `turn.audio.done` seen — no further frames will arrive for this turn. */
  doneReceived: boolean;
}

export function createTurnAudioQueue(options: TurnAudioQueueOptions): TurnAudioQueue {
  const { playback } = options;

  /** FIFO. `queue[0]` is the turn currently feeding playback. */
  let queue: TurnSlot[] = [];
  /**
   * True between an `enqueue` and the drain that follows it. Closes the
   * done-after-drain race: if `turn.audio.done` lands AFTER playback already
   * drained, no further drain event will ever fire, so the head has to be
   * retired from the `onAudioDone` path instead of the drain handler.
   */
  let hasPendingAudio = false;

  function findSlot(turnId: string): TurnSlot | undefined {
    return queue.find((slot) => slot.turnId === turnId);
  }

  function appendSlot(turnId: string): TurnSlot {
    const slot: TurnSlot = { turnId, buffered: [], doneReceived: false };
    queue.push(slot);
    log.debug("slot-appended", { turnId, depth: queue.length });
    return slot;
  }

  function play(samples: Float32Array): void {
    hasPendingAudio = true;
    playback.enqueue(samples);
  }

  /**
   * Retire finished heads and promote the next turn. Terminates: each
   * iteration either shifts the queue or returns.
   *
   * `head.buffered` is always empty (frames for the head go straight to
   * playback, and a promoted slot is flushed on promotion), so "head is
   * finished" reduces to `doneReceived`.
   */
  function retireFinishedHeads(): void {
    while (queue.length > 0 && queue[0]?.doneReceived === true) {
      const retired = queue.shift();
      log.info("head-retired", { turnId: retired?.turnId ?? null, depth: queue.length });
      const next = queue[0];
      if (next === undefined) {
        log.debug("queue-idle", { reason: "all turns played out" });
        return;
      }
      const promoted = next.buffered;
      next.buffered = [];
      log.info("head-promoted", { turnId: next.turnId, bufferedFrames: promoted.length });
      for (const samples of promoted) play(samples);
      if (promoted.length > 0) return; // wait for this turn's own drain
    }
  }

  const unsubDrain = playback.onDrain(() => {
    hasPendingAudio = false;
    const head = queue[0];
    if (head === undefined) return;
    if (!head.doneReceived) {
      log.debug("drain-ignored", { reason: "head still producing frames", turnId: head.turnId });
      return;
    }
    retireFinishedHeads();
  });

  return {
    onAudioStart(turnId: string): void {
      if (findSlot(turnId) !== undefined) {
        log.debug("start-ignored", { reason: "turn already queued", turnId });
        return;
      }
      appendSlot(turnId);
    },

    onAudioFrame(turnId: string, samples: Float32Array): void {
      const head = queue[0];
      if (head === undefined) {
        appendSlot(turnId);
        play(samples);
        log.debug("frame-played", { reason: "queue was idle", turnId, samples: samples.length });
        return;
      }
      if (head.turnId === turnId) {
        play(samples);
        return;
      }
      const slot = findSlot(turnId) ?? appendSlot(turnId);
      slot.buffered.push(samples);
      log.debug("frame-buffered", {
        reason: "turn is queued behind the head",
        turnId,
        headTurnId: head.turnId,
        bufferedFrames: slot.buffered.length,
      });
    },

    onAudioDone(turnId: string): void {
      const slot = findSlot(turnId) ?? appendSlot(turnId);
      slot.doneReceived = true;
      log.debug("done-received", { turnId, isHead: queue[0]?.turnId === turnId, hasPendingAudio });
      if (queue[0] === slot && !hasPendingAudio) retireFinishedHeads();
    },

    cancelAll(): void {
      log.info("cancel-all", {
        reason: "barge-in-or-interrupt",
        depth: queue.length,
        headTurnId: queue[0]?.turnId ?? null,
      });
      queue = [];
      hasPendingAudio = false;
      playback.clear();
    },

    depth(): number {
      return queue.length;
    },

    dispose(): void {
      unsubDrain();
      queue = [];
      hasPendingAudio = false;
    },
  };
}
