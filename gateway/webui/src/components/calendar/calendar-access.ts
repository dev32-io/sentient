import type { CalendarScope } from "../../services/calendar-api.ts";

/**
 * Presentation capabilities supplied by the authenticated session assembly.
 *
 * The editor deliberately does not accept a role, display name, event count,
 * or facet list as an authorization substitute. Every optional field is
 * treated as unavailable unless it is explicitly true.
 */
export interface CalendarScopeAccessCapabilities {
  readonly create?: boolean;
  readonly update?: boolean;
  readonly edit?: boolean;
  readonly delete?: boolean;
  readonly mutate?: boolean;
  readonly canCreate?: boolean;
  readonly canUpdate?: boolean;
  readonly canEdit?: boolean;
  readonly canDelete?: boolean;
  readonly canMutate?: boolean;
  readonly canWrite?: boolean;
  readonly write?: boolean;
  readonly [key: string]: unknown;
}

export interface CalendarAccessCapabilities {
  readonly canCreate?: boolean;
  readonly canUpdate?: boolean;
  readonly canEdit?: boolean;
  readonly canDelete?: boolean;
  readonly canMutate?: boolean;
  readonly canWrite?: boolean;
  readonly write?: boolean;
  readonly canCreatePrivate?: boolean;
  readonly canCreateHousehold?: boolean;
  readonly canUpdatePrivate?: boolean;
  readonly canUpdateHousehold?: boolean;
  readonly canEditPrivate?: boolean;
  readonly canEditHousehold?: boolean;
  readonly canDeletePrivate?: boolean;
  readonly canDeleteHousehold?: boolean;
  readonly canMutatePrivate?: boolean;
  readonly canMutateHousehold?: boolean;
  readonly canWritePrivate?: boolean;
  readonly canWriteHousehold?: boolean;
  /** Optional nested form accepted from authenticated session projections. */
  readonly private?: CalendarScopeAccessCapabilities;
  readonly household?: CalendarScopeAccessCapabilities;
  readonly scopes?: Partial<Record<CalendarScope, CalendarScopeAccessCapabilities>>;
  /** Forward-compatible capability projections must remain data, not roles. */
  readonly [key: string]: unknown;
}

export type CalendarMutationAction = "create" | "update" | "delete";

function explicitBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function actionNames(action: CalendarMutationAction): readonly string[] {
  switch (action) {
    case "create":
      return ["create", "canCreate"];
    case "update":
      return ["update", "edit", "mutate", "write", "canUpdate", "canEdit", "canMutate", "canWrite"];
    case "delete":
      return ["delete", "mutate", "write", "canDelete", "canMutate", "canWrite"];
  }
}

/**
 * Read only explicit capability booleans. A missing capability is never
 * widened from another user-visible signal and therefore returns false.
 */
export function calendarCapabilityAllows(
  capabilities: CalendarAccessCapabilities | undefined,
  action: CalendarMutationAction,
  scope: CalendarScope,
): boolean {
  if (!capabilities) return false;

  const scopedKeys = actionNames(action).flatMap((name) => [
    name,
    name.startsWith("can") ? name : `can${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`,
  ]);
  const directScopeKeys = scopedKeys.flatMap((name) => [
    `${name}${scope[0]?.toUpperCase() ?? ""}${scope.slice(1)}`,
    `${name}_${scope}`,
  ]);
  const directValues = directScopeKeys
    .map((key) => explicitBoolean(capabilities[key]))
    .filter((value): value is boolean => value !== undefined);
  if (directValues.length > 0) return directValues.every(Boolean);

  const nested = capabilities.scopes?.[scope] ?? capabilities[scope];
  if (nested && typeof nested === "object") {
    const nestedValues = actionNames(action)
      .map((name) => explicitBoolean(nested[name]))
      .filter((value): value is boolean => value !== undefined);
    if (nestedValues.length > 0) return nestedValues.every(Boolean);
  }

  const genericValues = actionNames(action)
    .map((name) => explicitBoolean(capabilities[name]))
    .filter((value): value is boolean => value !== undefined);
  return genericValues.length > 0 && genericValues.every(Boolean);
}

export const canUseCalendarCapability = calendarCapabilityAllows;

/**
 * Project the non-content authorization signal carried by the authenticated
 * session into the editor's narrow capability shape. The calendar route never
 * derives write access from events, facets, counts, or a failed request.
 *
 * A role is safe presentation data supplied by the auth boundary. When a
 * caller supplies an explicit capability projection, it wins; an unknown or
 * absent role remains conservative and produces no writable capability.
 */
export function projectCalendarCapabilities(
  user:
    | {
        readonly role?: unknown;
        readonly isAdmin?: unknown;
        readonly calendarCapabilities?: unknown;
      }
    | null
    | undefined,
): CalendarAccessCapabilities | undefined {
  if (!user) return undefined;

  if (
    user.calendarCapabilities &&
    typeof user.calendarCapabilities === "object" &&
    !Array.isArray(user.calendarCapabilities)
  ) {
    return user.calendarCapabilities as CalendarAccessCapabilities;
  }

  const role = user.role;
  const canWrite = role === "admin" || role === "adult" || role === "child";
  if (role === "admin" || role === "adult" || role === "child" || role === "guest") {
    return {
      canCreate: canWrite,
      canUpdate: canWrite,
      canDelete: canWrite,
      private: { create: canWrite, update: canWrite, delete: canWrite },
      household: { create: canWrite, update: canWrite, delete: canWrite },
    };
  }

  // `isAdmin` is retained only as an explicit legacy auth projection. A
  // false value is not widened into adult/child write access.
  if (user.isAdmin === true) {
    return {
      canCreate: true,
      canUpdate: true,
      canDelete: true,
      private: { create: true, update: true, delete: true },
      household: { create: true, update: true, delete: true },
    };
  }
  return undefined;
}
