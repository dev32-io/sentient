// The session's open permission prompts (session-model spec §2.4) — ONE map,
// keyed by a session-global `requestId`, fanned to every attached window.
//
// THE THING THAT MOVED. `permission-broker.ts` held this map per WS CONNECTION
// and called that scoping the isolation boundary: a `permission.response`
// could only settle a prompt minted on the same socket. Under N windows that
// boundary is drawn in the wrong place — a prompt raised at the laptop is
// unanswerable from the phone, and closing the laptop strands the tool call
// for the full timeout. So the map itself moved here, to the session. It is
// NOT a session-shaped façade over per-connection brokers: there is exactly
// one map per session, no per-connection object left to resolve against, and
// `ws.data.permissions` is gone.
//
// ISOLATION IS STILL STRUCTURAL, just at the right scope. A session belongs to
// exactly one principal, and a connection reaches this broker only through the
// registry entry it is ATTACHED to (ws-handlers.ts), so a frame naming another
// user's requestId still resolves nothing. Argument values ride the wire to
// every attached window unredacted, which is correct: every window is the same
// authenticated principal looking at their own data (spec §3.4).
//
// FAIL CLOSED, BOTH WAYS:
//   - the deadline denies (permission-prompt.ts), never approves;
//   - a prompt NO window can see is denied AT ONCE rather than parked. A
//     side-effecting tool waiting two minutes on a dialog nobody will ever
//     open is the worst of both outcomes, so `request` checks the delivery set
//     BEFORE it opens a prompt.
//
// THE FIRST ANSWER SETTLES IT. A second is refused, never re-decided: the
// prompt leaves this map inside the same synchronous settle that resolves it,
// and the prompt object refuses a second settlement on its own account. Two
// guards, one property — a deny a later allow can overturn is a security
// defect, not a race.
//
// ATTRIBUTION IS A LOG CONTRACT (spec §7.3). The `permission.resolved` frame
// carries no attachmentId — the wire is frozen — so the answering window is
// named in `session-permission.settled` and nowhere else. With N windows,
// "who approved this" has to be answerable from the log. Argument VALUES never
// are: every line carries `argKeys` only.

import { getLog } from "../logging/logger.js";
import { ConfirmUnavailableError } from "../tools/tool-types.js";
import type { ToolInvocation } from "../tools/tool-types.js";
import type { PendingPrompt, PermissionDecision, PermissionSettlement } from "./permission-prompt.js";
import { ABORTED_MESSAGE, WIRE_OUTCOME, openPermissionPrompt } from "./permission-prompt.js";
import type { PermissionRequest, PermissionResolution } from "./turn-emitter.js";

const log = getLog(["sentient", "runtime", "session-permission"]);

/** Model-facing copy for a prompt raised with nobody attached to answer it. */
const NO_WINDOW_MESSAGE = "permission request could not be shown: no window is open on this session";
/** Model-facing copy for a prompt minted under an id that is already open. */
const DUPLICATE_MESSAGE = "permission request could not be shown: a prompt is already open for this request";

/** The two emitter methods this module needs. Declared structurally rather
 *  than as `Pick<TurnEmitter, …>` so `runtime/` owns no import cycle and this
 *  module is testable against a two-method double. The session's
 *  `FanOutTurnEmitter` satisfies it by shape, which is what makes one
 *  `permissionRequest` call reach every attached window. */
export interface PermissionEmitter {
  permissionRequest(req: PermissionRequest): void;
  permissionResolved(res: PermissionResolution): void;
}

