const HEADER_BYTES = 44;
const PCM_FORMAT_CODE = 1;
const MONO = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = 2;
const FMT_CHUNK_SIZE = 16;
const RIFF_TAIL_BYTES = 36;

/** Wrap raw PCM16-LE mono bytes in a WAV container (44-byte header). */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + pcm.length);
  const dv = new DataView(out.buffer);
  writeAscii(out, 0, "RIFF");
  dv.setUint32(4, RIFF_TAIL_BYTES + pcm.length, true);
  writeAscii(out, 8, "WAVE");
  writeAscii(out, 12, "fmt ");
  dv.setUint32(16, FMT_CHUNK_SIZE, true);
  dv.setUint16(20, PCM_FORMAT_CODE, true);
  dv.setUint16(22, MONO, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * MONO * BYTES_PER_SAMPLE, true);
  dv.setUint16(32, MONO * BYTES_PER_SAMPLE, true);
  dv.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(out, 36, "data");
  dv.setUint32(40, pcm.length, true);
  out.set(pcm, HEADER_BYTES);
  return out;
}

function writeAscii(buf: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) buf[offset + i] = text.charCodeAt(i);
}
