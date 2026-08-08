import { z } from "zod";

/**
 * Every role a user record may carry. `admin` is a ROLE, not a boolean flag
 * beside one (owner ruling, plan 2026-08-07-tool-permissions task 2b): the
 * household's operator is simply the person whose role reaches the `admin`
 * impact tier, so "who may run this tool" and "who may administer the box" are
 * one vocabulary instead of two that must be kept in agreement.
 *
 * Ordered most- to least-privileged. Nothing depends on the order for a
 * decision — `canExecute` reads the explicit table below — but it keeps the
 * list readable and makes an accidental omission from `ROLE_PERMISSIONS` a
 * compile error rather than a silent gap.
 */
export const USER_ROLES = ["admin", "adult", "child", "guest"] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const userRoleSchema = z.enum(USER_ROLES);

export const IMPACT_TIERS = ["read", "write", "confirm", "admin"] as const;
export type ImpactTier = (typeof IMPACT_TIERS)[number];
export const impactTierSchema = z.enum(IMPACT_TIERS);

/**
 * Which impact tiers each role can use.
 *
 * `admin` is the ONLY role that reaches the `admin` tier — that is the whole
 * point of adding it. `config.yaml#mcp_catalog`'s restart / backup / addon
 * management tools land there, and an ordinary household adult must not get
 * them just for being an adult (which is what `adult: [..., "admin"]` meant
 * before this role existed).
 *
 * Every role reaches `read`. A locked-out account is a worse failure than an
 * over-permissive one here: the assistant is unusable without it.
 */
export const ROLE_PERMISSIONS: Record<UserRole, readonly ImpactTier[]> = {
  admin: ["read", "write", "confirm", "admin"],
  adult: ["read", "write", "confirm"],
  child: ["read", "write"],
  guest: ["read"],
} as const;

/**
 * The household operator's role, named once.
 *
 * Six files were about to spell this `"admin"` inline or keep a local copy of
 * this constant, and they are all asserting the SAME fact — "the operator role
 * is this one" — not six local policies. One name, one import, so a rename or
 * a split (`owner`/`admin`, say) is a compile error at every site rather than
 * a grep.
 */
export const ADMIN_ROLE: UserRole = "admin";

/**
 * The role an account gets when nothing says otherwise, named once for the
 * same reason `ADMIN_ROLE` is.
 *
 * Four places already needed this fact — the record migration, the auth
 * service, the user provisioner, and now the admin create route, which has to
 * seed a new member's permission table for the role that route is ABOUT to
 * store. Four private copies of `"adult"` are four chances for the stored role
 * and the seeded table to disagree about the same account, which is a
 * disagreement nothing downstream can detect.
 */
export const DEFAULT_ROLE: UserRole = "adult";

export function canExecute(role: UserRole, tier: ImpactTier): boolean {
  return (ROLE_PERMISSIONS[role] as readonly string[]).includes(tier);
}
