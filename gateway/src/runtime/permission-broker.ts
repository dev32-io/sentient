// PermissionBroker (spec §5.3 / §7.1, Plan 3 Task 6) — the L3 `confirm`
// round-trip. The PDP asks, a human answers, the tool runs or doesn't.
//
// Shape of the seam (locked, do not "improve"): `request()` is bound to
// `ToolBrokerDeps.requestConfirm`, whose signature is
// `(inv, reason) => Promise<boolean>`. Two return values, three real
// outcomes — so an explicit human answer RESOLVES (true = allow, false =
// deny) and an UNANSWERABLE request REJECTS with `ConfirmUnavailableError`.
// tool-broker.ts already treats a throw as a deny (fail-closed), and now
// forwards that error's message to the model verbatim, which is how spec
// §7.1's required "permission request timed out" tool result reaches the
// model. A timeout is NEVER an implicit approval.
//
// One broker per WS connection, held on `ws.data.permissions`. That scoping
// IS the isolation boundary: a `permission.response` frame can only ever
// settle a request minted on the same socket, so cross-user/cross-session
// resolution is structurally impossible rather than a check someone can
// forget. `cleanupSession` calls `denyAll()`, so a socket that drops with a
// dialog open never leaves a pending promise (and therefore a wedged ReAct
// turn) behind.
//
// Four ways a request settles, all funnelled through the single `settle()`
// below so "first settle wins" is structural: user answer, timeout,
// turn abort (the turn's AbortSignal fired while the dialog was open —
// without this the loop would sit on an awaited dispatch for the full
// timeout after an interrupt), and connection close.

import { getLog } from "../logging/logger.js";
import { ConfirmUnavailableError } from "../tools/tool-types.js";
import type { ToolInvocation } from "../tools/tool-types.js";

const log = getLog(["sentient", "runtime", "permission-broker"]);

/** Model-facing copy. These strings land in the model's context as the tool
 *  result on a fail-closed deny (see tool-broker.ts's `resolveDecision`), so
 *  they are written for the model to reason about, not for a log grep. */
const TIMEOUT_MESSAGE = "permission request timed out";
const CLOSED_MESSAGE = "permission request cancelled: client disconnected";
const ABORTED_MESSAGE = "permission request cancelled: turn aborted";

/** Outcome as it appears on the `permission.resolved` frame. */
export type PermissionOutcome = "allowed" | "denied" | "timeout";

/** Everything the client needs to render one permission dialog. Mirrors the
 *  `permission.request` frame payload (Task 1's frozen wire contract). */
export interface PermissionPrompt {
  requestId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  description: string;
  expiresAtMs: number;
}

/** One resolution, as it appears on the `permission.resolved` frame. */
export interface PermissionResolution {
  requestId: string;
  outcome: PermissionOutcome;
}

/** The two emitter methods this module needs. Declared structurally rather
 *  than as `Pick<TurnEmitter, …>` so `runtime/` owns no import cycle and this
 *  module is testable against a two-method double. Task 1's `TurnEmitter`
 *  satisfies it by shape — including the single-payload-object arity of both
 *  methods, which is why `permissionResolved` takes a `PermissionResolution`
 *  rather than two positional arguments. */
export interface PermissionEmitter {
  permissionRequest(req: PermissionPrompt): void;
  permissionResolved(res: PermissionResolution): void;
}

export interface PermissionBroker {
  /** Emits `permission.request` and returns the promise `ToolBroker.dispatch`
   *  awaits. Resolves `true`/`false` on a human answer; rejects with
   *  `ConfirmUnavailableError` when the request cannot be answered. */
  request(inv: ToolInvocation, reason: string): Promise<boolean>;
  /** Settles a pending request from a client `permission.response` frame.
   *  Returns `false` (and only logs) for an unknown, duplicate, or
   *  already-timed-out requestId — never throws, never double-settles. */
  resolve(requestId: string, approved: boolean): boolean;
  /** Settles every outstanding request as unanswerable. Idempotent. Called
   *  on socket close / session teardown. Emits no frame — the socket is gone. */
  denyAll(): void;
  /** Outstanding prompts. Exposed so teardown paths can assert no leak. */
  readonly pendingCount: number;
}

