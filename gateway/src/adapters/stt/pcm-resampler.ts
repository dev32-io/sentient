export function downsamplePcm16(input: Uint8Array, inputRate: number, outputRate: number): Uint8Array {
  if (inputRate === outputRate) return input;
  if (input.byteLength === 0) return input;

  const inSamples = new Int16Array(input.buffer, input.byteOffset, input.byteLength / 2);
  const ratio = inputRate / outputRate;
  const outLength = Math.floor(inSamples.length / ratio);
  const out = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio;
    const srcFloor = Math.floor(srcIndex);
    const srcCeil = Math.min(srcFloor + 1, inSamples.length - 1);
    const frac = srcIndex - srcFloor;
    out[i] = Math.round((inSamples[srcFloor] ?? 0) * (1 - frac) + (inSamples[srcCeil] ?? 0) * frac);
  }

  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
