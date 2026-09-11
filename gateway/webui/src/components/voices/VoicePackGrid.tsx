// gateway/webui/src/components/voices/VoicePackGrid.tsx
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { VoiceSummary } from "../../services/voices-api.ts";
import { ActionButton, ActionRow, AsyncState, Dialog } from "../common/index.ts";
import { VoicePackTile } from "./VoicePackTile.tsx";

export interface VoicePackGridProps {
  packs: VoiceSummary[];
  loading: boolean;
  error: string | null;
  activeId: string;
  previewId: string | null;
  previewLoadingId: string | null;
  previewDisabled: boolean;
  busy: boolean;
  /** `language` is the pack's `VoiceSummary.language` — threaded through so
   *  the preview plays in the pack's own language. */
  onPlay: (id: string, language: string) => void;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
}

export function VoicePackGrid(props: VoicePackGridProps): JSX.Element {
  const [confirmId, setConfirmId] = useState<string | null>(null);

  if (props.error) return <AsyncState state="error" title="Couldn't load voices" message={props.error} />;
  if (props.loading) return <AsyncState state="loading" title="Loading voices" />;
  if (props.packs.length === 0) {
    return <AsyncState state="empty" title="No voices match" message="Clear filters or add your own voice." />;
  }

  const confirmTarget = props.packs.find((p) => p.voiceId === confirmId) ?? null;

  return (
    <div class="voice-grid">
      {renderTiles(props, setConfirmId)}
      {confirmTarget && (
        <DeleteConfirmModal
          target={confirmTarget}
          onCancel={() => setConfirmId(null)}
          onConfirm={() => {
            props.onDelete(confirmTarget.voiceId);
            setConfirmId(null);
          }}
        />
      )}
    </div>
  );
}

/** One tile per pack — derives `previewState`/`isActive` from grid-level state
 *  and gates `onDelete` to user packs (opens the confirm modal, never deletes
 *  directly). Private helper, co-located per the decorator-pattern rules. */
function renderTiles(props: VoicePackGridProps, setConfirmId: (id: string | null) => void): JSX.Element[] {
  return props.packs.map((pack) => {
    const previewState =
      props.previewLoadingId === pack.voiceId ? "loading" : props.previewId === pack.voiceId ? "playing" : "idle";
    return (
      <VoicePackTile
        key={pack.voiceId}
        pack={pack}
        isActive={props.activeId === pack.voiceId}
        previewState={previewState}
        previewDisabled={props.previewDisabled}
        busy={props.busy}
        onPlay={() => props.onPlay(pack.voiceId, pack.language)}
        onPick={() => props.onPick(pack.voiceId)}
        {...(pack.source === "user" ? { onDelete: () => setConfirmId(pack.voiceId) } : {})}
      />
    );
  });
}

interface DeleteConfirmModalProps {
  target: VoiceSummary;
  onCancel: () => void;
  onConfirm: () => void;
}

function DeleteConfirmModal({ target, onCancel, onConfirm }: DeleteConfirmModalProps): JSX.Element {
  return (
    <Dialog
      title={`Delete "${target.name}"?`}
      description="This voice will be permanently deleted."
      onClose={onCancel}
      footer={<ActionRow><ActionButton variant="quiet" onClick={onCancel}>Cancel</ActionButton><ActionButton variant="destructive" onClick={onConfirm}>Delete</ActionButton></ActionRow>}
    />
  );
}
