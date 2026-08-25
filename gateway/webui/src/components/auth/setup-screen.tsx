import type { JSX } from "preact";
import { useCallback, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { ActionButton, Field, Plate, Surface } from "../common/foundation.tsx";
import { Notice } from "../common/composites.tsx";

const log = createLogger(["sentient", "webui", "auth", "setup-screen"]);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SetupScreenProps {
  auth: {
    setup(input: { userId: string; displayName: string; pin: string }): Promise<
      | { ok: true; value: { token: string; user: { userId: string; displayName: string; isAdmin: boolean; avatarTint: string } } }
      | { ok: false; error: { status: number; code: string } }
    >;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PIN_PATTERN = /^\d{4}$/;

function generateUserId(): string {
  return `u_${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SetupScreen({ auth }: SetupScreenProps): JSX.Element {
  const [displayName, setDisplayName] = useState("");
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isNameValid = displayName.trim().length > 0;
  const isPinValid = PIN_PATTERN.test(pin);
  const pinsMatch = pin === confirmPin;
  const canSubmit = isNameValid && isPinValid && pinsMatch && !submitting;

  const handleSubmit = useCallback(async (e: Event) => {
    e.preventDefault();
    if (!canSubmit) return;

    const trimmedName = displayName.trim();
    const userId = generateUserId();
    log.debug("setup-submit", { userId });

    setSubmitting(true);
    setError(null);

    const result = await auth.setup({ userId, displayName: trimmedName, pin });

    if (!result.ok) {
      if (result.error.code === "conflict") {
        log.warn("setup-conflict");
        setError("An admin already exists. Reload and use Login.");
      } else if (result.error.code === "network-error") {
        log.warn("setup-network-error");
        setError("Couldn't reach the gateway. Try again.");
      } else {
        log.warn("setup-error", { code: result.error.code });
        setError("Something went wrong. Try again.");
      }
      setSubmitting(false);
      return;
    }

    log.debug("setup-success", { userId: result.value.user.userId });
  }, [canSubmit, displayName, pin, auth]);

  return (
    <Surface className="setup-screen auth-gate">
      <Plate className="setup-screen__card auth-gate__card">
        <h1 class="setup-screen__title">Welcome to Sentient</h1>
        <p class="setup-screen__subtitle">Create the first household profile. This profile will be an admin.</p>
        <form class="setup-screen__form" onSubmit={handleSubmit}>
          <Field
            label="Display name"
            value={displayName}
            onInput={(event) => setDisplayName(event.currentTarget.value)}
            placeholder="Your name"
            disabled={submitting}
            required
          />
          <Field
            label="4-digit PIN"
            type="password"
            inputMode="numeric"
            value={pin}
            onInput={(event) => setPin(event.currentTarget.value.replace(/\D/g, ""))}
            maxLength={4}
            disabled={submitting}
            error={pin.length > 0 && !isPinValid ? "Enter four digits." : undefined}
            required
          />
          <Field
            label="Confirm PIN"
            type="password"
            inputMode="numeric"
            value={confirmPin}
            onInput={(event) => setConfirmPin(event.currentTarget.value.replace(/\D/g, ""))}
            maxLength={4}
            disabled={submitting}
            error={confirmPin.length > 0 && !pinsMatch ? "PINs do not match." : undefined}
            required
          />
          {error && <Notice tone="error">{error}</Notice>}
          <ActionButton type="submit" variant="primary" loading={submitting} disabled={!canSubmit} className="setup-screen__submit">
            Create admin
          </ActionButton>
        </form>
      </Plate>
    </Surface>
  );
}