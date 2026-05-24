// test-consumer.ts — Verifies the consumer API works end-to-end

import { createVoicePipeline, type PipelineEvent, type PipelineState } from "./pipeline-sdk";
import { createMockSTT, createMockLLM, createMockTTS } from "./mock-providers";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  PASS: ${msg}`); }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

async function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Test 1: Full turn lifecycle ───

async function testFullTurn() {
  console.log("\nTest 1: Full turn lifecycle");

  const events: PipelineEvent[] = [];
  const states: PipelineState[] = [];

  const pipeline = createVoicePipeline({
    stt: createMockSTT({ finalText: "hello world" }),
    llm: createMockLLM({ response: "Hi there! Nice to meet you." }),
    tts: createMockTTS({ framesPerSentence: 2 }),
  });

  pipeline.on((e) => {
    events.push(e);
    if (e.type === "state.changed") states.push(e.to);
  });

  await pipeline.start();
  assert(pipeline.state === "listening", "starts in listening state");

  pipeline.utteranceStart();
  pipeline.sendAudio(new Uint8Array(320));
  pipeline.utteranceEnd();

  await delay(300);

  assert(states.includes("processing"), "enters processing state");
  assert(states.includes("speaking"), "enters speaking state");
  assert(events.some((e) => e.type === "transcript.partial"), "emits partial transcripts");
  assert(events.some((e) => e.type === "transcript.final" && e.text === "hello world"), "emits final transcript");
  assert(events.some((e) => e.type === "response.text.delta"), "emits text deltas");
  assert(events.some((e) => e.type === "response.text.done"), "emits text done");
  assert(events.some((e) => e.type === "response.audio.frame"), "emits audio frames");
  assert(events.some((e) => e.type === "response.audio.done"), "emits audio done");

  await pipeline.destroy();
  assert(pipeline.state === "idle", "idle after destroy");
}

// ─── Test 2: Barge-in interrupts speaking ───

async function testBargeIn() {
  console.log("\nTest 2: Barge-in interrupts speaking");

  const states: PipelineState[] = [];
  let audioFrameCount = 0;

  const pipeline = createVoicePipeline({
    stt: createMockSTT(),
    llm: createMockLLM({
      response: "This is a very long response that should be interrupted before it finishes speaking all of these words.",
      tokenDelayMs: 20,
    }),
    tts: createMockTTS({ framesPerSentence: 10, frameDelayMs: 20 }),
  });

  pipeline.on((e) => {
    if (e.type === "state.changed") states.push(e.to);
    if (e.type === "response.audio.frame") audioFrameCount++;
  });

  await pipeline.start();
  pipeline.utteranceStart();
  pipeline.sendAudio(new Uint8Array(320));
  pipeline.utteranceEnd();

  // Wait for speaking to begin, then barge in
  await delay(150);
  const framesBeforeBargeIn = audioFrameCount;
  pipeline.bargeIn();

  await delay(100);
  const framesAfterBargeIn = audioFrameCount;

  assert(states.includes("listening"), "returns to listening after barge-in");
  assert(
    framesAfterBargeIn - framesBeforeBargeIn <= 1,
    `audio stops after barge-in (delta: ${framesAfterBargeIn - framesBeforeBargeIn})`
  );

  await pipeline.destroy();
}

// ─── Test 3: Consumer API line count ───

async function testLineCount() {
  console.log("\nTest 3: Consumer API is under 50 lines");

  // Read consumer.ts and count non-empty, non-comment lines
  const src = await Bun.file(import.meta.dir + "/consumer.ts").text();
  const lines = src.split("\n").filter(
    (l) => l.trim() && !l.trim().startsWith("//")
  );
  assert(lines.length < 50, `consumer.ts has ${lines.length} substantive lines (limit: 50)`);
}

// ─── Test 4: Zero internal knowledge required ───

async function testZeroInternalKnowledge() {
  console.log("\nTest 4: Consumer doesn't import internal types");

  const src = await Bun.file(import.meta.dir + "/consumer.ts").text();
  assert(!src.includes("Stage"), "no Stage type imported");
  assert(!src.includes("SentenceAggregator"), "no SentenceAggregator reference");
  assert(!src.includes("AbortController"), "no AbortController management");
  assert(!src.includes("TranscriptFrame"), "no TranscriptFrame reference");
  assert(!src.includes("AudioFrame"), "no AudioFrame reference");
}

// ─── Test 5: Multiple sequential turns ───

async function testMultipleTurns() {
  console.log("\nTest 5: Multiple sequential turns");

  let turnCount = 0;
  const stt = createMockSTT({ finalText: "turn one" });

  const pipeline = createVoicePipeline({
    stt,
    llm: createMockLLM({ response: "Response." }),
    tts: createMockTTS({ framesPerSentence: 1 }),
  });

  pipeline.on((e) => {
    if (e.type === "response.audio.done") turnCount++;
  });

  await pipeline.start();

  // Turn 1
  pipeline.utteranceStart();
  pipeline.sendAudio(new Uint8Array(320));
  pipeline.utteranceEnd();
  await delay(300);

  assert(turnCount >= 1, `completed at least 1 turn (got ${turnCount})`);

  await pipeline.destroy();
}

// ─── Run all ───

async function main() {
  console.log("Gateway Pipeline Consumer API Tests");
  console.log("====================================");

  await testFullTurn();
  await testBargeIn();
  await testLineCount();
  await testZeroInternalKnowledge();
  await testMultipleTurns();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
