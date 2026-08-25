// gateway/webui/src/components/settings/sidebar/nav-config.ts

export type SidebarKey =
  | "memory"
  | "personalities"
  | "voice"
  | "audio"
  | "model"
  | "tools"
  | "systemPrompt"
  | "advanced"
  | "account"
  | "members"
  | "secrets"
  | "getApp"
  | "diagnostics";

export interface NavItem {
  key: SidebarKey;
  label: string;
  icon: string; // icon name; resolved by sidebar-nav.tsx
}

export interface NavGroup {
  group: "Soul" | "User" | "Admin";
  items: NavItem[];
  /** Offered only to an admin. The panes behind it (Members, Secrets) are the
   *  only two whose API is gated by `require-admin-auth`, so this group is the
   *  whole admin surface — nothing outside it needs the same treatment. */
  adminOnly?: boolean;
}

/** Private on purpose: the ungated table is what the defect was. Every caller
 *  goes through `navGroupsFor` and therefore has to say which role it is
 *  drawing for. */
const ALL_NAV_GROUPS: readonly NavGroup[] = [
  {
    group: "Soul",
    items: [
      { key: "memory", label: "Memory", icon: "brain" },
      { key: "personalities", label: "Personalities", icon: "drama" },
      { key: "voice", label: "Voice", icon: "waveform" },
      { key: "audio", label: "Audio", icon: "volume-2" },
      { key: "model", label: "Model", icon: "cpu" },
      { key: "tools", label: "Tools", icon: "wrench" },
      { key: "systemPrompt", label: "System Prompt", icon: "book-open" },
      { key: "advanced", label: "Advanced", icon: "sliders-h" },
    ],
  },
  {
    group: "User",
    items: [
      { key: "account", label: "Account", icon: "user-circle" },
      { key: "getApp", label: "Get the app", icon: "phone" },
      { key: "diagnostics", label: "Diagnostics", icon: "thermo" },
    ],
  },
  {
    group: "Admin",
    adminOnly: true,
    items: [
      { key: "members", label: "Members", icon: "users-group" },
      { key: "secrets", label: "Secrets", icon: "key" },
    ],
  },
] as const;

/**
 * The groups to DRAW for a viewer whose current record says admin (or not).
 *
 * RENDER DATA, NOT AUTHORITY. `isAdmin` comes off `AuthUser`, which the gateway
 * derives from the user record and re-derives on every login and `/me` — the
 * client is deciding what to show, never what is allowed. Each pane's own calls
 * are still resolved against the record server-side (`require-admin-auth.ts`),
 * so a stale `true` here buys a viewer nothing but a pane full of 403s. What a
 * stale `false` costs is nothing at all, which is the right way round.
 *
 * The group is dropped whole rather than emptied: a heading with no items under
 * it reads as a surface that failed to load.
 */
export function navGroupsFor(isAdmin: boolean): readonly NavGroup[] {
  if (isAdmin) return ALL_NAV_GROUPS;
  return ALL_NAV_GROUPS.filter((group) => group.adminOnly !== true);
}

/** Soul-group tabs — render dirty dot in the sidebar. */
export const SOUL_KEYS: ReadonlySet<SidebarKey> = new Set([
  "memory",
  "personalities",
  "voice",
  "audio",
  "model",
  "tools",
  "systemPrompt",
  "advanced",
]);

/** Tabs that show the docked Apply bar when dirty. Soul tabs (minus Voice)
 *  collect a draft before commit, so the bar batches the save. Secrets are
 *  saved eagerly per row, but the per-user Hermes profile still needs a
 *  re-render to pick up the new key — the apply bar provides that
 *  affordance even though there's nothing to "save" at apply-time. Voice is
 *  excluded: voice-pack ops (record/upload/select/delete) are immediate and
 *  persist server-side on their own — see components/voices/VoicesPanel. */
export const APPLY_BAR_KEYS: ReadonlySet<SidebarKey> = new Set(
  [...SOUL_KEYS].filter((k) => k !== "voice").concat("secrets"),
);
