// gateway/webui/src/components/settings/panes/devices-pane.tsx
import type { JSX } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { useAuth } from "../../../hooks/use-auth.tsx";
import { useToast } from "../../../hooks/use-toast.tsx";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { Btn } from "../primitives/btn.tsx";
import { Modal } from "../primitives/modal.tsx";
import { QrLinkModal } from "./qr-link-modal.tsx";

const log = createLogger(["sentient", "webui", "settings", "devices-pane"]);

interface SignalDeviceState {
  paired: boolean;
  account_masked?: string;
  linked_at?: string;
}

interface DevicesPayload {
  platforms: { signal: SignalDeviceState };
}

export function DevicesPane(): JSX.Element {
  const auth = useAuth();
  const toast = useToast();
  const isAuthed = auth.status === "authenticated";
  const token = isAuthed ? auth.token : "";

  const [signal, setSignal] = useState<SignalDeviceState | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const resp = await fetch("/api/v1/devices", {
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!resp.ok) {
      log.warn("devices-fetch-failed", { status: resp.status });
      return;
    }
    const data = (await resp.json()) as DevicesPayload;
    log.debug("devices-fetch-ok", { paired: data.platforms.signal.paired });
    setSignal(data.platforms.signal);
  }, [token]);

  useEffect(() => {
    if (!isAuthed) return;
    void refresh();
  }, [isAuthed, refresh]);

  async function unlink(): Promise<void> {
    setBusy(true);
    try {
      const resp = await fetch("/api/v1/devices/signal/unlink", {
        method: "POST",
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!resp.ok) {
        log.warn("unlink-failed", { status: resp.status });
        toast.show("Failed to unlink Signal", "error");
        return;
      }
      log.info("unlink-ok");
      toast.show("Signal unlinked");
      setShowUnlinkConfirm(false);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!isAuthed) return <></>;

  return (
    <>
      <PaneHead
        title="Devices"
        sub="External devices and platforms linked to your agent."
      />

      <Card title="Signal" sub="Text-chat via your own Signal account">
        {signal === null ? (
          <div class="pane-skeleton" />
        ) : signal.paired ? (
          <LinkedView
            signal={signal}
            busy={busy}
            onUnlink={() => setShowUnlinkConfirm(true)}
          />
        ) : (
          <UnpairedView busy={busy} onLink={() => setShowQr(true)} />
        )}
      </Card>

      {showQr && (
        <QrLinkModal
          onClose={() => setShowQr(false)}
          onLinked={() => {
            setShowQr(false);
            void refresh();
          }}
        />
      )}

      {showUnlinkConfirm && (
        <Modal
          title="Disconnect Signal?"
          onClose={() => setShowUnlinkConfirm(false)}
          footer={
            <>
              <Btn
                kind="ghost"
                size="sm"
                onClick={() => setShowUnlinkConfirm(false)}
                disabled={busy}
              >
                Cancel
              </Btn>
              <Btn
                kind="primary"
                size="sm"
                danger
                onClick={() => void unlink()}
                disabled={busy}
              >
                Disconnect
              </Btn>
            </>
          }
        >
          <p class="modal-lead">
            This removes Sentient as a linked device from your Signal account.
            Past Signal conversation history will be kept in your Sentient memory.
          </p>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

interface LinkedViewProps {
  signal: SignalDeviceState;
  busy: boolean;
  onUnlink: () => void;
}

function LinkedView({ signal, busy, onUnlink }: LinkedViewProps): JSX.Element {
  return (
    <div class="devices-linked">
      <div class="devices-status-row">
        <span class="devices-dot devices-dot--ok" />
        <span class="devices-status-label">Linked</span>
        {signal.account_masked && (
          <span class="devices-account">{signal.account_masked}</span>
        )}
        {signal.linked_at && (
          <span class="devices-linked-at dim">
            since {new Date(signal.linked_at).toLocaleDateString()}
          </span>
        )}
      </div>

      <div class="devices-howto">
        <p class="devices-howto-label">How to use:</p>
        <ol>
          <li>Open Signal on your phone</li>
          <li>Go to your "Note to Self" thread</li>
          <li>Text your agent like any conversation</li>
        </ol>
      </div>

      <div class="devices-actions">
        <Btn kind="secondary" size="sm" danger onClick={onUnlink} disabled={busy}>
          Unlink
        </Btn>
      </div>
    </div>
  );
}

interface UnpairedViewProps {
  busy: boolean;
  onLink: () => void;
}

function UnpairedView({ busy, onLink }: UnpairedViewProps): JSX.Element {
  return (
    <div class="devices-unpaired">
      <p class="devices-desc">
        Text-chat with your agent from Signal. Uses "Note to Self" mode — links
        your own Signal account, no second number needed.
      </p>
      <div class="devices-actions">
        <Btn kind="primary" size="sm" onClick={onLink} disabled={busy}>
          Link Signal
        </Btn>
      </div>
    </div>
  );
}
