// gateway/webui/src/components/settings/panes/qr-link-modal.tsx
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { useAuth } from "../../../hooks/use-auth.tsx";
import { Btn } from "../primitives/btn.tsx";
import { Modal } from "../primitives/modal.tsx";

const log = createLogger(["sentient", "webui", "settings", "qr-link-modal"]);

export interface QrLinkModalProps {
  onClose: () => void;
  onLinked: () => void;
}

const STATUS_POLL_MS = 2000;

export function QrLinkModal({ onClose, onLinked }: QrLinkModalProps): JSX.Element {
  const auth = useAuth();
  const isAuthed = auth.status === "authenticated";
  const token = isAuthed ? auth.token : "";

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<string>("");

  // 1) Initiate link — gateway returns the QR PNG as a data: URL the <img>
  //    below renders directly. signal-cli (shared sidecar) handles the actual
  //    handshake server-side after the phone scans + confirms.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        log.debug("link-initiate");
        const resp = await fetch("/api/v1/devices/signal/link", {
          method: "POST",
          credentials: "include",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const data = (await resp.json()) as {
          qrDataUrl?: string;
          expiresAt?: number;
          error?: string;
        };
        if (cancelled) return;
        if (!resp.ok) {
          const msg = data.error ?? `HTTP ${resp.status}`;
          log.warn("link-initiate-failed", { status: resp.status, error: msg });
          setError(msg);
          return;
        }
        log.debug("link-initiate-ok", { expiresAt: data.expiresAt });
        setQrDataUrl(data.qrDataUrl ?? null);
        setExpiresAt(data.expiresAt ?? null);
      } catch (err) {
        if (!cancelled) {
          log.warn("link-initiate-error", { error: String(err) });
          setError(String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // 2) Poll status until linked or failed
  useEffect(() => {
    if (!qrDataUrl || error) return;
    const handle = setInterval(() => {
      void (async () => {
        try {
          const resp = await fetch("/api/v1/devices/signal/link/status", {
            credentials: "include",
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
          const data = (await resp.json()) as { state: string; error?: string };
          log.debug("status-poll", { state: data.state });
          if (data.state === "linked") {
            clearInterval(handle);
            log.info("link-success");
            onLinked();
          } else if (data.state === "failed") {
            clearInterval(handle);
            const msg = data.error ?? "Linking failed";
            log.warn("link-failed", { error: msg });
            setError(msg);
          }
        } catch (err) {
          log.debug("status-poll-failed", { error: String(err) });
        }
      })();
    }, STATUS_POLL_MS);
    return () => clearInterval(handle);
  }, [qrDataUrl, error, token, onLinked]);

  // 3) Countdown ticker
  useEffect(() => {
    if (!expiresAt) return;
    const handle = setInterval(() => {
      const ms = expiresAt - Date.now();
      if (ms <= 0) {
        setRemaining("expired");
        return;
      }
      const mins = Math.floor(ms / 60_000);
      const secs = Math.floor((ms % 60_000) / 1000);
      setRemaining(`${mins}:${secs.toString().padStart(2, "0")}`);
    }, 500);
    return () => clearInterval(handle);
  }, [expiresAt]);

  function cancel(): void {
    // Close immediately for UI responsiveness, then fire cleanup in background.
    onClose();
    log.debug("link-cancel");
    fetch("/api/v1/devices/signal/link/cancel", {
      method: "POST",
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).catch((err: unknown) => {
      log.warn("cancel-cleanup-failed", { error: String(err) });
    });
  }

  return (
    <Modal
      title="Link your Signal account"
      onClose={cancel}
      footer={
        <Btn kind="ghost" size="sm" onClick={cancel}>
          Cancel
        </Btn>
      }
    >
      <ol class="qr-steps">
        <li>On your phone, open Signal</li>
        <li>Tap your avatar → Linked Devices</li>
        <li>Tap "Link New Device"</li>
        <li>Scan this QR code</li>
      </ol>

      {error && <p class="qr-error">{error}</p>}

      {!error && qrDataUrl && (
        <img
          class="qr-canvas"
          width={240}
          height={240}
          src={qrDataUrl}
          alt="Signal device linking QR code"
        />
      )}

      {!error && !qrDataUrl && <p class="qr-preparing">Preparing link…</p>}

      {!error && qrDataUrl && remaining && <p class="qr-countdown">Code expires in {remaining}</p>}
    </Modal>
  );
}
