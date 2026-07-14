// gateway/webui/src/components/voices/VoiceList.tsx
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { VoiceSummary } from "../../services/voices-api.ts";
import { Btn } from "../settings/primitives/btn.tsx";
import { Modal } from "../settings/primitives/modal.tsx";
import { Icon } from "../common/icon.tsx";

export interface VoiceListProps {
  voices: VoiceSummary[] | null;
  loading: boolean;
  error: string | null;
  /** Currently active voiceId — derives the "active" marker, never stored. */
  activeId: string;
  /** True while a create/delete/set-active op is in flight — disables row actions. */
  busy: boolean;
  onSetActive: (voiceId: string) => void;
  onDelete: (voiceId: string) => void;
}

export function VoiceList({
  voices,
  loading,
  error,
  activeId,
  busy,
  onSetActive,
  onDelete,
}: VoiceListProps): JSX.Element {
  const [confirmId, setConfirmId] = useState<string | null>(null);

  if (error) return <p class="pane-error">{error}</p>;
  if (loading || voices === null) return <div class="pane-skeleton" aria-hidden="true" />;
  if (voices.length === 0) {
    return <div class="empty-pad">No voices yet — record or upload one.</div>;
  }

  const confirmTarget = voices.find((v) => v.voiceId === confirmId) ?? null;

  return (
    <div class="lst">
      {voices.map((v) => (
        <VoiceRow
          key={v.voiceId}
          voice={v}
          isActive={v.voiceId === activeId}
          busy={busy}
          onSetActive={() => onSetActive(v.voiceId)}
          onRequestDelete={() => setConfirmId(v.voiceId)}
        />
      ))}

      {confirmTarget && (
        <Modal
          title={`Delete "${confirmTarget.name}"?`}
          onClose={() => setConfirmId(null)}
          footer={
            <>
              <Btn kind="ghost" size="sm" onClick={() => setConfirmId(null)}>
                Cancel
              </Btn>
              <Btn
                kind="primary"
                size="sm"
                danger
                onClick={() => {
                  onDelete(confirmTarget.voiceId);
                  setConfirmId(null);
                }}
              >
                Delete
              </Btn>
            </>
          }
        >
          <p class="modal-lead">This voice pack will be permanently deleted.</p>
        </Modal>
      )}
    </div>
  );
}

interface VoiceRowProps {
  voice: VoiceSummary;
  isActive: boolean;
  busy: boolean;
  onSetActive: () => void;
  onRequestDelete: () => void;
}

function VoiceRow({ voice, isActive, busy, onSetActive, onRequestDelete }: VoiceRowProps): JSX.Element {
  return (
    <div class={["lst-row", isActive && "on"].filter(Boolean).join(" ")}>
      <div class="lst-row-main">
        <div class="lst-body">
          <div class="lst-title">
            {voice.name}
            {isActive && <span class="tag tag-active">active</span>}
          </div>
          <div class="lst-sub">
            {formatDuration(voice.refDurationMs)} · {formatCreatedAt(voice.createdAt)}
          </div>
        </div>
        <div class="lst-acts">
          {!isActive && (
            <Btn kind="ghost" size="sm" disabled={busy} onClick={onSetActive}>
              Use
            </Btn>
          )}
          <Btn kind="ghost" size="sm" danger disabled={busy} onClick={onRequestDelete} title="Delete voice">
            <Icon name="trash" size={12} />
          </Btn>
        </div>
      </div>
    </div>
  );
}

const MS_PER_SECOND = 1000;

function formatDuration(refDurationMs: number): string {
  return `${(refDurationMs / MS_PER_SECOND).toFixed(1)}s clip`;
}

/** `createdAt` is Unix epoch SECONDS (float) — the TTS service's `time.time()`. */
function formatCreatedAt(createdAtSeconds: number): string {
  const d = new Date(createdAtSeconds * MS_PER_SECOND);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}
