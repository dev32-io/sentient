import type { JSX } from "preact";
import { useMemo, useRef, useState } from "preact/hooks";
import type { ApnsCredentialsInput, ApnsCredentialsStatus } from "../../../services/admin-api.ts";
import { ActionButton, ActionRow, Dialog, Field, FilePicker, Notice } from "../../common/index.ts";
import { useSettingsBusyState, useSettingsDraft } from "../navigation-state.ts";
import "./apns-credentials-dialog.css";

const ID_PATTERN = /^[A-Z0-9]{10}$/;
const KEY_FILENAME_PATTERN = /^AuthKey_([A-Z0-9]{10})\.p8$/;
const MAX_REQUEST_BYTES = 16 * 1024;
const DEFINITIVE_SAVE_ERRORS = new Set(["body-too-large", "request-timeout", "schema"]);

type Operation = "idle" | "saving" | "applying-replacement" | "applying-saved";
type Feedback = "save-rejected" | "save-unconfirmed" | "apply-error" | "apply-unconfirmed" | "saved-running" | "running" | null;

export interface ApnsCredentialsDialogProps {
  status: ApnsCredentialsStatus;
  onSave: (input: ApnsCredentialsInput) => Promise<void>;
  onApply: () => Promise<void>;
  onCredentialsSaved: () => void;
  onClose: () => void;
}

function credentialsComplete(status: ApnsCredentialsStatus): boolean {
  return status.has_key && status.has_key_id && status.has_team_id;
}

