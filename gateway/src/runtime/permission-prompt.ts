// ONE permission prompt, settled exactly once (spec §5.3/§7.1) — the L3
// `confirm` round-trip's per-prompt half. The PDP asks, a human answers, the
// tool runs or doesn't.
//
// WHAT MOVED, AND WHY THIS FILE IS NO LONGER A BROKER. It was
// `permission-broker.ts`, and its header opened with "One broker per WS
// connection, held on `ws.data.permissions`" — the prompt MAP lived here,
// reachable only from the socket that minted it. With one window per session
// that scoping WAS the isolation boundary; with N windows (session-model spec
// §2.4) it is the defect: a prompt raised while you are at your laptop is
// unanswerable from your phone, and closing the laptop strands the tool call
// until it times out. The map now belongs to the SESSION
// (session-permission-broker.ts). What is left here is the part that was
// always per-PROMPT and is untouched by the move — one deadline, one abort
// listener, one settlement.
//
// FOUR WAYS A PROMPT SETTLES, all funnelled through the single `settle()`
// below so "first settle wins" is STRUCTURAL rather than four independent
// guards that can drift: a human answer, the deadline, the turn's AbortSignal
// (without which the ReAct loop would sit on an awaited dispatch for the full
// timeout after an interrupt), and session teardown.
//
// IT NEVER REJECTS, AND THAT IS THE ONE DELIBERATE CHANGE OF SHAPE. Every
// settlement resolves a `PermissionDecision`; a decision no human made carries
// `unavailable`, the model-facing sentence explaining why. The throw the
// `requestConfirm` seam is contracted on (tool-broker.ts treats a throw as a
// fail-closed deny and forwards `ConfirmUnavailableError`'s message to the
// model verbatim) is reintroduced at exactly ONE place — `createConfirmHook`
// in session-permission-broker.ts. Modelling "nobody answered" as a VALUE is
// what lets the session broker log and attribute every settlement uniformly,
// including the ones no window caused.
//
// A TIMEOUT IS NEVER AN IMPLICIT APPROVAL. Neither is an abort, a teardown, or
// a prompt nobody could see (that last one is denied by the session broker
// before a prompt is ever opened).

import { getLog } from "../logging/logger.js";
import type { PermissionRequest } from "./turn-emitter.js";

const log = getLog(["sentient", "runtime", "permission-prompt"]);

/** Model-facing copy. These strings land in the model's context as the tool
 *  result on a fail-closed deny (tool-broker.ts's `resolveDecision`), so they
 *  are written for the model to reason about, not for a log grep. */
export const TIMEOUT_MESSAGE = "permission request timed out";
export const ABORTED_MESSAGE = "permission request cancelled: turn aborted";
/** What `SessionPermissionBroker.denyAll` is given when the session's handles
 *  are disposed — the last window left, so there is nobody to ask. */
export const SESSION_CLOSED_MESSAGE = "permission request cancelled: the session closed";

/** Outcome as it appears on the `permission.resolved` frame. */
export type PermissionOutcome = "allowed" | "denied" | "timeout";

/** Why a prompt closed. `closed` is teardown — the only reason whose
 *  model-facing text comes from the caller rather than from this module. */
export type SettleReason = "allowed" | "denied" | "timeout" | "aborted" | "closed";

/**
 * How each settle reason appears on the wire. `aborted` has no frozen-contract
 * outcome of its own, so it reports as `denied` — the fail-closed reading, and
 * the one that makes every window dismiss the dialog. `closed` has no entry
 * because it emits nothing: teardown means no window is left to tell.
 */
export const WIRE_OUTCOME: Record<Exclude<SettleReason, "closed">, PermissionOutcome> = {
  allowed: "allowed",
  denied: "denied",
  timeout: "timeout",
  aborted: "denied",
};

