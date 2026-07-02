/**
 * RNNoise WASM denoiser. Streams Float32 PCM at 48 kHz mono through the
 * Mozilla/Xiph RNNoise neural noise suppressor. Emits cleaned audio +
 * per-frame speech probability so callers can drive STT/barge-in flow.
 *
 * Frame size is fixed at 480 samples (10 ms @ 48 kHz) — RNNoise constraint.
 * Caller pushes arbitrary-length Float32; wrapper buffers internally to
 * exactly-480 frames before invoking the native processor.
 *
 * Sample scale: RNNoise expects Float32 scaled to the int16 numeric range
 * (-32768..32767), NOT normalized [-1, 1]. We scale on entry and reverse
 * on exit so the caller's contract stays normalized.
 *
 * Compatibility: any browser with WebAssembly (iOS Safari 11+, Chrome 57+,
 * Firefox 53+, Edge 16+). Returns `null` on unsupported environments so
 * callers can fall back to a no-denoise capture path.
 */
import { createLogger } from "@sentient/web-sdk";

const log = createLogger(["sentient", "webui", "rnnoise"]);

/** RNNoise's required frame size — 10 ms @ 48 kHz. Hardcoded in the model. */
const FRAME_SAMPLES = 480;

/** Bytes per Float32 sample — used to size WASM-heap allocations. */
const FLOAT32_BYTES = 4;

/** Forward scale Float32 [-1, 1] → int16-range float, for RNNoise input. */
const SCALE_TO_INT16 = 32768;

/** Reverse scale RNNoise output → Float32 [-1, 1] for the caller. */
const SCALE_FROM_INT16 = 1 / 32768;

export interface RnNoiseFrameResult {
  /**
   * Denoised PCM samples at 48 kHz mono, Float32 in [-1, 1]. Length 480.
   *
   * IMPORTANT: This buffer is reused across frames. Consume synchronously
   * inside the `onFrame` callback or copy it out — do not retain a reference.
   */
  samples: Float32Array;
  /** Speech probability for this frame, [0, 1]. > 0.5 typically means speech. */
  speechProb: number;
}

export interface RnNoiseDenoiserAPI {
  /**
   * Push arbitrary-length Float32 PCM (48 kHz mono); wrapper buffers to
   * 480-sample frames and fires `onFrame` once per frame.
   */
  push(pcm: Float32Array): void;
  /** Reset internal denoiser state — call between separate utterances. */
  reset(): Promise<void>;
  /** Free WASM memory. Idempotent. */
  close(): Promise<void>;
}

export interface RnNoiseDenoiserOptions {
  /** Fires once per 10 ms frame after denoise. Buffer reused — see RnNoiseFrameResult. */
  onFrame: (result: RnNoiseFrameResult) => void;
  /** Called once if WASM init fails. Caller falls back to no-denoise path. */
  onUnsupported?: () => void;
  /**
   * Test toggle: still run RNNoise to compute `speechProb` (for the gate) but
   * emit the RAW input frame instead of the denoised output — so Whisper sees
   * un-enhanced audio. See constants.DENOISE_BYPASS.
   */
  bypass?: boolean;
}

/**
 * Returns `null` if WebAssembly is unavailable. If lazy WASM init fails
 * later, `onUnsupported` is fired and subsequent `push()` calls no-op.
 */
