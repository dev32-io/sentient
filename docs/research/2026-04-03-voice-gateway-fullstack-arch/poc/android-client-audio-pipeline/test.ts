import { RingBuffer, FrameAccumulator } from "./ring-buffer";
import { AudioPipeline, buildWireMessages, type WakeWordDetector } from "./audio-pipeline";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${name}`);
  } else {
    failed++;
    console.log(`  FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

function assertEq(actual: any, expected: any, name: string) {
  const eq = typeof actual === "object" && actual !== null
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : actual === expected;
  assert(eq, name, eq ? undefined : `expected ${expected}, got ${actual}`);
}

function makeBytes(length: number, startVal: number = 0): Uint8Array {
  const arr = new Uint8Array(length);
  for (let i = 0; i < length; i++) arr[i] = (startVal + i) & 0xff;
  return arr;
}

// ============================================================
// 1. RING BUFFER TESTS (from decomposition test matrix)
// ============================================================
console.log("\n=== Ring Buffer Tests ===");

// Test: Write below capacity
{
  const rb = new RingBuffer(100);
  rb.write(makeBytes(50));
  const drained = rb.drain();
  assertEq(drained.length, 50, "Write below capacity: drain returns exact bytes");
  for (let i = 0; i < 50; i++) assert(drained[i] === (i & 0xff), `  byte[${i}] correct`);
}

// Test: Write at capacity
{
  const rb = new RingBuffer(100);
  rb.write(makeBytes(100));
  const drained = rb.drain();
  assertEq(drained.length, 100, "Write at capacity: drain returns exactly capacity bytes");
}

// Test: Write past capacity (wrap) — oldest overwritten
{
  const rb = new RingBuffer(100);
  rb.write(makeBytes(60, 0));   // bytes 0-59
  rb.write(makeBytes(60, 60));  // bytes 60-119 — wraps, overwrites first 20
  const drained = rb.drain();
  assertEq(drained.length, 100, "Write past capacity: drain returns capacity bytes");
  // Should contain bytes 20-119 (most recent 100 bytes)
  assert(drained[0] === 20, "Write past capacity: oldest byte is 20");
  assert(drained[99] === 119, "Write past capacity: newest byte is 119");
  // Verify all bytes in sequence
  let allCorrect = true;
  for (let i = 0; i < 100; i++) {
    if (drained[i] !== ((20 + i) & 0xff)) { allCorrect = false; break; }
  }
  assert(allCorrect, "Write past capacity: all bytes in correct order");
}

// Test: Drain empty buffer
{
  const rb = new RingBuffer(100);
  const drained = rb.drain();
  assertEq(drained.length, 0, "Drain empty buffer: returns 0 bytes");
}

// Test: Drain after drain
{
  const rb = new RingBuffer(100);
  rb.write(makeBytes(50));
  rb.drain();
  const second = rb.drain();
  assertEq(second.length, 0, "Drain after drain: returns 0 bytes");
}

// Test: Write after drain
{
  const rb = new RingBuffer(100);
  rb.write(makeBytes(50, 0));
  rb.drain();
  rb.write(makeBytes(30, 100));
  const drained = rb.drain();
  assertEq(drained.length, 30, "Write after drain: returns only new data");
  assert(drained[0] === 100, "Write after drain: first byte is new data");
}

// Test: Byte order preserved
{
  const rb = new RingBuffer(100);
  const data = new Uint8Array([0x01, 0x00, 0xff, 0x7f]);
  rb.write(data);
  const drained = rb.drain();
  assert(
    drained[0] === 0x01 && drained[1] === 0x00 && drained[2] === 0xff && drained[3] === 0x7f,
    "Byte order preserved: [0x01,0x00,0xFF,0x7F]"
  );
}

// Test: Exact 2-second fill (64,000 bytes)
{
  const rb = new RingBuffer(64_000);
  rb.write(makeBytes(64_000));
  const drained = rb.drain();
  assertEq(drained.length, 64_000, "Exact 2-second fill: 64,000 bytes");
  assertEq(rb.size, 0, "Exact 2-second fill: buffer empty after drain");
}

// Test: Partial frame write
{
  const rb = new RingBuffer(100);
  rb.write(new Uint8Array([0xAA])); // single byte
  rb.write(new Uint8Array([0xBB, 0xCC]));
  const drained = rb.drain();
  assertEq(drained.length, 3, "Partial frame write: 3 bytes");
  assert(drained[0] === 0xAA && drained[1] === 0xBB && drained[2] === 0xCC, "Partial frame write: correct bytes");
}

// Test: Duration calculation
{
  const rb = new RingBuffer(64_000);
  rb.write(makeBytes(32_000)); // 1 second of audio
  assertEq(rb.durationMs, 1000, "Duration: 32,000 bytes = 1000ms");
}

