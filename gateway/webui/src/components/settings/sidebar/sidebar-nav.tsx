// gateway/webui/src/components/settings/sidebar/sidebar-nav.tsx
import type { JSX } from "preact";
import { Icon, type IconName } from "../../common/icon.tsx";
import { NAV_GROUPS, SOUL_KEYS, type SidebarKey } from "./nav-config.ts";

export interface SidebarNavProps {
  active: SidebarKey;
  onChange: (key: SidebarKey) => void;
  dirtyKeys: ReadonlySet<SidebarKey>;
}

export function SidebarNav({
  active,
  onChange,
  dirtyKeys,
}: SidebarNavProps): JSX.Element {
  return (
    <nav class="s-nav">
      {NAV_GROUPS.map((g) => (
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
