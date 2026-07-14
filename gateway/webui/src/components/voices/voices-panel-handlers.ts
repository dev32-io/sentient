// gateway/webui/src/components/voices/voices-panel-handlers.ts
import { createLogger } from "@sentient/web-sdk";
import type { UseVoicePreview } from "../../hooks/use-voice-preview.ts";
import type { UseVoices } from "../../hooks/use-voices.ts";

const log = createLogger(["sentient", "webui", "voices", "panel"]);

export interface ToastApi {
  show(message: string, tone?: "success" | "error"): void;
}

export interface VoicesPanelHandlersDeps {
  hook: UseVoices;
  preview: UseVoicePreview;
  toast: ToastApi;
  setBusy: (busy: boolean) => void;
}

export interface VoicesPanelHandlers {
  handleCreate(audio: Blob, name: string, description: string, tags: string[]): Promise<boolean>;
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
  const { hook, preview, toast, setBusy } = deps;

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

  return { handleCreate, handleDelete, handlePick, handlePlay };
}
