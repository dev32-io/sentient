/**
 * Gateway Pipeline Test Harness
 *
 * Tests the voice pipeline in complete isolation using mock providers.
 * Zero API keys, zero network, zero audio hardware.
 *
 * Categories:
 * 1. Stage isolation — sentence aggregator, TTS stage
 * 2. Happy path — full turn lifecycle
 * 3. Partial transcripts — relay during speech
 * 4. Multi-turn — sequential conversations
 * 5. Barge-in — interrupt during processing/speaking
 * 6. Provider failures — STT/LLM/TTS errors
 * 7. Lifecycle — start, destroy, reconnect
 * 8. Edge cases — empty input, rapid fire, double utterance
 */

import {
  createVoicePipeline,
  createSentenceAggregatorStage,
  createTTSStage,
  type FlowManager,
  type PipelineConfig,
} from "./pipeline";
import {
  createControllableSTT,
  createControllableLLM,
  createControllableTTS,
  createScriptedSTT,
  type ControllableSTT,
  type ControllableLLM,
  type ControllableTTS,
} from "./mock-providers";
import {
  EventCollector,
  describe,
  test,
  runTests,
  assert,
  assertEqual,
  assertIncludes,
  assertDeepEqual,
  delay,
  runFullTurn,
} from "./test-helpers";

// ─── Helpers ───

function setupPipeline(overrides?: Partial<{
  stt: any;
  llm: any;
  tts: any;
  systemPrompt: string;
}>): {
  pipeline: FlowManager;
  collector: EventCollector;
  stt: ControllableSTT;
  llm: ControllableLLM;
  tts: ControllableTTS;
} {
  const stt = overrides?.stt ?? createControllableSTT();
  const llm = overrides?.llm ?? createControllableLLM({ response: "Hello! Nice to meet you.", tokenDelayMs: 1 });
  const tts = overrides?.tts ?? createControllableTTS({ framesPerSentence: 2, frameDelayMs: 1 });
  const collector = new EventCollector();
  const pipeline = createVoicePipeline({
    stt,
    llm,
    tts,
    systemPrompt: overrides?.systemPrompt,
  });
  pipeline.on(collector.handler);
  return { pipeline, collector, stt, llm, tts };
}

async function startPipeline(p: ReturnType<typeof setupPipeline>) {
  await p.pipeline.start();
  await delay(5);
}

// ════════════════════════════════════════════════════════════════
// 1. STAGE ISOLATION
// ════════════════════════════════════════════════════════════════

