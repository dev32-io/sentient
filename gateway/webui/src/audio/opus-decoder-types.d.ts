/**
 * Override for `ogg-opus-decoder` typings.
 * Upstream bundled `types.d.ts` mistypes the main-thread `OggOpusDecoder.decode`
 * as sync; the README and runtime confirm it is actually async. The WebWorker
 * variant is already typed Promise upstream, but we redeclare both classes for
 * symmetry and to widen `sampleRate` from the literal `48000` to `number`.
 */
declare module "ogg-opus-decoder" {
  interface OggOpusDecodedAudio {
    channelData: Float32Array[];
    samplesDecoded: number;
    sampleRate: number;
    errors: { message: string; frameLength?: number; frameNumber?: number }[];
  }

  export class OggOpusDecoder {
    constructor(options?: { forceStereo?: boolean });
    ready: Promise<void>;
    decode(data: Uint8Array): Promise<OggOpusDecodedAudio>;
    decodeFile(data: Uint8Array): Promise<OggOpusDecodedAudio>;
    flush(): Promise<OggOpusDecodedAudio>;
    reset(): Promise<void>;
    free(): void;
  }

  export class OggOpusDecoderWebWorker {
    constructor(options?: { forceStereo?: boolean });
    ready: Promise<void>;
    decode(data: Uint8Array): Promise<OggOpusDecodedAudio>;
    decodeFile(data: Uint8Array): Promise<OggOpusDecodedAudio>;
    flush(): Promise<OggOpusDecodedAudio>;
    reset(): Promise<void>;
    free(): Promise<void>;
  }
}
