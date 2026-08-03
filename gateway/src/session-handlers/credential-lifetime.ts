// Credential lifetime — ONE predicate, ONE ejection, three seams
// (session-model spec §3.6).
//
// A `UserPrincipal` is frozen and carries no expiry, and the PASETO token is
// validated exactly ONCE, at the auth gate. Without a check somewhere later, an
// attachment outlives its credential indefinitely: a token that expired hours
// ago keeps authorizing.
//
// NO TIMER, DELIBERATELY. Auth gates content at the POINT OF USE, not on a
// clock. A background sweep would need its own scheduler, its own shutdown, and
// would still leave the window between two ticks open; checking where the
// resource actually changes hands has neither problem and cannot drift out of
// step with the thing it guards.
//
// THE TWO SEAMS THE RESOURCE CROSSES, and both are needed because the gateway
// PUSHES:
//
//   - INBOUND, at the WS message-handler entry (ws-handlers.ts) — BEFORE the
//     frame-type switch, so binary mic audio, `session.configure`,
//     `conversation.activate`, `session.new` and the preference write are all
//     covered by the same check as the mediated commands. Putting it only in
//     `mediateCommand` covered the mediated subset, and the frames it missed
//     are precisely the ones that RE-ATTACH a detached socket.
//   - OUTBOUND, in the fan-out delivery filter (fan-out-emitter.ts) — beside
//     the `readyState !== OPEN` skip, which is where content would leave. A
//     socket whose credential died while it sat quietly never sends anything,
//     so an inbound-only gate never fires for it while every fanned-out frame
//     of the conversation keeps arriving. That is the actual disclosure.
//
// Both seams call `isCredentialExpired` — one predicate, so they cannot
// disagree — and eject through `closeExpiredCredential`. What differs per seam
// is only the local bookkeeping (the mediator adds its `command.rejected`, the
// fan-out departs the window) and that is not a second decision.
//
// WHY CLOSING, NOT DETACHING. Detaching alone is undone by the next frame: the
// session-changing frames are outside the command gate by design, so a merely
// detached connection re-attaches with one of them and resumes reading. A
// CLOSED socket cannot read, cannot re-attach, and has to come back through the
// auth gate with a fresh expiry.
//
// `code: "expired"` is `token-service.ts`'s own vocabulary, and it is what both
// mobile SDKs classify TERMINAL (`AuthErrorClass.kt`'s `TERMINAL_AUTH_CODES`)
// — so this routes the user to the login screen rather than into a silent
// retry loop. Auth expiring should return you to login, not degrade quietly.
//
// NO IDLE-TAB GAP IS LEFT. An expired socket on a quiet session receives
// nothing (outbound seam) and can send nothing (inbound seam), so there is
// nothing left to disclose while the WS idle timeout reaps it.

import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import type { SessionData } from "./ws-helpers.js";
import { sendConnectionFrame } from "./ws-send.js";

const log = getLog(["sentient", "ws", "credential-lifetime"]);

/** RFC 6455 policy violation — the same code the auth gate closes on. */
const WS_CLOSE_POLICY = 1008;

/** What `token-service.ts` calls an expired credential, and what both mobile
 *  SDKs classify as terminal (→ route to login). */
const EXPIRED_CODE = "expired";

const EXPIRED_MESSAGE = "session token expired — please sign in again";

/** Which gate tripped. Log-only, and worth carrying: "the socket was still
 *  reading" and "the socket tried to act" are different incidents. */
export type CredentialSeam = "inbound" | "outbound" | "command";

/**
 * Has this connection's credential expired at [nowMs]?
 *
 * `null` means no expiry is known — the socket has not authenticated yet, or
 * was rejected — and an unauthenticated socket is already gated elsewhere, so
 * this answers false rather than closing something that was never open.
 *
 * [nowMs] is injectable so the check is deterministic under test; production
 * always takes the default. It is NEVER read from the client — a clock the
 * caller supplies would be an input to a security decision.
 */
export function isCredentialExpired(ws: ServerWebSocket<SessionData>, nowMs: number = Date.now()): boolean {
  const expiresAtMs = ws.data.tokenExpiresAtMs;
  return expiresAtMs !== null && nowMs >= expiresAtMs;
}

/**
 * Tell the client its credential died and close the socket.
 *
 * Says it OUT LOUD before closing: a bare close is indistinguishable from a
 * lost network, and both SDKs would reconnect with the same dead token forever
 * instead of showing the login screen.
 *
 * Detaching is the CALLER's job and differs per seam — the mediator drops the
 * attachment through `detachSession`, the fan-out departs the window through
 * its own deferred detach. Reaching into either from here would give this
 * module a dependency on the modules that depend on it.
 *
 * THE CLOSE CANNOT THROW OUT OF HERE, and that is not defensiveness. The
 * OUTBOUND caller runs inside `deliver()` → `broadcast()` → `textDelta()` —
 * i.e. inside the running ReAct loop — so an exception escaping this function
 * unwinds a live turn because one window's socket was already gone.
 * `sendConnectionFrame` is already write-safe; the close is the one exposed
 * call, so it is wrapped exactly as `disconnectLaggingWindow`
 * (fan-out-emitter.ts) wraps the identical call, for the identical reason. The
 * window has already stopped being served either way — the close is what makes
 * the ejection stick, not what makes it correct.
 */
export function closeExpiredCredential(ws: ServerWebSocket<SessionData>, seam: CredentialSeam): void {
  log.warn("credential.expired", {
    connectionId: ws.data.sessionId,
    sessionId: ws.data.attachment?.sessionId ?? null,
    attachmentId: ws.data.attachment?.attachmentId ?? null,
    seam,
    reason: "this connection's token expired — closing so it returns through the auth gate",
  });
  sendConnectionFrame(ws, { type: "auth.error", code: EXPIRED_CODE, message: EXPIRED_MESSAGE });
  try {
    ws.close(WS_CLOSE_POLICY, "credential expired");
  } catch (err) {
    log.debug("credential.close-failed", {
      connectionId: ws.data.sessionId,
      seam,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}
