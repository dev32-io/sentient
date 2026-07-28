// TurnVoice (spec §6, §4.7, §7.2) — the fork from the native loop's text
// deltas into the TTS pipeline, and the session's outbound audio serializer.
//
// Composition: built at the WS layer (ws-session-configure.ts, which knows
// the socket, the emitter, and the user's profile) and handed to
// SessionRuntime, which calls `begin(turnId, signal)` with the TURN'S OWN
// AbortSignal. That signal ownership is the whole point: barge-in and
// interrupt abort the turn's controller (cancellation.ts), and TTS dies with
// it at no extra cost. A TTS controller minted anywhere else would survive
// both gestures and keep the assistant talking over the user.
//
// Audio serialization: one WebSocket carries one binary stream and the frame
// header has no turn id, so two turns draining at once would interleave
// frames between one `turn.audio.start` and the next. Each `begin()` chains
// its drain behind the previous turn's — the gateway side of §7.2's "queue,
// don't replace". A new turn NEVER cancels in-flight audio (spec §4.6/§7.2:
// the gateway never stops its own audio); only the user does, via abort.
// Text still buffers immediately, so nothing about the text path waits.
//
// `TextStreamSynthesizer.synthesize` returns a LAZY async generator (see
// streaming-tts-synthesizer.ts) — the upstream local-tts session is not
// created until the first `next()`. A turn aborted while its drain is still
// queued therefore never opens a socket at all.

import { getLog } from "../logging/logger.js";
import { FLUSH_SIGNAL, type TtsChunk } from "../tts/stages/stage-types.js";
import type { AudioFrame, TextStreamSynthesizer } from "../tts/text-stream-synthesizer.js";

const log = getLog(["sentient", "runtime", "turn-voice"]);

/** Outbound audio frames, narrowed to what this module needs. `TurnEmitter`
 *  (turn-emitter.ts) satisfies it structurally. */
export interface TurnAudioSink {
  audioStart(turnId: string, encoding: "opus" | "pcm", sampleRate: number): void;
  audioFrame(turnId: string, data: Uint8Array): void;
  audioDone(turnId: string): void;
}

/** Mic suppression around a TTS window. Declared here (not in
 *  session-handlers/) so the dependency points inward: the WS-layer
 *  implementation (mic-echo-guard.ts) imports this type, never the reverse. */
export interface MicEchoGuard {
  onTtsStart(turnId: string): void;
  onTtsCancel(turnId: string): void;
}

export interface TurnVoiceStream {
  /** One assistant text delta from the loop. */
  pushText(text: string): void;
  /**
   * The loop paused text to call a tool — tell local-tts to speak what it
   * has buffered instead of holding a short pre-tool acknowledgement
   * ("Let me check.") for the whole tool round-trip. IDEMPOTENT per
   * `toolCallId`: `onToolUpdate` fires on every status transition, and a
   * second flush mid-tool-call would split the sentence again.
   */
  flush(toolCallId: string): void;
  /** No more text this turn — lets the synthesizer finalize its tail. */
  end(): void;
}

export interface TurnVoice {
  begin(turnId: string, signal: AbortSignal): TurnVoiceStream;
}

export interface TurnVoiceDeps {
  readonly synthesizer: TextStreamSynthesizer;
  readonly sink: TurnAudioSink;
  readonly echoGuard: MicEchoGuard;
  /** Read per turn — the user's profile.json audio prefs. */
  readonly shouldSpeak: () => boolean;
  readonly sessionId: string;
}

const SILENT_STREAM: TurnVoiceStream = {
  pushText() {},
  flush() {},
  end() {},
};

interface ChunkQueue {
  readonly stream: AsyncIterable<TtsChunk>;
  push(chunk: TtsChunk): void;
  close(): void;
}

/** Text-delta queue feeding the synthesizer. Ends on abort as well as on
 *  `close()`: the synthesizer's producer loop only re-checks `signal.aborted`
 *  when the text stream yields, so a turn aborted mid-silence would otherwise
 *  leave it awaiting a chunk that never comes. */
