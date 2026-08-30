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
//
// SPEECH OUTLIVES ITS TURN. `end()` closes only the TEXT queue; the audio
// chained on `tail` keeps draining for as long as playback lasts — seconds
// after the loop committed its final entry and the turn settled. A turn that
// finishes NATURALLY never aborts its own controller, so that controller
// cannot carry a cancel gesture landing in the tail window. Each turn's audio
// therefore runs on its OWN AbortController, derived from (and aborted by)
// the turn's signal but reachable independently through `cancelAudio()`.
// Without that second handle the last stretch of every reply is
// un-cancellable: UI Stop and mic-onset barge-in do nothing server-side and
// the gateway keeps writing frames the user asked it to stop.
//
// `cancelAudio()` has exactly one caller — cancellation.ts, on a USER
// gesture. The gateway still never stops its own audio for a new turn
// (spec §4.6/§7.2); a new turn queues behind the old one on `tail`.

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
  /**
   * Stop every drain this session still has queued or in flight, NOW, and
   * report the turnIds that were cut (empty when nothing was speaking).
   *
   * The tail-window handle described in this file's header: it works whether
   * or not the turn is still in flight, because it aborts the audio's own
   * controller rather than the turn's. Never called on a new turn.
   *
   * Three callers, all of them "this speech has no audience any more": a user
   * cancel gesture (barge-in / interrupt), session teardown (`dispose`), and —
   * since derived retention let a session outlive its last window — the last
   * window detaching (`cutUnheardSpeech`). The caller owns the WHY; this method
   * logs only what it cut.
   */
  cancelAudio(): string[];
}

export interface TurnVoiceDeps {
  readonly synthesizer: TextStreamSynthesizer;
  readonly sink: TurnAudioSink;
  readonly echoGuard: MicEchoGuard;
  /**
   * Whether to speak this turn, resolved against the user's profile AT DRAIN
   * TIME — see user-audio-policy.ts. Async and awaited inside the tail rather
   * than at `begin()` for two reasons: `SessionRuntime.startTurn` is
   * deliberately synchronous (its store-seq snapshot must not be split by an
   * await), and the answer is most truthful at the last possible moment — a
   * mute landing during the PREVIOUS turn's playback silences this one.
   */
  readonly shouldSpeak: () => Promise<boolean>;
  /**
   * Whether anyone is attached to hear this session RIGHT NOW, read per turn.
   *
   * Separate from `shouldSpeak` because the two answer different questions and
   * each needs its own log line — "the user muted me" and "there is nobody in
   * the room" are not the same fallback, and a single gate would have to lie
   * about one of them. Since derived retention (task 8) a session outlives its
   * last window and keeps running turns while a background task completes, so
   * without this a background-completion turn synthesises a whole reply into
   * the void, occupying the single-threaded on-host TTS against other users'
   * real speech.
   */
  readonly hasAudience: () => boolean;
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

/** Mirror `source`'s abort onto `target`, now or when it happens. Lets a
 *  turn's own signal still kill its audio while leaving the audio a second,
 *  independently abortable handle for the tail window. */
function mirrorAbort(source: AbortSignal, target: AbortController): void {
  if (source.aborted) {
    target.abort();
    return;
  }
  source.addEventListener("abort", () => target.abort(), { once: true });
}

export function createTurnVoice(deps: TurnVoiceDeps): TurnVoice {
  // Serializes the audio DRAIN across turns — see the file header.
  let tail: Promise<void> = Promise.resolve();
  // turnId → the controller driving THAT turn's audio. An entry lives from
  // `begin()` until its drain settles, so the map IS the set of turns whose
  // speech a cancel gesture still has to reach — including turns that already
  // settled and turns whose drain is still queued behind an earlier one.
  const draining = new Map<string, AbortController>();

  return {
    begin(turnId, signal) {
      // `shouldSpeak` is NOT checked here — it is awaited in the tail below,
      // where the answer is read fresh. The two gates that remain are the ones
      // already true synchronously.
      if (!deps.hasAudience()) {
        log.info("turn-voice.silent", {
          sessionId: deps.sessionId,
          turnId,
          reason: "no window is attached — synthesising this turn would occupy the on-host TTS for zero listeners",
        });
        return SILENT_STREAM;
      }
      if (signal.aborted) {
        log.info("turn-voice.silent", { sessionId: deps.sessionId, turnId, reason: "turn already aborted" });
        return SILENT_STREAM;
      }

      const audio = new AbortController();
      mirrorAbort(signal, audio);
      draining.set(turnId, audio);

      const queue = createChunkQueue(audio.signal);
      // Constructed here, not after the `shouldSpeak` read below, so that a
      // turn's synthesis is bound at `begin()` and the cross-turn drain order
      // is decided by `tail` alone. Costs nothing for a turn that turns out to
      // be silent: `synthesize` returns a LAZY generator, so never iterating it
      // never opens an upstream local-tts session (see the file header).
      const frames = deps.synthesizer.synthesize(queue.stream, audio.signal);
      const flushedToolCalls = new Set<string>();
      const previous = tail;
      tail = (async () => {
        try {
          await previous;
        } catch {
          /* the prior turn's drain logged its own failure */
        }
        try {
          // Read here, not at `begin()`: this is the instant before audio would
          // leave, so a mute that landed while the previous turn was still
          // playing takes effect on this one. Returning without iterating
          // `frames` leaves the synthesizer's generator unstarted, so no
          // upstream session is ever opened for a silent turn.
          if (audio.signal.aborted || !(await deps.shouldSpeak())) {
            queue.close();
            log.info("turn-voice.silent", {
              sessionId: deps.sessionId,
              turnId,
              reason: audio.signal.aborted ? "cut before its drain began" : "profile audio prefs disable TTS",
            });
            return;
          }
          await drainAudio(deps, turnId, frames, audio.signal);
        } finally {
          // Only ever drop THIS turn's entry: `cancelAudio` may already have
          // cleared the map and a newer turn may already own its own slot.
          if (draining.get(turnId) === audio) draining.delete(turnId);
        }
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

    cancelAudio(): string[] {
      const cut = [...draining.keys()];
      for (const controller of draining.values()) controller.abort();
      draining.clear();
      log.info("turn-voice.audio.cancel", {
        sessionId: deps.sessionId,
        turnIds: cut,
        reason: "this session's speech has no audience any more — see the caller for which gesture",
      });
      return cut;
    },
  };
}
