/** STT decode language sent to the local-stt service on connect. `auto`
 * keeps SenseVoice's per-utterance classifier; `en` / `zh` force that
 * language for better short-utterance accuracy. */
export type SttDecodeLanguage = "auto" | "en" | "zh";

/** Pause-marker render language. `auto` is NOT valid here — the pause
 * renderer emits human-readable strings and needs a concrete language.
 * When the decode language is `auto`, this falls back to the gateway's
 * configured default (see stt-factory.ts). */
export type SttPauseRenderLanguage = "en" | "zh";

/** Wire-format for binary frames on the STT WS uplink. `pcm16` is the
 * default for sources that capture PCM (browser AudioWorklet); `opus`
 * is used for sources that ship opus packets directly (ESP32 cube).
 * STT decodes opus server-side via OpusStreamDecoder. Per STT
 * CONTRACT.md §1.2 the value is sent as a URL query param at connect. */
export type SttAudioFormat = "pcm16" | "opus";

export interface STTAdapterConfig {
  readonly url: string;
  readonly language: SttDecodeLanguage;
  /** Used only by the pause-marker renderer; independent of `language`. */
  readonly pauseRenderLanguage: SttPauseRenderLanguage;
  readonly inputSampleRate: number;
  readonly ttsEchoCooldownMs: number;
  readonly connectTimeoutMs: number;
  /** Wire-format for the binary path. Required — caller picks per session
   * source. See SttAudioFormat for the encoding contract. */
  readonly audioFormat: SttAudioFormat;
}

export type STTEvent =
  | { readonly type: "turn_started"; readonly turnIdx: number }
  | { readonly type: "transcript"; readonly turnIdx: number; readonly text: string }
  | { readonly type: "turn_dropped"; readonly turnIdx: number };

export interface STTAdapter {
  open(signal: AbortSignal): Promise<void>;
  send(pcm: Uint8Array): void;
  events(signal: AbortSignal): AsyncGenerator<STTEvent>;
  close(): Promise<void>;
  /** Suppress send() for `ms` milliseconds starting now. Called when the
   *  assistant starts producing audio so WebRTC AEC can converge. A call
   *  with `ms=0` clears any active suppression window immediately. */
  suppressInputFor(ms: number): void;
  /** Client signalled end-of-stream (`audio.end` — PTT release / mic off).
   *  Sends `{"type":"flush"}` so the service force-finalizes any open turn
   *  NOW. Without it the turn-pipeline watchdogs only run on frame arrival,
   *  so a turn left open when frames stop would finalize at the NEXT mic
   *  hold — the transcript would ride the next session. */
  endUtterance(): void;
}

export type STTAdapterFactory = (config: STTAdapterConfig) => STTAdapter;
