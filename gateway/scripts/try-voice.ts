#!/usr/bin/env bun
/**
 * Dirt-simple end-to-end voice-loop test.
 *
 * input.mp3 -> Deepgram STT -> OpenRouter LLM -> Fish Audio TTS -> output.wav
 *
 * Usage:
 *   DEEPGRAM_API_KEY=... FISH_AUDIO_API_KEY=... FISH_AUDIO_VOICE_ID=... \
 *   OPENROUTER_API_KEY=... bun run gateway/scripts/try-voice.ts
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEnglishBoundaryDetector } from "../src/pipeline/processors/en-boundary-detector.ts";
import { createStreamingOverlap } from "../src/pipeline/processors/streaming-overlap.ts";
import { createTTSProcessor } from "../src/pipeline/processors/tts-processor.ts";
import { createOpenRouterProvider } from "../src/providers/openrouter.ts";
import { createDeepgramProvider } from "../src/providers/stt/flux-provider.ts";
import { type STTConfig, STT_DEFAULTS } from "../src/providers/stt/stt-types.ts";
import { createFishAudioProvider } from "../src/providers/tts/fish-audio-provider.ts";
import { type TTSConfig, TTS_DEFAULTS } from "../src/providers/tts/tts-types.ts";

// ─── Config ─────────────────────────────────────────────────────────────────

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const INPUT_MP3 = join(SCRIPT_DIR, "input.mp3");
const INPUT_WAV = join(SCRIPT_DIR, "input.wav"); // temp
const OUTPUT_WAV = join(SCRIPT_DIR, "output.wav");

const STT_SAMPLE_RATE = 16_000;
const TTS_SAMPLE_RATE = 24_000;
const FRAME_MS = 20;
const BYTES_PER_SAMPLE = 2; // PCM16
const BYTES_PER_FRAME = (STT_SAMPLE_RATE * FRAME_MS * BYTES_PER_SAMPLE) / 1000; // 640
const STT_IDLE_TIMEOUT_MS = 5_000;

const CHAT_MODEL = "anthropic/claude-3-haiku";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

const DEEPGRAM_API_KEY = requireEnv("DEEPGRAM_API_KEY");
const FISH_AUDIO_API_KEY = requireEnv("FISH_AUDIO_API_KEY");
const FISH_AUDIO_VOICE_ID = requireEnv("FISH_AUDIO_VOICE_ID");
const OPENROUTER_API_KEY = requireEnv("OPENROUTER_API_KEY");
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Converts input.mp3 → 16kHz mono linear PCM16 WAV via macOS afconvert. */
function convertMp3ToWav(inputMp3: string, outputWav: string): void {
  const result = spawnSync(
    "afconvert",
    [inputMp3, outputWav, "-d", `LEI16@${STT_SAMPLE_RATE}`, "-c", "1", "-f", "WAVE"],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`afconvert failed with status ${result.status}`);
  }
}