function createChunkQueue(signal: AbortSignal): ChunkQueue {
  const items: TtsChunk[] = [];
  let pending: ((result: IteratorResult<TtsChunk>) => void) | null = null;
  let closed = false;

  function close(): void {
    if (closed) return;
    closed = true;
    const resolve = pending;
    pending = null;
    resolve?.({ value: undefined, done: true });
  }

  signal.addEventListener("abort", close, { once: true });

  return {
    stream: {
      [Symbol.asyncIterator](): AsyncIterator<TtsChunk> {
        return {
          next(): Promise<IteratorResult<TtsChunk>> {
            const next = items.shift();
            if (next !== undefined) return Promise.resolve({ value: next, done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise<IteratorResult<TtsChunk>>((resolve) => {
              pending = resolve;
            });
          },
        };
      },
    },
    push(chunk) {
      if (closed) return;
      const resolve = pending;
      if (resolve) {
        pending = null;
        resolve({ value: chunk, done: false });
        return;
      }
      items.push(chunk);
    },
    close,
  };
}

/** The provider yields "opus" today (local-tts-provider.ts's LIVE_ENCODING).
 *  The wire contract admits exactly "opus" | "pcm", so narrow here rather
 *  than widening the frame schema. */
function toWireEncoding(raw: string, turnId: string): "opus" | "pcm" {
  if (raw === "opus") return "opus";
  if (raw === "pcm") return "pcm";
  log.warn("turn-voice.audio.unknown-encoding", {
    turnId,
    encoding: raw,
    reason: "provider encoding outside the wire contract — declaring pcm",
  });
  return "pcm";
}

async function drainAudio(
  deps: TurnVoiceDeps,
  turnId: string,
  frames: AsyncIterable<AudioFrame>,
  signal: AbortSignal,
): Promise<void> {
  const { sink, echoGuard, sessionId } = deps;
  const beganAtMs = Date.now();
  let started = false;
  let frameCount = 0;
  let bytesSent = 0;

  try {
    if (signal.aborted) {
      log.info("turn-voice.drain.skipped", { sessionId, turnId, reason: "aborted while queued behind a prior turn" });
      return;
    }
    for await (const frame of frames) {
      if (signal.aborted) return;
      if (!started) {
        started = true;
        // Suppress the mic for the AEC convergence window at the exact
        // moment audio starts leaving — not when synthesis started, which
        // may have been queued behind a previous turn.
        echoGuard.onTtsStart(turnId);
        const encoding = toWireEncoding(frame.encoding, turnId);
        sink.audioStart(turnId, encoding, frame.sampleRate);
        log.info("turn-voice.audio.start", {
          sessionId,
          turnId,
          encoding,
          sampleRate: frame.sampleRate,
          firstFrameMs: Date.now() - beganAtMs,
        });
      }
      sink.audioFrame(turnId, frame.data);
      frameCount += 1;
      bytesSent += frame.data.byteLength;
      log.debug("turn-voice.audio.frame", {
        sessionId,
        turnId,
        frameIndex: frameCount,
        byteSize: frame.data.byteLength,
      });
    }
    if (started && !signal.aborted) {
      sink.audioDone(turnId);
      log.info("turn-voice.audio.done", {
        sessionId,
        turnId,
        frameCount,
        bytesSent,
        elapsedMs: Date.now() - beganAtMs,
      });
    }
  } catch (err: unknown) {
    log.warn("turn-voice.drain.failed", {
      sessionId,
      turnId,
      frameCount,
      reason: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (signal.aborted) {
      // Barge-in / interrupt: the user is talking NOW. Clear the echo window
      // instead of leaving the mic muted for the rest of the cooldown.
      echoGuard.onTtsCancel(turnId);
      log.info("turn-voice.audio.cancelled", { sessionId, turnId, frameCount, bytesSent });
    }
  }
}

export function createTurnVoice(deps: TurnVoiceDeps): TurnVoice {
  // Serializes the audio DRAIN across turns — see the file header.
  let tail: Promise<void> = Promise.resolve();

  return {
    begin(turnId, signal) {
      if (!deps.shouldSpeak()) {
        log.info("turn-voice.silent", { sessionId: deps.sessionId, turnId, reason: "profile audio prefs disable TTS" });
        return SILENT_STREAM;
      }
      if (signal.aborted) {
        log.info("turn-voice.silent", { sessionId: deps.sessionId, turnId, reason: "turn already aborted" });
        return SILENT_STREAM;
      }

      const queue = createChunkQueue(signal);
      const frames = deps.synthesizer.synthesize(queue.stream, signal);
      const flushedToolCalls = new Set<string>();
      const previous = tail;
      tail = (async () => {
        try {
          await previous;
        } catch {
          /* the prior turn's drain logged its own failure */
        }
        await drainAudio(deps, turnId, frames, signal);
      })();

      log.info("turn-voice.begin", { sessionId: deps.sessionId, turnId });

      return {
        pushText(text) {
          queue.push(text);
        },
        flush(toolCallId) {
          if (flushedToolCalls.has(toolCallId)) return;
          flushedToolCalls.add(toolCallId);
          log.debug("turn-voice.flush", { sessionId: deps.sessionId, turnId, toolCallId });
          queue.push(FLUSH_SIGNAL);
        },
        end() {
          queue.close();
          log.debug("turn-voice.end", { sessionId: deps.sessionId, turnId });
        },
      };
    },
  };
}
