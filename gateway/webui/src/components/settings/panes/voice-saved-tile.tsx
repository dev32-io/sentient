// gateway/webui/src/components/settings/panes/voice-saved-tile.tsx
//
// "Currently using" tile rendered into the search Card's action slot. Mirrors
// the VoiceTile DOM (.voice + .v-play + .v-meta) so it looks like the grid
// tiles below — distinguished only by an orange-tinted bg via .voice-saved.
// When the saved voice ID isn't in the cached top-page list, fetches it on
// demand from Fish Audio via /api/v1/providers/voices/:id.
import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import type { ProvidersApi, VoiceEntry } from "../../../services/providers-api.ts";
import type { ProfileV1 } from "../../../services/profile-api.js";
import { Icon } from "../../common/icon.tsx";
import { bucketVoiceTags } from "./voice-bucket.ts";

const log = createLogger(["sentient", "webui", "settings", "voice-saved-tile"]);

export interface VoiceSavedTileProps {
  api: ProvidersApi;
  token: string;
  saved: ProfileV1["voice"] | null;
  cached: VoiceEntry[];
  playingId: string | null;
  onPreview: (voice: VoiceEntry) => void;
}

type FetchState = "idle" | "loading" | "error";

export function VoiceSavedTile({
  api,
  token,
  saved,
  cached,
  playingId,
  onPreview,
}: VoiceSavedTileProps): JSX.Element {
  const cachedMatch = useMemo(() => {
    if (!saved || saved.id === "default") return null;
    return cached.find((v) => v.id === saved.id) ?? null;
  }, [cached, saved]);

  const [fetched, setFetched] = useState<VoiceEntry | null>(null);
  const [fetchState, setFetchState] = useState<FetchState>("idle");

  useEffect(() => {
    if (!saved || saved.id === "default") {
      setFetched(null);
      setFetchState("idle");
      return;
    }
    if (cachedMatch) {
      setFetched(null);
      setFetchState("idle");
      return;
    }
    setFetchState("loading");
    let cancelled = false;
    void (async () => {
      const r = await api.getVoice(token, saved.id);
      if (cancelled) return;
      if (r.ok) {
        setFetched(r.value.voice);
        setFetchState("idle");
      } else {
        log.warn("getVoice.failed", { id: saved.id, code: r.error.code });
        setFetched(null);
        setFetchState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, token, saved, cachedMatch]);

  if (!saved || saved.id === "default") {
    return <div class="voice voice-saved voice-saved-empty">No voice selected</div>;
  }

  const voice = cachedMatch ?? fetched;

  if (fetchState === "loading" && !voice) {
    return (
      <div class="voice voice-saved voice-saved-loading">
        <span class="spin" aria-hidden="true" />
        <span>Loading voice…</span>
      </div>
    );
  }

  if (voice) {
    const lang = voice.languages[0] ?? null;
    const buckets = bucketVoiceTags(voice.tags);
    const playing = playingId === voice.id;
    return (
      <div class="voice voice-saved">
        <button
          type="button"
          class={["v-play", playing && "v-play-on"].filter(Boolean).join(" ")}
          aria-label={playing ? `Stop preview for ${voice.title}` : `Preview ${voice.title}`}
          aria-pressed={playing}
          disabled={!voice.previewAudioUrl}
          onClick={(e) => {
            e.stopPropagation();
            onPreview(voice);
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
          </div>
        </div>
      </div>
    );
  }

  const short = saved.id.length > 12 ? `${saved.id.slice(0, 6)}…${saved.id.slice(-4)}` : saved.id;
  return (
    <div class="voice voice-saved voice-saved-unknown">
      custom voice (<code>{short}</code>)
    </div>
  );
}
