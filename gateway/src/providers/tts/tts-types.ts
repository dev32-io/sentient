export interface TTSConfig {
  readonly apiKey: string;
  readonly voiceId: string;
  readonly modelId: string;
  readonly format: "opus" | "pcm" | "mp3";
  readonly bitrate: number;
  readonly sampleRate: number;
  readonly latency: "normal" | "balanced";
  readonly chunkLengthMs: number;
  readonly connectTimeoutMs: number;
}

export const TTS_DEFAULTS = {
  modelId: "speech-1.6",
  format: "opus" as const,
  bitrate: 48000,
  sampleRate: 48000,
  latency: "balanced" as const,
  chunkLengthMs: 200,
  connectTimeoutMs: 10000,
} as const;

export interface TTSAudioChunk {
  readonly data: Uint8Array;
  readonly encoding: "opus" | "pcm" | "mp3";
  readonly sampleRate: number;
  readonly isFinal: boolean;
}

// ---------------------------------------------------------------------------
// TTSProvider — per-task isolated TTS session.
//
// Each call to `createFishAudioProvider(config)` produces a fresh provider
// bound to a single Fish Audio WebSocket. One `speak` effect invocation owns
// one provider end-to-end; no sharing between tasks (no race on session state).
//
// Lifecycle:
//   1. `warmup()`       — fire-and-forget; opens WS + sends StartEvent.
//   2. `ready(signal)`  — resolves when WS is open + StartEvent acknowledged.
//   3. `pushText(text)` — queue a TextEvent. Safe to call repeatedly.
//   4. `audioFrames()`  — async iterator of audio chunks; ends on FinishEvent.
//   5. `endInput()`     — send StopEvent (no more text; server will flush + Finish).
//   6. `dispose()`      — force-close WS without Stop (abort path).
//
// Typical flow:
//   provider.warmup();                // kick off handshake ASAP
//   // ... do other work in parallel ...
//   await provider.ready(signal);
//   provider.pushText("Hello. ");
//   provider.pushText("How are you?");
//   provider.endInput();
//   for await (const chunk of provider.audioFrames(signal)) { ... }
//
// Abort flow:
//   provider.dispose();               // close WS, drop queued audio
// ---------------------------------------------------------------------------

export interface TTSProvider {
  warmup(): void;
  ready(signal: AbortSignal): Promise<void>;
  pushText(text: string): void;
  audioFrames(signal: AbortSignal): AsyncGenerator<TTSAudioChunk>;
  endInput(): void;
  dispose(): void;
}

/**
 * Per-session override knobs handed to a TTSProviderFactory call. Today the
 * only override is `voiceId` — set by the WS handler from the authenticated
 * user's profile.json#voice.id so each PersonSession synthesizes in its own
 * voice. Omitting falls back to the gateway-wide default from cfg.tts.voice_id.
 */
export interface TTSProviderOverrides {
  readonly voiceId?: string;
}

/** Constructor for a fresh, isolated per-cycle TTS session. */
export type TTSProviderFactory = (overrides?: TTSProviderOverrides) => TTSProvider;