export interface PermissionBrokerDeps {
  emitter: PermissionEmitter;
  /** The CONNECTION id (`ws.data.sessionId`), for log correlation and nothing
   *  else. It matches this broker's own scope — one per socket, settleable
   *  only by that socket — and is deliberately NOT the durable conversation
   *  the session store partitions on, which spans every reconnect and would
   *  make two connections' prompts indistinguishable in the log. See
   *  `SessionRuntimeRequest` in session-handles.ts. */
  sessionId: string;
  userId: string;
  /** `orchestrator.permission.request_timeout_ms` — never a literal here. */
  timeoutMs: number;
}

type SettleReason = "allowed" | "denied" | "timeout" | "aborted" | "closed";

/** How each internal settle reason appears on the wire. `aborted` has no
 *  frozen-contract outcome of its own, so it reports as `denied` — the
 *  fail-closed reading, and the one that makes the client dismiss the
 *  dialog. `closed` emits nothing (there is no socket left to tell). */
const WIRE_OUTCOME: Record<Exclude<SettleReason, "closed">, PermissionOutcome> = {
  allowed: "allowed",
  denied: "denied",
  timeout: "timeout",
  aborted: "denied",
};

interface PendingPermission {
  toolCallId: string;
  toolName: string;
  timer: ReturnType<typeof setTimeout>;
  detach: () => void;
  finish: (reason: SettleReason) => void;
}

export function createPermissionBroker(deps: PermissionBrokerDeps): PermissionBroker {
  const { emitter, sessionId, userId, timeoutMs } = deps;
  const pending = new Map<string, PendingPermission>();

  /** The ONE place a request leaves the pending map. Everything else
   *  (timeout, abort, client answer, teardown) routes through here, which is
   *  what makes "first settle wins" a structural property instead of four
   *  independent guards that can drift. */
  function settle(requestId: string, reason: SettleReason): void {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.detach();

    if (reason !== "closed") {
      emitter.permissionResolved({ requestId, outcome: WIRE_OUTCOME[reason] });
    }
    log.info("permission-broker.settled", {
      userId,
      sessionId,
      requestId,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      reason,
      pending: pending.size,
    });
    entry.finish(reason);
  }

  function request(inv: ToolInvocation, reason: string): Promise<boolean> {
    const requestId = crypto.randomUUID();
    const expiresAtMs = Date.now() + timeoutMs;

    let resolveFn: (approved: boolean) => void = () => {};
    let rejectFn: (err: unknown) => void = () => {};
    const promise = new Promise<boolean>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });

    const timer = setTimeout(() => settle(requestId, "timeout"), timeoutMs);
    const onAbort = () => settle(requestId, "aborted");
    inv.signal.addEventListener("abort", onAbort, { once: true });

    pending.set(requestId, {
      toolCallId: inv.toolCallId,
      toolName: inv.name,
      timer,
      detach: () => inv.signal.removeEventListener("abort", onAbort),
      finish: (settleReason) => {
        if (settleReason === "allowed") return resolveFn(true);
        if (settleReason === "denied") return resolveFn(false);
        if (settleReason === "timeout") return rejectFn(new ConfirmUnavailableError(TIMEOUT_MESSAGE));
        if (settleReason === "aborted") return rejectFn(new ConfirmUnavailableError(ABORTED_MESSAGE));
        return rejectFn(new ConfirmUnavailableError(CLOSED_MESSAGE));
      },
    });

    // Argument KEYS only — the values go on the wire to the user's own
    // dialog, but they must never enter the log (logging rule: no raw
    // content, ids/lengths/types only).
    log.info("permission-broker.request", {
      userId,
      sessionId,
      requestId,
      toolCallId: inv.toolCallId,
      toolName: inv.name,
      turnId: inv.turnId,
      argKeys: Object.keys(inv.args),
      timeoutMs,
      pending: pending.size,
    });

    emitter.permissionRequest({
      requestId,
      toolCallId: inv.toolCallId,
      toolName: inv.name,
      args: inv.args,
      description: reason,
      expiresAtMs,
    });

    return promise;
  }

  function resolve(requestId: string, approved: boolean): boolean {
    if (!pending.has(requestId)) {
      log.warn("permission-broker.resolve.unmatched", {
        userId,
        sessionId,
        requestId,
        approved,
        pending: pending.size,
        reason:
          "no pending prompt for this requestId — already answered, timed out, or never issued on this connection",
      });
      return false;
    }
    settle(requestId, approved ? "allowed" : "denied");
    return true;
  }

  function denyAll(): void {
    const requestIds = [...pending.keys()];
    for (const requestId of requestIds) settle(requestId, "closed");
    log.info("permission-broker.deny-all", { userId, sessionId, count: requestIds.length });
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
