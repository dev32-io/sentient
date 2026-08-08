// The CREDENTIAL FLOOR — the instant before which an account's tokens are dead.
//
// THE TOKEN IDENTIFIES, IT NEVER AUTHORIZES (owner ruling, 2026-08-07), and
// this is the other half of that ruling. The token says who; the record says
// whether the credential is still good, read at the moment of the decision.
// Demote someone and every token they hold stops validating on its very next
// use — no refresh, no re-login, no cache to flush.
//
// IT IS A PORT, injected into `token-service.ts`, so that service stays a
// crypto unit with no user-store dependency (and so a caller cannot construct a
// token service that skips the check by forgetting to wire a store).
//
// NO CACHE HERE, NOT NOW AND NOT LATER. A memoised floor re-creates exactly the
// staleness the ruling exists to close: the window between a revocation and the
// cache's next miss is a window in which a revoked token still authorizes.
// `user-store.ts` reads one small JSON file; if that ever becomes a
// measurable cost the answer is a cheaper store, never a remembered answer.

import { getLog } from "../logging/logger.js";
import type { UserStore } from "./user-store.js";

const log = getLog(["sentient", "gateway", "user-auth", "credential-floor"]);

/**
 * A fresh account's floor: the epoch, i.e. nothing of theirs is revoked.
 *
 * DELIBERATELY NOT `createdAt`. `TokenPayload.issuedAt` is unix SECONDS while
 * the floor is a millisecond instant, and the comparison fails closed on a tie
 * — so a floor at the creation instant refuses the account's OWN first token
 * whenever the sign-in lands in the same second as the record was written,
 * which is exactly what the first-run wizard does (create the admin, then log
 * them straight in). The epoch says the same thing ("no revocation has ever
 * happened") with no boundary to trip over. The migration's default for a
 * record written before this field existed is still `createdAt`, which is safe
 * there: no live token of such a record was minted in its creation second.
 */
export const NEVER_REVOKED = new Date(0).toISOString();

export interface CredentialFloor {
  /** Epoch ms before which this user's tokens are dead. `null` = no such user. */
  validFromMsFor(userId: string): Promise<number | null>;
}

/**
 * Read the floor off the user record, every time.
 *
 * `null` for a user with no record AND for a store that cannot answer — a
 * token naming a user who is not there identifies nobody, so it is an invalid
 * credential rather than a caller with a defaulted floor.
 */
export function createCredentialFloor(users: Pick<UserStore, "get">): CredentialFloor {
  return {
    async validFromMsFor(userId) {
      const r = await users.get(userId);
      if (!r.ok) {
        log.warn("floor.unreadable", {
          userId,
          reason: `the user store could not be read (${r.error}) — refusing rather than defaulting a floor`,
        });
        return null;
      }
      if (r.value === null) {
        log.warn("floor.no-record", { userId, reason: "token names a user with no record" });
        return null;
      }
      // Always a valid instant: `migrateUserRecord` derives one for every row
      // it returns, including the rows it had to repair.
      return Date.parse(r.value.credentialsValidFrom);
    },
  };
}
