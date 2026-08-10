// gateway/webui/src/components/settings/sidebar/sidebar-nav.tsx
import type { JSX } from "preact";
import { Icon, type IconName } from "../../common/icon.tsx";
import { SOUL_KEYS, type SidebarKey, navGroupsFor } from "./nav-config.ts";

export interface SidebarNavProps {
  active: SidebarKey;
  onChange: (key: SidebarKey) => void;
  dirtyKeys: ReadonlySet<SidebarKey>;
  /** Whether the signed-in viewer's record says admin — decides whether the
   *  Admin group is drawn. Display only: every pane behind it re-checks the
   *  record server-side on each call. */
  isAdmin: boolean;
}

export function SidebarNav({
  active,
  onChange,
  dirtyKeys,
  isAdmin,
}: SidebarNavProps): JSX.Element {
  return (
    <nav class="s-nav">
      {navGroupsFor(isAdmin).map((g) => (
        <div key={g.group} class="s-nav-group">
          {g.group !== "Soul" && (
            <div class="s-nav-h">{g.group}</div>
          )}
          {g.items.map((it) => (
            <button
              key={it.key}
              type="button"
              class={["s-nav-i", active === it.key && "active"]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onChange(it.key)}
            >
              <Icon name={it.icon as IconName} size={14} />
              <span>{it.label}</span>
              {SOUL_KEYS.has(it.key) && dirtyKeys.has(it.key) && (
                <span class="dot-dirty" />
              )}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}
