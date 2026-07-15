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
    // TODO(Task 8/9, voice-pack-language plan): look up this pack's
    // VoiceSummary.language and pass it here so preview picks a matching
    // greeting. "" is the documented unset default and matches today's
    // pre-language behavior (server picks the English greeting).
    const r = await api.previewVoice(token, voiceId, "");
    if (loadingId.value !== voiceId) return; // superseded by a later play()/stop()
    loadingId.value = null;
    if (!r.ok) {
      log.warn("preview.failed", { voiceId, code: r.error.code });
      onError();
      return;
    }
    url = URL.createObjectURL(r.value);
    const el = new Audio(url); // the element created for THIS play()
    audio = el;
    previewId.value = voiceId;
    el.addEventListener("ended", stop, { once: true });
    el.play().catch((e) => {
      // A superseding play() pauses this element, rejecting its pending
      // play-promise (AbortError). If a newer play() already owns the
      // module-level `audio`, this stale rejection must NOT clear the newer
      // request's loadingId/previewId — otherwise the guard above drops it.
      if (audio !== el) return;
      log.warn("preview.audio-failed", { voiceId, error: String(e) });
      stop();
    });
  }

  return { previewId, loadingId, play, stop };
}
