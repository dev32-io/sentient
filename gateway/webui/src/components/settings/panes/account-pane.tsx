import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { useAuth } from "../../../hooks/use-auth.tsx";
import { useToast } from "../../../hooks/use-toast.tsx";
import { createAuthApi } from "../../../services/auth-api.ts";
import {
  ActionButton,
  ActionRow,
  Dialog,
  Field,
  PaneChrome,
  PinEntry,
  SettingsCard,
  SettingsRow,
} from "../../common/index.ts";

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
  const [pinError, setPinError] = useState<string | undefined>();
  const [savingName, setSavingName] = useState(false);
  const [savingPin, setSavingPin] = useState(false);

  if (auth.status !== "authenticated") return <></>;

  const trimmedName = name.trim();
  const nameUnchanged = trimmedName === auth.user.displayName;
  const canSubmitPin = PIN_PATTERN.test(oldPin) && PIN_PATTERN.test(newPin);

  const handleSaveName = async () => {
    if (nameUnchanged || !trimmedName) return;
    setSavingName(true);
    const result = await api.updateMe(auth.token, { displayName: trimmedName });
    setSavingName(false);
    if (!result.ok) {
      log.warn("update.failed", { code: result.error.code });
      toast.show("Couldn't update display name", "error");
      return;
    }
    auth.updateUser(result.value.user);
    toast.show("Display name updated");
  };

  const closePinDialog = () => {
    setPinOpen(false);
    setOldPin("");
    setNewPin("");
    setPinError(undefined);
  };

  const handleSavePin = async () => {
    if (!canSubmitPin) return;
    setSavingPin(true);
    setPinError(undefined);
    const result = await api.changePin(auth.token, { currentPin: oldPin, newPin });
    setSavingPin(false);
    if (!result.ok) {
      log.warn("changePin.failed", { code: result.error.code, status: result.error.status });
      if (result.error.status === 401) setPinError("Current PIN is wrong");
      else if (result.error.status === 422) setPinError("PIN must be 4 digits");
      else setPinError("Something went wrong. Try again.");
      return;
    }
    toast.show("PIN updated");
    closePinDialog();
  };

  return (
    <PaneChrome title="Account" subtitle="Your profile inside this household." className="owned-pane">
      <SettingsCard title="Identity" subtitle="How Sentient knows it's you.">
        <SettingsRow label="Display name">
          <div class="owned-inline-field">
            <Field ariaLabel="Display name" value={name} onInput={(event) => setName(event.currentTarget.value)} />
            <ActionButton loading={savingName} disabled={nameUnchanged || !trimmedName} onClick={() => void handleSaveName()}>Save</ActionButton>
          </div>
        </SettingsRow>
        <SettingsRow label="Voice print" hint="Used to recognize you when you speak.">
          <span class="snt-kicker" aria-disabled="true">Coming soon</span>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="Security" subtitle="Used for sensitive household actions.">
        <SettingsRow label="PIN" hint="Four digits, required for sensitive actions.">
          <ActionButton onClick={() => setPinOpen(true)}>Change PIN</ActionButton>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="Session" subtitle="This device only.">
        <SettingsRow label="Sign out" hint="Returns you to the login screen on this device.">
          <ActionButton variant="destructive" onClick={() => void auth.logout()}>Sign out</ActionButton>
        </SettingsRow>
      </SettingsCard>

      {pinOpen && (
        <Dialog
          title="Change PIN"
          description="Enter your current four-digit PIN, then choose a new one."
          onClose={closePinDialog}
          footer={
            <ActionRow>
              <ActionButton variant="quiet" disabled={savingPin} onClick={closePinDialog}>Cancel</ActionButton>
              <ActionButton variant="primary" loading={savingPin} disabled={!canSubmitPin} onClick={() => void handleSavePin()}>Update PIN</ActionButton>
            </ActionRow>
          }
        >
          <div class="owned-fields">
            <PinEntry label="Current PIN" value={oldPin} onChange={setOldPin} autoFocus error={pinError} />
            <PinEntry label="New PIN" value={newPin} onChange={setNewPin} />
          </div>
        </Dialog>
      )}
    </PaneChrome>
  );
}
