// gateway/webui/src/components/settings/primitives/pane-head.tsx
import type { JSX } from "preact";

export interface PaneHeadProps {
  title: string;
  sub?: string;
  action?: JSX.Element;
}

export function PaneHead({ title, sub, action }: PaneHeadProps): JSX.Element {
  return (
    <div class="pane-head">
      <div>
        <h2>{title}</h2>
        {sub && <p class="pane-sub">{sub}</p>}
      </div>
      {action && <div class="pane-action">{action}</div>}
    </div>
  );
}
