import { getLog } from "../logging/logger.ts";
import type { TTSProvider } from "../providers/tts/tts-types.ts";
import { FLUSH_SIGNAL, type TtsChunk } from "./stages/stage-types.ts";
import type { AudioFrame, TextStreamSynthesizer } from "./text-stream-synthesizer.ts";

const log = getLog(["sentient", "tts", "streaming-tts-synthesizer"]);

// ---------------------------------------------------------------------------
// StreamingTtsSynthesizer — provider-neutral concrete TextStreamSynthesizer.
//
// Pipeline inside:
//   raw text deltas → TTSProvider.pushText (no aggregation, no stripping —
//   the local-tts service buffers the doc and cleans it service-side)
// Concurrent: provider.audioFrames(signal) drains as frames are produced.
//
// Depends only on the abstract TTSProvider (tts-types.ts), so it drives ANY
// provider behind that interface — the local LocalTTSService today.
// The handler (speak-effect.ts) sees only frames in / frames out.
// Provider-specific session management lives entirely in this file.
// ---------------------------------------------------------------------------

export interface StreamingTtsSynthesizerDeps {
  readonly sessionFactory: TTSSessionFactory;
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

  let frameCount = 0;

  // Background producer: forward raw text deltas → pushText. No aggregation,
  // no stripping — the local-tts service buffers the document and cleans it
  // service-side. We don't await this here; we drain frames in the foreground.
  const producer = (async () => {
    let firstPush = true;
    try {
      for await (const chunk of textStream) {
        if (signal.aborted) break;
        if (chunk === FLUSH_SIGNAL) continue; // service buffers + splits now
        if (chunk.length === 0) continue;

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
        log.debug("delta-push", { chars: chunk.length });
        session.pushText(chunk);
      }
    } catch (err: unknown) {
      log.error("producer-error", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      session.endInput();
      log.debug("producer-end-input");
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
      log.info("synthesize-aborted", { frameCount });
    } else {
      log.info("synthesize-done", { frameCount });
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
