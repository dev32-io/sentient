// gateway/webui/src/components/settings/primitives/row.tsx
import type { ComponentChildren, JSX } from "preact";

export interface RowProps {
  label: string;
  hint?: string;
  children: ComponentChildren;
  dirty?: boolean;
  vertical?: boolean;
}

export function Row({ label, hint, children, dirty, vertical }: RowProps): JSX.Element {
  const cls = ["row", dirty ? "dirty" : "", vertical ? "v" : ""].filter(Boolean).join(" ");
  return (
    <div class={cls}>
      <div class="row-l">
        <div class="row-label">
          <span>{label}</span>
          {dirty && <span class="dot-dirty" title="Unapplied change" />}
        </div>
        {hint && <p class="row-hint">{hint}</p>}
      </div>
      <div class="row-r">{children}</div>
    </div>
  );
}
