import { SurfaceAction } from "../../common/foundation.tsx";
import type { ComponentChildren, JSX } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { Icon, type IconName } from "../../common/icon.tsx";
import { SOUL_KEYS, type SidebarKey, navGroupsFor } from "./nav-config.ts";

export interface LocalNavigationItem<TKey extends string> {
  key: TKey;
  label: string;
  icon: ComponentChildren;
  description?: string;
  dirty?: boolean;
  navigable?: boolean;
}

export interface LocalNavigationGroup<TKey extends string> {
  key: string;
  label?: string;
  items: readonly LocalNavigationItem<TKey>[];
}

export interface LocalNavigationProps<TKey extends string> {
  active: TKey;
  ariaLabel: string;
  groups: readonly LocalNavigationGroup<TKey>[];
  onChange: (key: TKey) => void;
  className?: string;
}

export function LocalNavigation<TKey extends string>({
  active,
  ariaLabel,
  groups,
  onChange,
  className,
}: LocalNavigationProps<TKey>): JSX.Element {
  const navRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;

    const syncCurrentSurface = () => {
      const current = nav.querySelector<HTMLElement>(".s-nav-i[aria-current='page']");
      if (!current) return;
      const navBounds = nav.getBoundingClientRect();
      const currentBounds = current.getBoundingClientRect();
      nav.style.setProperty("--nav-current-top", `${currentBounds.top - navBounds.top}px`);
      nav.style.setProperty("--nav-current-height", `${currentBounds.height}px`);
      nav.dataset.sntReady = "true";
    };

    syncCurrentSurface();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncCurrentSurface);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [active]);

  return (
    <nav
      ref={navRef}
      class={["s-nav", className].filter(Boolean).join(" ")}
      aria-label={ariaLabel}
    >
      <span class="s-nav-current" aria-hidden="true" />
      {groups.map((group) => {
        const headingId = group.label ? `settings-group-${group.key}` : undefined;
        return (
          <section
            key={group.key}
            class="s-nav-group"
            {...(headingId ? { "aria-labelledby": headingId } : {})}
          >
            {group.label && <h2 id={headingId} class="s-nav-h">{group.label}</h2>}
            {group.items.map((item) => (
              <SurfaceAction
                type="button"
                key={item.key}
                class={["s-nav-i", item.description && "s-nav-i--described"].filter(Boolean).join(" ")}
                aria-current={active === item.key ? "page" : undefined}
                aria-label={item.dirty ? `${item.label}, changed` : undefined}
                onClick={() => onChange(item.key)}
                title={item.dirty ? `${item.label}, changed` : item.label}
              >
                <span class="s-nav-icon" aria-hidden="true">{item.icon}</span>
                <span class="s-nav-copy">
                  {item.label}
                  {item.description && <small>{item.description}</small>}
                </span>
                {item.dirty
                  ? <span class="dot-dirty" aria-hidden="true" />
                  : item.navigable
                    ? <Icon name="chevron" size={17} />
                    : null}
              </SurfaceAction>
            ))}
          </section>
        );
      })}
    </nav>
  );
}

export interface SidebarNavProps {
  active: SidebarKey;
  onChange: (key: SidebarKey) => void;
  dirtyKeys: ReadonlySet<SidebarKey>;
  isAdmin: boolean;
}

export function SidebarNav({ active, onChange, dirtyKeys, isAdmin }: SidebarNavProps): JSX.Element {
  const groups: readonly LocalNavigationGroup<SidebarKey>[] = navGroupsFor(isAdmin).map((group) => ({
    key: group.group,
    label: group.group,
    items: group.items.map((item) => ({
      key: item.key,
      label: item.label,
      icon: <Icon name={item.icon as IconName} size={20} />,
      dirty: SOUL_KEYS.has(item.key) && dirtyKeys.has(item.key),
    })),
  }));

  return (
    <LocalNavigation
      active={active}
      ariaLabel="Settings panes"
      groups={groups}
      onChange={onChange}
      className="s-nav--settings"
    />
  );
}