// Test: Multiple wraps
{
  const rb = new RingBuffer(10);
  for (let i = 0; i < 35; i++) rb.write(new Uint8Array([i & 0xff]));
  const drained = rb.drain();
  assertEq(drained.length, 10, "Multiple wraps: capacity bytes");
  assert(drained[0] === 25, "Multiple wraps: oldest = 25");
  assert(drained[9] === 34, "Multiple wraps: newest = 34");
}

// ============================================================
// 2. FRAME ACCUMULATOR TESTS
// ============================================================
console.log("\n=== Frame Accumulator Tests ===");

// Test: Exact frame size input
{
  const acc = new FrameAccumulator(512);
  const data = makeBytes(1024); // exactly 512 samples * 2 bytes
  const frames = acc.feed(data);
  assertEq(frames.length, 1, "Exact frame: produces 1 frame");
  assertEq(frames[0].length, 1024, "Exact frame: frame is 1024 bytes");
  assertEq(acc.pending, 0, "Exact frame: no pending bytes");
}

// Test: Half frame input
{
  const acc = new FrameAccumulator(512);
  const frames = acc.feed(makeBytes(512)); // 256 samples
  assertEq(frames.length, 0, "Half frame: no complete frames");
  assertEq(acc.pending, 512, "Half frame: 512 bytes pending");
}

// Test: Accumulation across calls
{
  const acc = new FrameAccumulator(512);
  acc.feed(makeBytes(512));
  const frames = acc.feed(makeBytes(512));
  assertEq(frames.length, 1, "Accumulation: second half completes frame");
  assertEq(acc.pending, 0, "Accumulation: no pending after complete frame");
}

// Test: Variable chunk sizes (128, 256, 640 samples)
{
  const acc = new FrameAccumulator(512);
  const allFrames: Uint8Array[] = [];
  // 128 samples = 256 bytes
  allFrames.push(...acc.feed(makeBytes(256)));
  // 256 samples = 512 bytes
  allFrames.push(...acc.feed(makeBytes(512)));
  // 640 samples = 1280 bytes (512 + 128 leftover)
  allFrames.push(...acc.feed(makeBytes(1280)));
  assertEq(allFrames.length, 2, "Variable chunks: 2 complete frames from 1024 samples total");
  assertEq(acc.pending, 0, "Variable chunks: no pending (exactly 1024 samples = 2 frames)");
}

// Test: Large input producing multiple frames
{
  const acc = new FrameAccumulator(512);
  const frames = acc.feed(makeBytes(5120)); // 2560 samples = 5 frames
  assertEq(frames.length, 5, "Large input: 5 frames from 5120 bytes");
  assertEq(acc.pending, 0, "Large input: no pending");
}

// Test: ByteArray race condition — frames are independent copies
{
  const acc = new FrameAccumulator(4); // 4 samples = 8 bytes for easy testing
  const data1 = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]); // frame 1
  const data2 = new Uint8Array([5, 0, 6, 0, 7, 0, 8, 0]); // frame 2
  const frames1 = acc.feed(data1);
  const frames2 = acc.feed(data2);
  // Frame 1 must NOT be mutated by frame 2 (race condition fix)
  assert(frames1[0][0] === 1, "Race condition fix: frame1[0] still 1 after frame2 written");
  assert(frames2[0][0] === 5, "Race condition fix: frame2[0] is 5");
  assert(frames1[0][4] === 3, "Race condition fix: frame1 data intact");
}

// ============================================================
// 3. AUDIO PIPELINE TESTS
// ============================================================
console.log("\n=== Audio Pipeline Tests ===");

function makeMockDetector(triggerOnFrame?: number): WakeWordDetector {
  let frameCount = 0;
  return {
    process(_frame: Int16Array): number {
      frameCount++;
      return frameCount === triggerOnFrame ? 0 : -1;
    }
  };
}

// Test: No detection — continuous buffering
{
  const pipeline = new AudioPipeline(makeMockDetector(), 64_000);
  // Feed 10 frames (each 1024 bytes = 512 samples)
  for (let i = 0; i < 10; i++) pipeline.onAudioData(makeBytes(1024));
  const events = pipeline.drainEvents();
  assertEq(events.length, 0, "No detection: no events emitted");
  assertEq(pipeline.bufferSize, 10240, "No detection: buffer accumulates");
  assert(!pipeline.isStreaming, "No detection: not streaming");
}

