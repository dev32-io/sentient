import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";
import type { ProfileV1 } from "../../../services/profile-api.js";
import { PaneChrome, SegmentedControl, SettingsCard, SettingsGroup, SettingsRow, ToggleControl } from "../../common/index.ts";

const log = createLogger(["sentient", "webui", "settings", "audio-pane"]);
const CHANNEL_OPTIONS = [{ value: "voice", label: "Voice and chat" }, { value: "text", label: "Text only" }];

export interface AudioPaneProps {
  draft: ProfileV1;
  onDraftAudio: (audio: ProfileV1["audio"]) => void;
}

export function AudioPane({ draft, onDraftAudio }: AudioPaneProps): JSX.Element {
  return (
    <PaneChrome title="Audio" subtitle="Choose how Sentient delivers replies. Changes apply across sessions and devices after you save settings.">
      <SettingsCard title="Reply output" padded={false}>
        <SettingsGroup>
          <SettingsRow label="Speak responses" hint="When off, replies stay silent while text continues to stream to chat.">
            <ToggleControl
              label="Speak responses"
              checked={draft.audio.ttsEnabled}
              onChange={(ttsEnabled) => {
                log.debug("audio.ttsEnabled.change", { ttsEnabled });
                onDraftAudio({ ...draft.audio, ttsEnabled });
              }}
            />
          </SettingsRow>
          <SettingsRow label="Reply channel" hint="Voice plays audio alongside chat. Text suppresses audio entirely.">
            <SegmentedControl
              label="Reply channel"
              value={draft.audio.channel}
              onChange={(value) => {
                const channel = value === "text" ? "text" : "voice";
                log.debug("audio.channel.change", { channel });
                onDraftAudio({ ...draft.audio, channel });
              }}
              options={CHANNEL_OPTIONS}
            />
          </SettingsRow>
        </SettingsGroup>
      </SettingsCard>
    </PaneChrome>
  );
}
