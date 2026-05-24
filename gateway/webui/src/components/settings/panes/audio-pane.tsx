// gateway/webui/src/components/settings/panes/audio-pane.tsx
import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";
import type { ProfileV1 } from "../../../services/profile-api.js";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { Row } from "../primitives/row.tsx";
import { Segmented } from "../primitives/segmented.tsx";
import { Toggle } from "../primitives/toggle.tsx";

const log = createLogger(["sentient", "webui", "settings", "audio-pane"]);

const CHANNEL_OPTIONS = [
  { value: "voice", label: "Voice (audio + chat)" },
  { value: "text", label: "Text only" },
];

export interface AudioPaneProps {
  draft: ProfileV1;
  onDraftAudio: (audio: ProfileV1["audio"]) => void;
}

export function AudioPane({ draft, onDraftAudio }: AudioPaneProps): JSX.Element {
  const handleTtsToggle = () => {
    const next = !draft.audio.ttsEnabled;
    log.debug("audio.ttsEnabled.change", { ttsEnabled: next });
    onDraftAudio({ ...draft.audio, ttsEnabled: next });
  };

  const handleChannelChange = (v: string) => {
    const channel = v === "text" ? "text" : "voice";
    log.debug("audio.channel.change", { channel });
    onDraftAudio({ ...draft.audio, channel });
  };

  return (
    <>
      <PaneHead
        title="Audio"
        sub="How Sentient delivers replies. Both settings persist across sessions and devices, and take effect on the next reply."
      />

      <Card title="Output">
        <Row
          label="Speak responses (TTS)"
          hint="When off, replies are silent — text still streams to chat."
        >
          <Toggle on={draft.audio.ttsEnabled} onChange={handleTtsToggle} />
        </Row>
        <Row
          label="Reply channel"
          hint="Voice plays audio alongside chat. Text suppresses audio entirely."
        >
          <Segmented
            value={draft.audio.channel}
            onChange={handleChannelChange}
            options={CHANNEL_OPTIONS}
          />
        </Row>
      </Card>
    </>
  );
}
