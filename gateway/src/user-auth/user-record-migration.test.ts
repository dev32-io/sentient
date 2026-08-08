import { describe, expect, it } from "vitest";
import { migrateUserRecord } from "./user-record-migration.js";

// SECURITY BOUNDARY. `isAdmin: boolean` became `role: UserRole` (plan
// 2026-08-07-tool-permissions task 2b). Every stored record predating that
// carries the boolean and no role, so this function is the only thing standing
// between an existing household and a lockout — or, worse, a silent promotion.
// The two directions it must never get wrong:
//   * an admin must not lose their admin surface, and
//   * a non-admin must never gain one, however mangled the record is.

const LEGACY_BASE = {
  userId: "u_a1b2c3d4",
  displayName: "Kevin",
  pinHash: "$argon2id$fake",
  avatarTint: "terra",
  createdAt: "2026-04-24T00:00:00.000Z",
};

describe("migrateUserRecord", () => {
  it("loads a record stored with isAdmin: true as role admin", () => {
    expect(migrateUserRecord({ ...LEGACY_BASE, isAdmin: true }).role).toBe("admin");
  });

  it("loads a record stored with isAdmin: false as role adult", () => {
    expect(migrateUserRecord({ ...LEGACY_BASE, isAdmin: false }).role).toBe("adult");
  });

  it("drops the legacy isAdmin key so nothing can read it as a second source of truth", () => {
    const migrated = migrateUserRecord({ ...LEGACY_BASE, isAdmin: true });
    expect(Object.hasOwn(migrated, "isAdmin")).toBe(false);
  });

  it("keeps every other field of a legacy record untouched", () => {
    const migrated = migrateUserRecord({ ...LEGACY_BASE, isAdmin: false });
    expect(migrated).toEqual({ ...LEGACY_BASE, role: "adult" });
  });

  it("leaves an already-migrated record alone", () => {
    const modern = { ...LEGACY_BASE, role: "child" as const };
    expect(migrateUserRecord(modern)).toEqual(modern);
  });

  it("defaults a record carrying neither field to adult, never admin", () => {
    expect(migrateUserRecord(LEGACY_BASE).role).toBe("adult");
  });

  it("defaults a record whose role is not a known role to adult, never admin", () => {
    expect(migrateUserRecord({ ...LEGACY_BASE, role: "superadmin" }).role).toBe("adult");
  });

  it("does not read a truthy non-boolean isAdmin as admin", () => {
    expect(migrateUserRecord({ ...LEGACY_BASE, isAdmin: "yes" }).role).toBe("adult");
  });

  it("returns a record for junk rather than throwing, so one bad row cannot lock out the file", () => {
    expect(migrateUserRecord(null).role).toBe("adult");
    expect(migrateUserRecord("nonsense").role).toBe("adult");
  });
});
