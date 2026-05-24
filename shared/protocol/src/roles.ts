import { z } from "zod";

export const USER_ROLES = ["adult", "child", "guest"] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const userRoleSchema = z.enum(USER_ROLES);

export const IMPACT_TIERS = ["read", "write", "confirm", "admin"] as const;
export type ImpactTier = (typeof IMPACT_TIERS)[number];
export const impactTierSchema = z.enum(IMPACT_TIERS);

/** Which impact tiers each role can use */
export const ROLE_PERMISSIONS: Record<UserRole, readonly ImpactTier[]> = {
  adult: ["read", "write", "confirm", "admin"],
  child: ["read", "write"],
  guest: ["read"],
} as const;

export function canExecute(role: UserRole, tier: ImpactTier): boolean {
  return (ROLE_PERMISSIONS[role] as readonly string[]).includes(tier);
}