describe("Stage Isolation", () => {
  describe("SentenceAggregatorStage", () => {
    test("aggregates tokens into sentences by punctuation", async () => {
      const stage = createSentenceAggregatorStage();
      const ac = new AbortController();
      const input = (async function* () {
        yield "Hello ";
        yield "there. ";
        yield "How are ";
        yield "you?";
      })();
      const sentences: string[] = [];
      for await (const s of stage(input, ac.signal)) {
        sentences.push(s);
      }
      assertEqual(sentences.length, 2, "sentence count");
      assertEqual(sentences[0], "Hello there.", "first sentence");
      assertEqual(sentences[1], "How are you?", "second sentence");
    });

    test("flushes remaining buffer when input ends", async () => {
      const stage = createSentenceAggregatorStage();
      const ac = new AbortController();
      const input = (async function* () {
        yield "No punctuation here";
      })();
      const sentences: string[] = [];
      for await (const s of stage(input, ac.signal)) {
        sentences.push(s);
      }
      assertEqual(sentences.length, 1, "flush count");
      assertEqual(sentences[0], "No punctuation here", "flushed text");
    });

    test("stops on abort signal", async () => {
      const stage = createSentenceAggregatorStage();
      const ac = new AbortController();
      const input = (async function* () {
        yield "First. ";
        ac.abort();
        yield "Second.";
      })();
      const sentences: string[] = [];
      for await (const s of stage(input, ac.signal)) {
        sentences.push(s);
      }
      assertEqual(sentences.length, 1, "aborted after first");
    });

    test("handles empty input", async () => {
      const stage = createSentenceAggregatorStage();
      const ac = new AbortController();
      const input = (async function* () {})();
      const sentences: string[] = [];
      for await (const s of stage(input, ac.signal)) {
        sentences.push(s);
      }
      assertEqual(sentences.length, 0, "empty input = no sentences");
    });

    test("handles multiple sentence endings in one token", async () => {
      const stage = createSentenceAggregatorStage();
      const ac = new AbortController();
      // "Hi! " ends with !, so first yield triggers a sentence
      const input = (async function* () {
        yield "Hi! ";
        yield "Bye!";
      })();
      const sentences: string[] = [];
      for await (const s of stage(input, ac.signal)) {
        sentences.push(s);
      }
      assertEqual(sentences.length, 2, "two sentences");
    });
  });

  describe("TTSStage", () => {
    test("synthesizes each sentence into audio frames", async () => {
      const tts = createControllableTTS({ framesPerSentence: 3, frameDelayMs: 1 });
      await tts.connect(new AbortController().signal);
      const stage = createTTSStage(tts);
      const ac = new AbortController();
      const input = (async function* () {
        yield "Hello.";
        yield "Goodbye.";
      })();
      const frames: Uint8Array[] = [];
      for await (const f of stage(input, ac.signal)) {
        frames.push(f);
      }
      assertEqual(frames.length, 6, "3 frames × 2 sentences");
      assertDeepEqual(tts.synthesizedSentences, ["Hello.", "Goodbye."], "sentences passed to TTS");
    });

    test("stops on abort signal mid-synthesis", async () => {
      const tts = createControllableTTS({ framesPerSentence: 100, frameDelayMs: 1 });
      await tts.connect(new AbortController().signal);
      const stage = createTTSStage(tts);
      const ac = new AbortController();
      const input = (async function* () {
        yield "Long sentence.";
      })();
      const frames: Uint8Array[] = [];
      setTimeout(() => ac.abort(), 10);
      for await (const f of stage(input, ac.signal)) {
        frames.push(f);
      }
      assert(frames.length < 100, `aborted early: got ${frames.length} frames`);
    });
  });
});

// ════════════════════════════════════════════════════════════════
// 2. HAPPY PATH
// ════════════════════════════════════════════════════════════════

describe("Happy Path", () => {
  test("full turn: utterance → partials → final → LLM → TTS → audio.done", async () => {
    const { pipeline, collector, stt } = setupPipeline();
    await startPipeline({ pipeline, collector, stt } as any);

    assertEqual(pipeline.state, "listening", "state after start");

    // User speaks
    pipeline.utteranceStart();
    pipeline.sendAudio(new Uint8Array([1, 2, 3]));
    pipeline.sendAudio(new Uint8Array([4, 5, 6]));

    // STT emits partials
    stt.emitPartial("hel");
    await delay(5);
    stt.emitPartial("hello");
    await delay(5);

    // User stops speaking
    pipeline.utteranceEnd();
    assert(stt.finalized, "STT finalize called");

    // STT emits final
    stt.emitFinal("hello there");
    await collector.waitForType("response.audio.done", 3000);

    // Verify event sequence
    const partials = collector.partialTexts();
    assertDeepEqual(partials, ["hel", "hello"], "partial transcripts relayed");

    const finals = collector.ofType("transcript.final");
    assertEqual(finals.length, 1, "one final transcript");
    assertEqual(finals[0].text, "hello there", "final text");

    assert(collector.audioFrameCount() > 0, "audio frames received");
    assert(collector.hasAudioDone(), "audio.done received");

    // State transitions: idle→listening→processing→speaking→listening
    const states = collector.stateSequence();
    assertIncludes(states, "listening", "went through listening");
    assertIncludes(states, "processing", "went through processing");
    assertIncludes(states, "speaking", "went through speaking");

    await pipeline.destroy();
  });

  test("scripted STT works for simple happy path", async () => {
    const stt = createScriptedSTT({ partials: ["hi"], finalText: "hi there" });
    const llm = createControllableLLM({ response: "Hey!", tokenDelayMs: 1 });
    const tts = createControllableTTS({ framesPerSentence: 2, frameDelayMs: 1 });
    const collector = new EventCollector();
    const pipeline = createVoicePipeline({ stt, llm, tts });
    pipeline.on(collector.handler);
    await pipeline.start();
    await delay(5);

    pipeline.utteranceStart();
    pipeline.sendAudio(new Uint8Array([1]));
    pipeline.utteranceEnd();

    await collector.waitForType("response.audio.done", 3000);
    assert(collector.hasAudioDone(), "scripted STT happy path complete");
    await pipeline.destroy();
  });

  test("audio chunks forwarded to STT provider", async () => {
    const { pipeline, collector, stt } = setupPipeline();
    await startPipeline({ pipeline, collector, stt } as any);

    pipeline.utteranceStart();
    pipeline.sendAudio(new Uint8Array([1]));
    pipeline.sendAudio(new Uint8Array([2]));
    pipeline.sendAudio(new Uint8Array([3]));

    assertEqual(stt.audioChunkCount, 3, "3 audio chunks forwarded");
    await pipeline.destroy();
  });

  test("response text deltas accumulate to full response", async () => {
    const { pipeline, collector, stt, llm } = setupPipeline();
    llm.setResponse(["Hello", "! ", "Nice ", "to ", "meet ", "you."]);
    await startPipeline({ pipeline, collector, stt, llm } as any);

    pipeline.utteranceStart();
    pipeline.utteranceEnd();
    stt.emitFinal("hi");
    await collector.waitForType("response.audio.done", 3000);

    const fullText = collector.fullResponseText();
    assertEqual(fullText, "Hello! Nice to meet you.", "accumulated text");
    assert(collector.ofType("response.text.done").length === 1, "text.done emitted");
    await pipeline.destroy();
  });
});