/**
 * The answer `ToolBroker.dispatch` is waiting on.
 *
 * `allow` is the whole decision. `unavailable` is present ONLY when no human
 * answered at all (deadline, turn abort, teardown, no window to ask) and
 * carries the sentence the model is told — an explicit human "no" deliberately
 * has none, because "the user declined" is not the same fact as "nobody could
 * be asked" and the model must be able to tell them apart.
 */
export interface PermissionDecision {
  readonly allow: boolean;
  readonly unavailable?: string;
}

/** One settlement, as the winner supplies it. */
export interface PermissionSettlement {
  readonly reason: SettleReason;
  /** The attachment that answered — the "who approved this" of spec §7.3.
   *  Null for every settlement no window caused (deadline, abort, teardown). */
  readonly attachmentId: string | null;
  /** Model-facing text for a `closed` settlement. Ignored for every other
   *  reason, which owns its copy above. */
  readonly unavailable?: string;
}

export interface PendingPrompt {
  /** What was fanned out to the windows. Held so the session broker can name
   *  the tool in its settle line without keeping a second map. */
  readonly request: PermissionRequest;
  /** Resolves once, on the first settlement. NEVER rejects. */
  readonly decided: Promise<PermissionDecision>;
  /**
   * Close this prompt. Returns false when it was already settled — the second
   * answer is REFUSED, never re-decided, so a deny cannot be overturned by a
   * later allow.
   */
  settle(settlement: PermissionSettlement): boolean;
}

export interface PermissionPromptDeps {
  /** The wire payload, already minted with its session-global `requestId` and
   *  its absolute `expiresAtMs` deadline. */
  request: PermissionRequest;
  /**
   * The turn's abort signal. MUST NOT be already aborted — the caller settles
   * that case itself (see `SessionPermissionBroker.request`), because a prompt
   * that settles inside its own constructor would run `onSettled` before the
   * caller could record it and leave a settled entry in the map forever.
   */
  signal: AbortSignal;
  /** Runs EXACTLY ONCE, on the winning settlement, BEFORE `decided` resolves —
   *  so the prompt is out of the session's map before the ReAct loop wakes. */
  onSettled: (settlement: PermissionSettlement) => void;
}

function decisionFor(settlement: PermissionSettlement): PermissionDecision {
  if (settlement.reason === "allowed") return { allow: true };
  if (settlement.reason === "denied") return { allow: false };
  if (settlement.reason === "timeout") return { allow: false, unavailable: TIMEOUT_MESSAGE };
  if (settlement.reason === "aborted") return { allow: false, unavailable: ABORTED_MESSAGE };
  return { allow: false, unavailable: settlement.unavailable ?? SESSION_CLOSED_MESSAGE };
}

/**
 * Open one prompt and arm both of its unattended exits.
 *
 * The deadline is derived from `request.expiresAtMs` — the SAME value the
 * client renders and dismisses on — rather than from a separately-passed
 * duration, so the dialog and the auto-deny cannot drift apart. A deadline
 * already in the past settles on the next tick, which is the fail-closed
 * answer.
 */
export function openPermissionPrompt(deps: PermissionPromptDeps): PendingPrompt {
  const { request, signal, onSettled } = deps;
  let settled = false;
  let publish: (decision: PermissionDecision) => void = () => {};
  const decided = new Promise<PermissionDecision>((resolve) => {
    publish = resolve;
  });

  function settle(settlement: PermissionSettlement): boolean {
    if (settled) {
      log.debug("permission-prompt.already-settled", {
        requestId: request.requestId,
        reason: settlement.reason,
        attachmentId: settlement.attachmentId,
        note: "this prompt was settled by an earlier answer — refusing, not re-deciding",
      });
      return false;
    }
    settled = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    onSettled(settlement);
    publish(decisionFor(settlement));
    return true;
  }

  const timer = setTimeout(
    () => settle({ reason: "timeout", attachmentId: null }),
    Math.max(0, request.expiresAtMs - Date.now()),
  );
  const onAbort = (): void => {
    settle({ reason: "aborted", attachmentId: null });
  };
  signal.addEventListener("abort", onAbort, { once: true });

  return { request, decided, settle };
}
