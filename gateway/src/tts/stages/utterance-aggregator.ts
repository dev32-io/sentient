import { getLog } from "../../logging/logger.ts";
import { FLUSH_SIGNAL, type TtsChunk } from "./stage-types.ts";

const log = getLog(["sentient", "tts", "utterance-aggregator"]);

// ---------------------------------------------------------------------------
// UtteranceAggregator — buffers a text token stream and emits speakable
// "blocks" on paragraph boundaries.
//
// This is stage 1 of the speak effect's internal mini-pipeline:
//   LLM text deltas → UtteranceAggregator → TTS provider
//
// Splitting at paragraph level (not sentence level) preserves the TTS
// provider's built-in sentence-level prosody — it already handles
// inflection and micro-pauses within a paragraph. Splitting too
// aggressively fragments the audio and loses natural tone across the
// sentence arc.
//
// Boundaries:
//   1. Newline (\n)           — paragraph break / list marker, always splits.
//   2. FLUSH_SIGNAL           — out-of-band marker (e.g. tool-call interrupt).
//                               Flushes any buffered text immediately so a
//                               short pre-tool acknowledgement gets spoken
//                               without waiting for the model to resume text.
//   3. Max-length force-flush — at `maxBlockChars`, cut at the last space
//                               so a run-on generation still starts TTS.
//
// On stream end the remaining buffer flushes regardless of length —
// a short final reply ("Sure.") still gets spoken. On abort, the buffer
// is dropped (we don't speak cancelled words).
// ---------------------------------------------------------------------------

export interface UtteranceAggregatorOptions {
  readonly maxBlockChars: number;
}

/**
 * Consume `source` and yield utterance blocks.
 *
 * Respects `signal`: if aborted during consumption, returns immediately
 * without flushing remaining buffer.
 */
export async function* aggregateUtterances(
  source: AsyncIterable<TtsChunk>,
  opts: UtteranceAggregatorOptions,
  signal: AbortSignal,
): AsyncGenerator<string> {
  let buffer = "";
  let chunksReceived = 0;
  let blocksEmitted = 0;
  log.debug("start", { maxBlockChars: opts.maxBlockChars });

  for await (const chunk of source) {
    if (signal.aborted) {
      log.debug("abort-during-consume", { bufferedChars: buffer.length });
      return;
    }
    if (chunk === FLUSH_SIGNAL) {
      const block = buffer.trim();
      buffer = "";
      if (block.length > 0) {
        blocksEmitted += 1;
        log.debug("block-emit-flush", {
          index: blocksEmitted - 1,
          blockChars: block.length,
          preview: block.length <= 120 ? block : `${block.slice(0, 120)}…`,
        });
        yield block;
      } else {
        log.debug("flush-noop", { reason: "empty buffer" });
      }
      continue;
    }
    if (chunk.length === 0) continue;
    chunksReceived += 1;
    buffer += chunk;
    log.debug("chunk-received", {
      chunkChars: chunk.length,
      totalChunks: chunksReceived,
      bufferedChars: buffer.length,
    });

    while (true) {
      const boundary = findBoundary(buffer, opts);
      if (boundary === -1) break;
      const block = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary).trimStart();
      if (block.length > 0) {
        blocksEmitted += 1;
        log.debug("block-emit", {
          index: blocksEmitted - 1,
          blockChars: block.length,
          remainingBufferChars: buffer.length,
          preview: block.length <= 120 ? block : `${block.slice(0, 120)}…`,
        });
        yield block;
      }
    }
  }

  if (signal.aborted) {
    log.debug("abort-before-flush", { bufferedChars: buffer.length, blocksEmitted });
    return;
  }
  const tail = buffer.trim();
  if (tail.length > 0) {
    blocksEmitted += 1;
    log.debug("block-flush-tail", {
      index: blocksEmitted - 1,
      blockChars: tail.length,
      preview: tail.length <= 120 ? tail : `${tail.slice(0, 120)}…`,
    });
    yield tail;
  }
  log.info("complete", { chunksReceived, blocksEmitted });
}

// ---------------------------------------------------------------------------
// Boundary detection
// ---------------------------------------------------------------------------

/**
 * Return the slice-end index of the earliest valid boundary, or -1 if
 * the buffer should keep growing. A "valid boundary" is the position
 * AFTER the boundary character.
 */
function findBoundary(buffer: string, opts: UtteranceAggregatorOptions): number {
  // Paragraph break: any newline splits. Consecutive newlines resolve to
  // separate empty blocks which are filtered out by the length-0 check
  // in the main loop, so `\n\n` behaves as one real boundary.
  const newlineIdx = buffer.indexOf("\n");
  if (newlineIdx !== -1) return newlineIdx + 1;

  // Safety valve for run-on generations with no paragraph break. Cut at
  // the last space so we don't bisect a word. If there's no space at
  // all, fall back to a hard cut at max.
  if (buffer.length >= opts.maxBlockChars) {
    const spaceIdx = buffer.lastIndexOf(" ", opts.maxBlockChars);
    return spaceIdx > 0 ? spaceIdx + 1 : opts.maxBlockChars;
  }

  return -1;
}
