import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { getLog } from "../logging/logger.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import type { Stimulus } from "../runtime/stimulus.js";
import { ClosedSessionExecutionError, DeletedSessionError } from "../store/session-store.js";
import { closeWithAuthError } from "./credential-lifetime.js";
import { bindSessionRuntime, completeAttachWithSnapshot, detachSession, withSessionStore } from "./session-binding.js";
import type { SessionData } from "./ws-helpers.js";
import { sendError } from "./ws-helpers.js";
import { sendConnectionFrame } from "./ws-send.js";

const log = getLog(["sentient", "ws", "cube-input"]);

function rejectCube(ws: ServerWebSocket<SessionData>, services: GatewayServices): false {
  ws.data.authState = "rejected";
  detachSession(ws, services);
  closeWithAuthError(ws, "expired", "device authority expired or changed");
  return false;
}

/** Synchronous transport check: never reorder/drop mic frames behind owner-file reads.
 * Owner mutations retire registry authority before writing; accepted transcripts
 * and execution boundaries additionally resolve current owner state asynchronously. */
export function cubeCredentialLive(ws: ServerWebSocket<SessionData>, services: GatewayServices): boolean {
  const credential = ws.data.deviceCredential;
  return ws.data.authState === "authed" && credential?.principal === ws.data.principal && credential.live()
    ? true
    : rejectCube(ws, services);
}

async function authorizeCube(ws: ServerWebSocket<SessionData>, services: GatewayServices): Promise<boolean> {
  if (!cubeCredentialLive(ws, services)) return false;
  const credential = ws.data.deviceCredential;
  if (!credential || !(await credential.current())) return rejectCube(ws, services);
  return cubeCredentialLive(ws, services);
}

/** Both text and STT consume this already-committed admission. No client-selected origin/session. */
export async function admitCubeMessage(
  ws: ServerWebSocket<SessionData>,
  services: GatewayServices,
  text: string,
  pendingId?: string,
  captureIsCurrent: () => boolean = () => true,
): Promise<{ runtime: SessionRuntime; stimulus: Stimulus; authoritative: true } | null> {
  const credential = ws.data.deviceCredential;
  const principal = ws.data.principal;
  const draftKey = ws.data.draftKey;
  if (!credential || credential.principal !== principal || !principal || !draftKey) {
    sendError(ws, "protocol_error", "Configure the authenticated Cube before input");
    return null;
  }
  try {
    // Receipt time and fence precede asynchronous current-owner authorization.
    const now = Date.now();
    const fence = withSessionStore(services, principal, (store) => {
      const id = store.getCurrentCubeSessionId();
      if (
        id &&
        services.sessionRegistry.handlesFor(id)?.runtime.executionAvailable === false &&
        store.getSessionExecutionStatus(id) === "open"
      ) {
        // Expiry retires only the immutable credential/runtime, not daily history.
        // Clear transport handles before removing the attach index. Captures keep
        // their session target; no durable session switch has happened here.
        for (const attachment of services.sessionRegistry.subscribers(id)) {
          attachment.ws.data.attachment = null;
          attachment.ws.data.runtime = null;
          attachment.ws.data.journal = null;
          attachment.ws.data.epoch = 0;
        }
        services.sessionRegistry.orphanSession(principal.userId, id);
      }
      return store.getCubeAdmissionFence();
    });
    if (!(await authorizeCube(ws, services)) || !captureIsCurrent() || ws.data.draftKey !== draftKey) return null;
    const inputId = JSON.stringify([
      credential.principal.origin?.deviceId,
      credential.principal.origin?.generation,
      pendingId ?? crypto.randomUUID(),
    ]);
    const admitted = withSessionStore(services, principal, (store) => {
      const currentId = store.getCurrentCubeSessionId();
      const attached = ws.data.runtime;
      const current = currentId ? services.sessionRegistry.handlesFor(currentId)?.runtime : null;
      // Recheck the immutable initial runtime grant before choosing an active turn.
      const activeSessionId =
        attached?.executionAvailable !== false && attached?.running
          ? ws.data.conversationId
          : current?.executionAvailable !== false && current?.running
            ? currentId
            : null;
      if (!credential.live()) return null;
      return store.admitCubeInput({
        inputId,
        expectedFence: fence,
        now,
        dreamerHour: services.cubeDreamerHour,
        ...(activeSessionId ? { activeSessionId } : {}),
        entry: {
          turnId: crypto.randomUUID(),
          replyId: null,
          kind: "user",
          createdAt: now,
          text,
          toolCallId: null,
          toolName: null,
          toolArgs: null,
          cutoff: null,
          compactedThroughSeq: null,
        },
      });
    });
    if (!admitted || admitted.status !== "accepted") {
      sendError(ws, "session_closed", "Input authority changed; send a fresh input after reauthorization");
      return null;
    }
    if (ws.data.attachment?.sessionId !== admitted.sessionId) {
      detachSession(ws, services);
      ws.data.conversationId = admitted.sessionId;
      const bound = await bindSessionRuntime(
        ws,
        services,
        admitted.sessionId,
        () =>
          ws.data.authState === "authed" &&
          ws.data.deviceCredential === credential &&
          ws.data.conversationId === admitted.sessionId,
      );
      if (bound.kind !== "bound") {
        if (bound.kind === "no-runtime")
          sendError(ws, "orchestrator_unavailable", "Cube execution is unavailable; send a fresh input after recovery");
        return null;
      }
      sendConnectionFrame(ws, { type: "session.created", sessionId: admitted.sessionId, ts: Date.now() });
      completeAttachWithSnapshot(ws, services);
    }
    // Durable retry receipt never launches a second execution, including after restart.
    if (admitted.replayed || !ws.data.runtime || !credential.live() || ws.data.runtime.executionAvailable === false)
      return null;
    return {
      runtime: ws.data.runtime,
      authoritative: true,
      stimulus: { kind: "preadmitted-conversational", entrySeq: admitted.entry.seq, admission: "fresh" },
    };
  } catch (error) {
    const retired = error instanceof ClosedSessionExecutionError || error instanceof DeletedSessionError;
    if (!retired)
      log.warn("cube-input.unavailable", {
        connectionId: ws.data.sessionId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    // No fence refresh/retry: an old callback must never mint a replacement.
    sendError(ws, retired ? "session_closed" : "session_unavailable", "Cube input could not be admitted");
    return null;
  }
}
