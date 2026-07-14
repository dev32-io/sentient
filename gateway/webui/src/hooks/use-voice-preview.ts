// gateway/webui/src/hooks/use-voice-preview.ts
import { type ReadonlySignal, signal } from "@preact/signals";
import { createLogger } from "@sentient/web-sdk";
import { createVoicesApi } from "../services/voices-api.ts";

const log = createLogger(["sentient", "webui", "voices", "preview"]);

export interface UseVoicePreview {
  readonly previewId: ReadonlySignal<string | null>;
  readonly loadingId: ReadonlySignal<string | null>;
  play(voiceId: string): Promise<void>;
  stop(): void;
}

/** Single-flight voice-preview playback: at most one preview audio element
 *  is ever alive. Each `play` stops any prior preview (pause + revoke the
 *  object URL) before starting the new fetch; a `stop()`/superseding `play()`
 *  mid-fetch is detected via the `loadingId` guard so a slow response never
 *  clobbers a newer request's state. */
export function createUseVoicePreview(token: string, onError: () => void): UseVoicePreview {
  const api = createVoicesApi();
  const previewId = signal<string | null>(null);
  const loadingId = signal<string | null>(null);
  let audio: HTMLAudioElement | null = null;
  let url: string | null = null;

  function stop(): void {
    if (audio) {
      audio.pause();
      audio = null;
    }
    if (url) {
      URL.revokeObjectURL(url);
      url = null;
    }
    previewId.value = null;
    loadingId.value = null;
  }

  async function play(voiceId: string): Promise<void> {
    stop();
    loadingId.value = voiceId;
    log.debug("preview.play", { voiceId });
    const r = await api.previewVoice(token, voiceId);
    if (loadingId.value !== voiceId) return; // superseded by a later play()/stop()
    loadingId.value = null;
    if (!r.ok) {
      log.warn("preview.failed", { voiceId, code: r.error.code });
      onError();
      return;
    }
    url = URL.createObjectURL(r.value);
    audio = new Audio(url);
    previewId.value = voiceId;
    audio.addEventListener("ended", stop, { once: true });
    audio.play().catch((e) => {
      log.warn("preview.audio-failed", { voiceId, error: String(e) });
      stop();
    });
  }

  return { previewId, loadingId, play, stop };
}
