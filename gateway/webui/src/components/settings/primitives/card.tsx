// gateway/webui/src/components/settings/primitives/card.tsx
import type { ComponentChildren, JSX } from "preact";

export interface CardProps {
  title?: string;
  sub?: string;
  action?: JSX.Element;
  children: ComponentChildren;
  padding?: boolean;
}

export function Card({ title, sub, action, children, padding = true }: CardProps): JSX.Element {
  const hasHeader = title || sub || action;
  return (
    <section class="sc-card">
      {hasHeader && (
        <header class="sc-h">
          <div>
            {title && <h3 class="sc-title">{title}</h3>}
            {sub && <p class="sc-sub">{sub}</p>}
          </div>
          {action && <div class="sc-act">{action}</div>}
        </header>
      )}
      <div class={["sc-body", padding ? "" : "flush"].filter(Boolean).join(" ")}>{children}</div>
    </section>
  );
}
