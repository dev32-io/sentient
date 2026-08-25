import type { JSX } from "preact";
import { useSystemReadiness } from "../../../hooks/use-system-readiness.ts";
import { StatusChip } from "../../common/status-chip.tsx";

export interface SidebarStatusProps {
  token: string | null;
}

export function SidebarStatus({ token }: SidebarStatusProps): JSX.Element {
  const ready = useSystemReadiness(token !== null);
  const label = ready === null ? "Checking household status" : ready ? "Household services ready" : "Household services need attention";
  return (
    <div class="s-side-foot" data-testid="settings-household-status">
      <StatusChip label={label} indicator={ready === null ? "idle" : ready ? "live" : "off"} />
      <p>Technical details are available in Diagnostics.</p>
    </div>
  );
}
