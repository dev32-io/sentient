// gateway/webui/src/components/voices/VoicePackTile.tsx
import type { JSX } from "preact";
import type { VoiceSummary } from "../../services/voices-api.ts";
import { bucketVoiceTags } from "./fish/fish-bucket.ts";
import { Btn } from "../settings/primitives/btn.tsx";
import { Icon } from "../common/icon.tsx";
import { VoiceRow } from "./VoiceRow.tsx";

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

/** One Voice-Packs row — thin mapping onto the shared `VoiceRow` (also used
 *  by the Fish browse tile, fish/fish-voice-tile.tsx), so clone-source and
 *  local packs read as one consistent list rather than two different UIs.
 *  Click the row to Pick; play is a left icon button; delete (user packs
 *  only) overlays on hover. */
export function VoicePackTile(props: VoicePackTileProps): JSX.Element {
  const { pack, isActive, previewState } = props;
  const buckets = bucketVoiceTags(pack.tags);
  const facts = [buckets.gender, buckets.age].filter((f): f is string => f !== null);

  return (
    <VoiceRow
      name={pack.name}
      lang={pack.language || null}
      source={pack.source === "builtin" ? "Built-in" : "Yours"}
      facts={facts}
      description={pack.description}
      tags={buckets.vibes}
      playing={previewState === "playing"}
      playDisabled={props.previewDisabled}
      playLoading={previewState === "loading"}
      selected={isActive}
      selectedMarker={isActive ? <span class="v-active">Active</span> : null}
      trailing={
        props.onDelete ? (
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
        ) : null
      }
      onSelect={props.onPick}
      onPlay={props.onPlay}
    />
  );
}
