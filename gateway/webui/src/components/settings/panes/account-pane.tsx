// gateway/webui/src/components/settings/panes/account-pane.tsx
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { useAuth } from "../../../hooks/use-auth.tsx";
import { useToast } from "../../../hooks/use-toast.tsx";
import { createAuthApi } from "../../../services/auth-api.js";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { Row } from "../primitives/row.tsx";
import { TextField } from "../primitives/text-field.tsx";
import { Btn } from "../primitives/btn.tsx";
import { Modal } from "../primitives/modal.tsx";
import { PinInput } from "../primitives/pin-input.tsx";
import { WipBadge } from "../primitives/wip-badge.tsx";

const log = createLogger(["sentient", "webui", "settings", "account-pane"]);
const PIN_PATTERN = /^\d{4}$/;

export function AccountPane(): JSX.Element {
  const auth = useAuth();
  const toast = useToast();
  const api = createAuthApi();
  const [name, setName] = useState(auth.status === "authenticated" ? auth.user.displayName : "");
  const [pinOpen, setPinOpen] = useState(false);
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [savingPin, setSavingPin] = useState(false);

  if (auth.status !== "authenticated") return <></>;

  const trimmedName = name.trim();
  const nameUnchanged = trimmedName === auth.user.displayName;

  const handleSaveName = async () => {
    if (nameUnchanged || !trimmedName) return;
    setSavingName(true);
    const r = await api.updateMe(auth.token, { displayName: trimmedName });
    setSavingName(false);
    if (!r.ok) {
      log.warn("update.failed", { code: r.error.code });
      toast.show("Couldn't update display name", "error");
      return;
    }
    auth.updateUser(r.value.user);
    toast.show("Display name updated");
  };

  const canSubmitPin = PIN_PATTERN.test(oldPin) && PIN_PATTERN.test(newPin);

  const handleSavePin = async () => {
    if (!canSubmitPin) return;
    setSavingPin(true);
    setPinError(null);
    const r = await api.changePin(auth.token, { currentPin: oldPin, newPin });
    setSavingPin(false);
    if (!r.ok) {
      log.warn("changePin.failed", { code: r.error.code, status: r.error.status });
      if (r.error.status === 401) setPinError("Current PIN is wrong");
      else if (r.error.status === 422) setPinError("PIN must be 4 digits");
      else setPinError("Something went wrong");
      return;
    }
    toast.show("PIN updated");
    setPinOpen(false);
    setOldPin("");
    setNewPin("");
  };

  const closePinModal = () => {
    setPinOpen(false);
    setOldPin("");
    setNewPin("");
    setPinError(null);
  };

  return (
    <>
      <PaneHead title="Account" sub="Your profile inside this household." />

      <Card title="Identity" sub="How Sentient knows it's you.">
        <Row label="Display name">
          <div class="kv-row grow">
            <TextField
              value={name}
              onChange={(e) => setName((e.target as HTMLInputElement).value)}
              fullWidth
            />
            <Btn
              kind="secondary"
              size="sm"
              disabled={nameUnchanged || !trimmedName || savingName}
              onClick={handleSaveName}
            >
              {savingName ? "Saving…" : "Save"}
            </Btn>
          </div>
        </Row>
        <Row label="Voice print" hint="Used to recognize you when you speak.">
          <WipBadge label="Coming soon" />
        </Row>
      </Card>

      <Card title="Security" sub="Used for destructive actions like unlocking doors or spending money.">
        <Row label="PIN" hint="4 digits. Required for sensitive actions.">
          <Btn kind="secondary" size="sm" onClick={() => setPinOpen(true)}>Change PIN</Btn>
        </Row>
      </Card>

      <Card title="Session" sub="This device only.">
        <Row label="Sign out" hint="Returns you to the login screen on this device.">
          <Btn kind="secondary" size="sm" danger onClick={() => void auth.logout()}>Sign out</Btn>
        </Row>
      </Card>

      {pinOpen && (
        <Modal
          title="Change PIN"
          onClose={closePinModal}
          footer={
            <>
              <Btn kind="ghost" size="sm" onClick={() => setPinOpen(false)} disabled={savingPin}>Cancel</Btn>
              <Btn kind="primary" size="sm" disabled={!canSubmitPin || savingPin} onClick={handleSavePin}>
                {savingPin ? "Saving…" : "Update PIN"}
              </Btn>
            </>
          }
        >
          <p class="modal-lead">Enter your current 4-digit PIN, then choose a new one.</p>
          <div class="modal-fields">
            <label class="mf">
              <span class="mf-l">Current PIN</span>
              <PinInput value={oldPin} onChange={setOldPin} autoFocus />
            </label>
            <label class="mf">
              <span class="mf-l">New PIN</span>
              <PinInput value={newPin} onChange={setNewPin} />
            </label>
            {pinError && <p class="account-section__error">{pinError}</p>}
          </div>
        </Modal>
      )}
    </>
  );
}
