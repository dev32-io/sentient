import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";
import { ActionButton, Notice, PaneChrome, SettingsCard } from "../../common/index.ts";

const log = createLogger(["sentient", "webui", "settings", "get-app-pane"]);
const DOWNLOAD_PATH = "/download";

export function GetAppPane(): JSX.Element {
  const url = `${location.origin}${DOWNLOAD_PATH}`;
  return (
    <PaneChrome title="Get the app" subtitle="Install Sentient on your phone." className="owned-pane">
      <SettingsCard title="Mobile apps" subtitle="Open the download page on your phone, or scan the code.">
        <Notice>Android downloads directly. iPhone installation is available only for registered devices.</Notice>
        <div class="owned-actions">
          <ActionButton variant="primary" onClick={() => { log.info("open-download-page"); window.open(DOWNLOAD_PATH, "_blank", "noopener"); }}>Open download page</ActionButton>
          <span class="snt-kicker" aria-disabled="true">App store release coming soon</span>
        </div>
        <figure class="owned-download-code">
          <img src="/download/qr.png" width={200} height={200} alt="QR code for download page" />
          <figcaption><code>{url}</code></figcaption>
        </figure>
      </SettingsCard>
    </PaneChrome>
  );
}
