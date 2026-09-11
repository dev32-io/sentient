import type { JSX } from "preact";
import { ActionButton } from "../common/foundation.tsx";
import { Notice } from "../common/composites.tsx";

export interface ConnectionBannerProps {
  onReconnect: () => void;
}

export function ConnectionBanner({ onReconnect }: ConnectionBannerProps): JSX.Element {
  return (
    <div class="connection-lost-banner">
      <Notice
        tone="error"
        title="Connection lost"
        action={<ActionButton variant="quiet" className="connection-lost-banner__btn" onClick={onReconnect}>Reconnect</ActionButton>}
      >{null}</Notice>
    </div>
  );
}
