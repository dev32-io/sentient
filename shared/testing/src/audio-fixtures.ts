const BYTES_PER_SAMPLE = 2; // PCM16 = 2 bytes per sample

export function createSilentPCM16Frame(durationMs: number, sampleRate = 16000): Uint8Array {
  const sampleCount = Math.floor((sampleRate * durationMs) / 1000);
  return new Uint8Array(sampleCount * BYTES_PER_SAMPLE);
}

export function createSineWavePCM16Frame(durationMs: number, frequencyHz = 440, sampleRate = 16000): Uint8Array {
  const sampleCount = Math.floor((sampleRate * durationMs) / 1000);
  const buffer = new ArrayBuffer(sampleCount * BYTES_PER_SAMPLE);
  const view = new DataView(buffer);

  for (let i = 0; i < sampleCount; i++) {
    const sample = Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate);
    const pcm16 = Math.round(sample * 32767);
    view.setInt16(i * BYTES_PER_SAMPLE, pcm16, true);
  }

  return new Uint8Array(buffer);
}

export function createUtteranceFrames(frameCount = 10, frameDurationMs = 20, sampleRate = 16000): Uint8Array[] {
  return Array.from({ length: frameCount }, () => createSineWavePCM16Frame(frameDurationMs, 440, sampleRate));
}

export type FluxTurnEvent = "StartOfTurn" | "Update" | "EagerEndOfTurn" | "TurnResumed" | "EndOfTurn";

/**
 * Create a raw Flux TurnInfo JSON response string (as Deepgram /v2/listen sends).
 */
export function createFluxTurnInfoResponse(params: {
  event: FluxTurnEvent;
  transcript: string;
  confidence?: number;
  turnIndex?: number;
}): string {
  return JSON.stringify({
    type: "TurnInfo",
    event: params.event,
    turn_index: params.turnIndex ?? 0,
    transcript: params.transcript,
    words: params.transcript
      ? params.transcript.split(" ").map((w) => ({ word: w, confidence: params.confidence ?? 0.99 }))
      : [],
    end_of_turn_confidence: params.confidence ?? 0,
  });
}

/** @deprecated Use createFluxTurnInfoResponse instead. Alias for backward compat. */
export function createDeepgramTranscriptResponse(params: {
  text: string;
  isFinal: boolean;
  confidence?: number;
  speechFinal?: boolean;
}): string {
  const event: FluxTurnEvent = params.speechFinal ? "EndOfTurn" : params.isFinal ? "EagerEndOfTurn" : "Update";
  return createFluxTurnInfoResponse({
    event,
    transcript: params.text,
    ...(params.confidence !== undefined ? { confidence: params.confidence } : {}),
  });
}

/**
 * Create a raw Nova-3 Results JSON response string (as Deepgram /v1/listen sends).
 */
export function createNova3ResultResponse(params: {
  transcript: string;
  isFinal: boolean;
  speechFinal?: boolean;
  confidence?: number;
}): string {
  return JSON.stringify({
    type: "Results",
    channel: {
      alternatives: [
        {
          transcript: params.transcript,
          confidence: params.confidence ?? 0.99,
        },
      ],
    },
    is_final: params.isFinal,
    speech_final: params.speechFinal ?? false,
  });
}

export function createNova3SpeechStartedResponse(): string {
  return JSON.stringify({ type: "SpeechStarted" });
}

export function createNova3UtteranceEndResponse(): string {
  return JSON.stringify({ type: "UtteranceEnd" });
}

export function createDeepgramMetadataResponse(): string {
  return JSON.stringify({
    type: "Metadata",
    transaction_key: "test-transaction",
    request_id: "test-request-id",
    sha256: "test-sha256",
    created: new Date().toISOString(),
    duration: 0,
    channels: 1,
  });
}
