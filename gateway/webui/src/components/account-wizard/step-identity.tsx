// gateway/webui/src/components/account-wizard/step-identity.tsx
import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";
import type { DraftAccount } from "./AccountWizard.tsx";
import { Toggle } from "../settings/primitives/toggle.tsx";
import { Btn } from "../settings/primitives/btn.tsx";
import { Field } from "../common/foundation.tsx";

const log = createLogger(["sentient", "webui", "account-wizard", "step-identity"]);

const MAX_DISPLAY_NAME_LEN = 64;
const PIN_MIN_LEN = 4;
const PIN_MAX_LEN = 8;
const PIN_PATTERN = /^\d+$/;

export interface StepIdentityProps {
  draft: DraftAccount;
  onDraft: (patch: Partial<DraftAccount>) => void;
  onNext: () => void;
  lockAdmin: boolean;
  onCancel?: () => void;
}

function validateIdentity(draft: DraftAccount): string | null {
  if (!draft.displayName.trim()) return "Display name is required.";
  if (draft.displayName.length > MAX_DISPLAY_NAME_LEN) return `Display name must be ≤${MAX_DISPLAY_NAME_LEN} characters.`;
  if (!draft.pin) return "PIN is required.";
  if (!PIN_PATTERN.test(draft.pin)) return "PIN must be digits only.";
  if (draft.pin.length < PIN_MIN_LEN || draft.pin.length > PIN_MAX_LEN) {
    return `PIN must be ${PIN_MIN_LEN}–${PIN_MAX_LEN} digits.`;
  }
  if (draft.pin !== draft.pinConfirm) return "PINs do not match.";
  return null;
}

export function StepIdentity({ draft, onDraft, onNext, lockAdmin, onCancel }: StepIdentityProps): JSX.Element {
  const error = validateIdentity(draft);
  const isValid = error === null;

  log.debug("render", { isValid, lockAdmin });

  function handleNext(): void {
    if (!isValid) return;
    onNext();
  }

  return (
    <section class="aw-step aw-step-identity">
      <h2 class="aw-step__title">Create account</h2>
      <div class="aw-fields">
        <Field id="aw-display-name" className="aw-field-group" inputClassName="aw-input" label="Display name" maxLength={MAX_DISPLAY_NAME_LEN} placeholder="Username" value={draft.displayName} onInput={(event) => onDraft({ displayName: event.currentTarget.value })} />
        <Field id="aw-pin" className="aw-field-group" inputClassName="aw-input" label="PIN" hint="4–8 digits" type="password" inputMode="numeric" maxLength={PIN_MAX_LEN} placeholder="Enter PIN" value={draft.pin} onInput={(event) => onDraft({ pin: event.currentTarget.value.replace(/\D/g, "") })} />
        <Field id="aw-pin-confirm" className="aw-field-group" inputClassName="aw-input" label="Confirm PIN" type="password" inputMode="numeric" maxLength={PIN_MAX_LEN} placeholder="Repeat PIN" value={draft.pinConfirm} onInput={(event) => onDraft({ pinConfirm: event.currentTarget.value.replace(/\D/g, "") })} />

        <div class="aw-field-group aw-toggle-row">
          <div class="aw-toggle-label">
            <span class="aw-label">Admin</span>
            {lockAdmin ? (
              <span class="aw-label-hint">Admin (required for first user)</span>
            ) : (
              <span class="aw-label-hint">Can manage users and settings</span>
            )}
          </div>
          <Toggle
            on={draft.isAdmin}
            onChange={() => {
              if (!lockAdmin) onDraft({ isAdmin: !draft.isAdmin });
            }}
            disabled={lockAdmin}
          />
        </div>
      </div>

      <footer class="aw-footer">
        {onCancel && (
          <Btn kind="ghost" onClick={onCancel}>Cancel</Btn>
        )}
        <span class="aw-footer__spacer" />
        <Btn kind="primary" disabled={!isValid} onClick={handleNext}>
          Next
        </Btn>
      </footer>
    </section>
  );
}
