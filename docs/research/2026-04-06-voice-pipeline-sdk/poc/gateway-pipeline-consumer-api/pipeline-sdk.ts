// pipeline-sdk.ts — The library layer. Developer never reads this.

// ─── Public types (what the developer sees) ───

export type PipelineState =
  | "idle"
  | "listening"
  | "processing"
  | "speaking"
  | "error";

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
  /** Current pipeline state */
  readonly state: PipelineState;

  /** Start a session — connects providers, prepares pipeline */
  start(): Promise<void>;

  /** Signal that the user started speaking */
  utteranceStart(): void;

  /** Feed raw audio into the pipeline */
  sendAudio(chunk: Uint8Array): void;

  /** Signal that the user stopped speaking — triggers processing */
  utteranceEnd(): void;

  /** Interrupt assistant speech (barge-in) */
  bargeIn(): void;

  /** Subscribe to pipeline events */
  on(handler: (event: PipelineEvent) => void): () => void;

  /** Tear down everything */
  destroy(): Promise<void>;
}

// ─── Provider interfaces (what provider authors implement) ───

export interface STTProvider {
  connect(signal: AbortSignal): Promise<void>;
  sendAudio(chunk: Uint8Array): void;
  finalize(): void;
  transcripts(signal: AbortSignal): AsyncGenerator<{ text: string; isFinal: boolean }>;
  disconnect(): Promise<void>;
}

export interface LLMProvider {
  stream(messages: Array<{ role: string; content: string }>): AsyncGenerator<string>;
}

export interface TTSProvider {
  connect(signal: AbortSignal): Promise<void>;
  synthesize(text: string, signal: AbortSignal): AsyncGenerator<Uint8Array>;
  disconnect(): Promise<void>;
}

export interface PipelineConfig {
  stt: STTProvider;
  llm: LLMProvider;
  tts: TTSProvider;
  systemPrompt?: string;
}

// ─── Internal: Stage composition (developer never sees this) ───

type Stage<In, Out> = (
  input: AsyncIterable<In>,
  signal: AbortSignal
) => AsyncGenerator<Out>;

// Sentence boundary detection (simplified from real codebase's sentence-boundary.ts)
function isSentenceEnd(text: string): boolean {
  return /[.!?]\s*$/.test(text.trimEnd());
}

function createSentenceAggregatorStage(): Stage<string, string> {
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

function createTTSStage(provider: TTSProvider): Stage<string, Uint8Array> {
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

// ─── Internal: FlowManager implementation ───

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
      // LLM stage: stream tokens
      const llmMessages = [...history];
      const tokens = config.llm.stream(llmMessages);

      // Sentence aggregation stage
      const sentenceStage = createSentenceAggregatorStage();
      const sentences = sentenceStage(
        // Tap tokens for text.delta events
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

      // TTS stage
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

  // Accumulate partials, wait for final transcript
  let partialText = "";

  return {
    get state() {
      return currentState;
    },

    async start() {
      sessionController = new AbortController();
      const signal = sessionController.signal;
      await Promise.all([
        config.stt.connect(signal),
        config.tts.connect(signal),
      ]);
      transition("listening");

      // Background: read STT transcripts and dispatch
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
        // Implicit barge-in
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
      return () => {
        handlers = handlers.filter((h) => h !== handler);
      };
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
