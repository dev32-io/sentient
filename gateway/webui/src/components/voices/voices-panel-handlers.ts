// gateway/webui/src/components/voices/voices-panel-handlers.ts
import { createLogger } from "@sentient/web-sdk";
import type { UseVoicePreview } from "../../hooks/use-voice-preview.ts";
import type { UseVoices } from "../../hooks/use-voices.ts";
import type { FishApi, FishApiError } from "../../services/fish-api.ts";

const log = createLogger(["sentient", "webui", "voices", "panel"]);

const HTTP_UNPROCESSABLE = 422;
// The TTS service's only pre-pack-build validation reject is a too-short
// reference clip (voice_store.py's `_MIN_REF_SECONDS` check) — its message
// always starts with this literal, so a substring match reliably identifies
// it without depending on the runtime-varying duration numbers it appends.
const CLIP_TOO_SHORT_MARKER = "too short";
const CLIP_TOO_SHORT_MESSAGE = "That sample is too short to clone — try another voice.";

export interface ToastApi {
  show(message: string, tone?: "success" | "error"): void;
}

export interface VoicesPanelHandlersDeps {
  hook: UseVoices;
  preview: UseVoicePreview;
  toast: ToastApi;
  setBusy: (busy: boolean) => void;
  fishApi: FishApi;
  /** Closed over here (rather than threaded through the returned handler's
   *  signature) so `AddVoiceModal`'s `onCloneFromFish` prop matches the
   *  brief's `(fishVoiceId, name, description, tags)` shape exactly. */
  token: string;
}

export interface VoicesPanelHandlers {
  handleCreate(audio: Blob, name: string, description: string, tags: string[]): Promise<boolean>;
  handleCloneFromFish(fishVoiceId: string, name: string, description: string, tags: string[]): Promise<boolean>;
  handleDelete(voiceId: string): Promise<void>;
  handlePick(voiceId: string): Promise<void>;
  /** `disabled` is read at click time from the panel's `previewDisabled`
   *  derivation (assistantSpeaking signal) — the panel owns that read so this
   *  module stays signal-free and easy to reason about. */
  handlePlay(voiceId: string, disabled: boolean): void;
}

/** Imperative create/delete/pick/play handlers for VoicesPanel, extracted so
 *  the component body stays render-only. Mirrors the pre-rewrite VoicesPanel
 *  toast copy verbatim. */
export function createVoicesPanelHandlers(deps: VoicesPanelHandlersDeps): VoicesPanelHandlers {
  const { hook, preview, toast, setBusy, fishApi, token } = deps;

  async function handleCreate(audio: Blob, name: string, description: string, tags: string[]): Promise<boolean> {
    log.debug("create.requested", { audioBytes: audio.size, nameLength: name.length, tagCount: tags.length });
    setBusy(true);
    const r = await hook.createVoice(audio, name, description, tags);
    setBusy(false);
    if (!r.ok) {
      toast.show("Couldn't create voice", "error");
      return false;
    }
    toast.show(
      r.warning === "not-activated" ? "Voice saved, but activation failed — try selecting it below." : "Voice created",
      r.warning ? "error" : "success",
    );
    // A `warning` still means the pack exists server-side — success.
    return true;
  }

  async function handleCloneFromFish(
    fishVoiceId: string,
    name: string,
    description: string,
    tags: string[],
  ): Promise<boolean> {
    log.debug("cloneFromFish.requested", {
      fishVoiceIdLength: fishVoiceId.length,
      nameLength: name.length,
      tagCount: tags.length,
    });
    setBusy(true);
    // TODO(Task 8, voice-pack-language plan): thread the Fish-suggested
    // language once AddVoiceModal/FishClonePanel grow `suggestedLanguage`.
    // "" is the documented unset default and matches today's pre-language behavior.
    const r = await fishApi.cloneFromFish(token, { fishVoiceId, name, description, tags, language: "" });
    setBusy(false);
    if (!r.ok) {
      log.warn("cloneFromFish.failed", { status: r.error.status, code: r.error.code });
      toast.show(mapFishCloneError(r.error), "error");
      return false;
    }
    await hook.load();
    if (r.value.warning === "not-activated") {
      toast.show("Voice saved, but activation failed — try selecting it below.", "error");
    } else {
      hook.activateVoiceLocally(r.value.voiceId);
      toast.show("Voice created", "success");
    }
    // A `warning` still means the pack exists server-side — success.
    return true;
  }

  async function handleDelete(voiceId: string): Promise<void> {
    log.debug("delete.requested", { voiceId });
    setBusy(true);
    const r = await hook.deleteVoice(voiceId);
    setBusy(false);
    if (!r.ok) {
      toast.show("Couldn't delete voice", "error");
      return;
    }
    toast.show(
      r.warning === "profile-not-updated" ? "Voice deleted, but the active pick may be stale." : "Voice deleted",
      r.warning ? "error" : "success",
    );
  }

  async function handlePick(voiceId: string): Promise<void> {
    log.debug("setActive.requested", { voiceId });
    setBusy(true);
    const r = await hook.setActiveVoice(voiceId);
    setBusy(false);
    if (!r.ok) toast.show("Couldn't switch voice", "error");
  }

  function handlePlay(voiceId: string, disabled: boolean): void {
    if (disabled) {
      toast.show("Can't preview while Sentient is speaking", "error");
      return;
    }
    if (preview.previewId.value === voiceId) {
      preview.stop();
      return;
    }
    void preview.play(voiceId);
  }

  return { handleCreate, handleCloneFromFish, handleDelete, handlePick, handlePlay };
}

/** voice-op-failed 422s from the clone route only ever originate from the
 *  TTS service's create() — and its one pre-build validation reject is a
 *  too-short reference clip — so pattern-match the reason for a precise,
 *  actionable message instead of a generic fallback. */
function mapFishCloneError(error: FishApiError): string {
  if (error.status === HTTP_UNPROCESSABLE && error.reason?.includes(CLIP_TOO_SHORT_MARKER)) {
    return CLIP_TOO_SHORT_MESSAGE;
  }
  return "Couldn't clone this voice";
}
