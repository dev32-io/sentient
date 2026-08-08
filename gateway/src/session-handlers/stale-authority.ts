// The socket's authority, re-resolved against the record at `session.configure`.
//
// WHY THIS SEAM EXISTS. Credential revocation (credential-revocation.ts)
// enumerates ATTACHMENTS, and a connection has none until it configures. So a
// socket that authenticated and then sat there is invisible to the revoker —
// and the window is not server-bounded, because the CLIENT decides when to send
// `session.configure`. A demoted member who parks an authenticated socket and
// configures later would otherwise survive revocation entirely.
//
// WHAT IT WOULD COST. `handleSessionConfigure` reads `ws.data.principal` with
// no re-check and hands it to `createSessionRuntime`, which mints the session's
// runtime and its `ToolBroker` capability at that principal's role. That
// capability is authority-by-value, baked in at mint — so a stale principal
// reaching that line becomes a frozen pre-demotion grant good for the token's
// entire remaining TTL. `isCredentialExpired` cannot catch it: that predicate
// only compares `tokenExpiresAtMs` against the clock, and the clock is fine.
//
// NO REBIND, AND NOTHING IS MUTATED. `UserPrincipal` stays minted-once and
// frozen; this module never writes to it. The remedy is the same one the
// revoker uses — kill the socket, let the client sign in again, and let the
// next connection mint a fresh principal from the record as it stands. A
// setter here would make the identity anchor mutable and put every holder of a
// derived capability back in doubt.
//
// THE SAME EJECTION AS EVERY OTHER AUTH FAILURE: `auth.error` code `expired`
// then close 1008, through `closeWithAuthError`. Both SDKs already classify
// `expired` as terminal, so this routes to the login screen exactly as the
// revoker's kick does — the client cannot tell them apart, and must not have to.
//
// DETACHING IS NOT THIS MODULE'S JOB, for the same reason it is not the
// revoker's: the connection-close handler (`cleanupSession`, ws-handlers.ts) is
// the one owner of that teardown.

import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import { isRevoked } from "../user-auth/credential-floor.js";
import type { UserStore } from "../user-auth/user-store.js";
import { closeWithAuthError } from "./credential-lifetime.js";
import type { SessionData } from "./ws-helpers.js";

const log = getLog(["sentient", "ws", "stale-authority"]);

/** Same code and same vocabulary as every other credential ejection. */
const STALE_CODE = "expired";

const STALE_MESSAGE = "your account changed — please sign in again";

/**
 * Why a socket's authenticated context no longer matches the record.
 *
 * Three, not one, because they are different incidents in a log even though
 * they take the same remedy: the account is gone, its credentials were revoked,
 * or its role moved without the floor moving with it.
 */
export type StaleAuthorityReason = "no-record" | "credentials-revoked" | "role-diverged";

/**
 * Re-resolve this socket's authority and eject it if it has gone stale.
 *
 * @returns the reason it was refused, or `null` when the socket may proceed.
 *          A caller that gets a reason must return immediately — the socket is
 *          already closed.
 */
export async function refuseStaleAuthority(
  ws: ServerWebSocket<SessionData>,
  users: Pick<UserStore, "get">,
): Promise<StaleAuthorityReason | null> {
  const reason = await findStaleAuthority(ws, users);
  if (reason === null) return null;
  log.warn("authority.stale", {
    connectionId: ws.data.sessionId,
    userId: ws.data.principal?.userId ?? null,
    socketRole: ws.data.principal?.role ?? null,
    reason,
    detail: "this socket authenticated under an authority the record no longer grants — closing so it re-authenticates",
  });
  closeWithAuthError(ws, STALE_CODE, STALE_MESSAGE);
  return reason;
}

/**
 * ONE record read answering BOTH questions, deliberately. Asking the credential
 * floor and the role separately would be two reads of one file with a write
 * possible between them, and the two answers are exactly the pair that must
 * agree.
 *
 * `null` for an unauthenticated socket: it has no authority to be stale, and
 * the auth gate is what governs it.
 */
async function findStaleAuthority(
  ws: ServerWebSocket<SessionData>,
  users: Pick<UserStore, "get">,
): Promise<StaleAuthorityReason | null> {
  const principal = ws.data.principal;
  if (principal === null) return null;

  const stored = await users.get(principal.userId);
  // FAIL CLOSED on an unreadable store as well as a missing row: neither can
  // establish that this socket's authority is still granted.
  if (!stored.ok || stored.value === null) return "no-record";

  const issuedAtMs = ws.data.tokenIssuedAtMs;
  const floorMs = Date.parse(stored.value.credentialsValidFrom);
  if (issuedAtMs !== null && isRevoked(issuedAtMs, floorMs)) return "credentials-revoked";

  // BELT TO THAT BRACES. `setRole` writes the role and the floor in one patch,
  // so a role change always trips the check above; this catches any other write
  // that changes a role without moving the floor, and costs nothing since the
  // record is already in hand.
  if (stored.value.role !== principal.role) return "role-diverged";

  return null;
}
