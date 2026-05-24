import { createLogger } from "@sentient/web-sdk";
import type { FadeablePlaybackAdapter } from "./web-audio-playback.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CycleAudioQueueOptions {
  playback: FadeablePlaybackAdapter;
  /** Minimum playback duration (ms) guaranteed to the active cycle before a
   *  newer cycle's audio can preempt. Set to 0 to disable the cap. */
  minEagerEndMs: number;
  /** Duration (ms) of the gain fade applied on a preempt cut. */
  preemptFadeoutMs: number;
}

export interface CycleAudioQueueConfig {
  minEagerEndMs: number;
  preemptFadeoutMs: number;
}

export interface CycleAudioQueue {
  /** Called when a new TTS stream begins for the given cycle. */
  onAudioStart(cycleId: string): void;
  /** Called for each decoded PCM frame belonging to this cycle. */
  onAudioFrame(cycleId: string, samples: Float32Array): void;
  /** Called when the gateway has emitted all TTS frames for this cycle. */
  onAudioDone(cycleId: string): void;
  /** Barge-in / Stop: immediately drop all state and clear playback (no fade). */
  cancelAll(): void;
  /**
   * Update preempt tunables after construction (e.g. when session.ready arrives).
   *
   * Changes take effect for **future** preempt decisions only. A preempt timer
   * that is already scheduled will not be rescheduled if `minEagerEndMs`
   * changes while a cycle is active. This is acceptable because `configure` is
   * called once on session.ready, before any cycle is live.
   */
  configure(config: CycleAudioQueueConfig): void;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface ActiveCycle {
  id: string;
  /** Wall-clock ms when this cycle became active and started playing. */
  startedAtMs: number;
  doneReceived: boolean;
}

interface PendingCycle {
  id: string;
  /** Wall-clock ms when the first audio arrived for this cycle. */
  firstArrivedAtMs: number;
  queuedFrames: Float32Array[];
  doneReceived: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const log = createLogger(["sentient", "webui", "cycle-audio-queue"]);

export function createCycleAudioQueue(options: CycleAudioQueueOptions): CycleAudioQueue {
  const { playback } = options;
  let minEagerEndMs = options.minEagerEndMs;
  let preemptFadeoutMs = options.preemptFadeoutMs;

  let activeCycle: ActiveCycle | null = null;
  let pending: PendingCycle | null = null;
  let preemptTimer: ReturnType<typeof setTimeout> | null = null;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function cancelPreemptTimer(): void {
    if (preemptTimer !== null) {
      clearTimeout(preemptTimer);
      preemptTimer = null;
    }
  }

  /** Promote pending to active and replay its buffered frames. */
  function promotePending(): void {
    if (!pending) {
      activeCycle = null;
      log.debug("drain-idle: no pending, going idle");
      return;
    }

    const { id, queuedFrames, doneReceived } = pending;
    pending = null;
    cancelPreemptTimer();

    activeCycle = { id, startedAtMs: Date.now(), doneReceived };
    log.debug("promote: pending cycle promoted to active", {
      cycleId: id,
      bufferedFrames: queuedFrames.length,
      doneReceived,
    });

    for (const samples of queuedFrames) {
      playback.enqueue(samples);
    }
  }

  /**
   * Execute the preempt: fade out the active cycle and start the pending one.
   * Only fires when pending still exists and active is still running.
   */
  async function executePreempt(): Promise<void> {
    if (!pending || !activeCycle) return;

    log.debug("preempt: fading out active cycle, promoting pending", {
      activeCycleId: activeCycle.id,
      pendingCycleId: pending.id,
      preemptFadeoutMs,
    });

    await playback.fadeOutAndClear(preemptFadeoutMs);
    promotePending();
  }

  /**
   * Decide whether to preempt now or schedule a timer when a new pending
   * cycle's first audio arrives.
   */
  function schedulePreempt(): void {
    if (!activeCycle) return;

    const now = Date.now();
    const deadline = activeCycle.startedAtMs + minEagerEndMs;

    if (now >= deadline) {
      // Already past the cap — preempt immediately.
      log.debug("preempt-now: elapsed >= cap, preempting immediately", {
        activeCycleId: activeCycle.id,
        elapsedMs: now - activeCycle.startedAtMs,
        minEagerEndMs,
      });
      void executePreempt();
      return;
    }

    const delayMs = deadline - now;
    log.debug("preempt-at-deadline: scheduling timer", {
      activeCycleId: activeCycle.id,
      delayMs,
      deadline,
    });

    cancelPreemptTimer();
    preemptTimer = setTimeout(() => {
      preemptTimer = null;
      if (!pending || !activeCycle) {
        log.debug("preempt-timer: fired but no pending or no active, skipping");
        return;
      }
      log.debug("preempt-timer: deadline reached, executing preempt", {
        activeCycleId: activeCycle.id,
        pendingCycleId: pending.id,
      });
      void executePreempt();
    }, delayMs);
  }

  // ---------------------------------------------------------------------------
  // Drain handler — fires whenever playback physically empties
  // ---------------------------------------------------------------------------

  playback.onDrain(() => {
    if (!activeCycle) return;
    if (!activeCycle.doneReceived) {
      log.debug("drain: doneReceived=false, waiting for more frames", {
        cycleId: activeCycle.id,
      });
      return;
    }
    log.debug("drain: active cycle fully played out", { cycleId: activeCycle.id });
    cancelPreemptTimer();
    promotePending();
  });

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  return {
    onAudioStart(cycleId: string): void {
      if (!activeCycle) {
        // Idle — claim the cycle immediately.
        activeCycle = { id: cycleId, startedAtMs: Date.now(), doneReceived: false };
        log.debug("new-active: cycle claimed", { cycleId });
        return;
      }

      if (activeCycle.id === cycleId) {
        // Duplicate start for the same active cycle — no-op.
        log.debug("onAudioStart: stale-duplicate ignored", { cycleId });
        return;
      }

      // New cycle while one is active — hold as pending (singular).
      if (pending === null) {
        pending = { id: cycleId, firstArrivedAtMs: Date.now(), queuedFrames: [], doneReceived: false };
        log.debug("buffered-pending: new pending cycle announced", {
          cycleId,
          activeCycleId: activeCycle.id,
        });
        schedulePreempt();
      } else if (pending.id !== cycleId) {
        // Superseded — replace the existing pending with the newer one.
        log.warn("superseded-by-newer-cycle: dropping older pending", {
          reason: "superseded-by-newer-cycle",
          droppedCycleId: pending.id,
          newerCycleId: cycleId,
        });
        pending = { id: cycleId, firstArrivedAtMs: Date.now(), queuedFrames: [], doneReceived: false };
        // The preempt timer is keyed on activeCycle.startedAtMs — no need to rearm.
      }
      // else: same pending cycleId repeated — no-op.
    },

    onAudioFrame(cycleId: string, samples: Float32Array): void {
      if (activeCycle?.id === cycleId) {
        playback.enqueue(samples);
        log.debug("frame: forwarded to playback", {
          cycleId,
          samples: samples.length,
        });
        return;
      }

      // Frame for pending (or arriving before start) — buffer it.
      if (pending !== null && pending.id === cycleId) {
        pending.queuedFrames.push(samples);
        log.debug("frame: buffered for pending cycle", {
          cycleId,
          bufferedFrames: pending.queuedFrames.length,
        });
      } else if (pending === null && activeCycle !== null) {
        // Frame arrived before onAudioStart for this new cycleId — create pending on-the-fly.
        pending = { id: cycleId, firstArrivedAtMs: Date.now(), queuedFrames: [samples], doneReceived: false };
        log.debug("frame: pending created on-the-fly (start not yet seen)", { cycleId });
        schedulePreempt();
      } else if (pending === null && activeCycle === null) {
        // Idle — treat as a new active cycle (frame before start, no active).
        activeCycle = { id: cycleId, startedAtMs: Date.now(), doneReceived: false };
        playback.enqueue(samples);
        log.debug("frame: idle — claimed as active, frame forwarded", { cycleId });
      }
      // Else: frame for a cycleId that is neither active nor the current pending — drop.
      else {
        log.debug("frame: dropped — cycleId neither active nor pending", {
          reason: "unknown-cycle",
          cycleId,
          activeCycleId: activeCycle?.id ?? null,
          pendingCycleId: pending?.id ?? null,
        });
      }
    },

    onAudioDone(cycleId: string): void {
      if (activeCycle?.id === cycleId) {
        activeCycle.doneReceived = true;
        log.debug("done: active cycle marked done-received, waiting for drain", { cycleId });
        return;
      }

      if (pending?.id === cycleId) {
        pending.doneReceived = true;
        log.debug("done: pending cycle marked done-received", { cycleId });
        return;
      }

      // Done for an untracked cycleId — ignore.
      log.debug("done: cycleId not tracked (done-before-start), ignoring", { cycleId });
    },

    cancelAll(): void {
      log.debug("cancel-all: clearing active + pending + playback (no fade)", {
        activeCycleId: activeCycle?.id ?? null,
        pendingCycleId: pending?.id ?? null,
      });
      cancelPreemptTimer();
      activeCycle = null;
      pending = null;
      playback.clear();
    },

    configure(config: CycleAudioQueueConfig): void {
      log.debug("configure: updating preempt tunables", {
        minEagerEndMs: config.minEagerEndMs,
        preemptFadeoutMs: config.preemptFadeoutMs,
      });
      minEagerEndMs = config.minEagerEndMs;
      preemptFadeoutMs = config.preemptFadeoutMs;
    },
  };
}
