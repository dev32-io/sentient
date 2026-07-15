// gateway/webui/src/components/voices/VoicePackTile.tsx
import type { JSX } from "preact";
import type { VoiceSummary } from "../../services/voices-api.ts";
import { bucketVoiceTags } from "./fish/fish-bucket.ts";
import { Btn } from "../settings/primitives/btn.tsx";
import { Icon } from "../common/icon.tsx";

export interface VoicePackTileProps {
  pack: VoiceSummary;
  isActive: boolean;
  previewState: "idle" | "loading" | "playing";
  previewDisabled: boolean;
  busy: boolean;
  onPlay: () => void;
  onPick: () => void;
  onDelete?: () => void;
}

/** One Voice-Packs row — same `.voice`/`.v-*` list design as the Fish browse
 *  tile (fish/fish-voice-tile.tsx), so clone-source and local packs read as
 *  one consistent list rather than two different UIs. Click the row to Pick;
 *  play is a left icon button; delete (user packs only) reveals on hover. */
export function VoicePackTile(props: VoicePackTileProps): JSX.Element {
  const { pack, isActive, previewState } = props;
  const buckets = bucketVoiceTags(pack.tags);
  const vibes = buckets.vibes.slice(0, 3);
  const moreCount = buckets.vibes.length - vibes.length;
  const playIcon = previewState === "playing" ? "pause" : previewState === "loading" ? "waveform" : "play";

  return (
    <div
      class={["voice", isActive && "is-sel"].filter(Boolean).join(" ")}
      onClick={props.onPick}
      role="button"
      tabIndex={0}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        props.onPick();
      }}
    >
      <button
        type="button"
        class={["v-play", previewState === "playing" && "v-play-on"].filter(Boolean).join(" ")}
        aria-label={previewState === "playing" ? `Stop preview for ${pack.name}` : `Preview ${pack.name}`}
        aria-pressed={previewState === "playing"}
        disabled={props.previewDisabled || previewState === "loading"}
        onClick={(e) => {
          e.stopPropagation();
          props.onPlay();
        }}
      >
        <Icon name={playIcon} size={14} />
      </button>
      <div class="v-meta">
        <div class="v-name">{pack.name}</div>
        <div class="v-info">
          {pack.language && <span class="v-lang">{pack.language}</span>}
          <span class="v-source">{pack.source === "builtin" ? "Built-in" : "Yours"}</span>
          {buckets.gender && <span class="v-fact">{buckets.gender}</span>}
          {buckets.age && <span class="v-fact">{buckets.age}</span>}
          {pack.description && <span class="v-desc">{pack.description}</span>}
          {isActive && (
            <span class="v-active">
              <Icon name="check" size={9} /> Active
            </span>
          )}
        </div>
        {vibes.length > 0 && (
          <div class="v-tags">
            {vibes.map((t) => (
              <span key={t} class="v-tag">
                {t}
              </span>
            ))}
            {moreCount > 0 && <span class="v-tag-more">+{moreCount}</span>}
          </div>
        )}
      </div>
      {props.onDelete && (
        <div class="v-del">
          <Btn
            kind="ghost"
            size="sm"
            danger
            disabled={props.busy}
            onClick={(e) => {
              e.stopPropagation();
              props.onDelete?.();
            }}
            title="Delete voice"
          >
            <Icon name="trash" size={12} />
          </Btn>
        </div>
      )}
    </div>
  );
}