export function ApnsCredentialsDialog({ status, onSave, onApply, onCredentialsSaved, onClose }: ApnsCredentialsDialogProps): JSX.Element {
  const [, setSettingsBusy] = useSettingsBusyState();
  const [keyId, setKeyId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [privateKey, setPrivateKey] = useState("");
  const [fileError, setFileError] = useState<string>();
  const [readingFile, setReadingFile] = useState(false);
  const [operation, setOperation] = useState<Operation>("idle");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [savedThisSession, setSavedThisSession] = useState(false);
  const keyIdRef = useRef<HTMLInputElement>(null);
  const readRevision = useRef(0);
  const busy = operation !== "idle";
  const hasSavedCredentials = savedThisSession || credentialsComplete(status);
  const keyIdValid = ID_PATTERN.test(keyId);
  const teamIdValid = ID_PATTERN.test(teamId);
  const requestBytes = useMemo(() => new TextEncoder().encode(JSON.stringify({
    private_key_p8: privateKey,
    key_id: keyId,
    team_id: teamId,
  })).byteLength, [keyId, privateKey, teamId]);
  const requestTooLarge = Boolean(privateKey) && requestBytes > MAX_REQUEST_BYTES;
  const canSave = !busy && !readingFile && Boolean(privateKey) && keyIdValid && teamIdValid && !requestTooLarge;

  useSettingsDraft(Boolean(keyId || teamId || selectedFile || privateKey));

  const clearFile = (): void => {
    readRevision.current += 1;
    setSelectedFile(null);
    setPrivateKey("");
    setFileError(undefined);
    setReadingFile(false);
  };

  const close = (): void => {
    if (busy) return;
    clearFile();
    setKeyId("");
    setTeamId("");
    onClose();
  };

  const selectFile = async (file: File): Promise<void> => {
    const revision = ++readRevision.current;
    setFeedback(null);
    setPrivateKey("");
    setFileError(undefined);
    setReadingFile(false);
    if (!file.name.toLocaleLowerCase().endsWith(".p8")) {
      setSelectedFile(null);
      setFileError("Choose an Apple .p8 private key file.");
      return;
    }
    if (file.size > MAX_REQUEST_BYTES) {
      setSelectedFile(null);
      setFileError("File is too large. The entire request must be 16 KiB or less.");
      return;
    }

    setSelectedFile(file);
    setReadingFile(true);
    try {
      const contents = await file.text();
      if (readRevision.current !== revision) return;
      if (!contents) {
        setPrivateKey("");
        setFileError("The selected file is empty. Choose another .p8 file.");
        return;
      }
      setPrivateKey(contents);
      const filenameId = KEY_FILENAME_PATTERN.exec(file.name)?.[1];
      if (filenameId) setKeyId((current) => current || filenameId);
    } catch {
      if (readRevision.current === revision) setFileError("The selected file could not be read. Choose it again to retry.");
    } finally {
      if (readRevision.current === revision) setReadingFile(false);
    }
  };

  const applySaved = async (source: "replacement" | "saved"): Promise<void> => {
    setOperation(source === "replacement" ? "applying-replacement" : "applying-saved");
    setFeedback(null);
    try {
      await onApply();
      setFeedback(source === "replacement" ? "saved-running" : "running");
    } catch (error) {
      setFeedback(error instanceof Error && error.message === "network-error" ? "apply-unconfirmed" : "apply-error");
    }
  };

  const saveAndApply = async (): Promise<void> => {
    if (!canSave) return;
    setSettingsBusy(true);
    setOperation("saving");
    setFeedback(null);
    try {
      await onSave({ private_key_p8: privateKey, key_id: keyId, team_id: teamId });
      clearFile();
      setKeyId("");
      setTeamId("");
      setSavedThisSession(true);
      onCredentialsSaved();
      await applySaved("replacement");
    } catch (error) {
      setFeedback(error instanceof Error && DEFINITIVE_SAVE_ERRORS.has(error.message) ? "save-rejected" : "save-unconfirmed");
    } finally {
      setOperation("idle");
      setSettingsBusy(false);
    }
  };

  const reapplySaved = async (): Promise<void> => {
    if (!hasSavedCredentials || busy) return;
    setSettingsBusy(true);
    try {
      await applySaved("saved");
    } finally {
      setOperation("idle");
      setSettingsBusy(false);
    }
  };

  const replacementLoading = operation === "saving" || operation === "applying-replacement";
  const saveLabel = operation === "saving" ? "Saving…" : operation === "applying-replacement" ? "Applying…" : "Save and apply";
  const displayedFileError = fileError ?? (requestTooLarge ? "The entire request must be 16 KiB or less." : undefined);

  return (
    <Dialog
      title="Apple Push Notifications"
      description="Replace the Key ID, Team ID, and private key together. Closing does not undo credentials already saved."
      width={560}
      initialFocusRef={keyIdRef as { current: HTMLElement | null }}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      onClose={close}
      footer={<ActionRow>
        <ActionButton variant="quiet" disabled={busy} onClick={close}>Cancel</ActionButton>
        {hasSavedCredentials && (
          <ActionButton loading={operation === "applying-saved"} disabled={busy} onClick={() => void reapplySaved()}>
            Apply saved credentials
          </ActionButton>
        )}
        <ActionButton variant="primary" loading={replacementLoading} disabled={!canSave} onClick={() => void saveAndApply()}>{saveLabel}</ActionButton>
      </ActionRow>}
    >
      <div class="apns-credentials-dialog__fields">
        {feedback === "save-rejected" && <Notice tone="error" title="Credential replacement rejected">Server rejected this replacement. Correct the fields or choose a different private key before retrying.</Notice>}
        {feedback === "save-unconfirmed" && <Notice tone="error" title="Credential save could not be confirmed">Persistence may have completed before the failure was reported. Retrying the same replacement is safe. Closing cannot undo credentials that may already have been saved.</Notice>}
        {feedback === "apply-error" && <Notice tone="error" title="Credentials saved, activation failed">Saved credentials remain available. Retry activation without uploading the key again.</Notice>}
        {feedback === "apply-unconfirmed" && <Notice tone="error" title="Activation could not be confirmed">Saved credentials remain available. Transport may have started despite the missing response. Retry activation or close; closing does not stop or undo it.</Notice>}
        {feedback === "saved-running" && <Notice tone="success" title="Credentials saved and transport running">Local push transport is running. This does not confirm Apple acceptance or phone delivery.</Notice>}
        {feedback === "running" && <Notice tone="success" title="Transport running">This does not confirm Apple acceptance or phone delivery.</Notice>}
        {hasSavedCredentials && feedback === null && <p class="apns-credentials-dialog__saved">Complete saved credentials are available to apply without uploading a replacement.</p>}
        {!hasSavedCredentials && (status.has_key || status.has_key_id || status.has_team_id) && <p class="apns-credentials-dialog__saved">Saved credentials are incomplete. Replace all three fields to continue.</p>}
        <div class="apns-credentials-dialog__id-fields">
          <Field
            label="Key ID"
            hint="10 uppercase letters or numbers. A conventional AuthKey_<ID>.p8 filename can fill this field."
            value={keyId}
            required
            maxLength={10}
            pattern="[A-Z0-9]{10}"
            autoComplete="off"
            disabled={busy}
            inputRef={keyIdRef}
            error={keyId.length > 0 && !keyIdValid ? "Use exactly 10 uppercase letters or numbers." : undefined}
            onInput={(event) => { setKeyId(event.currentTarget.value); setFeedback(null); }}
          />
          <Field
            label="Team ID"
            hint="Enter the 10-character Apple Developer Team ID."
            value={teamId}
            required
            maxLength={10}
            pattern="[A-Z0-9]{10}"
            autoComplete="off"
            disabled={busy}
            error={teamId.length > 0 && !teamIdValid ? "Use exactly 10 uppercase letters or numbers." : undefined}
            onInput={(event) => { setTeamId(event.currentTarget.value); setFeedback(null); }}
          />
        </div>
        <FilePicker
          label="Apple private key file"
          accept=".p8"
          selectedFile={selectedFile}
          error={displayedFileError}
          disabled={busy}
          hint={readingFile ? "Reading selected file…" : "Choose or drop the .p8 private key downloaded from Apple."}
          onSelect={(file) => void selectFile(file)}
          onRemove={clearFile}
        />
      </div>
    </Dialog>
  );
}
