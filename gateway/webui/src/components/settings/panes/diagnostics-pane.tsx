import type { JSX } from "preact";
import { useServiceVersions, type ServiceVersions } from "../../../hooks/use-service-versions.ts";
import { useSystemReadiness } from "../../../hooks/use-system-readiness.ts";
import { ActionButton, AsyncState, Notice, PaneChrome, SettingsCard, SettingsRow } from "../../common/index.ts";

export interface DiagnosticsPaneProps {
  token: string | null;
}

const COMPONENTS: ReadonlyArray<{ key: keyof Omit<ServiceVersions, "features">; label: string }> = [
  { key: "gateway", label: "Sentient gateway" },
  { key: "hermes", label: "Hermes delegation" },
  { key: "stt_service", label: "Speech recognition service" },
  { key: "tts_service", label: "Speech synthesis service" },
];

function versionLabel(value: string | undefined): string {
  if (!value || value === "unknown") return "Unknown";
  return value.startsWith("v") ? value : `v${value}`;
}

export function DiagnosticsPane({ token }: DiagnosticsPaneProps): JSX.Element {
  const versions = useServiceVersions(token);
  const readiness = useSystemReadiness(token !== null);

  return (
    <PaneChrome
      title="Diagnostics"
      subtitle="Technical status for troubleshooting. These observations do not grant access or guarantee a service is ready."
      className="owned-pane"
    >
      <SettingsCard title="System readiness" subtitle="Reported by the latest system status check.">
        {readiness === null ? (
          <AsyncState state="loading" title="Checking readiness" message="Waiting for an observed status." />
        ) : readiness ? (
          <Notice tone="success" title="Required services reported ready">The latest check observed all required services as ready.</Notice>
        ) : (
          <Notice tone="error" title="Readiness unavailable">
            The latest check did not observe every required service as ready. Check the host services, then try again.
          </Notice>
        )}
      </SettingsCard>

      <SettingsCard title="Component versions" subtitle="Sanitized build information returned by the gateway.">
        {COMPONENTS.map((component) => (
          <SettingsRow key={component.key} label={component.label}>
            <code data-testid={`diagnostics-version-${component.key}`}>{versionLabel(versions?.[component.key])}</code>
          </SettingsRow>
        ))}
      </SettingsCard>

      {readiness === false && (
        <div class="owned-actions">
          <ActionButton variant="quiet" onClick={() => window.location.reload()}>Reload diagnostics</ActionButton>
        </div>
      )}
    </PaneChrome>
  );
}
