/**
 * OGG-Opus streaming decoder running in a Web Worker.
 *
 * Decodes the local-tts service's OGG-Opus TTS output to Float32 samples
 * at 48 kHz, then linearly downsamples to the playback adapter's target rate.
 * Off-main-thread to avoid blocking UI on each chunk decode (~10-30 ms).
 *
 * Compatibility: any browser with WebAssembly + Web Workers (iOS Safari 11+,
 * Chrome 57+, Firefox 53+, Edge 16+).
 */
import { createLogger } from "@sentient/web-sdk";

const log = createLogger(["sentient", "webui", "opus-decoder"]);

export interface OpusDecoderAPI {
  decode(oggBytes: Uint8Array): void;
  /** Reset decoder state — call between cycles to clear any residual buffer. */
  reset(): Promise<void>;
  /** Free WASM memory + terminate worker. */
  close(): Promise<void>;
}

export interface OpusDecoderOptions {
  onFrame: (samples: Float32Array) => void;
  targetSampleRate: number;
}

export function createOpusDecoder(options: OpusDecoderOptions): OpusDecoderAPI {
  let decoder: import("ogg-opus-decoder").OggOpusDecoderWebWorker | null = null;
  let ready = false;
  let closed = false;
  const pending: Uint8Array[] = [];

  (async () => {
    const mod = await import("ogg-opus-decoder");
    if (closed) return;
    decoder = new mod.OggOpusDecoderWebWorker();
    await decoder.ready;
    if (closed) return;
    ready = true;
    log.info("ready", { codec: "ogg-opus", thread: "worker" });
    for (const bytes of pending) {
      if (closed) break;
      await flushOne(bytes);
    }
    pending.length = 0;
  })().catch((err: unknown) => {
    closed = true;
    pending.length = 0;
    log.error("init-failed", {
      reason: "lazy import or decoder.ready rejected",
      message: err instanceof Error ? err.message : String(err),
    });
  });

  async function flushOne(bytes: Uint8Array): Promise<void> {
    if (!decoder) return;
    try {
      const result = await decoder.decode(bytes);
      if (result.errors.length > 0) {
        log.warn("decode-warnings", { count: result.errors.length, first: result.errors[0] });
      }
      if (result.channelData.length === 0 || result.samplesDecoded === 0) return;
      const samples = result.channelData[0]?.subarray(0, result.samplesDecoded);
      if (samples === undefined) return;
      const out =
        options.targetSampleRate === result.sampleRate
          ? new Float32Array(samples)
          : linearResample(samples, result.sampleRate, options.targetSampleRate);
      options.onFrame(out);
    } catch (err) {
      log.error("decode-threw", { message: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    decode(oggBytes: Uint8Array): void {
      if (closed) return;
      if (!ready) {
        pending.push(oggBytes);
        return;
      }
      void flushOne(oggBytes);
    },
    async reset(): Promise<void> {
      if (closed || !ready || !decoder) return;
      await decoder.reset();
    },
    async close(): Promise<void> {
      if (closed) return;
      const wasReady = ready;
      closed = true;
      pending.length = 0;
      if (wasReady && decoder) await decoder.free();
      log.info("closed", { wasReady });
    },
  };
}

function linearResample(input: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return new Float32Array(input);
  const ratio = srcRate / dstRate;
  const outLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = srcIdx - lo;
    output[i] = (input[lo] ?? 0) * (1 - frac) + (input[hi] ?? 0) * frac;
  }
  return output;
}