// ════════════════════════════════════════════════════════════════
// 3. PARTIAL TRANSCRIPTS
// ════════════════════════════════════════════════════════════════

describe("Partial Transcripts", () => {
  test("partials emitted in order during speech", async () => {
    const { pipeline, collector, stt } = setupPipeline();
    await startPipeline({ pipeline, collector, stt } as any);

    pipeline.utteranceStart();
    stt.emitPartial("h");
    await delay(5);
    stt.emitPartial("he");
    await delay(5);
    stt.emitPartial("hel");
    await delay(5);
    stt.emitPartial("hell");
    await delay(5);
    stt.emitPartial("hello");
    await delay(5);

    assertDeepEqual(collector.partialTexts(), ["h", "he", "hel", "hell", "hello"], "partials in order");
    await pipeline.destroy();
  });

  test("empty partial text used as fallback for final", async () => {
    const { pipeline, collector, stt } = setupPipeline();
    await startPipeline({ pipeline, collector, stt } as any);

    pipeline.utteranceStart();
    stt.emitPartial("hello world");
    await delay(5);
    pipeline.utteranceEnd();

    // Final with empty text — should use last partial as fallback
    stt.emitFinal("");
    await collector.waitForType("response.audio.done", 3000);

    const finals = collector.ofType("transcript.final");
    assertEqual(finals[0].text, "hello world", "fell back to partial text");
    await pipeline.destroy();
  });
});

// ════════════════════════════════════════════════════════════════
// 4. MULTI-TURN
// ════════════════════════════════════════════════════════════════

describe("Multi-Turn", () => {
  test("two sequential turns maintain conversation history", async () => {
    const { pipeline, collector, stt, llm } = setupPipeline({
      systemPrompt: "You are helpful.",
    });
    await startPipeline({ pipeline, collector, stt, llm } as any);

    // Turn 1
    pipeline.utteranceStart();
    pipeline.utteranceEnd();
    stt.emitFinal("hello");
    await collector.waitForType("response.audio.done", 3000);
    await delay(20);

    const turn1Messages = llm.lastMessages;
    assertEqual(turn1Messages[0].role, "system", "system prompt present");
    assertEqual(turn1Messages[1].role, "user", "user message");
    assertEqual(turn1Messages[1].content, "hello", "user content");

    collector.clear();

    // Turn 2
    pipeline.utteranceStart();
    pipeline.utteranceEnd();
    stt.emitFinal("how are you");
    await collector.waitForType("response.audio.done", 3000);
    await delay(20);

    // LLM should receive full history: system + user1 + assistant1 + user2
    const turn2Messages = llm.lastMessages;
    assert(turn2Messages.length >= 4, `history has ${turn2Messages.length} messages`);
    assertEqual(turn2Messages[0].role, "system", "system prompt preserved");
    assertEqual(turn2Messages[turn2Messages.length - 1].content, "how are you", "latest user message");
    assertEqual(llm.streamCount, 2, "two LLM calls");

    await pipeline.destroy();
  });

  test("state returns to listening between turns", async () => {
    const { pipeline, collector, stt } = setupPipeline();
    await startPipeline({ pipeline, collector, stt } as any);

    // Turn 1
    pipeline.utteranceStart();
    pipeline.utteranceEnd();
    stt.emitFinal("first");
    await collector.waitForType("response.audio.done", 3000);
    await delay(20);

    assertEqual(pipeline.state, "listening", "back to listening after turn 1");

    // Turn 2
    pipeline.utteranceStart();
    pipeline.utteranceEnd();
    stt.emitFinal("second");
    await collector.waitForType("response.audio.done", 3000);
    await delay(20);

    assertEqual(pipeline.state, "listening", "back to listening after turn 2");
    await pipeline.destroy();
  });
});

