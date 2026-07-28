// Pins three TurnVoice invariants (spec §4.7, §6, §7.2):
//   1. ONE FLUSH_SIGNAL per tool call. The loop's `onToolUpdate` fires on
//      every status transition (running → done/error, plus a second
//      "running" carrying taskId for background dispatch); the deleted
//      forkTextDeltas flushed once per tool START. Multiple flushes per call
//      make local-tts split a sentence mid-clause.
//   2. Turn N+1's audio NEVER interleaves with turn N's. One socket, one
//      binary stream, no per-frame turn id — the gateway must serialize.
//   3. An aborted turn emits NO turn.audio.done, and clears the mic echo
//      window (the user is speaking; their frames must reach STT now).

import { describe, expect, it } from "bun:test";
import { FLUSH_SIGNAL, type TtsChunk } from "../tts/stages/stage-types.js";
import type { AudioFrame, TextStreamSynthesizer } from "../tts/text-stream-synthesizer.js";
import type { MicEchoGuard, TurnAudioSink } from "./turn-voice.js";
import { createTurnVoice } from "./turn-voice.js";

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

const FRAME: AudioFrame = { data: new Uint8Array([9, 9]), encoding: "opus", sampleRate: 48000 };

interface FakeCall {
  chunks: TtsChunk[];
  emit(frame: AudioFrame): void;
  finish(): void;
}

interface FakeSynth {
  synthesizer: TextStreamSynthesizer;
  calls: FakeCall[];
}

function fakeSynthesizer(): FakeSynth {
  const calls: FakeCall[] = [];
  const synthesizer: TextStreamSynthesizer = {
    synthesize(textStream, signal) {
      const queued: AudioFrame[] = [];
      let deliver: ((frame: AudioFrame | null) => void) | null = null;
      // End-of-stream is STICKY. `finish()` may land while nothing is
      // awaiting (a drain still queued behind an earlier turn, or one that
      // has just been handed a frame and not yet re-armed), and a fake that
      // only resolves an armed waiter would leave that stream hanging
      // forever — hiding exactly the cross-turn ordering this test pins.
      let finished = false;
      const call: FakeCall = {
        chunks: [],
        emit(frame) {
          const d = deliver;
          if (d) {
            deliver = null;
            d(frame);
            return;
          }
          queued.push(frame);
        },
        finish() {
          finished = true;
          const d = deliver;
          deliver = null;
          d?.(null);
        },
      };
      calls.push(call);
      return (async function* () {
        // Mirror the real synthesizer: drain text in the background so
        // pushText() never blocks on frame consumption.
        void (async () => {
          for await (const chunk of textStream) call.chunks.push(chunk);
        })();
        while (!signal.aborted) {
          const next = queued.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (finished) return;
          const awaited = await new Promise<AudioFrame | null>((resolve) => {
            deliver = resolve;
            signal.addEventListener("abort", () => resolve(null), { once: true });
          });
          if (awaited === null) return;
          yield awaited;
        }
      })();
    },
  };
  return { synthesizer, calls };
}

interface SinkEvent {
  type: "start" | "frame" | "done";
  turnId: string;
}

function recordingSink(): { sink: TurnAudioSink; events: SinkEvent[] } {
  const events: SinkEvent[] = [];
  return {
    events,
    sink: {
      audioStart: (turnId) => events.push({ type: "start", turnId }),
      audioFrame: (turnId) => events.push({ type: "frame", turnId }),
      audioDone: (turnId) => events.push({ type: "done", turnId }),
    },
  };
}

function recordingGuard(): { guard: MicEchoGuard; started: string[]; cancelled: string[] } {
  const started: string[] = [];
  const cancelled: string[] = [];
  return {
    started,
    cancelled,
    guard: {
      onTtsStart: (turnId) => started.push(turnId),
      onTtsCancel: (turnId) => cancelled.push(turnId),
    },
  };
}

describe("createTurnVoice", () => {
  it("pushes exactly one FLUSH_SIGNAL per tool call, however many tool updates fire", async () => {
    const synth = fakeSynthesizer();
    const sink = recordingSink();
    const guard = recordingGuard();
    const voice = createTurnVoice({
      synthesizer: synth.synthesizer,
      sink: sink.sink,
      echoGuard: guard.guard,
      shouldSpeak: () => true,
      sessionId: "sess-1",
    });

    const controller = new AbortController();
    const speech = voice.begin("turn-a", controller.signal);
    speech.pushText("Let me check.");
    speech.flush("call-1"); // tool "running"
    speech.flush("call-1"); // same tool, "done"
    speech.flush("call-2"); // a second tool
    speech.end();
    await settle();
    synth.calls[0]?.finish(); // let the drain finish so no generator dangles

    expect(synth.calls[0]?.chunks).toEqual(["Let me check.", FLUSH_SIGNAL, FLUSH_SIGNAL]);
  });

  it("never emits a later turn's audio before the earlier turn's drain finishes", async () => {
    const synth = fakeSynthesizer();
    const sink = recordingSink();
    const guard = recordingGuard();
    const voice = createTurnVoice({
      synthesizer: synth.synthesizer,
      sink: sink.sink,
      echoGuard: guard.guard,
      shouldSpeak: () => true,
      sessionId: "sess-1",
    });

    const first = new AbortController();
    const second = new AbortController();
    const a = voice.begin("turn-a", first.signal);
    const b = voice.begin("turn-b", second.signal);
    a.pushText("first");
    a.end();
    b.pushText("second");
    b.end();

    // Turn B produces its audio FIRST — it still must not reach the socket.
    synth.calls[1]?.emit(FRAME);
    synth.calls[1]?.finish();
    await settle();
    expect(sink.events).toEqual([]);

    synth.calls[0]?.emit(FRAME);
    synth.calls[0]?.finish();
    await settle();

    expect(sink.events).toEqual([
      { type: "start", turnId: "turn-a" },
      { type: "frame", turnId: "turn-a" },
      { type: "done", turnId: "turn-a" },
      { type: "start", turnId: "turn-b" },
      { type: "frame", turnId: "turn-b" },
      { type: "done", turnId: "turn-b" },
    ]);
  });

  it("emits no audio.done and clears the mic echo window when the turn aborts", async () => {
    const synth = fakeSynthesizer();
    const sink = recordingSink();
    const guard = recordingGuard();
    const voice = createTurnVoice({
      synthesizer: synth.synthesizer,
      sink: sink.sink,
      echoGuard: guard.guard,
      shouldSpeak: () => true,
      sessionId: "sess-1",
    });

    const controller = new AbortController();
    const speech = voice.begin("turn-a", controller.signal);
    speech.pushText("I was saying");
    synth.calls[0]?.emit(FRAME);
    await settle();
    expect(guard.started).toEqual(["turn-a"]);

    controller.abort();
    await settle();

    expect(sink.events.some((e) => e.type === "done")).toBe(false);
    expect(guard.cancelled).toEqual(["turn-a"]);
  });

  it("synthesizes nothing when the user's profile has TTS off", async () => {
    const synth = fakeSynthesizer();
    const sink = recordingSink();
    const guard = recordingGuard();
    const voice = createTurnVoice({
      synthesizer: synth.synthesizer,
      sink: sink.sink,
      echoGuard: guard.guard,
      shouldSpeak: () => false,
      sessionId: "sess-1",
    });

    const controller = new AbortController();
    const speech = voice.begin("turn-a", controller.signal);
    speech.pushText("silence please");
    speech.end();
    await settle();

    expect(synth.calls).toEqual([]);
    expect(sink.events).toEqual([]);
  });
});
