// ---------------------------------------------------------------------------
// SessionAttachmentLedger — tracks which ACP sessions are attached to the
// CURRENT child, keyed by socket epoch.
//
// The overlay (`acp_ws_server.py`) spawns a FRESH `hermes -p <profile> acp`
// child per WS connection, with EMPTY in-process session state. ACP requires
// `session/new` OR `session/load` to register a session in the child before any
// `session/prompt`. After a reconnect (new epoch) the prior child's
// registrations are stale: a captured conversationId the old child knew is
// unknown to the new one, so the gateway must `session/load` it again before
// the next prompt — else the fresh child 404s with "session not found".
//
// This ledger is the source of truth for that decision: a session is attached
// iff it was minted/loaded at the epoch that is current right now.
// ---------------------------------------------------------------------------

/** Sentinel epoch meaning "never attached on any child". */
const NO_EPOCH = -1;

export interface SessionAttachmentLedger {
  /** Record that `sessionId` is attached to the child live at `epoch`. */
  markAttached(sessionId: string, epoch: number): void;
  /**
   * True iff `sessionId` was attached at the SAME epoch that is current now —
   * i.e. the current child already has it loaded and a prompt can go straight
   * out. False after a reconnect bumps the epoch (re-attach needed).
   */
  isAttached(sessionId: string, epoch: number): boolean;
}

export function createSessionAttachmentLedger(): SessionAttachmentLedger {
  const attachedAtEpoch = new Map<string, number>();
  return {
    markAttached(sessionId: string, epoch: number): void {
      attachedAtEpoch.set(sessionId, epoch);
    },
    isAttached(sessionId: string, epoch: number): boolean {
      return (attachedAtEpoch.get(sessionId) ?? NO_EPOCH) === epoch;
    },
  };
}
