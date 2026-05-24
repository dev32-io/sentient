/**
 * WebCodecs streaming opus encoder for mic uplink.
 *
 * Wraps the browser-native `AudioEncoder` to emit RAW opus packets (no OGG
 * framing) suitable for forwarding one-packet-per-WS-binary-frame to the
 * gateway's STT path (see STTService `OpusStreamDecoder` CONTRACT.md §1.2).
 *
 * Targets 20 ms frames @ 16 kHz mono speech, 24-32 kbps for the toggle-to-talk
 * mic capture pipeline. AudioEncoder itself handles internal chunking — the
 * caller passes arbitrary-length Float32 PCM (e.g. 128-sample worklet frames)
 * and `onPacket` fires when a 20 ms opus packet is ready.
 *
 * Compatibility: Chrome 98+, Firefox 130+, Safari 17.2+. Returns `null` on
 * unsupported browsers so callers can fall back to the PCM path.
 */
import { createLogger } from "@sentient/web-sdk";

const log = createLogger(["sentient", "webui", "opus-encoder"]);

/** Opus application hint — "voip" optimizes for speech intelligibility. */
const OPUS_APPLICATION = "voip";

/** Opus bitstream format — "opus" emits raw TOC-byte packets (no OGG framing). */
const OPUS_FORMAT = "opus";

/** Opus frame duration in microseconds. 20 ms = 20000 µs. */
const OPUS_FRAME_DURATION_US = 20000;

/** Microseconds per second — used to derive AudioData timestamps. */
const US_PER_SECOND = 1_000_000;

/**
 * The W3C WebCodecs Opus codec registration adds an `application` hint
 * ("voip" | "audio" | "lowdelay"), but TS DOM lib (as of this writing) does
 * not yet include the field on `OpusEncoderConfig`. Extend locally.
 */
interface OpusEncoderConfigWithApplication extends OpusEncoderConfig {
  application?: "voip" | "audio" | "lowdelay";
}

export interface OpusEncoderAPI {
  /** Push one PCM Float32 frame (any length); encoder buffers internally to 20 ms frames. */
  encode(pcm: Float32Array): void;
  /** Flush any partial frame and emit. Resolves when underlying encoder drains. */
  flush(): Promise<void>;
  /** Terminate encoder + free resources. Idempotent. */
  close(): Promise<void>;
}

export interface OpusEncoderOptions {
  /** Source PCM sample rate (e.g. 16000). Must be one of {8000, 12000, 16000, 24000, 48000}. */
  sampleRate: number;
  /** Channel count — opus supports 1 (mono) or 2 (stereo). Mic capture is mono → 1. */
  channels: 1 | 2;
  /** Target bitrate in BPS. Speech 16-32 kbps recommended. */
  bitrate: number;
  /** Called once per encoded opus packet — caller forwards to WS. */
  onPacket: (packet: Uint8Array) => void;
  /** Optional: called once with `false` if AudioEncoder unsupported in this browser. */
  onUnsupported?: () => void;
}

/**
 * Returns null if WebCodecs `AudioEncoder` is unavailable in this browser
 * (caller falls back to the raw PCM uplink).
 */
export function createOpusEncoder(options: OpusEncoderOptions): OpusEncoderAPI | null {
  if (typeof AudioEncoder === "undefined") {
    log.warn("unsupported", { reason: "AudioEncoder not present on this browser" });
    options.onUnsupported?.();
    return null;
  }

  const { sampleRate, channels, bitrate, onPacket } = options;

  let encoder: AudioEncoder | null = null;
  let ready = false;
  let closed = false;
  let errored = false;
  /** Sample count consumed so far — used to compute monotonic AudioData timestamps. */
  let totalSamples = 0;
  const pending: Float32Array[] = [];

  const onChunk = (chunk: EncodedAudioChunk): void => {
    if (closed) return;
    const out = new Uint8Array(chunk.byteLength);
    chunk.copyTo(out);
    onPacket(out);
  };

  const onError = (err: Error): void => {
    errored = true;
    log.warn("encoder-error", { reason: "AudioEncoder fired error", message: err.message });
  };

  try {
    encoder = new AudioEncoder({ output: onChunk, error: onError });
    const opusConfig: OpusEncoderConfigWithApplication = {
      format: OPUS_FORMAT,
      application: OPUS_APPLICATION,
      frameDuration: OPUS_FRAME_DURATION_US,
    };
    encoder.configure({
      codec: "opus",
      sampleRate,
      numberOfChannels: channels,
      bitrate,
      opus: opusConfig,
    });
    ready = true;
    log.info("ready", { codec: "opus", sampleRate, channels, bitrate });
    drainPending();
  } catch (err) {
    errored = true;
    log.warn("configure-failed", {
      reason: "AudioEncoder.configure threw — likely unsupported codec params",
      message: err instanceof Error ? err.message : String(err),
    });
    options.onUnsupported?.();
    return null;
  }

  function pushFrame(pcm: Float32Array): void {
    if (!encoder || errored || closed) return;
    const framesInChunk = pcm.length / channels;
    const timestampUs = Math.round((totalSamples / sampleRate) * US_PER_SECOND);
    // Copy into a fresh ArrayBuffer-backed Float32Array — AudioData's `data`
    // is typed as BufferSource (ArrayBuffer | ArrayBufferView<ArrayBuffer>),
    // and worklet-message Float32Arrays may be backed by ArrayBufferLike.
    const audioBuffer = new ArrayBuffer(pcm.byteLength);
    new Float32Array(audioBuffer).set(pcm);
    const audioData = new AudioData({
      format: "f32-planar",
      sampleRate,
      numberOfChannels: channels,
      numberOfFrames: framesInChunk,
      timestamp: timestampUs,
      data: audioBuffer,
    });
    totalSamples += framesInChunk;
    try {
      encoder.encode(audioData);
    } finally {
      audioData.close();
    }
  }

  function drainPending(): void {
    if (!ready || errored || closed) return;
    for (const frame of pending) {
      if (errored || closed) break;
      pushFrame(frame);
    }
    pending.length = 0;
  }

  return {
    encode(pcm: Float32Array): void {
      if (closed || errored) return;
      if (!ready) {
        pending.push(pcm);
        return;
      }
      pushFrame(pcm);
    },
    async flush(): Promise<void> {
      if (closed || errored || !encoder) return;
      try {
        await encoder.flush();
      } catch (err) {
        log.warn("flush-failed", {
          reason: "AudioEncoder.flush rejected",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      const wasReady = ready;
      closed = true;
      pending.length = 0;
      if (encoder && !errored) {
        try {
          await encoder.flush();
        } catch {
          // Ignore — we're tearing down anyway.
        }
        try {
          encoder.close();
        } catch {
          // Ignore — already closed.
        }
      }
      encoder = null;
      log.info("closed", { wasReady });
    },
  };
}