/** Walks RIFF chunks and returns the raw PCM data inside the "data" chunk. */
function extractWavPCM(wavBytes: Uint8Array): Uint8Array {
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  const riff = String.fromCharCode(...wavBytes.slice(0, 4));
  const wave = String.fromCharCode(...wavBytes.slice(8, 12));
  if (riff !== "RIFF" || wave !== "WAVE") throw new Error("Not a WAVE file");

  let offset = 12;
  while (offset < wavBytes.length - 8) {
    const id = String.fromCharCode(...wavBytes.slice(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (id === "data") {
      return wavBytes.slice(offset + 8, offset + 8 + size);
    }
    offset += 8 + size;
  }
  throw new Error("No data chunk found in WAV");
}

/** Wraps raw PCM16 mono bytes in a minimal RIFF WAV header. */
function wrapPCMInWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const dataSize = pcm.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize;
  const out = new Uint8Array(fileSize);
  const view = new DataView(out.buffer);

  // RIFF header
  out.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, fileSize - 8, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"

  // fmt chunk
  out.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  // data chunk
  out.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, dataSize, true);
  out.set(pcm, 44);

  return out;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.info("\n[1/5] Converting input.mp3 → 16kHz mono PCM16 WAV...");
  convertMp3ToWav(INPUT_MP3, INPUT_WAV);
  const wavBytes = new Uint8Array(readFileSync(INPUT_WAV));
  const pcm = extractWavPCM(wavBytes);
  console.info(
    `      ${pcm.length} bytes = ${(pcm.length / (STT_SAMPLE_RATE * BYTES_PER_SAMPLE)).toFixed(2)}s of audio`,
  );

  console.info("\n[2/5] Streaming audio to Deepgram...");
  const sttConfig: STTConfig = {
    ...STT_DEFAULTS,
    apiKey: DEEPGRAM_API_KEY,
  };
  const stt = createDeepgramProvider();
  const sttController = new AbortController();
  await stt.connect(sttConfig, sttController.signal);

  // Collect final transcript in background
  let finalTranscript = "";
  let lastFinalAt = 0;
  const transcriptTask = (async () => {
    for await (const event of stt.transcripts(sttController.signal)) {
      if (event.type === "transcript") {
        if (event.isFinal) {
          finalTranscript = finalTranscript ? `${finalTranscript} ${event.text}` : event.text;
          lastFinalAt = Date.now();
          process.stdout.write(`      final: ${event.text}\n`);
        } else {
          process.stdout.write(`      partial: ${event.text}\r`);
        }
      }
    }
  })();

  // Send frames at real-time pace so endpointing works
  for (let off = 0; off < pcm.length; off += BYTES_PER_FRAME) {
    stt.sendAudio(pcm.subarray(off, Math.min(off + BYTES_PER_FRAME, pcm.length)));
    await sleep(FRAME_MS);
  }

  // Give Deepgram time to finalize (endpointing)
  const idleStart = Date.now();
  while (Date.now() - idleStart < STT_IDLE_TIMEOUT_MS) {
    if (lastFinalAt > 0 && Date.now() - lastFinalAt > 2000) break;
    await sleep(50);
  }
  sttController.abort();
  await transcriptTask.catch(() => {});
  await stt.disconnect();

  if (!finalTranscript.trim()) {
    console.error("\n[!] No transcript produced. Is the audio clear? Aborting.");
    process.exit(1);
  }
  console.info(`\n      transcript: "${finalTranscript.trim()}"`);

  console.info("\n[3/5] Sending transcript to OpenRouter LLM...");
  const llm = createOpenRouterProvider({
    apiKey: OPENROUTER_API_KEY,
    baseUrl: OPENROUTER_BASE_URL,
    siteName: "Sentient try-voice",
  });

  console.info("\n[4/5] Streaming LLM → sentence aggregator → Fish Audio TTS...");
  const tts = createFishAudioProvider();
  const ttsConfig: TTSConfig = {
    ...TTS_DEFAULTS,
    apiKey: FISH_AUDIO_API_KEY,
    voiceId: FISH_AUDIO_VOICE_ID,
    format: "pcm",
    sampleRate: TTS_SAMPLE_RATE,
  };
  const ttsController = new AbortController();
  await tts.connect(ttsConfig, ttsController.signal);

  const ttsProcessor = createTTSProcessor(tts);
  const overlap = createStreamingOverlap(ttsProcessor, createEnglishBoundaryDetector());

  async function* llmTokens(): AsyncGenerator<string> {
    process.stdout.write("      response: ");
    for await (const token of llm.stream({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: "You are a friendly assistant. Reply in 1-2 short sentences." },
        { role: "user", content: finalTranscript.trim() },
      ],
      signal: ttsController.signal,
    })) {
      process.stdout.write(token);
      yield token;
    }
    process.stdout.write("\n");
  }

  const audioChunks: Uint8Array[] = [];
  overlap.onAudioStart(() => console.info("      [audio.start]"));
  overlap.onAudioDone(() => console.info("      [audio.done]"));

  for await (const frame of overlap.process(llmTokens(), ttsController.signal)) {
    audioChunks.push(frame.data);
  }

  await tts.disconnect();

  const totalAudioBytes = audioChunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Uint8Array(totalAudioBytes);
  let mergeOffset = 0;
  for (const chunk of audioChunks) {
    merged.set(chunk, mergeOffset);
    mergeOffset += chunk.length;
  }

  console.info(`\n[5/5] Wrapping ${totalAudioBytes} bytes of PCM16 @ ${TTS_SAMPLE_RATE}Hz in WAV...`);
  const wav = wrapPCMInWav(merged, TTS_SAMPLE_RATE);
  writeFileSync(OUTPUT_WAV, wav);
  console.info(`      wrote ${OUTPUT_WAV} (${(wav.length / 1024).toFixed(1)} KB)`);

  console.info("\nDone. Play it with:");
  console.info(`  afplay ${OUTPUT_WAV}\n`);
}

main().catch((err) => {
  console.error("\n[!] Failed:", err);
  process.exit(1);
});
