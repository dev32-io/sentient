import type { MirrorEntry } from "../cerebrum/conversation-mirror.ts";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "sessions", "switch-flow"]);

export type SwitchFlowState = "idle" | "cancelling" | "fetching" | "rehydrating" | "ready";

export interface SwitchFlowMirror {
  replaceAll(entries: readonly MirrorEntry[]): void;
}

export interface SwitchFlowConfig {
  readonly mirror: SwitchFlowMirror;
  /**
   * Aborts the active cycle (interruptController). Should resolve when the
   * cycle has truly torn down. MUST be idempotent — concurrent / superseding
   * switches may invoke this multiple times against an already-torn-down
   * cycle.
   */
  readonly cancelCurrentCycle: () => Promise<void>;
  /** Pulls history for the target sessionId. Honors AbortSignal for concurrent-switch cancellation. */
  readonly fetchHistory: (sessionId: string, signal: AbortSignal) => Promise<readonly MirrorEntry[]>;
  /** Hard cap on cancelCurrentCycle wait. */
  readonly teardownTimeoutMs: number;
}

export interface SwitchFlow {
  readonly state: SwitchFlowState;
  /** True iff state is idle or ready. */
  canAcceptUserMessage(): boolean;
  /** Run the switch state machine for the given target. */
  switchTo(sessionId: string): Promise<void>;
}

export function createSwitchFlow(cfg: SwitchFlowConfig): SwitchFlow {
  let state: SwitchFlowState = "idle";
  let active: { id: string; abort: AbortController } | null = null;

  const transition = (next: SwitchFlowState): void => {
    log.debug("transition", { from: state, to: next });
    state = next;
  };

  const withTimeout = async (p: Promise<void>, ms: number): Promise<void> => {
    // Late rejections (after timeout) are not actionable here — the cycle is
    // already considered torn down for our purposes. Swallow them so they
    // don't surface as unhandled-promise rejections.
    p.catch(() => {
      /* swallow late rejection */
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log.warn("teardown-timeout", { ms });
        resolve();
      }, ms);
    });
    try {
      await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    get state() {
      return state;
    },
    canAcceptUserMessage(): boolean {
      return state === "idle" || state === "ready";
    },
    async switchTo(sessionId: string): Promise<void> {
      // Abort any in-flight switch — latest wins.
      if (active) {
        log.info("switch:supersede", { from: active.id, to: sessionId });
        active.abort.abort();
      }
      const abort = new AbortController();
      active = { id: sessionId, abort };

      try {
        transition("cancelling");
        await withTimeout(cfg.cancelCurrentCycle(), cfg.teardownTimeoutMs);
        if (abort.signal.aborted) return;

        transition("fetching");
        const entries = await cfg.fetchHistory(sessionId, abort.signal);
        if (abort.signal.aborted) return;

        transition("rehydrating");
        cfg.mirror.replaceAll(entries);
        if (abort.signal.aborted) return;

        transition("ready");
      } catch (err: unknown) {
        const name = (err as { name?: string }).name;
        if (name === "AbortError") {
          log.info("switch:aborted", { sessionId });
          return;
        }
        log.warn("switch:error", { sessionId, message: (err as Error).message });
        transition("idle");
        throw err;
      } finally {
        if (active && active.id === sessionId) active = null;
      }
    },
  };
}
