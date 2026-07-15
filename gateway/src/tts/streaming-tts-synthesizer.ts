import { getLog } from "../logging/logger.ts";
import type { TTSProvider } from "../providers/tts/tts-types.ts";
import type { TtsChunk } from "./stages/stage-types.ts";
import { type UtteranceAggregatorOptions, aggregateUtterances } from "./stages/utterance-aggregator.ts";
import type { AudioFrame, TextStreamSynthesizer } from "./text-stream-synthesizer.ts";

const log = getLog(["sentient", "tts", "streaming-tts-synthesizer"]);

// ---------------------------------------------------------------------------
// StreamingTtsSynthesizer — provider-neutral concrete TextStreamSynthesizer.
//
// Pipeline inside:
//   text deltas → UtteranceAggregator → TTSProvider.pushText
// Concurrent: provider.audioFrames(signal) drains as frames are produced.
//
// Depends only on the abstract TTSProvider (tts-types.ts), so it drives ANY
// provider behind that interface — the local LocalTTSService today.
// The handler (speak-effect.ts) sees only frames in / frames out.
// Aggregation, paragraph separators, and provider-specific session
// management live entirely in this file.
// ---------------------------------------------------------------------------

export interface StreamingTtsSynthesizerDeps {
  readonly sessionFactory: TTSSessionFactory;
  /** Builds a per-session aggregator options bag. Called once per synthesize() run. */
  readonly aggregator: () => UtteranceAggregatorOptions;
}

export interface TTSSessionFactory {
  createSession(): Promise<TTSProvider>;
}

export function createStreamingTtsSynthesizer(deps: StreamingTtsSynthesizerDeps): TextStreamSynthesizer {
  return {
    synthesize(textStream: AsyncIterable<TtsChunk>, signal: AbortSignal): AsyncIterable<AudioFrame> {
      return synthesizeImpl(textStream, signal, deps);
    },
  };
}

async function* synthesizeImpl(
  textStream: AsyncIterable<TtsChunk>,
  signal: AbortSignal,
  deps: StreamingTtsSynthesizerDeps,
): AsyncGenerator<AudioFrame> {
  log.info("synthesize-start");
  if (signal.aborted) {
    log.debug("aborted-before-start");
    return;
  }

  const session = await deps.sessionFactory.createSession();
  session.warmup();

  let blocksFed = 0;
  let frameCount = 0;

  // Background producer: aggregate text deltas → pushText.
  // We don't await this here; we drain frames in the foreground.
  const producer = (async () => {
    try {
      const blocks = aggregateUtterances(textStream, deps.aggregator(), signal);
      let firstPush = true;

      for await (const rawBlock of blocks) {
        if (signal.aborted) break;

        const cleaned = stripEdgePauses(rawBlock);
        if (cleaned.length === 0) {
          log.debug("block-skip-empty-after-strip", { blockIndex: blocksFed });
          continue;
        }

        if (firstPush) {
          try {
            await session.ready(signal);
          } catch (err: unknown) {
            log.error("session-ready-failed", {
              message: err instanceof Error ? err.message : String(err),
            });
            session.dispose();
            return;
          }
          firstPush = false;
        }

        // Re-introduce paragraph break for the provider's prosodic gap.
        const sent = `${cleaned}\n\n`;
        log.debug("block-push", {
          blockIndex: blocksFed,
          rawChars: rawBlock.length,
          sentChars: sent.length,
          preview: sent.length <= 120 ? sent : `${sent.slice(0, 120)}…`,
        });
        session.pushText(sent);
        blocksFed += 1;
      }
    } catch (err: unknown) {
      log.error("producer-error", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      session.endInput();
      log.debug("producer-end-input", { blocksFed });
    }
  })();

  try {
    for await (const chunk of session.audioFrames(signal)) {
      if (signal.aborted) break;
      const frame: AudioFrame = {
        data: chunk.data,
        encoding: chunk.encoding,
        sampleRate: chunk.sampleRate,
      };
      frameCount += 1;
      log.debug("frame-yield", { byteSize: frame.data.byteLength, encoding: frame.encoding });
      yield frame;
    }
  } finally {
    if (signal.aborted) {
      log.info("synthesize-aborted", { frameCount, blocksFed });
    } else {
      log.info("synthesize-done", { frameCount, blocksFed });
    }
    // Dispose after the drain loop completes — on abort AND on normal
    // completion alike. The local LocalTTSService — see
    // local-tts-provider.ts's "dispose-after-completion" CONTRACT — never
    // self-closes its connection; skipping dispose() on the
    // normal-completion path leaks the session for the process lifetime.
    // dispose() is idempotent, so calling it here is always safe.
    session.dispose();
    // Make sure producer exits. It listens to signal too.
    await producer.catch(() => {
      /* logged */
    });
  }
}

// ---------------------------------------------------------------------------
// Defensive pause-tag stripping at block edges.
// Emotion-tagging (which could inject pause tags) has been removed from this
// pipeline, but a raw LLM block could still contain literal pause-tag text —
// this strip is a safety net.
// ---------------------------------------------------------------------------

const PAUSE_TAG_NAME = /\[(?:pause|short pause|long pause|停顿 | 短停顿 | 长停顿)\]/i;
const LEADING_PAUSE_RE = new RegExp(`^(?:\\s*${PAUSE_TAG_NAME.source}\\s*)+`, "i");
const TRAILING_PAUSE_RE = new RegExp(`(?:\\s*${PAUSE_TAG_NAME.source}\\s*)+$`, "i");

function stripEdgePauses(s: string): string {
  return s.replace(LEADING_PAUSE_RE, "").replace(TRAILING_PAUSE_RE, "").trim();
}
