// gateway/webui/src/audio/wav-encoder.ts
//
// Minimal 16-bit PCM mono WAV encoder for the voice-cloning recorder
// (components/voices/VoiceRecorder.tsx). The Task-15 voices service decodes
// uploaded reference clips with libsndfile/soundfile, which reads WAV/FLAC/
// OGG but NOT audio/webm — Chrome MediaRecorder's default container. So the
// recorder captures raw PCM via the existing capture-worklet primitive and
// this module wraps it in a RIFF/WAVE header instead of using MediaRecorder.

const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2; // 16-bit PCM
const PCM_FORMAT_CODE = 1;
const MONO_CHANNEL_COUNT = 1;
const BITS_PER_SAMPLE = 16;
const FMT_CHUNK_SIZE = 16;
const RIFF_HEADER_TAIL_BYTES = 36; // byte count from "WAVE" through the fmt chunk

/** Concatenates Int16 PCM frames (mono) into a single `audio/wav` Blob. */
export function encodeWav(frames: readonly Int16Array[], sampleRate: number): Blob {
  const sampleCount = frames.reduce((sum, frame) => sum + frame.length, 0);
  const dataBytes = sampleCount * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, RIFF_HEADER_TAIL_BYTES + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, FMT_CHUNK_SIZE, true);
  view.setUint16(20, PCM_FORMAT_CODE, true);
  view.setUint16(22, MONO_CHANNEL_COUNT, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * MONO_CHANNEL_COUNT * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, MONO_CHANNEL_COUNT * BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i++) {
      view.setInt16(offset, frame[i] ?? 0, true);
      offset += BYTES_PER_SAMPLE;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
