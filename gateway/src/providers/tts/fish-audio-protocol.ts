import { decode, encode } from "@msgpack/msgpack";
import type { TTSConfig } from "./tts-types.ts";

export type FishAudioAudioEvent = { event: "audio"; audio: Uint8Array };
export type FishAudioFinishEvent = { event: "finish" };
export type FishAudioEvent = FishAudioAudioEvent | FishAudioFinishEvent;

interface StartMessageRequest {
  text: string;
  reference_id: string;
  latency: string;
  format: string;
  sample_rate: number;
  chunk_length: number;
  /** Fish TTSRequest schema: format-specific bitrate fields, not a generic `bitrate`. */
  opus_bitrate?: number;
  mp3_bitrate?: number;
}

/**
 * Fish opus_bitrate accepted values, in BPS. -1000 = auto. Empirically
 * verified by Fish error response when an invalid value is submitted
 * ("Invalid opus bitrate 32. Supported bitrates: -1000, 24000, 32000,
 * 48000, 64000"). The live WS endpoint uses BPS despite docs claiming kbps.
 */
const FISH_OPUS_BITRATE_ALLOWED_BPS = [-1000, 24000, 32000, 48000, 64000] as const;

/** Fallback opus bitrate (BPS) when caller's value is outside the allowed set. */
const FISH_OPUS_BITRATE_FALLBACK_BPS = 32000;

/** Fish mp3_bitrate accepted values, in kbps, per Fish docs. */
const FISH_MP3_BITRATE_ALLOWED_KBPS = [64, 128, 192] as const;

/** Fallback mp3 bitrate (kbps) when caller's value is outside the allowed set. */
const FISH_MP3_BITRATE_FALLBACK_KBPS = 128;

/**
 * Fish Audio uses a streaming protocol:
 *   1. Send `start` with empty text and `streaming: true` (this message)
 *   2. Send `text` events via buildFishAudioTextMessage for each sentence
 *   3. Send `stop` via buildFishAudioStopMessage to signal end-of-input
 *   4. Server responds with `audio` events followed by a `finish` event
 *
 * Bitrate field name depends on format. Fish's TTSRequest schema (per
 * https://docs.fish.audio/api-reference/sdk/python/types) uses `opus_bitrate`
 * with valid values {-1000 (auto), 24, 32, 48, 64} kbps for opus, and
 * `mp3_bitrate` with valid values {64, 128, 192} kbps for mp3. PCM/WAV
 * ignore bitrate entirely. Sending a generic `bitrate` field is unknown to
 * Fish; it may be silently dropped or cause the server to reject the start.
 */
export function buildFishAudioStartMessage(config: TTSConfig): Uint8Array {
  const request: StartMessageRequest = {
    text: "",
    reference_id: config.voiceId,
    latency: config.latency,
    format: config.format,
    sample_rate: config.sampleRate,
    chunk_length: config.chunkLengthMs,
  };
  if (config.format === "opus") {
    const bps = config.bitrate;
    request.opus_bitrate = (FISH_OPUS_BITRATE_ALLOWED_BPS as readonly number[]).includes(bps)
      ? bps
      : FISH_OPUS_BITRATE_FALLBACK_BPS;
  } else if (config.format === "mp3") {
    const kbps = Math.round(config.bitrate / 1000);
    request.mp3_bitrate = (FISH_MP3_BITRATE_ALLOWED_KBPS as readonly number[]).includes(kbps)
      ? kbps
      : FISH_MP3_BITRATE_FALLBACK_KBPS;
  }
  // pcm/wav: no bitrate field.
  return encode({ event: "start", request });
}

export function buildFishAudioTextMessage(text: string): Uint8Array {
  return encode({ event: "text", text });
}

export function parseFishAudioResponse(data: Uint8Array): FishAudioEvent | null {
  let msg: unknown;
  try {
    msg = decode(data);
  } catch {
    return null;
  }

  if (!msg || typeof msg !== "object") return null;

  const record = msg as Record<string, unknown>;
  const event = record.event;
  if (typeof event !== "string") return null;

  if (event === "audio") {
    const audio = record.audio;
    if (audio instanceof Uint8Array) {
      return { event: "audio", audio };
    }
    return null;
  }

  if (event === "finish") {
    return { event: "finish" };
  }

  return null;
}

/**
 * Diagnostic helper: return the event-type string of an arbitrary Fish message
 * even when the parser drops it (log/info/unknown). Caller can log this to
 * see what Fish is actually sending (e.g. when audio frames count is 0).
 */
export function describeFishAudioResponse(data: Uint8Array): string | null {
  let msg: unknown;
  try {
    msg = decode(data);
  } catch {
    return "decode-error";
  }
  if (!msg || typeof msg !== "object") return "non-object";
  const record = msg as Record<string, unknown>;
  const ev = typeof record.event === "string" ? record.event : "no-event-field";
  // Include any human-readable fields for diagnostics (log lines, errors).
  const extras: Record<string, unknown> = {};
  for (const key of ["message", "msg", "level", "code", "error", "detail"]) {
    if (record[key] !== undefined) extras[key] = record[key];
  }
  const extraStr = Object.keys(extras).length > 0 ? ` ${JSON.stringify(extras)}` : "";
  return `${ev}${extraStr}`;
}

export function buildFishAudioFlushMessage(): Uint8Array {
  return encode({ event: "flush" });
}

export function buildFishAudioStopMessage(): Uint8Array {
  return encode({ event: "stop" });
}
