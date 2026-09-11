import type { JSX } from "preact";
import { Notice, PaneChrome, SettingsCard, SettingsGroup, SettingsRow } from "../../common/composites.tsx";

export function PushNotificationsPane(): JSX.Element {
  return <PaneChrome title="Push notifications" subtitle="Delivery outside this browser is not available yet.">
    <Notice tone="info" title="Browser push is deferred">Scheduled messages still run, and their message cards remain available from the bell. Disabling push on another device never pauses schedules or hides cards here.</Notice>
    <SettingsCard title="This browser" padded={false}><SettingsGroup>
      <SettingsRow label="Push delivery" hint="Sentient does not register browsers for push notifications in this release."><span class="snt-status-text">Not available</span></SettingsRow>
      <SettingsRow label="Message previews" hint="Preview privacy is managed on supported iOS installations."><span class="snt-status-text">Managed on device</span></SettingsRow>
    </SettingsGroup></SettingsCard>
  </PaneChrome>;
}
