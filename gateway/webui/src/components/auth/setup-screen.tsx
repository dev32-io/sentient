import type { JSX } from "preact";
import { useCallback, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";

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
    log.debug("setup-submit", { userId, displayName: trimmedName });

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
    <div class="setup-screen">
      <div class="setup-screen__card">
        <h1 class="setup-screen__title">Welcome to Sentient</h1>
        <p class="setup-screen__subtitle">
          This is the first account on this device. You'll be the admin.
        </p>
        <form class="setup-screen__form" onSubmit={handleSubmit}>
          <label class="setup-screen__label">
            Display Name
            <input
              type="text"
              class="setup-screen__input"
              value={displayName}
              onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)}
              placeholder="Your name"
              disabled={submitting}
              aria-label="Display name"
            />
          </label>
          <label class="setup-screen__label">
            PIN
            <input
              type="password"
              inputMode="numeric"
              pattern="\d{4}"
              class="setup-screen__input"
              value={pin}
              onInput={(e) => setPin((e.target as HTMLInputElement).value)}
              placeholder="4-digit PIN"
              maxLength={4}
              disabled={submitting}
              aria-label="PIN"
            />
          </label>
          <label class="setup-screen__label">
            Confirm PIN
            <input
              type="password"
              inputMode="numeric"
              pattern="\d{4}"
              class="setup-screen__input"
              value={confirmPin}
              onInput={(e) => setConfirmPin((e.target as HTMLInputElement).value)}
              placeholder="Re-enter PIN"
              maxLength={4}
              disabled={submitting}
              aria-label="Confirm PIN"
            />
          </label>
          {error && <p class="setup-screen__error">{error}</p>}
          <button
            type="submit"
            class="setup-screen__submit"
            disabled={!canSubmit}
          >
            {submitting ? "Creating..." : "Create Admin"}
          </button>
        </form>
      </div>
    </div>
  );
}