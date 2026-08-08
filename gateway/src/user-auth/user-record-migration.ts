// `isAdmin: boolean` → `role: UserRole`, applied on every read of users.json.
//
// SAME NO-SCHEMA-BUMP IDIOM the profile store uses for `voice.provider:
// "fish-audio"` and `tools.enabled`: the shape on disk is upgraded as it is
// loaded, so an install that predates the change keeps working with no
// operator step and no version field to bump.
//
// IT CANNOT FAIL, and that is the requirement it is written against. users.json
// is the only thing standing between the household and a locked door, so this
// never throws, never rejects a row, and never validates a field it does not
// own. It reads at most two keys and passes everything else through untouched;
// a record whose `avatarTint` is gibberish is still a record that can log in,
// exactly as it was before this function existed (the store has never validated
// that file, deliberately).
//
// IT NEVER PROMOTES. Every ambiguous input — no `isAdmin`, a non-boolean
// `isAdmin`, an unrecognised `role`, a row that is not even an object —
// resolves to `adult`, the default the owner specified. `admin` is only ever
// the result of `isAdmin === true` or an already-stored `role: "admin"`.
// Erring the other way would hand the admin REST surface, and the `admin`
// impact tier with it, to whoever happened to have a malformed row.
//
// The legacy key is DROPPED rather than carried alongside: two fields that can
// disagree about the same fact is the defect class this replaced.
//
// THE SECOND FIELD IT DERIVES is `credentialsValidFrom`, the credential floor
// (plan 2026-08-07-tool-permissions task 2c). An ABSENT one reads as the
// record's `createdAt` — never as `now`, which would log out every account in
// the household the moment the gateway upgraded. Absent means "no revocation
// has ever happened", and `createdAt` says exactly that for a record that
// predates the field.

import { ADMIN_ROLE, USER_ROLES, type UserRole } from "@sentient/protocol";
import { NEVER_REVOKED } from "./credential-floor.js";
import type { UserRecord } from "./types.js";

const DEFAULT_ROLE: UserRole = "adult";

function isKnownRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}

/**
 * True iff `raw` still carries the pre-role shape, i.e. reading it would have
 * to derive a role. Callers use this to log the migration once rather than on
 * every read of an un-rewritten file.
 */
export function isLegacyUserRecord(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return true;
  return !isKnownRole((raw as { role?: unknown }).role);
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * The credential floor for one stored row.
 *
 * A stored value wins — it is the only record a revocation leaves. Absent, it
 * is `createdAt`. Absent AND with an unreadable `createdAt` it is
 * `NEVER_REVOKED`: this function may not lock anyone out over a mangled field
 * it does not own, and a row that has never been revoked has nothing to
 * enforce anyway.
 */
function resolveCredentialFloor(raw: Record<string, unknown>): string {
  if (isInstant(raw.credentialsValidFrom)) return raw.credentialsValidFrom;
  return isInstant(raw.createdAt) ? raw.createdAt : NEVER_REVOKED;
}

/** Normalize one stored row into the current `UserRecord` shape. Total: every
 *  input produces a record, and the role is never widened by accident. */
export function migrateUserRecord(raw: unknown): UserRecord {
  if (typeof raw !== "object" || raw === null) {
    return { role: DEFAULT_ROLE, credentialsValidFrom: NEVER_REVOKED } as UserRecord;
  }
  const { isAdmin, role, ...rest } = raw as Record<string, unknown>;
  const credentialsValidFrom = resolveCredentialFloor(raw as Record<string, unknown>);
  if (isKnownRole(role)) {
    return { ...rest, role, credentialsValidFrom } as UserRecord;
  }
  return { ...rest, role: isAdmin === true ? ADMIN_ROLE : DEFAULT_ROLE, credentialsValidFrom } as UserRecord;
}
