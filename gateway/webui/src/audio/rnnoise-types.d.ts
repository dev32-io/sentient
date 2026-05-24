/**
 * Ambient module declarations for `@jitsi/rnnoise-wasm`.
 * Upstream ships no TypeScript types; this is the minimum surface area our
 * wrapper consumes. The factory function name is `createRNNWasmModule`
 * (three N's — verified against node_modules/@jitsi/rnnoise-wasm/dist/rnnoise.js).
 *
 * The resolved value is the Emscripten Module object itself — C exports are
 * properties prefixed with `_`, and the WASM linear memory is exposed as
 * typed-array views (HEAPF32, etc.).
 */
declare module "@jitsi/rnnoise-wasm/dist/rnnoise" {
  export interface RnnoiseModule {
    /** Create a new RNNoise denoiser state. Pass 0/undefined to use the
     *  default model baked into the WASM. Returns a state pointer (number). */
    _rnnoise_create(modelPtr?: number): number;
    /** Process one 480-sample frame. Reads Float32 from `inPtr`, writes
     *  Float32 to `outPtr`. Returns the per-frame speech probability [0, 1]. */
    _rnnoise_process_frame(state: number, outPtr: number, inPtr: number): number;
    /** Free the denoiser state. */
    _rnnoise_destroy(state: number): void;
    /** Allocate WASM-heap bytes; returns a pointer (offset into HEAPF32 etc.). */
    _malloc(bytes: number): number;
    /** Free a previously `_malloc`'d pointer. */
    _free(ptr: number): void;
    /** Float32 view over the WASM linear memory. Pointers index this in
     *  Float32 stride (ptr / 4). */
    HEAPF32: Float32Array;
  }

  /** Module-override options. We only use `locateFile` to point at the
   *  Vite-served WASM URL. */
  export interface CreateOptions {
    locateFile?: (path: string) => string;
  }

  /** The factory is exposed as a default export only — it accepts the
   *  Emscripten Module overrides and resolves to the initialized module. */
  const createRNNWasmModule: (options?: CreateOptions) => Promise<RnnoiseModule>;
  export default createRNNWasmModule;
}

declare module "@jitsi/rnnoise-wasm/dist/rnnoise.wasm?url" {
  const url: string;
  export default url;
}
