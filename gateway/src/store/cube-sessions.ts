import type { Database } from "bun:sqlite";
import { mintSessionId } from "../session-handlers/session-id.js";
import type { NewSessionEntry, SessionEntry } from "./entry-types.js";
import type { SessionMetadataOps } from "./session-metadata.js";

/** Same local timezone and Date disambiguation as dreamer/scheduler.ts.
 * Missing DST hours advance through the gap; repeated hours use the first occurrence. */
export function cubePeriodStart(now: number, dreamerHour: number): number {
  if (!Number.isFinite(now) || !Number.isInteger(dreamerHour) || dreamerHour < 0 || dreamerHour > 23)
    throw new RangeError("invalid Cube period configuration");
  const boundary = new Date(now);
  boundary.setHours(dreamerHour, 0, 0, 0);
  if (boundary.getTime() > now) {
    boundary.setDate(boundary.getDate() - 1);
    boundary.setHours(dreamerHour, 0, 0, 0);
  }
  return boundary.getTime();
}

export type ExecutionStatus = "open" | "closed" | "deleted" | "absent";
export type CubeClosureReason = "revoked" | "owner-changed" | "deleted";
export type CubeInputResult =
  | { status: "accepted"; sessionId: string; entry: SessionEntry; replayed: boolean }
  | { status: "stale-fence" | "closed" | "deleted" | "input-conflict" };

export interface CubeSessionOps {
  /** Snapshot BEFORE authorizing fresh device input. Not device authorization itself. */
  getCubeAdmissionFence(): number;
  /** Lookup only: neither period rollover nor reads create history. */
  getCurrentCubeSessionId(): string | null;
  /** Only fresh, currently authorized device input may call this minting API.
   * inputId is stable across retries and unique per user's Cube input (not per device).
   * Pass configured orchestrator.memory.dreamer.hour; now is server receipt time.
   * activeSessionId is runtime-selected steering authority, never a client anchor.
   * Steering retains that session and the same durable retry receipts across a boundary. */
  admitCubeInput(input: {
    inputId: string;
    activeSessionId?: string;
    expectedFence: number;
    dreamerHour: number;
    now: number;
    entry: Omit<NewSessionEntry, "sessionId" | "pendingId">;
  }): CubeInputResult;
  /** No minting, no association lookup. Late work retains its original session ID. */
  getSessionExecutionStatus(sessionId: string): ExecutionStatus;
  /** Permanent, idempotent session fence; history remains readable. */
  closeCubeSessionExecution(sessionId: string, reason: CubeClosureReason): ExecutionStatus;
  /** Shared per-user sessions: revoking any participating device conservatively closes all.
   * Always advances admission fence, including when no session exists yet. */
  closeCubeExecutions(reason: Exclude<CubeClosureReason, "deleted">): string[];
}

export function createCubeSessionOps(
  db: Database,
  metadata: SessionMetadataOps,
  admit: (entry: NewSessionEntry) => SessionEntry,
  readEntry: (sessionId: string, pendingId: string) => SessionEntry | null,
): CubeSessionOps {
  const state = db.query<{ admission_fence: number; session_id: string | null; period_start: number | null }, []>(
    "SELECT * FROM cube_session_state WHERE singleton=1",
  );
  function readState() {
    const row = state.get();
    if (!row) throw new Error("Cube admission state is missing");
    return row;
  }
  const status = (sessionId: string): ExecutionStatus => {
    if (db.query("SELECT 1 FROM deleted_sessions WHERE session_id=?").get(sessionId)) return "deleted";
    if (db.query("SELECT 1 FROM closed_session_executions WHERE session_id=?").get(sessionId)) return "closed";
    return metadata.getSession(sessionId) ? "open" : "absent";
  };
  const invalidate = () => db.exec("UPDATE cube_session_state SET admission_fence=admission_fence+1 WHERE singleton=1");
  const close = (sessionId: string, reason: CubeClosureReason): ExecutionStatus => {
    const current = status(sessionId);
    if (current !== "open") return current;
    const row = db.query<{ origin: string }, [string]>("SELECT origin FROM sessions WHERE session_id=?").get(sessionId);
    if (row?.origin !== "cube") return "absent";
    db.query("INSERT INTO closed_session_executions VALUES (?,?,?)").run(sessionId, Date.now(), reason);
    db.query("UPDATE cube_session_state SET session_id=NULL,period_start=NULL WHERE session_id=?").run(sessionId);
    invalidate();
    return "closed";
  };
  const admission = db.transaction((input: Parameters<CubeSessionOps["admitCubeInput"]>[0]): CubeInputResult => {
    const current = readState();
    if (current.admission_fence !== input.expectedFence) return { status: "stale-fence" };
    if (!input.inputId || input.entry.kind !== "user") return { status: "input-conflict" };
    const receipt = db
      .query<{ session_id: string }, [string]>("SELECT session_id FROM cube_input_receipts WHERE input_id=?")
      .get(input.inputId);
    if (receipt) {
      const execution = status(receipt.session_id);
      if (execution === "closed" || execution === "deleted") return { status: execution };
      const entry = readEntry(receipt.session_id, input.inputId);
      if (!entry || entry.text !== input.entry.text) return { status: "input-conflict" };
      return { status: "accepted", sessionId: receipt.session_id, entry, replayed: true };
    }
    const period = cubePeriodStart(input.now, input.dreamerHour);
    let sessionId = input.activeSessionId ?? current.session_id;
    if (input.activeSessionId) {
      if (status(input.activeSessionId) !== "open" || metadata.getSession(input.activeSessionId)?.provenance !== "cube")
        return { status: "closed" };
    }
    if (
      !input.activeSessionId &&
      (!sessionId || current.period_start === null || current.period_start < period || status(sessionId) !== "open")
    ) {
      sessionId = mintSessionId();
      // Existing mint/tombstone path, under the same IMMEDIATE transaction as first entry.
      metadata.createSession(sessionId, `cube:${sessionId}`);
      db.query("UPDATE sessions SET origin='cube',cube_period_start=? WHERE session_id=?").run(period, sessionId);
      db.query("UPDATE cube_session_state SET session_id=?,period_start=? WHERE singleton=1").run(sessionId, period);
    }
    if (!sessionId) throw new Error("Cube association is missing");
    const entry = admit({ ...input.entry, sessionId, pendingId: input.inputId });
    db.query("INSERT INTO cube_input_receipts VALUES (?,?)").run(input.inputId, sessionId);
    return { status: "accepted", sessionId, entry, replayed: false };
  });
  return {
    getCubeAdmissionFence: () => readState().admission_fence,
    getCurrentCubeSessionId: () => readState().session_id,
    admitCubeInput: (input) => admission.immediate(input),
    getSessionExecutionStatus: status,
    closeCubeSessionExecution: (sessionId, reason) => db.transaction(() => close(sessionId, reason)).immediate(),
    closeCubeExecutions: (reason) =>
      db
        .transaction(() => {
          const rows = db
            .query<{ session_id: string }, []>(
              "SELECT session_id FROM sessions WHERE origin='cube' AND session_id NOT IN (SELECT session_id FROM closed_session_executions)",
            )
            .all();
          for (const row of rows) close(row.session_id, reason);
          invalidate();
          return rows.map((row) => row.session_id);
        })
        .immediate(),
  };
}
