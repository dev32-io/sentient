import type { JSX } from "preact";
import { ActionButton } from "../../common/foundation.tsx";
import { Icon, type IconName } from "../../common/icon.tsx";
import { SOUL_KEYS, type SidebarKey, navGroupsFor } from "./nav-config.ts";

export interface SidebarNavProps {
  active: SidebarKey;
  onChange: (key: SidebarKey) => void;
  dirtyKeys: ReadonlySet<SidebarKey>;
  isAdmin: boolean;
}

export function SidebarNav({ active, onChange, dirtyKeys, isAdmin }: SidebarNavProps): JSX.Element {
  return (
    <nav class="s-nav" aria-label="Settings panes">
      {navGroupsFor(isAdmin).map((group) => (
        <section key={group.group} class="s-nav-group" aria-labelledby={`settings-group-${group.group}`}>
          <h2 id={`settings-group-${group.group}`} class="s-nav-h">{group.group}</h2>
          {group.items.map((item) => {
            const dirty = SOUL_KEYS.has(item.key) && dirtyKeys.has(item.key);
            return (
              <ActionButton
                key={item.key}
                variant="quiet"
                className={["s-nav-i", active === item.key && "active"].filter(Boolean).join(" ")}
                onClick={() => onChange(item.key)}
                title={dirty ? `${item.label}, changed` : item.label}
              >
                <Icon name={item.icon as IconName} size={14} />
                <span>{item.label}</span>
                {dirty && <span class="dot-dirty" aria-label="Changed" />}
              </ActionButton>
            );
          })}
        </section>
      ))}
    </nav>
  );
}
