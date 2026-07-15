// gateway/webui/src/components/voices/VoiceRow.tsx
//
// The single `.voice` list-row element shared by the Fish browse tile
// (fish/fish-voice-tile.tsx) and the Voice-Packs tile (VoicePackTile.tsx).
// Both callers map their own data onto these generic props so clone-source
// and local packs render as one consistent row instead of two duplicated
// markups. Presentational only — no data fetching, no service calls.

import type { JSX } from "preact";
import { Icon } from "../common/icon.tsx";

export interface VoiceRowProps {
  name: string;
  /** 2-letter language code shown as a `.v-lang` chip. Omit/null hides it. */
  lang?: string | null;
  /** "Built-in" | "Yours" shown as a `.v-source` chip. Omit/null hides it. */
  source?: string | null;
  /** e.g. ["Male", "Middle-aged"] — rendered as `.v-fact` spans. */
  facts?: string[];
  description?: string;
  /** ALL vibe tags — no +N truncation; the hover marquee (Fix 4) reveals overflow. */
  tags: string[];
  playing: boolean;
  playDisabled?: boolean;
  /** Shows a "waveform" icon instead of play/pause and forces the button disabled. */
  playLoading?: boolean;
  selected: boolean;
  /** Fish passes a check `<Icon>`; the voice-pack tile passes an "Active" chip. */
  selectedMarker?: JSX.Element | null;
  /** Voice-pack tile passes the hover-reveal delete button; Fish passes null. */
  trailing?: JSX.Element | null;
  onSelect: () => void;
  onPlay: () => void;
  onTagClick?: (t: string) => void;
}

export function VoiceRow(props: VoiceRowProps): JSX.Element {
  const {
    name,
    lang = null,
    source = null,
    facts = [],
    description,
    tags,
    playing,
    playDisabled = false,
    playLoading = false,
    selected,
    selectedMarker = null,
    trailing = null,
    onSelect,
    onPlay,
    onTagClick,
  } = props;

  const playIcon = playing ? "pause" : playLoading ? "waveform" : "play";

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
        aria-label={playing ? `Stop preview for ${name}` : `Preview ${name}`}
        aria-pressed={playing}
        disabled={playDisabled || playLoading}
        onClick={(e) => {
          e.stopPropagation();
          onPlay();
        }}
      >
        <Icon name={playIcon} size={14} />
      </button>
      <div class="v-meta">
        <div class="v-name">{name}</div>
        <div class="v-info">
          <div class="v-scroll">
            {lang && <span class="v-lang">{lang}</span>}
            {source && <span class="v-source">{source}</span>}
            {facts.map((f) => (
              <span key={f} class="v-fact">
                {f}
              </span>
            ))}
            {description && <span class="v-desc">{description}</span>}
          </div>
        </div>
        {tags.length > 0 && (
          <div class="v-tags">
            <div class="v-scroll">
              {tags.map((t) =>
                onTagClick ? (
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
                ) : (
                  <span key={t} class="v-tag">
                    {t}
                  </span>
                ),
              )}
            </div>
          </div>
        )}
      </div>
      {selectedMarker}
      {trailing}
    </div>
  );
}
