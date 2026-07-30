// Late-bound holder for the delegated worker's external tool.
//
// WHY LATE-BOUND, and why that is not a shortcut. The delegated worker's
// configuration (`hermes-external-tool.ts`) needs the tool surface the gateway's
// MCP host advertises, and that host is constructed AFTER the composition root
// that builds `createSessionRuntime` — it depends on the user store, the user
// lifecycle and the session-controls registry that root produces. So the
// dependency genuinely runs the other way for one hop.
//
// WHY A SETTLE-GATED PROMISE AND NOT A PLAIN GETTER. An earlier shape exposed
// `get(): ExternalTool | null` and was read ONCE per session, at WS-connect
// time, on the premise that boot had long since filled it. Nothing enforced
// that premise: `Bun.serve()` began accepting connections before the MCP host
// had started, so a client that reconnected inside the boot window baked a
// permanent `null` into its session's `delegateTask` runner — every delegation
// for the life of that socket then skipped the verify-and-repair phase, with no
// self-heal short of a reconnect. That is exactly the silent, undiagnosable
// D8/D11 failure this task exists to make structurally impossible, so the
// premise is now enforced by the type instead of by a comment:
//
//   * The slot settles exactly ONCE per boot — `set` (a tool exists) or
//     `sealEmpty` (this configuration has none). Both are idempotent.
//   * Readers `await resolve(signal)`. A read that lands before the settle
//     waits for it rather than mistaking "not yet" for "never".
//   * `main.ts` settles the slot BEFORE the server accepts its first
//     connection, so in production that wait is always zero-length. The wait
//     is the guarantee that a future re-ordering degrades to "slightly later"
//     instead of "silently tool-less forever".
//
// The wait is bounded by the caller's own AbortSignal (the delegation's
// cancel/barge-in path), so a wedged boot can never become a wedged, uncancellable
// delegation either.
//
// An empty slot is still a degraded path, not a crash: `delegateTask` treats a
// null tool as "nothing to provide" and dispatches anyway.

import { getLog } from "../logging/logger.js";
import type { ExternalTool } from "./external-tool.js";

const log = getLog(["sentient", "external-tools", "slot"]);

/** Read side — what a tool runner depends on. Deliberately narrower than the
 *  slot: a reader may wait for the settle, never cause one. */
export interface ExternalToolSource {
  /**
   * The bound external tool, awaiting boot's settle when it has not happened
   * yet. Resolves `null` when this configuration has no external tool, or when
   * `signal` aborts first — a cancelled delegation must not wait on boot.
   */
  resolve(signal: AbortSignal): Promise<ExternalTool | null>;
}

export interface ExternalToolSlot extends ExternalToolSource {
  /** Settle with a tool. Called at boot by the composition root that owns the
   *  MCP host. A second call is ignored and logged — a settled promise cannot
   *  change, and a reader holding the first value must never disagree with a
   *  reader holding a later one. */
  set(tool: ExternalTool): void;
  /** Settle as empty. The boot tail calls this UNCONDITIONALLY so every
   *  configuration settles before the server accepts a connection; it is a
   *  no-op once `set` has run. */
  sealEmpty(reason: string): void;
}

/** Resolves with the settled tool, or with `null` if the caller aborts first. */
function raceSettle(settled: Promise<ExternalTool | null>, signal: AbortSignal): Promise<ExternalTool | null> {
  return new Promise((resolve) => {
    const onAbort = () => {
      log.warn("external-tool-slot.wait-cancelled", {
        reason: "the delegation was cancelled while waiting for boot to settle the slot",
      });
      resolve(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void settled.then((tool) => {
      signal.removeEventListener("abort", onAbort);
      resolve(tool);
    });
  });
}

export function createExternalToolSlot(): ExternalToolSlot {
  let bound: ExternalTool | null = null;
  let isSettled = false;
  let announce: (tool: ExternalTool | null) => void = () => {};
  const settled = new Promise<ExternalTool | null>((resolve) => {
    announce = resolve;
  });

  function settle(tool: ExternalTool | null): boolean {
    if (isSettled) return false;
    isSettled = true;
    bound = tool;
    announce(tool);
    return true;
  }

  return {
    set(tool: ExternalTool) {
      if (!settle(tool)) {
        log.warn("external-tool-slot.already-settled", {
          tool: tool.name,
          reason: "the slot settles once per boot; a second bind is ignored so no two readers can disagree",
        });
        return;
      }
      log.info("external-tool-slot.set", { tool: tool.name });
    },
    sealEmpty(reason: string) {
      if (!settle(null)) {
        log.debug("external-tool-slot.seal-noop", { reason: "a tool is already bound" });
        return;
      }
      log.info("external-tool-slot.sealed-empty", { reason });
    },
    async resolve(signal: AbortSignal) {
      if (isSettled) return bound;
      if (signal.aborted) return null;
      log.warn("external-tool-slot.waiting", {
        reason: "read before boot settled the slot; waiting for the settle instead of reporting no external tool",
      });
      return await raceSettle(settled, signal);
    },
  };
}
