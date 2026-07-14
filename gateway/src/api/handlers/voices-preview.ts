import { getLog } from "../../logging/logger.js";
import { pcmToWav } from "../../providers/tts/pcm-to-wav.js";
import { synthesizePreview } from "../../providers/tts/preview-synth-client.js";
import { HTTP_OK, mapVoiceOpError } from "./voices-http.js";
import type { VoicesHandlerDeps } from "./voices.js";

const log = getLog(["sentient", "gateway", "api", "voices", "preview"]);

/**
 * POST /api/v1/voices/:id/preview — live-synthesizes one randomly-picked
 * configured greeting in the target voice and returns it as a WAV clip.
 * Read-only: no profile write, no activation side effect (mirrors the "Play"
 * button in the voice picker — auditioning a voice never changes the
 * caller's active pick).
 */
export async function handleVoicesPreview(
  deps: VoicesHandlerDeps,
  voiceId: string,
  signal: AbortSignal,
): Promise<Response> {
  const greeting = deps.previewGreetings[Math.floor(Math.random() * deps.previewGreetings.length)] ?? "Hello.";
  log.info("preview.request", { voiceId, greetingLen: greeting.length });

  const result = await synthesizePreview(
    {
      url: deps.ttsUrl,
      connectTimeoutMs: deps.connectTimeoutMs,
      opTimeoutMs: deps.previewTimeoutMs,
      ...(deps.socketFactory ? { socketFactory: deps.socketFactory } : {}),
    },
    voiceId,
    greeting,
    signal,
  );
  if (!result.ok) return mapVoiceOpError(result.error);

  const wav = pcmToWav(result.value.pcm, result.value.sampleRate);
  log.info("preview.success", { voiceId, bytes: wav.byteLength });
  return new Response(wav, { status: HTTP_OK, headers: { "content-type": "audio/wav" } });
}
