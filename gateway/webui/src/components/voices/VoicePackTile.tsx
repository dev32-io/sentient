// gateway/webui/src/components/voices/VoicePackTile.tsx
import type { JSX } from "preact";
import { LANGUAGE_DISPLAY } from "@sentient/config";
import type { VoiceSummary } from "../../services/voices-api.ts";
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

export function VoicePackTile(props: VoicePackTileProps): JSX.Element {
  const { pack, isActive } = props;
  const playIcon = props.previewState === "playing" ? "pause" : "play";
  return (
    <div class={["vp-tile", isActive && "on", `vp-${pack.source}`].filter(Boolean).join(" ")}>
      <div class="vp-tile-head">
        <span class="vp-name">{pack.name}</span>
        {pack.language ? (
          <span class="lang-badge" title={LANGUAGE_DISPLAY[pack.language]?.name ?? pack.language}>
            {LANGUAGE_DISPLAY[pack.language]?.flag ?? "🌐"}
          </span>
        ) : null}
        <span class={`vp-badge vp-badge-${pack.source}`}>{pack.source === "builtin" ? "Built-in" : "Yours"}</span>
      </div>
      {pack.description && <div class="vp-desc">{pack.description}</div>}
      {pack.tags.length > 0 && (
        <div class="vp-tags">{pack.tags.map((t) => <span key={t} class="vp-tag">#{t}</span>)}</div>
      )}
      <div class="vp-acts">
        <Btn
          kind="ghost"
          size="sm"
          disabled={props.previewDisabled || props.previewState === "loading"}
          onClick={props.onPlay}
          title={props.previewDisabled ? "Can't preview while speaking" : "Play a sample"}
        >
          <Icon name={props.previewState === "loading" ? "waveform" : playIcon} size={12} />
        </Btn>
        <Btn kind={isActive ? "secondary" : "ghost"} size="sm" disabled={props.busy || isActive} onClick={props.onPick}>
          {isActive ? "Active" : "Pick"}
        </Btn>
        {props.onDelete && (
          <Btn kind="ghost" size="sm" danger disabled={props.busy} onClick={props.onDelete} title="Delete voice">
            <Icon name="trash" size={12} />
          </Btn>
        )}
      </div>
    </div>
  );
}