// Test: Detection triggers drain + session start
{
  const pipeline = new AudioPipeline(makeMockDetector(3), 64_000);
  // Feed 5 frames
  for (let i = 0; i < 5; i++) pipeline.onAudioData(makeBytes(1024));
  const events = pipeline.drainEvents();
  // Frame 3 triggers detection. Events should be:
  // 1. wake_word (with pre-trigger from frames 1-3)
  // 2. audio_frame (frame 4)
  // 3. audio_frame (frame 5)
  assert(events.length >= 1, "Detection: at least 1 event");
  assert(events[0].type === "wake_word", "Detection: first event is wake_word");
  if (events[0].type === "wake_word") {
    assert(events[0].pretriggerData.length > 0, "Detection: has pre-trigger data");
    assert(events[0].pretriggerMs > 0, "Detection: pretriggerMs > 0");
  }
  assert(pipeline.isStreaming, "Detection: pipeline is streaming");
}

// Test: Post-detection frames are forwarded
{
  const pipeline = new AudioPipeline(makeMockDetector(1), 64_000);
  pipeline.onAudioData(makeBytes(1024)); // triggers detection
  pipeline.onAudioData(makeBytes(1024)); // should be forwarded
  pipeline.onAudioData(makeBytes(1024)); // should be forwarded
  const events = pipeline.drainEvents();
  const audioFrames = events.filter(e => e.type === "audio_frame");
  assertEq(audioFrames.length, 2, "Post-detection: 2 audio frames forwarded");
}

// Test: Silence ends streaming
{
  const pipeline = new AudioPipeline(makeMockDetector(1), 64_000);
  pipeline.onAudioData(makeBytes(1024));
  pipeline.onSilence();
  const events = pipeline.drainEvents();
  const silenceEvents = events.filter(e => e.type === "silence_detected");
  assertEq(silenceEvents.length, 1, "Silence: ends streaming");
  assert(!pipeline.isStreaming, "Silence: pipeline stopped streaming");
}

// Test: Rapid double-trigger debounce
{
  const detector: WakeWordDetector = {
    _count: 0,
    process(_frame: Int16Array): number {
      (this as any)._count++;
      // Trigger on frames 1 and 2 (rapid succession)
      return ((this as any)._count === 1 || (this as any)._count === 2) ? 0 : -1;
    }
  };
  const pipeline = new AudioPipeline(detector, 64_000, 500);
  const now = 1000;
  pipeline.onAudioData(makeBytes(1024), now);       // frame 1: detect
  pipeline.onSilence();                              // end session
  pipeline.onAudioData(makeBytes(1024), now + 100);  // frame 2: detect within debounce
  const events = pipeline.drainEvents();
  const wakeEvents = events.filter(e => e.type === "wake_word");
  assertEq(wakeEvents.length, 1, "Debounce: only 1 wake_word event for rapid triggers");
}

// Test: Pre-trigger size accuracy (1.5s of audio)
{
  const pipeline = new AudioPipeline(makeMockDetector(48), 64_000);
  // 48 frames * 1024 bytes = 49,152 bytes = 1.536 seconds
  for (let i = 0; i < 48; i++) pipeline.onAudioData(makeBytes(1024));
  const events = pipeline.drainEvents();
  if (events[0]?.type === "wake_word") {
    // Pre-trigger should be ~48KB (all frames written before drain)
    assert(events[0].pretriggerData.length > 0, "Pre-trigger accuracy: has data");
    const expectedMs = events[0].pretriggerData.length / 32;
    assertEq(events[0].pretriggerMs, expectedMs, "Pre-trigger accuracy: ms matches byte count");
  }
}

// Test: Ring buffer wraps correctly at capacity
{
  const pipeline = new AudioPipeline(makeMockDetector(100), 64_000);
  // Write 100 frames = 102,400 bytes (exceeds 64KB capacity)
  for (let i = 0; i < 100; i++) pipeline.onAudioData(makeBytes(1024));
  const events = pipeline.drainEvents();
  if (events[0]?.type === "wake_word") {
    assertEq(events[0].pretriggerData.length, 64_000, "Buffer wrap: pre-trigger capped at capacity");
    assertEq(events[0].pretriggerMs, 2000, "Buffer wrap: 2000ms pre-trigger");
  }
}

// ============================================================
// 4. WIRE PROTOCOL MESSAGE CONSTRUCTION
// ============================================================
console.log("\n=== Wire Protocol Tests ===");

// Test: Full session produces correct message sequence
{
  const pipeline = new AudioPipeline(makeMockDetector(1), 64_000);
  pipeline.onAudioData(makeBytes(1024)); // triggers
  pipeline.onAudioData(makeBytes(1024)); // live frame
  pipeline.onSilence();
  const events = pipeline.drainEvents();
  const messages = buildWireMessages(events);

  assert(messages.length >= 3, "Wire: at least 3 messages (json + binary + json)");
  assert(messages[0].type === "json", "Wire: first message is JSON");
  assertEq(messages[0].data.type, "session.start", "Wire: session.start");
  assertEq(messages[0].data.encoding, "pcm_s16le", "Wire: encoding is pcm_s16le");
  assertEq(messages[0].data.sample_rate, 16000, "Wire: sample_rate is 16000");

  // Find the audio.end message
  const endMsg = messages.find(m => m.type === "json" && m.data.type === "audio.end");
  assert(endMsg !== undefined, "Wire: audio.end message present");
}

