// gateway/webui/src/components/account-wizard/AccountWizard.tsx
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import type { ProfileV1 } from "../../services/profile-api.ts";
import { createAdminApi, type UserSummary } from "../../services/admin-api.ts";
import { createProvidersApi } from "../../services/providers-api.ts";
import { StepIdentity } from "./step-identity.tsx";
import { StepModel } from "./step-model.tsx";
import { StepVoice } from "./step-voice.tsx";
import { StepReview, buildStagedLabels, STAGE_INTERVAL_MS } from "./step-review.tsx";
import "./account-wizard.css";

const log = createLogger(["sentient", "webui", "account-wizard"]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AccountWizardProps {
  /**
   * "admin"       → POST /api/v1/admin/users (requires admin token)
   * "first-admin" → POST /api/v1/auth/setup (no token needed; sets isAdmin forced true)
   */
  mode: "admin" | "first-admin";
  /** Required when mode === "first-admin". The unlock code from the previous setup step. */
  bootstrapUnlock?: string;
  /** Required when mode === "admin". The caller's admin token. */
  adminToken?: string;
  onComplete: (summary: UserSummary) => void;
  onCancel?: () => void;
  /**
   * When true, suppresses the outer <main> wrapper so the wizard can be
   * rendered inside an existing container (e.g. WizardShell's boxed layout)
   * without double-wrapping.
   */
  nested?: boolean;
}

/** Full wizard draft state. */
export interface DraftAccount {
  displayName: string;
  pin: string;
  pinConfirm: string;
  isAdmin: boolean;
  profile: Omit<ProfileV1, "userId" | "schemaVersion">;
}

// ---------------------------------------------------------------------------
// Step config
// ---------------------------------------------------------------------------

type WizardStep = "identity" | "model" | "voice" | "review";

const STEPS: ReadonlyArray<{ key: WizardStep; label: string }> = [
  { key: "identity", label: "Identity" },
  { key: "model", label: "Model" },
  { key: "voice", label: "Voice" },
  { key: "review", label: "Review" },
];

const STEP_ORDER: WizardStep[] = ["identity", "model", "voice", "review"];

const INITIAL_DRAFT: Omit<DraftAccount, "isAdmin"> = {
  displayName: "",
  pin: "",
  pinConfirm: "",
  profile: {
    model: { provider: "ollama-cloud", id: "" },
    voice: { provider: "local-tts", id: "default" },
    audio: { ttsEnabled: true, channel: "voice" },
    persona: { template: "default", overrides: "" },
    // No `permissions` key at all — a fresh account has never touched a
    // dropdown, so every tool resolves from its role template (see
    // `ProfileV1["tools"]["permissions"]`'s doc comment). Writing `{}` here
    // would instead mean "every server off", which is not what a new
    // account should get.
    tools: {},
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
  },
};

// ---------------------------------------------------------------------------
// Singleton API instances (stable across renders, no effect deps)
// ---------------------------------------------------------------------------

const adminApi = createAdminApi();
// Standard user-scoped API (admin mode — requires bearer token).
const providersApi = createProvidersApi();
// Wizard-scoped API (first-admin mode — no bearer token; gated by unlock_verified).
const wizardProvidersApi = createProvidersApi({ mode: "wizard" });

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AccountWizard({
  mode,
  adminToken,
  onComplete,
  onCancel,
  nested = false,
}: AccountWizardProps): JSX.Element {
  const [step, setStep] = useState<WizardStep>("identity");
  const [draft, setDraft] = useState<DraftAccount>({
    ...INITIAL_DRAFT,
    isAdmin: mode === "first-admin",
  });
  const [busy, setBusy] = useState(false);
  const [stageLabel, setStageLabel] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Spinner label ticker — interval is cleared on unmount and on submit completion.
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Catalog token: in "admin" mode we have adminToken available immediately;
  // in "first-admin" mode there is no token until after the account is created.
  const catalogToken: string | null = mode === "admin" ? (adminToken ?? null) : null;
  // API instance: wizard-scoped in first-admin mode, user-scoped otherwise.
  const activeProvidersApi = mode === "first-admin" ? wizardProvidersApi : providersApi;

  useEffect(() => {
    return () => {
      if (tickerRef.current !== null) clearInterval(tickerRef.current);
    };
  }, []);

  function patchDraft(patch: Partial<DraftAccount>): void {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  function patchProfile(patch: Partial<DraftAccount["profile"]>): void {
    setDraft((prev) => ({ ...prev, profile: { ...prev.profile, ...patch } }));
  }

  function advance(): void {
    const idx = STEP_ORDER.indexOf(step);
    if (idx < STEP_ORDER.length - 1) {
      setStep(STEP_ORDER[idx + 1] as WizardStep);
    }
  }

  function retreat(): void {
    const idx = STEP_ORDER.indexOf(step);
    if (idx > 0) {
      setStep(STEP_ORDER[idx - 1] as WizardStep);
      setSubmitError(null);
    }
  }

  async function handleSubmit(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setSubmitError(null);

    // Start the staged spinner labels.
    const tick = buildStagedLabels();
    setStageLabel(tick());
    tickerRef.current = setInterval(() => setStageLabel(tick()), STAGE_INTERVAL_MS);

    const profileBody = draft.profile;
    const input = {
      displayName: draft.displayName,
      pin: draft.pin,
      isAdmin: draft.isAdmin,
      profile: profileBody,
    };

    log.info("submit", { mode, displayName: draft.displayName });

    try {
      if (mode === "first-admin") {
        const r = await adminApi.bootstrapAdmin(input);
        stopTicker();
        if (!r.ok) {
          setSubmitError(mapError(r.error.status, r.error.code));
          return;
        }
        // Return a synthetic UserSummary from the bootstrap response.
        const u = r.value.user;
        onComplete({
          userId: u.userId,
          displayName: u.displayName,
          isAdmin: u.isAdmin,
          avatarTint: u.avatarTint,
          slotKey: "",
          createdAt: new Date().toISOString(),
        });
        return;
      }

      // mode === "admin"
      if (!adminToken) {
        stopTicker();
        setSubmitError("Admin token is required.");
        return;
      }
      const r = await adminApi.createUser(adminToken, input);
      stopTicker();
      if (!r.ok) {
        setSubmitError(mapError(r.error.status, r.error.code));
        return;
      }
      log.info("submit.success", { userId: r.value.user.userId });
      onComplete(r.value.user);
    } catch (err: unknown) {
      stopTicker();
      log.warn("submit.unexpected-error", { err: String(err) });
      setSubmitError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function stopTicker(): void {
    if (tickerRef.current !== null) {
      clearInterval(tickerRef.current);
      tickerRef.current = null;
    }
  }

  const lockAdmin = mode === "first-admin";

  // Inner content: stepper at top (always), then the current step.
  // The h1 title is intentionally omitted — Modal provides "Add user" in its
  // header bar; WizardShell provides "Welcome to Sentient" in its box header.
  const inner = (
    <>
      <header class="account-wizard__stepper-bar">
        <AccountStepper current={step} />
      </header>

      <div class="account-wizard__step">
        {step === "identity" && (
          <StepIdentity
            draft={draft}
            onDraft={patchDraft}
            onNext={advance}
            lockAdmin={lockAdmin}
            {...(onCancel ? { onCancel } : {})}
          />
        )}
        {step === "model" && (
          <StepModel
            draft={draft.profile as ProfileV1}
            onDraftModel={(model) => patchProfile({ model })}
            onNext={advance}
            onBack={retreat}
            catalogToken={catalogToken}
            providersApi={activeProvidersApi}
            {...(onCancel ? { onCancel } : {})}
          />
        )}
        {step === "voice" && (
          <StepVoice
            draft={draft.profile as ProfileV1}
            onNext={advance}
            onBack={retreat}
            {...(onCancel ? { onCancel } : {})}
          />
        )}
        {step === "review" && (
          <StepReview
            draft={draft}
            busy={busy}
            stageLabel={stageLabel}
            error={submitError}
            onBack={retreat}
            onSubmit={() => void handleSubmit()}
            {...(onCancel ? { onCancel } : {})}
          />
        )}
      </div>
    </>
  );

  // Scope under `settings-v2` so the shared primitives (Btn, Toggle, Card)
  // pick up their styles — those rules are namespaced under that root class.
  //
  // Modal mode (!nested): render without the full-page outer shell — the Modal
  // IS the surrounding box. No min-height, no background.
  // Nested mode: WizardShell provides the box; we suppress our own chrome.
  if (nested) return <div class="settings-v2 account-wizard account-wizard--nested">{inner}</div>;
  return <div class="settings-v2 account-wizard account-wizard--modal">{inner}</div>;
}

// ---------------------------------------------------------------------------
// AccountStepper — local stepper for the 4-step account wizard.
// ---------------------------------------------------------------------------

interface AccountStepperProps {
  current: WizardStep;
}

function AccountStepper({ current }: AccountStepperProps): JSX.Element {
  const idx = STEPS.findIndex((s) => s.key === current);
  return (
    <ol class="wizard-stepper">
      {STEPS.map((s, i) => (
        <li
          class={`wizard-stepper__item ${i === idx ? "is-current" : i < idx ? "is-done" : ""}`}
          key={s.key}
        >
          <span class="wizard-stepper__dot" />
          <span class="wizard-stepper__label">{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Error message mapper
// ---------------------------------------------------------------------------

function mapError(status: number, code: string): string {
  if (status === 422) {
    if (code === "invalid-profile") return "Profile is invalid. Please review your model and voice selections.";
    return "Invalid input. Please check your entries and try again.";
  }
  if (status === 503) return "Couldn't reach your assistant. Please try again.";
  if (status === 409) return "Setup has already been completed. Please log in instead.";
  if (status === 0) return "Network error. Please check your connection and try again.";
  return `Something went wrong (${code}). Please try again.`;
}
