// AudioWorklet processor for the localVAD PoC.
//
// Receives Float32 mic samples at the AudioContext's native sample rate
// (typically 48 000 Hz; sometimes 44 100). Linearly interpolates them down
// to exactly 16 000 Hz — Silero's required rate — converts to signed 16-bit
// PCM, batches to ~64 ms windows and posts each batch to the main thread
// as a transferable ArrayBuffer.
//
// Why resample here instead of letting the browser do it?
//   Firefox refuses to `createMediaStreamSource()` when the stream's
//   native rate differs from the AudioContext's rate, so the previous
//   approach of creating a 16 kHz AudioContext and relying on the browser
//   to resample the mic stream is a no-go. Running the AudioContext at
//   the native rate and downsampling inside the worklet works in both
//   Chrome and Firefox.
//
// Resampling: linear interpolation. Adequate for speech + VAD + Smart-Turn
// at 16 kHz; not a broadcast-quality resampler. If quality ever becomes a
// concern (it won't for this PoC), swap in a polyphase FIR.

/** Target rate that the Silero + Smart-Turn pipeline expects. */
const TARGET_SAMPLE_RATE = 16000;

/** 1024 output samples at 16 kHz = 64 ms of audio per batch. */
const BATCH_SAMPLES = 1024;

/** Signed 16-bit range (asymmetric: positive max is 0x7fff, |negative min| is 0x8000). */
const INT16_MAX = 0x7fff;
const INT16_MIN_MAGNITUDE = 0x8000;

/**
 * `sampleRate` is a global provided by `AudioWorkletGlobalScope` that
 * reports the enclosing AudioContext's sample rate. We capture it once at
 * module load; it cannot change over the life of the worklet.
 */
const INPUT_SAMPLE_RATE = sampleRate;
const RESAMPLE_STRIDE = INPUT_SAMPLE_RATE / TARGET_SAMPLE_RATE;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Int16Array(BATCH_SAMPLES);
    this.batchOffset = 0;

    // Fractional read position into a virtual input stream that begins
    // with `prevSample` (index 0) followed by the current render quantum
    // (indices 1..N). After each process() call we subtract N so the
    // position stays relative to the new "prevSample" baseline.
    this.readPos = 0;
    this.prevSample = 0;

    // One-shot diagnostic back to the main thread.
    this.port.postMessage({
      type: "worklet-ready",
      inputSampleRate: INPUT_SAMPLE_RATE,
      outputSampleRate: TARGET_SAMPLE_RATE,
      resampleStride: RESAMPLE_STRIDE,
    });
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    const N = input.length; // always 128 per spec

    // Virtual input stream for this call:
    //   index 0         → this.prevSample
    //   index 1..N      → input[0..N-1]
    // We can interpolate at position p while p < N (we need input[floor(p)]
    // to exist, which it does for floor(p) <= N-1, i.e. p < N).
    while (this.readPos < N) {
      const j = Math.floor(this.readPos);
      const frac = this.readPos - j;
      const s0 = j === 0 ? this.prevSample : input[j - 1];
      const s1 = input[j];
      const interpolated = s0 * (1 - frac) + s1 * frac;

      const clamped = Math.max(-1, Math.min(1, interpolated));
      this.batch[this.batchOffset++] =
        clamped < 0 ? clamped * INT16_MIN_MAGNITUDE : clamped * INT16_MAX;

      if (this.batchOffset >= BATCH_SAMPLES) {
        const out = new Int16Array(BATCH_SAMPLES);
        out.set(this.batch);
        this.port.postMessage({ type: "pcm", buffer: out.buffer }, [out.buffer]);
        this.batchOffset = 0;
      }

      this.readPos += RESAMPLE_STRIDE;
    }

    // Shift the reference frame for the next call: what was index N in the
    // current call's virtual stream becomes index 0 in the next call's.
    this.readPos -= N;
    this.prevSample = input[N - 1];
    return true;
  }
}

registerProcessor("localvad-capture", CaptureProcessor);
