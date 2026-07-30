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
  | "getApp";

export interface NavItem {
  key: SidebarKey;
  label: string;
  icon: string; // icon name; resolved by sidebar-nav.tsx
}

export interface NavGroup {
  group: "Soul" | "User" | "Admin";
  items: NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
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
    ],
  },
  {
    group: "Admin",
    items: [
      { key: "members", label: "Members", icon: "users-group" },
      { key: "secrets", label: "Secrets", icon: "key" },
    ],
  },
] as const;

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
 *  saved eagerly per row, but a Hermes restart is still needed to reload the
 *  per-user profile with the new key — the apply bar provides that
 *  affordance even though there's nothing to "save" at apply-time. Voice is
 *  excluded: voice-pack ops (record/upload/select/delete) are immediate and
 *  persist server-side on their own — see components/voices/VoicesPanel. */
export const APPLY_BAR_KEYS: ReadonlySet<SidebarKey> = new Set(
  [...SOUL_KEYS].filter((k) => k !== "voice").concat("secrets"),
);
