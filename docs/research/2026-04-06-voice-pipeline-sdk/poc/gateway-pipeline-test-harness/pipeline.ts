/**
 * Pipeline SDK — Extracted from consumer-api PoC for test harness use.
 * This is the system under test.
 */

import type { STTProvider, LLMProvider, TTSProvider } from "./mock-providers";

// ─── Public types ───

export type PipelineState = "idle" | "listening" | "processing" | "speaking" | "error";

export type PipelineEvent =
  | { type: "state.changed"; from: PipelineState; to: PipelineState }
  | { type: "transcript.partial"; text: string }
  | { type: "transcript.final"; text: string }
  | { type: "response.text.delta"; text: string }
  | { type: "response.text.done"; text: string }
  | { type: "response.audio.frame"; data: Uint8Array }
  | { type: "response.audio.done" }
  | { type: "error"; code: string; message: string };

export interface FlowManager {
  readonly state: PipelineState;
  start(): Promise<void>;
  utteranceStart(): void;
  sendAudio(chunk: Uint8Array): void;
  utteranceEnd(): void;
  bargeIn(): void;
  on(handler: (event: PipelineEvent) => void): () => void;
  destroy(): Promise<void>;
}

export interface PipelineConfig {
  stt: STTProvider;
  llm: LLMProvider;
  tts: TTSProvider;
  systemPrompt?: string;
}

// ─── Internal: Stage composition ───

type Stage<In, Out> = (input: AsyncIterable<In>, signal: AbortSignal) => AsyncGenerator<Out>;

function isSentenceEnd(text: string): boolean {
  return /[.!?]\s*$/.test(text.trimEnd());
}

export function createSentenceAggregatorStage(): Stage<string, string> {
  return async function* (tokens, signal) {
    let buffer = "";
    for await (const token of tokens) {
      if (signal.aborted) return;
      buffer += token;
      if (isSentenceEnd(buffer)) {
        yield buffer.trim();
        buffer = "";
      }
    }
    if (buffer.trim()) yield buffer.trim();
  };
}

export function createTTSStage(provider: TTSProvider): Stage<string, Uint8Array> {
  return async function* (sentences, signal) {
    for await (const sentence of sentences) {
      if (signal.aborted) return;
      for await (const chunk of provider.synthesize(sentence, signal)) {
        if (signal.aborted) return;
        yield chunk;
      }
    }
  };
}

// ─── FlowManager implementation ───

export function createVoicePipeline(config: PipelineConfig): FlowManager {
  let currentState: PipelineState = "idle";
  let handlers: Array<(event: PipelineEvent) => void> = [];
  let turnController: AbortController | null = null;
  let sessionController: AbortController | null = null;
  const history: Array<{ role: string; content: string }> = [];

  if (config.systemPrompt) {
    history.push({ role: "system", content: config.systemPrompt });
  }

  function emit(event: PipelineEvent) {
    for (const h of handlers) h(event);
  }

  function transition(to: PipelineState) {
    if (currentState === to) return;
    const from = currentState;
    currentState = to;
    emit({ type: "state.changed", from, to });
  }

  async function runTurn(transcript: string) {
    transition("processing");
    history.push({ role: "user", content: transcript });
    emit({ type: "transcript.final", text: transcript });

    const ac = new AbortController();
    turnController = ac;
    const signal = ac.signal;

    try {
      const llmMessages = [...history];
      const tokens = config.llm.stream(llmMessages);

      const sentenceStage = createSentenceAggregatorStage();
      const sentences = sentenceStage(
        (async function* () {
          let fullText = "";
          for await (const token of tokens) {
            if (signal.aborted) return;
            fullText += token;
            emit({ type: "response.text.delta", text: token });
            yield token;
          }
          emit({ type: "response.text.done", text: fullText });
          history.push({ role: "assistant", content: fullText });
        })(),
        signal
      );

      transition("speaking");
      const ttsStage = createTTSStage(config.tts);
      const audio = ttsStage(sentences, signal);

      for await (const frame of audio) {
        if (signal.aborted) break;
        emit({ type: "response.audio.frame", data: frame });
      }

      if (!signal.aborted) {
        emit({ type: "response.audio.done" });
      }
    } catch (err: any) {
      if (!signal.aborted) {
        emit({ type: "error", code: "pipeline.turn_failed", message: err.message ?? "Turn failed" });
        transition("error");
        return;
      }
    } finally {
      turnController = null;
    }

    transition("listening");
  }

  let partialText = "";

  return {
    get state() { return currentState; },

    async start() {
      sessionController = new AbortController();
      const signal = sessionController.signal;
      await Promise.all([
        config.stt.connect(signal),
        config.tts.connect(signal),
      ]);
      transition("listening");

      (async () => {
        try {
          for await (const t of config.stt.transcripts(signal)) {
            if (signal.aborted) break;
            if (!t.isFinal) {
              partialText = t.text;
              emit({ type: "transcript.partial", text: t.text });
            } else {
              const finalText = t.text || partialText;
              partialText = "";
              if (finalText.trim()) {
                runTurn(finalText);
              }
            }
          }
        } catch {
          // session closed
        }
      })();
    },

    utteranceStart() {
      if (currentState === "speaking") {
        turnController?.abort();
      }
      transition("listening");
    },

    sendAudio(chunk: Uint8Array) {
      config.stt.sendAudio(chunk);
    },

    utteranceEnd() {
      config.stt.finalize();
    },

    bargeIn() {
      turnController?.abort();
      transition("listening");
    },

    on(handler: (event: PipelineEvent) => void) {
      handlers.push(handler);
      return () => { handlers = handlers.filter((h) => h !== handler); };
    },

    async destroy() {
      turnController?.abort();
      sessionController?.abort();
      await Promise.allSettled([
        config.stt.disconnect(),
        config.tts.disconnect(),
      ]);
      transition("idle");
      handlers = [];
    },
  };
}
