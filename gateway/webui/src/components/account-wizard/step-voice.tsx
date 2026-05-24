// gateway/webui/src/components/account-wizard/step-voice.tsx
//
// Auth strategy: in "admin" mode the caller passes a catalogToken (adminToken)
// and a standard ProvidersApi. In "first-admin" mode we use a wizard-scoped
// ProvidersApi (mode: "wizard") that hits /api/v1/wizard/providers/voices —
// gated by unlock_verified instead of a bearer token. The VoicePane catalog
// is always shown; the free-form fallback is gone.
import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";
import type { ProfileV1 } from "../../services/profile-api.ts";
import type { ProvidersApi } from "../../services/providers-api.ts";
import { VoicePane } from "../settings/panes/voice-pane.tsx";
import { Btn } from "../settings/primitives/btn.tsx";

const log = createLogger(["sentient", "webui", "account-wizard", "step-voice"]);

export interface StepVoiceProps {
  draft: ProfileV1;
  onDraftVoice: (voice: ProfileV1["voice"]) => void;
  onNext: () => void;
  onBack: () => void;
  /**
   * When present, the voice catalog is fetched using this token (admin mode).
   * When null, the wizard-scoped API is used (first-admin mode).
   */
  catalogToken: string | null;
  providersApi: ProvidersApi;
  onCancel?: () => void;
}

export function StepVoice({
  draft,
  onDraftVoice,
  onNext,
  onBack,
  catalogToken,
  providersApi,
  onCancel,
}: StepVoiceProps): JSX.Element {
  const isValid = draft.voice.id.trim().length > 0;

  log.debug("render", { voiceId: draft.voice.id, hasCatalog: catalogToken !== null });

  return (
    <section class="aw-step aw-step-voice">
      <header class="aw-step-head">
        <h2 class="aw-step__title">Choose a voice</h2>
        <p class="aw-step__sub">Pick the Fish Audio voice your assistant will speak with. You can browse and switch in Settings → Voice anytime.</p>
      </header>

      <VoicePane
        api={providersApi}
        token={catalogToken ?? ""}
        draft={draft}
        savedVoice={null}
        onDraftVoice={onDraftVoice}
        hideHead
        hideSavedTile
      />

      <footer class="aw-footer">
        {onCancel && <Btn kind="ghost" onClick={onCancel}>Cancel</Btn>}
        <span class="aw-footer__spacer" />
        <Btn kind="secondary" onClick={onBack}>Back</Btn>
        <Btn kind="primary" disabled={!isValid} onClick={onNext}>Next</Btn>
      </footer>
    </section>
  );
}
