// gateway/webui/src/components/settings/sidebar/sidebar-status.tsx
import type { JSX } from "preact";
import { useServiceVersions } from "../../../hooks/use-service-versions.ts";

export interface SidebarStatusProps {
  token: string | null;
}

function fmt(raw: string): string {
  if (!raw || raw === "unknown") return "—";
  return raw.startsWith("v") ? raw : `v${raw}`;
}

export function SidebarStatus({ token }: SidebarStatusProps): JSX.Element {
  const v = useServiceVersions(token);
  return (
    <div class="s-side-foot">
      <div class="s-status">
        <span class="ok-dot" /> All services online
      </div>
      <ul class="s-side-meta">
        <li><span>Sentient</span> <code>{v ? fmt(v.gateway) : "…"}</code></li>
        <li><span>Hermes</span> <code>{v ? fmt(v.hermes) : "…"}</code></li>
        <li><span>STT</span> <code>{v ? fmt(v.stt_service) : "…"}</code></li>
      </ul>
    </div>
  );
}
