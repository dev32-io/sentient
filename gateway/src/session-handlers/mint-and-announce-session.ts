import type { AcpPerProfileConnection } from "../hermes-adapter-client/per-profile-connection.ts";
import type { Log } from "../logging/logger.ts";

/**
 * Inputs for {@link mintAndAnnounceSession}. The gateway is the source of
 * truth for a fresh chain's id: it mints via ACP, stashes the id so the next
 * outbound user.message forces it, and emits `session.created` so the client
 * learns the id (the mobile cache anchor depends on this).
 */
export interface MintAndAnnounceInput {
  readonly acpConn: AcpPerProfileConnection;
  /** Emit a wire frame to the client. */
  readonly send: (frame: Record<string, unknown>) => void;
  /** Stash the minted id so the next user.message forces it onto Hermes. */
  readonly setPendingNewSessionId: (sessionId: string) => void;
  readonly log: Log;
  /** Why the mint fired — `session.new` frame vs gate fresh-chain first message. */
  readonly reason: string;
  /** Correlates with the originating client request, when one exists. */
  readonly requestId?: string;
  /**
   * Optional backstop (ms). When set, a mint that does not settle within the
   * window resolves to null instead of hanging the caller (the gate uses this
   * so a wedged ACP mint aborts the cycle cleanly rather than blocking the
   * first message forever). Omit for the eager `session.new` path, which has
   * no critical-path latency to protect.
   */
  readonly timeoutMs?: number;
}

const TIMEOUT_SENTINEL = Symbol("mint-timeout");

/**
 * Mint a new ACP session, stash it as the pending forced id, and announce it
 * to the client via `session.created`. Returns the minted sessionId, or null
 * on failure / timeout (caller falls through to its own fallback — the
 * `session.new` handler surfaces a `sessions.error`; the gate falls through to
 * the lazy mint in acp-hermes-client). Never throws.
 */
export async function mintAndAnnounceSession(input: MintAndAnnounceInput): Promise<string | null> {
  const { acpConn, send, setPendingNewSessionId, log, reason, requestId, timeoutMs } = input;
  try {
    const result = await raceTimeout(acpConn.newSession({}), timeoutMs);
    if (result === TIMEOUT_SENTINEL) {
      log.warn("mint-session.timeout", { reason, requestId, timeoutMs });
      return null;
    }
    setPendingNewSessionId(result.sessionId);
    log.info("mint-session.minted", { reason, requestId, sessionId: result.sessionId });
    send({ type: "session.created", sessionId: result.sessionId, ts: Date.now() });
    return result.sessionId;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("mint-session.failed", { reason, requestId, error: message });
    return null;
  }
}

async function raceTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T | typeof TIMEOUT_SENTINEL> {
  if (timeoutMs === undefined) return promise;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
