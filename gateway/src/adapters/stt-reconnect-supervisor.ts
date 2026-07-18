import type { Log } from "../logging/logger.js";
import type { AdapterContext } from "./adapter-types.js";
import type { STTAdapter, STTAdapterConfig } from "./stt/stt-adapter-types.js";

// ---------------------------------------------------------------------------
// Reconnect supervisor
//
// STT runs as a separate container; at session start it may be down, and can
// disconnect mid-session. The supervisor keeps retrying adapter.open() with
// exponential backoff while the session is alive, so once STT comes online
// voice transparently starts working — no container restart required.
// ---------------------------------------------------------------------------

// Exported so the owning adapter can log the same initial-backoff value on its
// synchronous first-connect failure before handing off to the supervisor loop.
export const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER_MS = 250;

function nextBackoff(prev: number): number {
  const base = Math.min(prev * 2, RECONNECT_MAX_MS);
  const jitter = Math.floor(Math.random() * RECONNECT_JITTER_MS);
  return base + jitter;
}

async function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Dependencies the supervisor loop reaches back into the owning adapter for.
 * All are explicit — the supervisor holds no adapter-private state of its own
 * beyond the backoff/attempt bookkeeping and its own AbortController.
 */
export interface SttReconnectSupervisorDeps {
  /** Shared logger — passed in so the supervisor's log trail keeps the
   *  owning adapter's tag (`sentient:adapters:user-audio-input`). */
  log: Log;
  /** Live read of the current STT config. Read fresh on every access because
   *  reconfigure() swaps it (after aborting the running supervisor). */
  getConfig(): STTAdapterConfig;
  /** Open a fresh STT adapter for `config`, threading the session signal. */
  openOnce(config: STTAdapterConfig, ctx: AdapterContext): Promise<STTAdapter>;
  /** Publish a freshly-connected adapter as the session's active one. */
  setActiveAdapter(adapter: STTAdapter): void;
  /** Clear the active adapter iff it is still the given one (guards against
   *  a newer connect having already replaced it). */
  clearActiveAdapterIf(adapter: STTAdapter): void;
  /** Replay the last-known turn mode into a freshly-connected adapter. */
  replayTurnMode(adapter: STTAdapter): void;
  /** Drain the adapter's event stream until it ends (ws closed / aborted). */
  consumeEvents(adapter: STTAdapter, ctx: AdapterContext): Promise<void>;
}

export interface SttReconnectSupervisor {
  /**
   * (Re)start the background reconnect loop. Aborts any prior loop first.
   * `alreadyConnected` seeds the first iteration with an adapter start()/
   * reconfigure() just opened, so the first attempt doesn't duplicate it.
   */
  start(ctx: AdapterContext, alreadyConnected: STTAdapter | null): void;
  /** Abort the current loop (used by stop()/reconfigure()). */
  abort(): void;
}

export function createSttReconnectSupervisor(deps: SttReconnectSupervisorDeps): SttReconnectSupervisor {
  const { log } = deps;
  // Aborting this cancels only the current supervisor loop (used by
  // reconfigure() to tear down the in-flight retry cycle). The outer
  // ctx.abortSignal ends the session.
  let supervisorController: AbortController | null = null;

  /**
   * Background loop: watch the active adapter's event stream; when it ends
   * (STT ws closed), reconnect with exponential backoff. `alreadyConnected`
   * lets start() seed the loop with a freshly-opened adapter so the first
   * attempt doesn't duplicate what start() already did.
   */
  async function runSupervisor(
    ctx: AdapterContext,
    supervisorSignal: AbortSignal,
    alreadyConnected: STTAdapter | null,
  ): Promise<void> {
    let backoffMs = RECONNECT_INITIAL_MS;
    let attempt = alreadyConnected ? 1 : 0;
    let seeded = alreadyConnected;
    while (!ctx.abortSignal.aborted && !supervisorSignal.aborted) {
      let adapter = seeded;
      seeded = null;
      if (adapter === null) {
        attempt++;
        log.debug("stt-connect-attempt", { attempt, language: deps.getConfig().language, url: deps.getConfig().url });
        try {
          adapter = await deps.openOnce(deps.getConfig(), ctx);
          log.info("stt-connected", { attempt, language: deps.getConfig().language });
          deps.setActiveAdapter(adapter);
          deps.replayTurnMode(adapter);
          backoffMs = RECONNECT_INITIAL_MS;
        } catch (err: unknown) {
          if (ctx.abortSignal.aborted || supervisorSignal.aborted) break;
          log.warn("stt-connect-failed", {
            attempt,
            reason: err instanceof Error ? err.message : String(err),
            nextBackoffMs: backoffMs,
            url: deps.getConfig().url,
          });
          await sleepAbortable(backoffMs, AbortSignal.any([ctx.abortSignal, supervisorSignal]));
          backoffMs = nextBackoff(backoffMs);
          continue;
        }
      }

      try {
        await deps.consumeEvents(adapter, ctx);
      } finally {
        deps.clearActiveAdapterIf(adapter);
        try {
          await adapter.close();
        } catch {
          /* ignore */
        }
      }

      if (ctx.abortSignal.aborted || supervisorSignal.aborted) break;
      log.warn("stt-disconnected", {
        reason: "event stream ended — will reconnect with backoff",
        nextBackoffMs: backoffMs,
      });
      await sleepAbortable(backoffMs, AbortSignal.any([ctx.abortSignal, supervisorSignal]));
      backoffMs = nextBackoff(backoffMs);
    }
    log.debug("stt-supervisor-exit", {
      reason: ctx.abortSignal.aborted ? "session-ended" : "supervisor-replaced",
    });
  }

  function start(ctx: AdapterContext, alreadyConnected: STTAdapter | null): void {
    if (supervisorController !== null) {
      supervisorController.abort();
    }
    const controller = new AbortController();
    supervisorController = controller;
    runSupervisor(ctx, controller.signal, alreadyConnected).catch((err: unknown) => {
      log.error("stt-supervisor-crashed", { error: err instanceof Error ? err.message : String(err) });
    });
  }

  function abort(): void {
    supervisorController?.abort();
    supervisorController = null;
  }

  return { start, abort };
}
