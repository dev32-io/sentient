import type { JSX } from "preact";
import type { FishVoiceEntry } from "../../../services/fish-api.ts";
import { bucketVoiceTags } from "./fish-bucket.ts";
import { Icon } from "../../common/icon.tsx";

export interface VoiceTileProps {
  voice: FishVoiceEntry;
  selected: boolean;
  playing: boolean;
  onSelect: () => void;
  onPreview: () => void;
  onTagClick: (tag: string) => void;
}

export function VoiceTile({
  voice,
  selected,
  playing,
  onSelect,
  onPreview,
  onTagClick,
}: VoiceTileProps): JSX.Element {
  const lang = voice.languages[0] ?? null;
  const buckets = bucketVoiceTags(voice.tags);
  const vibes = buckets.vibes.slice(0, 3);
  const moreCount = buckets.vibes.length - vibes.length;

  return (
    <div
      class={["voice", selected && "is-sel"].filter(Boolean).join(" ")}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onSelect();
      }}
    >
      <button
        type="button"
        class={["v-play", playing && "v-play-on"].filter(Boolean).join(" ")}
        aria-label={playing ? `Stop preview for ${voice.title}` : `Preview ${voice.title}`}
        aria-pressed={playing}
        disabled={!voice.previewAudioUrl}
        onClick={(e) => {
          e.stopPropagation();
          onPreview();
        }}
      >
        <Icon name={playing ? "pause" : "play"} size={14} />
      </button>
      <div class="v-meta">
        <div class="v-name">{voice.title}</div>
        <div class="v-info">
          {lang && <span class="v-lang">{lang}</span>}
          {buckets.gender && <span class="v-fact">{buckets.gender}</span>}
          {buckets.age && <span class="v-fact">{buckets.age}</span>}
          {voice.description && <span class="v-desc">{voice.description}</span>}
        </div>
        {vibes.length > 0 && (
          <div class="v-tags">
            {vibes.map((t) => (
              <button
                key={t}
                type="button"
                class="v-tag"
                onClick={(e) => {
                  e.stopPropagation();
                  onTagClick(t);
                }}
              >
                {t}
              </button>
            ))}
            {moreCount > 0 && <span class="v-tag-more">+{moreCount}</span>}
          </div>
        )}
      </div>
      {selected && (
        <div class="v-check">
          <Icon name="check" size={11} />
        </div>
      )}
    </div>
  );
}