// ============================================================
// 5. BYTEARRAY RACE CONDITION — DETAILED TEST
// ============================================================
console.log("\n=== ByteArray Race Condition Test ===");

{
  // Simulate the race: audio thread writes to shared buffer, consumer reads later.
  // Without copy, consumer sees mutated data.
  const acc = new FrameAccumulator(4); // 4 samples = 8 bytes

  // Write frame 1
  const chunk1 = new Uint8Array([10, 0, 20, 0, 30, 0, 40, 0]);
  const frames1 = acc.feed(chunk1);
  const frame1Copy = frames1[0]; // This should be an independent copy

  // Write frame 2 (reuses internal buffer)
  const chunk2 = new Uint8Array([50, 0, 60, 0, 70, 0, 80, 0]);
  const frames2 = acc.feed(chunk2);

  // frame1Copy should NOT have been mutated by frame 2
  assert(frame1Copy[0] === 10, "Race: frame1[0] still 10");
  assert(frame1Copy[2] === 20, "Race: frame1[2] still 20");
  assert(frame1Copy[4] === 30, "Race: frame1[4] still 30");
  assert(frame1Copy[6] === 40, "Race: frame1[6] still 40");

  // frame 2 should have its own data
  assert(frames2[0][0] === 50, "Race: frame2[0] is 50");
  assert(frames2[0][6] === 80, "Race: frame2[6] is 80");

  console.log("  ByteArray race condition: FIXED by copy-on-emit in FrameAccumulator");
}

// ============================================================
// 6. PERFORMANCE BENCHMARKS
// ============================================================
console.log("\n=== Performance Benchmarks ===");

{
  // Ring buffer write throughput
  const rb = new RingBuffer(64_000);
  const chunk = makeBytes(1024);
  const iterations = 100_000;

  const start = performance.now();
  for (let i = 0; i < iterations; i++) rb.write(chunk);
  const elapsed = performance.now() - start;
  const perOp = (elapsed / iterations) * 1000; // microseconds
  console.log(`  Ring buffer write: ${perOp.toFixed(3)} us/op (${iterations} ops in ${elapsed.toFixed(1)}ms)`);
  assert(perOp < 10, `Ring buffer write < 10us/op (got ${perOp.toFixed(3)}us)`);
}

{
  // Ring buffer drain throughput
  const rb = new RingBuffer(64_000);
  const chunk = makeBytes(1024);
  const iterations = 10_000;

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    // Fill then drain
    for (let j = 0; j < 63; j++) rb.write(chunk); // ~63KB
    rb.drain();
  }
  const elapsed = performance.now() - start;
  const perOp = (elapsed / iterations) * 1000;
  console.log(`  Ring buffer fill+drain (64KB): ${perOp.toFixed(1)} us/op (${iterations} ops in ${elapsed.toFixed(1)}ms)`);
  assert(perOp < 200, `Ring buffer fill+drain < 200us/op (got ${perOp.toFixed(1)}us)`);
}

{
  // Frame accumulator throughput
  const acc = new FrameAccumulator(512);
  const chunk = makeBytes(1024);
  const iterations = 100_000;

  const start = performance.now();
  for (let i = 0; i < iterations; i++) acc.feed(chunk);
  const elapsed = performance.now() - start;
  const perOp = (elapsed / iterations) * 1000;
  console.log(`  Frame accumulator: ${perOp.toFixed(3)} us/op (${iterations} ops in ${elapsed.toFixed(1)}ms)`);
  assert(perOp < 10, `Frame accumulator < 10us/op (got ${perOp.toFixed(3)}us)`);
}

{
  // Full pipeline throughput (simulating real-time 16kHz audio)
  const detector = makeMockDetector(); // never triggers
  const pipeline = new AudioPipeline(detector, 64_000);
  const chunk = makeBytes(1024); // 32ms of audio
  const iterations = 100_000; // ~3200 seconds of simulated audio

  const start = performance.now();
  for (let i = 0; i < iterations; i++) pipeline.onAudioData(chunk);
  const elapsed = performance.now() - start;
  const perOp = (elapsed / iterations) * 1000;
  const realtimeRatio = 32 / (perOp / 1000); // how many x faster than real-time
  console.log(`  Full pipeline (no detection): ${perOp.toFixed(3)} us/op, ${realtimeRatio.toFixed(0)}x real-time`);
  assert(realtimeRatio > 100, `Pipeline > 100x real-time (got ${realtimeRatio.toFixed(0)}x)`);
}

// ============================================================
// SUMMARY
// ============================================================
console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.log("SOME TESTS FAILED");
  process.exit(1);
} else {
  console.log("ALL TESTS PASSED");
}