export function createRnNoiseDenoiser(options: RnNoiseDenoiserOptions): RnNoiseDenoiserAPI | null {
  if (typeof WebAssembly === "undefined") {
    log.warn("unsupported", { reason: "WebAssembly missing on this runtime" });
    options.onUnsupported?.();
    return null;
  }

  type Mod = import("@jitsi/rnnoise-wasm/dist/rnnoise").RnnoiseModule;
  let module: Mod | null = null;
  let state = 0;
  let inPtr = 0;
  let outPtr = 0;
  let ready = false;
  let closed = false;

  /** Accumulator for partial frames between `push()` calls. */
  const frameBuf = new Float32Array(FRAME_SAMPLES);
  let frameBufFill = 0;

  /** Pre-allocated output container — reused per frame. Caller must copy. */
  const outSamples = new Float32Array(FRAME_SAMPLES);

  (async () => {
    try {
      const mod = await import("@jitsi/rnnoise-wasm/dist/rnnoise");
      const wasmUrlMod = await import("@jitsi/rnnoise-wasm/dist/rnnoise.wasm?url");
      const wasmUrl = wasmUrlMod.default;
      const factory = mod.default;
      const resolved = await factory({ locateFile: () => wasmUrl });
      if (closed) return;
      module = resolved;
      state = resolved._rnnoise_create();
      inPtr = resolved._malloc(FRAME_SAMPLES * FLOAT32_BYTES);
      outPtr = resolved._malloc(FRAME_SAMPLES * FLOAT32_BYTES);
      ready = true;
      log.info("ready", { frameSamples: FRAME_SAMPLES, sampleRate: 48000 });
    } catch (err) {
      closed = true;
      log.error("init-failed", {
        reason: "rnnoise wasm load or init threw",
        message: err instanceof Error ? err.message : String(err),
      });
      options.onUnsupported?.();
    }
  })();

  function processFrame(samples: Float32Array): void {
    if (!module || !ready || closed) return;
    const heapInIdx = inPtr / FLOAT32_BYTES;
    const heapOutIdx = outPtr / FLOAT32_BYTES;
    // Forward scale → write into WASM heap at inPtr.
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      module.HEAPF32[heapInIdx + i] = (samples[i] ?? 0) * SCALE_TO_INT16;
    }
    // Always run RNNoise — even when bypassing — so `speechProb` stays valid
    // for the gate. In bypass mode the denoised output is simply discarded.
    const speechProb = module._rnnoise_process_frame(state, outPtr, inPtr);
    if (options.bypass) {
      // Emit RAW input (caller copies synchronously; frameBuf is reused).
      options.onFrame({ samples, speechProb });
      return;
    }
    // Reverse scale → expose Float32 [-1, 1] to the caller.
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      outSamples[i] = (module.HEAPF32[heapOutIdx + i] ?? 0) * SCALE_FROM_INT16;
    }
    options.onFrame({ samples: outSamples, speechProb });
  }

  function buffer(pcm: Float32Array): void {
    let consumed = 0;
    while (consumed < pcm.length) {
      const need = FRAME_SAMPLES - frameBufFill;
      const take = Math.min(need, pcm.length - consumed);
      for (let i = 0; i < take; i++) {
        frameBuf[frameBufFill + i] = pcm[consumed + i] ?? 0;
      }
      frameBufFill += take;
      consumed += take;
      if (frameBufFill === FRAME_SAMPLES) {
        processFrame(frameBuf);
        frameBufFill = 0;
      }
    }
  }

  return {
    push(pcm: Float32Array): void {
      if (closed) return;
      // Drop audio that arrives before WASM init finishes — RNNoise typically
      // initializes in ~50-100 ms. If startup loss matters in the future, swap
      // this for a pending queue (opus-decoder pattern).
      if (!ready) return;
      buffer(pcm);
    },
    async reset(): Promise<void> {
      if (closed || !ready || !module) return;
      module._rnnoise_destroy(state);
      state = module._rnnoise_create();
      frameBufFill = 0;
    },
    async close(): Promise<void> {
      if (closed) return;
      const wasReady = ready;
      closed = true;
      frameBufFill = 0;
      if (wasReady && module) {
        try {
          module._rnnoise_destroy(state);
          module._free(inPtr);
          module._free(outPtr);
        } catch (err) {
          log.warn("close-cleanup-failed", {
            reason: "rnnoise destroy/free threw during teardown",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      log.info("closed", { wasReady });
    },
  };
}