// ════════════════════════════════════════════════════════════════
// 5. BARGE-IN
// ════════════════════════════════════════════════════════════════

describe("Barge-In", () => {
  test("bargeIn during speaking aborts audio and returns to listening", async () => {
    const { pipeline, collector, stt, tts } = setupPipeline();
    // Slow TTS so we can barge in
    tts.setFramesPerSentence(100);
    const llm = createControllableLLM({ response: "Long response sentence.", tokenDelayMs: 1 });
    const pipeline2 = createVoicePipeline({
      stt, llm, tts,
    });
    const collector2 = new EventCollector();
    pipeline2.on(collector2.handler);
    await pipeline2.start();
    await delay(5);

    pipeline2.utteranceStart();
    pipeline2.utteranceEnd();
    stt.emitFinal("test");

    // Wait for speaking state
    await collector2.waitForState("speaking", 2000);
    await delay(10);

    // Barge in!
    pipeline2.bargeIn();
    await delay(10);

    assertEqual(pipeline2.state, "listening", "state after barge-in");

    // Audio frames should have stopped (fewer than 100)
    assert(collector2.audioFrameCount() < 100, "audio stopped early");

    await pipeline2.destroy();
  });

  test("utteranceStart during speaking acts as implicit barge-in", async () => {
    const { pipeline, collector, stt, tts, llm } = setupPipeline();
    tts.setFramesPerSentence(100);
    await startPipeline({ pipeline, collector, stt, llm, tts } as any);

    pipeline.utteranceStart();
    pipeline.utteranceEnd();
    stt.emitFinal("test");

    await collector.waitForState("speaking", 2000);
    await delay(10);

    // Start new utterance during speaking = implicit barge-in
    pipeline.utteranceStart();
    await delay(10);

    assertEqual(pipeline.state, "listening", "implicit barge-in → listening");
    await pipeline.destroy();
  });
});

// ════════════════════════════════════════════════════════════════
// 6. PROVIDER FAILURES
// ════════════════════════════════════════════════════════════════

describe("Provider Failures", () => {
  test("LLM error emits error event and transitions to error state", async () => {
    const { pipeline, collector, stt, llm } = setupPipeline();
    llm.setError(new Error("LLM rate limited"));
    await startPipeline({ pipeline, collector, stt, llm } as any);

    pipeline.utteranceStart();
    pipeline.utteranceEnd();
    stt.emitFinal("test");

    await collector.waitFor((e) => e.type === "error", 2000);

    assert(collector.hasError(), "error event emitted");
    assertEqual(collector.errors()[0].code, "pipeline.turn_failed", "error code");
    assert(collector.errors()[0].message.includes("LLM rate limited"), "error message");
    assertEqual(pipeline.state, "error", "state is error");

    await pipeline.destroy();
  });

  test("TTS error emits error event", async () => {
    const { pipeline, collector, stt, tts } = setupPipeline();
    tts.setError(new Error("TTS connection lost"));
    await startPipeline({ pipeline, collector, stt, tts } as any);

    pipeline.utteranceStart();
    pipeline.utteranceEnd();
    stt.emitFinal("test");

    await collector.waitFor((e) => e.type === "error", 2000);

    assert(collector.hasError(), "TTS error surfaced");
    assert(collector.errors()[0].message.includes("TTS connection lost"), "TTS error message");

    await pipeline.destroy();
  });

  test("STT disconnect doesn't crash pipeline", async () => {
    const { pipeline, collector, stt } = setupPipeline();
    await startPipeline({ pipeline, collector, stt } as any);

    // STT fails during transcription
    stt.fail(new Error("STT dropped"));
    await delay(20);

    // Pipeline should still be alive (session not destroyed)
    // Trying utteranceStart shouldn't throw
    try {
      pipeline.utteranceStart();
    } catch {
      assert(false, "utteranceStart should not throw after STT failure");
    }

    await pipeline.destroy();
  });
});

