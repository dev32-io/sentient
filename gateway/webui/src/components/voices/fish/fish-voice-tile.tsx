import type { JSX } from "preact";
import type { FishVoiceEntry } from "../../../services/fish-api.ts";
import { bucketVoiceTags } from "./fish-bucket.ts";
import { Icon } from "../../common/icon.tsx";
import { VoiceRow } from "../VoiceRow.tsx";

export interface VoiceTileProps {
  voice: FishVoiceEntry;
  selected: boolean;
  playing: boolean;
  onSelect: () => void;
  onPreview: () => void;
  onTagClick: (tag: string) => void;
}

/** Thin mapping of one Fish catalog voice onto the shared `VoiceRow`
 *  (also used by the Voice-Packs tile, ../VoicePackTile.tsx). */
export function VoiceTile({
  voice,
  selected,
  playing,
  onSelect,
  onPreview,
  onTagClick,
}: VoiceTileProps): JSX.Element {
  const buckets = bucketVoiceTags(voice.tags);
  const facts = [buckets.gender, buckets.age].filter((f): f is string => f !== null);

  return (
    <VoiceRow
      name={voice.title}
      lang={voice.languages[0] ?? null}
      source={null}
      facts={facts}
      description={voice.description}
      tags={buckets.vibes}
      playing={playing}
      playDisabled={!voice.previewAudioUrl}
      selected={selected}
      selectedMarker={selected ? <Icon name="check" size={11} /> : null}
      trailing={null}
      onSelect={onSelect}
      onPlay={onPreview}
      onTagClick={onTagClick}
    />
  );
}