export interface SessionPermissionBroker {
  /** Fan a prompt to every attachment; resolve on the FIRST answer. Never
   *  rejects — an unanswerable prompt resolves a decision carrying
   *  `unavailable` (permission-prompt.ts). */
  request(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision>;
  /** Answer from any attachment. Returns false when already settled — or when
   *  no prompt was ever open under this id. */
  resolve(requestId: string, decision: PermissionDecision, attachmentId: string): boolean;
  /** Deny everything outstanding — session teardown. [reason] is model-facing
   *  copy: it becomes the tool result the ReAct loop's parked dispatch sees.
   *  Idempotent. Emits no frame; teardown means no window is left to tell. */
  denyAll(reason: string): void;
  /** Outstanding prompts. Exposed so teardown paths can assert no leak. */
  readonly pendingCount: number;
}

export interface SessionPermissionBrokerDeps {
  /** The session's outbound seam — one call, every attached window. */
  emitter: PermissionEmitter;
  /** The DURABLE session id these prompts belong to (NOT a connection id): it
   *  is the partition every attached window shares, and the only id under
   *  which "who has an open prompt" is a well-formed question. */
  sessionId: string;
  userId: string;
  /**
   * How many windows are attached RIGHT NOW, read at PROMPT time rather than
   * captured at build time — a session outlives every one of its windows, and
   * the answer at construction (zero: the first attachment is recorded after
   * the handles are built) is never the answer that matters.
   */
  attachedWindows: () => number;
}

export function createSessionPermissionBroker(deps: SessionPermissionBrokerDeps): SessionPermissionBroker {
  const { emitter, sessionId, userId, attachedWindows } = deps;
  const pending = new Map<string, PendingPrompt>();

  /** The ONE place a prompt leaves the map. Runs inside the prompt's own
   *  settle, before its promise resolves, so every exit (answer, deadline,
   *  abort, teardown) removes it exactly once and in the same order. */
  function onSettled(request: PermissionRequest, settlement: PermissionSettlement): void {
    pending.delete(request.requestId);
    if (settlement.reason !== "closed") {
      emitter.permissionResolved({ requestId: request.requestId, outcome: WIRE_OUTCOME[settlement.reason] });
    }
    log.info("session-permission.settled", {
      userId,
      sessionId,
      requestId: request.requestId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      reason: settlement.reason,
      // The "who approved this" of spec §7.3 — null for every settlement no
      // window caused.
      attachmentId: settlement.attachmentId,
      windows: attachedWindows(),
      pending: pending.size,
    });
  }

  /** Deny before a prompt is ever opened — nothing is emitted, nothing is
   *  parked, and the model is told why. */
  function refuse(req: PermissionRequest, event: string, message: string, reason: string): Promise<PermissionDecision> {
    log.warn(event, {
      userId,
      sessionId,
      requestId: req.requestId,
      toolCallId: req.toolCallId,
      toolName: req.toolName,
      argKeys: Object.keys(req.args),
      windows: attachedWindows(),
      reason,
    });
    return Promise.resolve({ allow: false, unavailable: message });
  }

  function request(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision> {
    if (attachedWindows() === 0) {
      return refuse(
        req,
        "session-permission.no-window",
        NO_WINDOW_MESSAGE,
        "no window is attached to this session — denying at once rather than parking a side-effecting tool on a dialog nobody will see",
      );
    }
    if (signal.aborted) {
      return refuse(
        req,
        "session-permission.turn-gone",
        ABORTED_MESSAGE,
        "the turn was already aborted when the PDP asked — no dialog is opened for a turn nobody is waiting on",
      );
    }
    if (pending.has(req.requestId)) {
      // Every settle deletes ITS OWN key, so a second prompt under a live id
      // would leave the first unsettleable and let its deadline delete the
      // newcomer's entry. The id is the prompt's identity; refuse the
      // duplicate rather than displace the dialog a window is looking at.
      return refuse(
        req,
        "session-permission.duplicate-request",
        DUPLICATE_MESSAGE,
        "a prompt is already open under this requestId — refusing the duplicate rather than displacing it",
      );
    }

    const prompt = openPermissionPrompt({
      request: req,
      signal,
      onSettled: (settlement) => onSettled(req, settlement),
    });
    pending.set(req.requestId, prompt);

    // Argument KEYS only — the values go on the wire to this principal's own
    // dialogs, but they must never enter the log (logging rule: ids, lengths
    // and types, never content).
    log.info("session-permission.request", {
      userId,
      sessionId,
      requestId: req.requestId,
      toolCallId: req.toolCallId,
      toolName: req.toolName,
      argKeys: Object.keys(req.args),
      expiresAtMs: req.expiresAtMs,
      windows: attachedWindows(),
      pending: pending.size,
    });

    emitter.permissionRequest(req);
    return prompt.decided;
  }

  function resolve(requestId: string, decision: PermissionDecision, attachmentId: string): boolean {
    const prompt = pending.get(requestId);
    if (prompt === undefined) {
      log.warn("session-permission.resolve.unmatched", {
        userId,
        sessionId,
        requestId,
        attachmentId,
        allow: decision.allow,
        pending: pending.size,
        reason:
          "no open prompt under this requestId — already answered by another window, already timed out, or never issued on this session",
      });
      return false;
    }
    return prompt.settle({ reason: decision.allow ? "allowed" : "denied", attachmentId });
  }

  function denyAll(reason: string): void {
    // A copy: settling removes the entry from the map underneath the loop.
    const open = [...pending.values()];
    for (const prompt of open) prompt.settle({ reason: "closed", attachmentId: null, unavailable: reason });
    log.info("session-permission.deny-all", { userId, sessionId, count: open.length, reason });
  }

  return {
    request,
    resolve,
    denyAll,
    get pendingCount() {
      return pending.size;
    },
  };
}

/**
 * Bind this session's broker to the PDP's `requestConfirm` seam.
 *
 * TWO CONVERSIONS, and both are the reason this lives beside the broker rather
 * than at the composition root:
 *
 *  1. It mints the prompt — a session-global `requestId` and the absolute
 *     `expiresAtMs` deadline derived from `orchestrator.permission
 *     .request_timeout_ms`. One id, fanned to every window, so any window's
 *     answer names the same prompt.
 *  2. It turns an `unavailable` decision back into the throw
 *     `ToolBrokerDeps.requestConfirm` is contracted on. That seam is
 *     `(inv, reason) => Promise<boolean>` with three real outcomes, so an
 *     explicit human answer RESOLVES true/false and an unanswerable prompt
 *     REJECTS with `ConfirmUnavailableError`, whose message tool-broker.ts
 *     forwards to the model verbatim as the deny reason.
 */
export function createConfirmHook(
  broker: SessionPermissionBroker,
  timeoutMs: number,
): (inv: ToolInvocation, reason: string) => Promise<boolean> {
  return async (inv, reason) => {
    const req: PermissionRequest = {
      requestId: crypto.randomUUID(),
      toolCallId: inv.toolCallId,
      toolName: inv.name,
      args: inv.args,
      description: reason,
      expiresAtMs: Date.now() + timeoutMs,
    };
    // The prompt's own lines carry no turnId (the wire payload has no such
    // field), so this is the one place a prompt is tied back to the turn that
    // raised it.
    log.info("session-permission.confirm-requested", {
      requestId: req.requestId,
      toolCallId: inv.toolCallId,
      toolName: inv.name,
      turnId: inv.turnId,
      argKeys: Object.keys(inv.args),
      timeoutMs,
    });
    const decision = await broker.request(req, inv.signal);
    if (decision.unavailable !== undefined) throw new ConfirmUnavailableError(decision.unavailable);
    return decision.allow;
  };
}
