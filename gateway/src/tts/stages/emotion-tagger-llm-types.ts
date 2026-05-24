// ---------------------------------------------------------------------------
// Re-export LLM types from the canonical providers/llm-types module.
// The emotion-tagger uses these for its batched tagging LLM calls.
// The gateway no longer calls LLMs for cognitive cycles (Hermes handles that),
// but the emotion-tagger still needs the streaming interface.
// ---------------------------------------------------------------------------

export type {
  LLMMessage,
  LLMProvider,
  LLMStreamChunk,
  LLMStreamOptions,
} from "../../providers/llm-types.ts";
