// gateway/webui/src/components/settings/panes/get-app-pane.tsx
import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { Btn } from "../primitives/btn.tsx";

const log = createLogger(["sentient", "webui", "settings", "get-app-pane"]);
const DOWNLOAD_PATH = "/download";

export function GetAppPane(): JSX.Element {
  const url = `${location.origin}${DOWNLOAD_PATH}`;
  return (
    <>
      <PaneHead title="Get the app" sub="Install Sentient on your phone." />
      <Card title="Mobile apps" sub="Open the download page on your phone, or scan the code.">
        <p class="get-app-desc">
          Android installs the APK directly. iPhone installs over-the-air on
          registered devices (ad-hoc provisioning).
        </p>
        <div class="get-app-actions">
          <Btn
            kind="primary"
            size="sm"
            onClick={() => {
              log.info("open-download-page");
              window.open(DOWNLOAD_PATH, "_blank", "noopener");
            }}
          >
            Open download page
          </Btn>
        </div>
        <div class="get-app-qr">
          <img
            class="get-app-qr-img"
            src="/download/qr.png"
            width={200}
            height={200}
            alt="QR code for download page"
          />
        </div>
        <code class="get-app-url">{url}</code>
      </Card>
    </>
  );
}
