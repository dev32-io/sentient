import {
  CODE_BLOCK,
  CODE_FENCE,
  EQUATION_BLOCK,
  EQUATION_INLINE,
  HEADING_1,
  HEADING_2,
  HEADING_3,
  HEADING_4,
  HEADING_5,
  HEADING_6,
  IMAGE,
  LINE_BREAK,
  LIST_ITEM,
  PARAGRAPH,
  type Parser,
  RAW_URL,
  RULE,
  type Renderer,
  TABLE,
  TABLE_ROW,
  type Token,
  parser,
  parser_end,
  parser_write,
} from "streaming-markdown";
import { getLog } from "../../logging/logger.ts";
import { FLUSH_SIGNAL, type TextStage, type TtsChunk } from "./stage-types.ts";

const log = getLog(["sentient", "tts", "markdown-stripper"]);

// ---------------------------------------------------------------------------
// markdown-stripper — converts a stream of markdown text deltas into a stream
// of plain-text chunks suitable for TTS.
//
// Implementation: thin wrapper around the `streaming-markdown` library
// (https://github.com/thetarnav/streaming-markdown). The library tokenizes
// markdown across arbitrary chunk boundaries — including incomplete fences,
// unclosed bold, partial links, etc. — so we don't have to chase the
// boundary heuristic that broke under per-token streaming. We hand it a
// custom "TTS renderer" that emits text-only output via the provided
// callbacks.
//
// Renderer policy (read aloud vs skip):
//   - Inline code (`foo`)      — read aloud (it's usually a short identifier)
//   - Fenced code blocks       — skipped (long code is unintelligible in audio
//                                 and reading 50 lines of TS source is bad UX)
//   - Links [text](url)        — read the visible text; drop the URL
//   - Images ![alt](src)       — skipped entirely (no useful audio rendering)
//   - Raw URLs (https://...)   — skipped (Fish reading "https colon slash..."
//                                 is brutal)
//   - Equations ($...$ / $$$$) — skipped (latex source isn't speakable)
//   - Headings / paragraphs /  — read text, then emit a `\n` so the downstream
//     list items / blockquotes /  UtteranceAggregator splits at that boundary
//     table rows
//   - Bold / italic / strike   — read text (markers are eaten by the parser)
//
// FLUSH_SIGNAL is forwarded after closing the parser and re-opening it for
// the next round — the library is stateful and a fresh parser ensures the
// next pre-tool acknowledgement isn't accidentally treated as a continuation
// of the previous markdown context.
// ---------------------------------------------------------------------------

// Token types whose `add_text` callbacks must be suppressed entirely.
// We compare by numeric value (the library's Token enum is a const-numeric).
const SKIP_INSIDE: ReadonlySet<Token> = new Set<Token>([
  CODE_BLOCK,
  CODE_FENCE,
  IMAGE,
  RAW_URL,
  EQUATION_BLOCK,
  EQUATION_INLINE,
]);

// Token types whose `end_token` should emit a paragraph break so the
// utterance aggregator gets a clean split point.
const NEWLINE_AFTER: ReadonlySet<Token> = new Set<Token>([
  PARAGRAPH,
  HEADING_1,
  HEADING_2,
  HEADING_3,
  HEADING_4,
  HEADING_5,
  HEADING_6,
  LIST_ITEM,
  TABLE_ROW,
  TABLE,
  RULE,
]);

interface RendererState {
  out: string[];
  skipDepth: number;
}

function makeRenderer(state: RendererState): Renderer<RendererState> {
  return {
    data: state,
    add_token(data, type) {
      if (SKIP_INSIDE.has(type)) data.skipDepth += 1;
      // Track which token type we're entering so end_token can decide
      // whether to balance the skip counter on the way out.
      stack.push(type);
    },
    end_token(data) {
      const popped = stack.pop();
      if (popped !== undefined && SKIP_INSIDE.has(popped)) data.skipDepth -= 1;
      if (popped !== undefined && NEWLINE_AFTER.has(popped)) data.out.push("\n");
      if (popped === LINE_BREAK) data.out.push("\n");
    },
    add_text(data, text) {
      if (data.skipDepth === 0 && text.length > 0) data.out.push(text);
    },
    set_attr() {
      // Link href / image src / lang / etc. — none of which we voice.
    },
  };
  // The token stack is closure-local to this renderer so each pipeline
  // run keeps its own state. Declared after the return for hoisting.
}

// Per-pipeline-run token stack used by the renderer above. Shared across
// add_token / end_token within one parser instance; reset every
// makeStreamer().
let stack: Token[] = [];

interface Streamer {
  feed(chunk: string): string;
  flush(): string;
}

function makeStreamer(): Streamer {
  let state: RendererState = { out: [], skipDepth: 0 };
  stack = [];
  let p: Parser = parser(makeRenderer(state));

  function drain(): string {
    if (state.out.length === 0) return "";
    const text = state.out.join("");
    state.out = [];
    return text;
  }

  return {
    feed(chunk) {
      parser_write(p, chunk);
      return drain();
    },
    flush() {
      parser_end(p);
      const tail = drain();
      // Re-open a parser so the streamer survives a FLUSH_SIGNAL —
      // post-flush deltas should be a clean parse, not a continuation.
      state = { out: [], skipDepth: 0 };
      stack = [];
      p = parser(makeRenderer(state));
      return tail;
    },
  };
}

export function createMarkdownStripper(): TextStage {
  return async function* stripper(input, signal) {
    const streamer = makeStreamer();
    let emittedChunks = 0;

    log.debug("enter", {});
    try {
      for await (const chunk of input) {
        if (signal.aborted) break;
        if (chunk === FLUSH_SIGNAL) {
          const tail = streamer.flush();
          if (tail.length > 0) {
            emittedChunks++;
            log.debug("chunk-on-flush", { outputLen: tail.length });
            yield tail;
          }
          yield FLUSH_SIGNAL;
          continue;
        }
        const out = streamer.feed(chunk);
        if (out.length > 0) {
          emittedChunks++;
          log.debug("chunk", { inputLen: chunk.length, outputLen: out.length });
          yield out;
        }
      }
      if (!signal.aborted) {
        const tail = streamer.flush();
        if (tail.length > 0) {
          emittedChunks++;
          yield tail;
        }
      }
    } finally {
      log.debug("exit", { emittedChunks });
    }
  } as TextStage;
}

// Re-export TtsChunk for symmetry with the prior public surface (some
// callers imported it from this module historically).
export type { TtsChunk };
