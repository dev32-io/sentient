/**
 * Ambient type declarations for AudioWorklet processor context.
 *
 * AudioWorkletProcessor runs in a dedicated audio rendering thread, not the
 * main JS thread, and its global scope differs from lib.dom. These types are
 * not provided by bun-types, so we declare the minimum needed here.
 */

interface AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare const AudioWorkletProcessor: {
  new (): AudioWorkletProcessor;
};

declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void;
