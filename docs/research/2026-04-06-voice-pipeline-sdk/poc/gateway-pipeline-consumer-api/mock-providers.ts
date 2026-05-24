// mock-providers.ts — Zero-cost mock providers for testing without API keys

import type { STTProvider, LLMProvider, TTSProvider } from "./pipeline-sdk";

// ─── Mock STT: emits scripted transcripts when finalize() is called ───

export function createMockSTT(options?: {
  partials?: string[];
  finalText?: string;
  latencyMs?: number;
}): STTProvider {
  const partials = options?.partials ?? ["hel", "hello", "hello how"];
  const finalText = options?.finalText ?? "hello how are you";
  const latency = options?.latencyMs ?? 10;
  let resolveFinalize: (() => void) | null = null;
  let aborted = false;

  return {
    async connect(_signal) {},

    sendAudio(_chunk) {
      // In real provider: forward to STT websocket
    },

    finalize() {
      resolveFinalize?.();
    },

    async *transcripts(signal) {
      aborted = false;
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });

      // Wait for finalize
      await new Promise<void>((resolve) => { resolveFinalize = resolve; });

      for (const partial of partials) {
        if (aborted) return;
        await delay(latency);
        yield { text: partial, isFinal: false };
      }

      if (!aborted) {
        await delay(latency);
        yield { text: finalText, isFinal: true };
      }
    },

    async disconnect() {},
  };
}

// ─── Mock LLM: streams a canned response token by token ───

export function createMockLLM(options?: {
  response?: string;
  tokenDelayMs?: number;
}): LLMProvider {
  const response = options?.response ?? "I'm doing great! How can I help you today?";
  const tokenDelay = options?.tokenDelayMs ?? 5;

  return {
    async *stream(_messages) {
      const words = response.split(" ");
      for (let i = 0; i < words.length; i++) {
        await delay(tokenDelay);
        yield (i > 0 ? " " : "") + words[i];
      }
    },
  };
}

// ─── Mock TTS: converts text to fake audio frames ───

export function createMockTTS(options?: {
  frameSizeBytes?: number;
  framesPerSentence?: number;
  frameDelayMs?: number;
}): TTSProvider {
  const frameSize = options?.frameSizeBytes ?? 320;
  const framesPerSentence = options?.framesPerSentence ?? 3;
  const frameDelay = options?.frameDelayMs ?? 5;

  return {
    async connect(_signal) {},

    async *synthesize(_text, signal) {
      for (let i = 0; i < framesPerSentence; i++) {
        if (signal.aborted) return;
        await delay(frameDelay);
        yield new Uint8Array(frameSize); // silent frame
      }
    },

    async disconnect() {},
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