// ════════════════════════════════════════════════════════════════
// 7. LIFECYCLE
// ════════════════════════════════════════════════════════════════

describe("Lifecycle", () => {
  test("start() connects STT and TTS providers", async () => {
    const stt = createControllableSTT();
    const tts = createControllableTTS();
    const pipeline = createVoicePipeline({
      stt,
      llm: createControllableLLM(),
      tts,
    });
    await pipeline.start();

    assert(stt.connected, "STT connected");
    assert(tts.connected, "TTS connected");

    await pipeline.destroy();
  });

  test("destroy() disconnects all providers", async () => {
    const stt = createControllableSTT();
    const tts = createControllableTTS();
    const pipeline = createVoicePipeline({
      stt,
      llm: createControllableLLM(),
      tts,
    });
    await pipeline.start();
    await pipeline.destroy();

    assert(!stt.connected, "STT disconnected");
    assert(!tts.connected, "TTS disconnected");
    assertEqual(pipeline.state, "idle", "state after destroy");
  });

  test("destroy() mid-turn aborts processing", async () => {
    const { pipeline, collector, stt, tts } = setupPipeline();
    tts.setFramesPerSentence(1000); // Very slow TTS
    await startPipeline({ pipeline, collector, stt, tts } as any);

    pipeline.utteranceStart();
    pipeline.utteranceEnd();
    stt.emitFinal("test");

    await collector.waitForState("speaking", 2000);

    // Destroy mid-turn
    await pipeline.destroy();
    assertEqual(pipeline.state, "idle", "state after mid-turn destroy");
    assert(collector.audioFrameCount() < 1000, "audio stopped before all frames");
  });

  test("unsubscribe handler stops receiving events", async () => {
    const { pipeline, stt } = setupPipeline();
    let count = 0;
    const unsub = pipeline.on(() => { count++; });
    await pipeline.start();
    await delay(5);

    // Got at least the state.changed event
    const countAfterStart = count;
    unsub();

    // These events should not reach the handler
    pipeline.utteranceStart();
    pipeline.utteranceEnd();
    stt.emitFinal("test");
    await delay(50);

    assertEqual(count, countAfterStart, "no events after unsubscribe");
    await pipeline.destroy();
  });
});

// ════════════════════════════════════════════════════════════════
// 8. EDGE CASES
// ════════════════════════════════════════════════════════════════

