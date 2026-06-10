// ---------------------------------------------------------------------------
// stream-resume-handler — outbound stream.resume + inbound stream.resumed
// handling for the SentientSDK reconnect path.
//
// Extracted from sentient-sdk.ts so that file stays near its pre-task size.
// Parallel to sdk-message-router.ts / sdk-close-handler.ts.
//
// Responsibilities:
//   - sendStreamResume: build + fire the stream.resume outbound frame after
//     session.configure on a reconnect cycle with a non-zero cursor.
//   - handleStreamResumed: react to the gateway's stream.resumed ack:
//       recovered=true  → dedup already handles replayed frames; no-op here.
//       recovered=false → reset cursor + trigger a REST history refetch.
// ---------------------------------------------------------------------------

import { sdkLog } from "./debug.ts";
import type { ResumeCursorState } from "./resume-cursor.ts";
import { getCurrentSessionId } from "./sdk-reconnect.ts";

export interface StreamResumeHandlerDeps {
  /** Resume cursor — read for resume frame, reset on not-recovered. */
  cursor: ResumeCursorState;
  /** The device id established at SDK construction. */
  deviceId: string;
  /** Low-level send — wraps WS.send + JSON.stringify. */
  send: (message: unknown) => void;
  /** Trigger map for the "session.switched" type — used for synthetic dispatch. */
  getMessageHandlers: () => Map<string, Set<(msg: unknown) => void>>;
}

/**
 * Send `stream.resume` to the gateway after `session.configure` on a reconnect
 * cycle. No-op when the cursor has no seq yet (first real connect, or after a
 * non-recovered resume that reset the cursor).
 */
export function sendStreamResume(deps: StreamResumeHandlerDeps): void {
  const { epoch, lastSeq } = deps.cursor.cursor;
  if (lastSeq === 0) {
    sdkLog.debug("stream.resume skipped — no cursor yet");
    return;
  }
  sdkLog.info("stream.resume.sending", { epoch, lastSeq, deviceId: deps.deviceId });
  deps.send({ type: "stream.resume", epoch, lastSeq, deviceId: deps.deviceId });
}

/**
 * React to `stream.resumed` from the gateway.
 *
 * - recovered: true  → gateway will replay missed frames; seq dedup handles
 *   them automatically. Nothing more to do.
 * - recovered: false → epoch mismatch / buffer expired. Reset the cursor so
 *   incoming frames start a fresh epoch cleanly, then refetch history via a
 *   synthetic `session.switched` dispatch.
 */
export function handleStreamResumed(deps: StreamResumeHandlerDeps, recovered: boolean): void {
  if (recovered) {
    sdkLog.info("stream.resumed.recovered", { epoch: deps.cursor.cursor.epoch });
    return;
  }
  sdkLog.info("stream.resumed.not-recovered — resetting cursor + refetching history");
  deps.cursor.reset();
  triggerHistoryRefetch(deps);
}

function triggerHistoryRefetch(deps: StreamResumeHandlerDeps): void {
  const sessionId = getCurrentSessionId();
  if (!sessionId) {
    sdkLog.warn("stream.resumed.no-session-id — cannot refetch history");
    return;
  }
  const handlers = deps.getMessageHandlers().get("session.switched");
  if (handlers === undefined || handlers.size === 0) {
    sdkLog.debug("stream.resumed.no-switched-handlers — no refetch triggered");
    return;
  }
  sdkLog.debug("stream.resumed.synthetic-switched", { sessionId });
  for (const h of handlers) h({ type: "session.switched", sessionId });
}
