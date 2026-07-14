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
// Each `TTSProviderFactory(...)` call produces a fresh provider bound to a
// single upstream WebSocket (Fish Audio, or the native local-tts service). One
// synthesis run owns one provider end-to-end; no sharing between tasks (no race
// on session state).
//
// Lifecycle:
//   1. `warmup()`       — fire-and-forget; opens WS + sends the start handshake.
//   2. `ready(signal)`  — resolves when WS is open + start acknowledged.
//   3. `pushText(text)` — queue a text event. Safe to call repeatedly.
//   4. `audioFrames()`  — async iterator of audio chunks; ends on the finish event.
//   5. `endInput()`     — signal no-more-text (server flushes + finishes).
//   6. `dispose()`      — force-close the WS + drop queued audio.
//
// dispose() CONTRACT (load-bearing across all implementations):
//   - MUST be idempotent — safe to call more than once (guard with a `disposed`
//     flag). The synthesizer may dispose on an error/abort path AND again in its
//     cleanup `finally`.
//   - The consumer MUST call `dispose()` after the `audioFrames` loop completes
//     NORMALLY as well as on abort. Some servers (the local-tts ChatterboxTTS
//     service) never self-close the WS, so skipping dispose-on-completion LEAKS
//     the socket. (Fish's server self-closes, but disposing anyway is harmless.)
//
// Typical flow:
//   provider.warmup();                // kick off handshake ASAP
//   // ... do other work in parallel ...
//   try {
//     await provider.ready(signal);
//     provider.pushText("Hello. ");
//     provider.pushText("How are you?");
//     provider.endInput();
//     for await (const chunk of provider.audioFrames(signal)) { ... }
//   } finally {
//     provider.dispose();             // ALWAYS — completion and abort alike
//   }
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