describe("Edge Cases", () => {
  test("utteranceEnd without utteranceStart still works (STT handles it)", async () => {
    const { pipeline, collector, stt } = setupPipeline();
    await startPipeline({ pipeline, collector, stt } as any);

    // Skip utteranceStart, go straight to end
    pipeline.utteranceEnd();
    assert(stt.finalized, "STT finalize called");
    await pipeline.destroy();
  });

  test("sendAudio before start doesn't crash", async () => {
    const { pipeline } = setupPipeline();
    // No crash expected
    pipeline.sendAudio(new Uint8Array([1, 2, 3]));
    await pipeline.destroy();
  });

  test("double destroy is safe", async () => {
    const { pipeline } = setupPipeline();
    await pipeline.start();
    await pipeline.destroy();
    await pipeline.destroy(); // second destroy should be safe
    assertEqual(pipeline.state, "idle", "still idle after double destroy");
  });

  test("rapid sequential utterances don't crash", async () => {
    const { pipeline, collector, stt } = setupPipeline();
    await startPipeline({ pipeline, collector, stt } as any);

    // Fire off rapid utterances
    for (let i = 0; i < 5; i++) {
      pipeline.utteranceStart();
      pipeline.sendAudio(new Uint8Array([i]));
      pipeline.utteranceEnd();
    }

    // Emit final for the last one
    stt.emitFinal("rapid test");
    await delay(100);

    // Pipeline should not have crashed
    assert(
      pipeline.state === "listening" ||
      pipeline.state === "processing" ||
      pipeline.state === "speaking",
      `valid state after rapid fire: ${pipeline.state}`
    );
    await pipeline.destroy();
  });

  test("very long response text is fully captured", async () => {
    const { pipeline, collector, stt, llm } = setupPipeline();
    // 200 tokens
    const longTokens = Array.from({ length: 200 }, (_, i) => `word${i} `);
    longTokens[longTokens.length - 1] = "end.";
    llm.setResponse(longTokens);
    await startPipeline({ pipeline, collector, stt, llm } as any);

    pipeline.utteranceStart();
    pipeline.utteranceEnd();
    stt.emitFinal("test");
    await collector.waitForType("response.audio.done", 5000);

    assertEqual(collector.ofType("response.text.delta").length, 200, "all 200 tokens received");
    assert(collector.ofType("response.text.done").length === 1, "text.done emitted");
    await pipeline.destroy();
  });

  test("pipeline handles single-word response (no sentence boundary)", async () => {
    const { pipeline, collector, stt, llm } = setupPipeline();
    llm.setResponse(["OK"]);
    await startPipeline({ pipeline, collector, stt, llm } as any);

    pipeline.utteranceStart();
    pipeline.utteranceEnd();
    stt.emitFinal("test");
    await collector.waitForType("response.audio.done", 3000);

    // "OK" has no sentence-ending punctuation, should be flushed by aggregator
    const fullText = collector.fullResponseText();
    assertEqual(fullText, "OK", "single word captured");
    assert(collector.audioFrameCount() > 0, "audio frames for flushed text");
    await pipeline.destroy();
  });
});

// ════════════════════════════════════════════════════════════════
// 9. PRESENCE INDICATORS (no silent gaps)
// ════════════════════════════════════════════════════════════════

describe("Presence Indicators", () => {
  test("every state transition emits state.changed event", async () => {
    const { pipeline, collector, stt } = setupPipeline();
    await startPipeline({ pipeline, collector, stt } as any);

    pipeline.utteranceStart();
    pipeline.utteranceEnd();
    stt.emitFinal("test");
    await collector.waitForType("response.audio.done", 3000);
    await delay(20);

    const stateChanges = collector.ofType("state.changed");
    assert(stateChanges.length >= 3, `at least 3 state changes, got ${stateChanges.length}`);

    // No two consecutive states should be the same (no-op transitions filtered)
    for (let i = 1; i < stateChanges.length; i++) {
      assert(
        stateChanges[i].from !== stateChanges[i].to,
        `no self-transition: ${stateChanges[i].from} → ${stateChanges[i].to}`
      );
    }

    await pipeline.destroy();
  });

  test("processing state is entered before speaking", async () => {
    const { pipeline, collector, stt } = setupPipeline();
    await startPipeline({ pipeline, collector, stt } as any);

    pipeline.utteranceStart();
    pipeline.utteranceEnd();
    stt.emitFinal("test");
    await collector.waitForType("response.audio.done", 3000);

    const states = collector.stateSequence();
    const procIdx = states.indexOf("processing");
    const speakIdx = states.indexOf("speaking");
    assert(procIdx >= 0, "processing state reached");
    assert(speakIdx >= 0, "speaking state reached");
    assert(procIdx < speakIdx, "processing before speaking");

    await pipeline.destroy();
  });

  test("audio.done marks end of assistant speech", async () => {
    const { pipeline, collector, stt } = setupPipeline();
    await startPipeline({ pipeline, collector, stt } as any);

    pipeline.utteranceStart();
    pipeline.utteranceEnd();
    stt.emitFinal("test");
    await collector.waitForType("response.audio.done", 3000);

    // audio.done should be the last audio-related event
    const lastAudioIdx = collector.events.map((e, i) => ({ e, i }))
      .filter(({ e }) => e.type === "response.audio.frame" || e.type === "response.audio.done")
      .pop();
    assert(lastAudioIdx!.e.type === "response.audio.done", "audio.done is last audio event");

    await pipeline.destroy();
  });
});

// ─── Run ───

runTests();
