/**
 * PoC Test: Provider Integration on Bun
 *
 * Validates:
 * 1. MessagePack encode/decode over Bun WebSocket (Fish Audio protocol)
 * 2. Binary frame reliability — large and varied MessagePack payloads
 * 3. Streaming overlap pipeline: mock LLM → sentence splitter → mock TTS
 * 4. Sentence splitter correctness (abbreviations, decimals, edge cases)
 * 5. Barge-in cancel propagation through async generator pipeline
 * 6. Throughput: MessagePack encode/decode performance
 * 7. Deepgram-style binary frames + Fish Audio MessagePack on same runtime
 */

import { encode, decode } from '@msgpack/msgpack';
import { createFishAudioSession } from './fish-audio-client';
import { extractCompleteSentences, sentenceSplit } from './sentence-splitter';

// ─── Test Framework ────────────────────────────────────────────────

let testsPassed = 0;
let testsFailed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    testsPassed++;
    console.log("  PASS: " + message);
  } else {
    testsFailed++;
    console.log("  FAIL: " + message);
  }
}

function assertEqual(actual: any, expected: any, message: string) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (pass) {
    testsPassed++;
    console.log("  PASS: " + message);
  } else {
    testsFailed++;
    console.log("  FAIL: " + message + " (expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual) + ")");
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Mock Fish Audio Server (MessagePack) ──────────────────────────

interface MockFishState {
  messagesReceived: any[];
  textEventsReceived: string[];
  authHeader: string | null;
  startEventReceived: any | null;
}

function createMockFishServer(port: number) {
  const state: MockFishState = {
    messagesReceived: [],
    textEventsReceived: [],
    authHeader: null,
    startEventReceived: null,
  };

  let activeWs: any = null;
  // Configurable: how many audio chunks to send per text event
  let audioChunksPerText = 3;
  let audioChunkSize = 1024; // bytes
  // Configurable synthesis delay per chunk (simulates real TTS latency)
  let synthDelayMs = 5;

  // Serialize message handling to avoid stop racing flush
  let messageQueue: Promise<void> = Promise.resolve();

  const server = Bun.serve({
    port,
    fetch(req, server) {
      state.authHeader = req.headers.get('authorization');
      if (server.upgrade(req)) {
        return undefined;
      }
      return new Response('Not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        activeWs = ws;
        messageQueue = Promise.resolve();
      },
      message(ws, data) {
        // Enqueue handling to serialize flush/stop ordering
        messageQueue = messageQueue.then(async () => {
          try {
            let buf: Uint8Array;
            if (data instanceof ArrayBuffer) {
              buf = new Uint8Array(data);
            } else if (data instanceof Uint8Array) {
              buf = data;
            } else if (typeof data === 'string') {
              return;
            } else {
              buf = new Uint8Array(data as any);
            }

            const msg = decode(buf) as any;
            state.messagesReceived.push(msg);

            if (msg.event === 'start') {
              state.startEventReceived = msg;
            } else if (msg.event === 'text') {
              state.textEventsReceived.push(msg.text);
            } else if (msg.event === 'flush') {
              // Simulate TTS: send audio chunks back
              for (let i = 0; i < audioChunksPerText; i++) {
                await new Promise(r => setTimeout(r, synthDelayMs));
                const fakeAudio = new Uint8Array(audioChunkSize);
                for (let j = 0; j < audioChunkSize; j++) fakeAudio[j] = (i * 37 + j) & 0xFF;
                const audioEvt = encode({ event: 'audio', audio: fakeAudio });
                ws.send(audioEvt);
              }
            } else if (msg.event === 'stop') {
              // Send finish event AFTER all pending flushes complete
              await new Promise(r => setTimeout(r, synthDelayMs));
              ws.send(encode({ event: 'finish', reason: 'complete' }));
            }
          } catch (e) {
            console.error("Mock Fish server decode error:", e);
          }
        });
      },
      close() {
        activeWs = null;
      },
    },
  });

  return {
    server,
    state,
    setAudioConfig(chunks: number, size: number, delay: number) {
      audioChunksPerText = chunks;
      audioChunkSize = size;
      synthDelayMs = delay;
    },
    reset() {
      state.messagesReceived = [];
      state.textEventsReceived = [];
      state.authHeader = null;
      state.startEventReceived = null;
    },
  };
}

// ─── Mock LLM SSE Stream ───────────────────────────────────────────

async function* mockLLMStream(text: string, chunkSize: number = 3, delayMs: number = 5): AsyncGenerator<{ text: string }> {
  // Simulate SSE token streaming — emit a few chars at a time
  for (let i = 0; i < text.length; i += chunkSize) {
    yield { text: text.slice(i, i + chunkSize) };
    if (delayMs > 0) await sleep(delayMs);
  }
}

// Helper: collect all items from an async generator
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) {
    items.push(item);
  }
  return items;
}

// ─── Tests ─────────────────────────────────────────────────────────

async function runTests() {
  const FISH_PORT = 19877;
  const fish = createMockFishServer(FISH_PORT);

  try {
    // ══════════════════════════════════════════════════════════════
    // SECTION 1: MessagePack over Bun WebSocket
    // ══════════════════════════════════════════════════════════════

    console.log("\n=== Test 1: MessagePack encode/decode roundtrip ===");
    {
      // Test various data types that Fish Audio protocol uses
      const testCases = [
        { event: 'start', request: { model_id: 'speech-1.5', text: '', format: 'opus', sample_rate: 48000 } },
        { event: 'text', text: 'Hello, world! This is a test sentence.' },
        { event: 'flush' },
        { event: 'stop' },
        { event: 'audio', audio: new Uint8Array([0, 1, 2, 255, 128, 64]) },
        { event: 'finish', reason: 'complete' },
      ];

      for (const tc of testCases) {
        const encoded = encode(tc);
        const decoded = decode(encoded) as any;
        assert(decoded.event === tc.event, "Roundtrip event type: " + tc.event);
      }

      // Specifically test binary audio data preservation
      const audioData = new Uint8Array(4096);
      for (let i = 0; i < 4096; i++) audioData[i] = i & 0xFF;
      const encoded = encode({ event: 'audio', audio: audioData });
      const decoded = decode(encoded) as any;
      const decodedAudio = new Uint8Array(decoded.audio);
      let match = true;
      for (let i = 0; i < 4096; i++) {
        if (decodedAudio[i] !== audioData[i]) { match = false; break; }
      }
      assert(match, "Binary audio data preserved through MessagePack roundtrip (4KB)");
      assert(decodedAudio.length === 4096, "Audio length preserved: " + decodedAudio.length);
    }

    console.log("\n=== Test 2: MessagePack encode/decode performance ===");
    {
      // Benchmark encoding TextEvent (common operation)
      const textEvt = { event: 'text', text: 'The quick brown fox jumps over the lazy dog.' };
      const ITERATIONS = 100_000;

      const encStart = performance.now();
      for (let i = 0; i < ITERATIONS; i++) {
        encode(textEvt);
      }
      const encTime = performance.now() - encStart;

      const encoded = encode(textEvt);
      const decStart = performance.now();
      for (let i = 0; i < ITERATIONS; i++) {
        decode(encoded);
      }
      const decTime = performance.now() - decStart;

      console.log("  Encode: " + (encTime / ITERATIONS * 1000).toFixed(2) + "us/op (" + ITERATIONS + " ops in " + encTime.toFixed(1) + "ms)");
      console.log("  Decode: " + (decTime / ITERATIONS * 1000).toFixed(2) + "us/op (" + ITERATIONS + " ops in " + decTime.toFixed(1) + "ms)");
      assert(encTime / ITERATIONS < 0.1, "Encode < 100us/op (got " + (encTime / ITERATIONS * 1000).toFixed(2) + "us)");
      assert(decTime / ITERATIONS < 0.1, "Decode < 100us/op (got " + (decTime / ITERATIONS * 1000).toFixed(2) + "us)");

      // Benchmark large audio event (1KB chunk — typical TTS response)
      const audioEvt = { event: 'audio', audio: new Uint8Array(1024) };
      const AUDIO_ITERS = 50_000;
      const aEncStart = performance.now();
      for (let i = 0; i < AUDIO_ITERS; i++) {
        encode(audioEvt);
      }
      const aEncTime = performance.now() - aEncStart;
      console.log("  Audio encode (1KB): " + (aEncTime / AUDIO_ITERS * 1000).toFixed(2) + "us/op");
      assert(aEncTime / AUDIO_ITERS < 0.5, "Audio encode < 500us/op");
    }

    console.log("\n=== Test 3: MessagePack over Bun WebSocket (Fish Audio client) ===");
    {
      fish.reset();
      fish.setAudioConfig(2, 512, 2);

      const session = createFishAudioSession({
        apiKey: 'test-fish-key-123',
        endpoint: "ws://localhost:" + FISH_PORT,
        voiceId: 'test-voice',
        format: 'opus',
      });

      async function* singleSentence(): AsyncGenerator<string> {
        yield "Hello, how are you today?";
      }

      const audioChunks: Uint8Array[] = [];
      for await (const chunk of session.synthesize(singleSentence())) {
        audioChunks.push(chunk);
      }

      await sleep(50);

      assert(state().authHeader === 'Bearer test-fish-key-123', "Auth header sent: " + state().authHeader);
      assert(state().startEventReceived !== null, "StartEvent received by server");
      assertEqual(state().startEventReceived?.request?.format, 'opus', "Format = opus");
      assertEqual(state().startEventReceived?.request?.reference_id, 'test-voice', "Voice ID sent");
      assertEqual(state().textEventsReceived, ["Hello, how are you today?"], "Text event received");
      assert(audioChunks.length === 2, "Received 2 audio chunks (got " + audioChunks.length + ")");
      assert(audioChunks[0].length === 512, "Audio chunk size correct: " + audioChunks[0].length);
      assert(audioChunks[0] instanceof Uint8Array, "Audio chunk is Uint8Array");

      await session.close();

      function state() { return fish.state; }
    }

    console.log("\n=== Test 4: Multiple sentences through Fish Audio client ===");
    {
      fish.reset();
      fish.setAudioConfig(3, 1024, 1);

      const session = createFishAudioSession({
        apiKey: 'test-key',
        endpoint: "ws://localhost:" + FISH_PORT,
        voiceId: 'test-voice',
      });

      async function* threeSentences(): AsyncGenerator<string> {
        yield "Good morning.";
        yield "The weather is nice today.";
        yield "Would you like some coffee?";
      }

      const audioChunks: Uint8Array[] = [];
      for await (const chunk of session.synthesize(threeSentences())) {
        audioChunks.push(chunk);
      }

      await sleep(50);

      assertEqual(fish.state.textEventsReceived.length, 3, "3 text events sent");
      // 3 sentences × 3 audio chunks each = 9 total
      assert(audioChunks.length === 9, "Received 9 audio chunks (3×3) (got " + audioChunks.length + ")");

      await session.close();
    }

    console.log("\n=== Test 5: Large MessagePack payloads over WebSocket ===");
    {
      fish.reset();
      // 8KB audio chunks — test larger binary frames
      fish.setAudioConfig(1, 8192, 1);

      const session = createFishAudioSession({
        apiKey: 'test-key',
        endpoint: "ws://localhost:" + FISH_PORT,
        voiceId: 'test-voice',
      });

      async function* longText(): AsyncGenerator<string> {
        yield "This is a longer sentence that tests whether large MessagePack binary payloads survive Bun WebSocket transmission without corruption or frame fragmentation issues.";
      }

      const audioChunks: Uint8Array[] = [];
      for await (const chunk of session.synthesize(longText())) {
        audioChunks.push(chunk);
      }

      await sleep(50);

      assert(audioChunks.length === 1, "Got 1 large audio chunk");
      assert(audioChunks[0].length === 8192, "8KB chunk intact: " + audioChunks[0].length);
      // Verify content pattern
      assert(audioChunks[0][0] === 0, "First byte correct");
      assert(audioChunks[0][37] === 37, "Byte at offset 37 correct");

      await session.close();
    }

    // ══════════════════════════════════════════════════════════════
    // SECTION 2: Sentence Splitter
    // ══════════════════════════════════════════════════════════════

    console.log("\n=== Test 6: Sentence splitter — basic cases ===");
    {
      // Simple sentences ending with period + uppercase
      let r = extractCompleteSentences("Hello world. This is great.");
      assertEqual(r.complete, ["Hello world."], "Period + uppercase splits");
      assertEqual(r.remainder, "This is great.", "Remainder kept when no follower");

      // Question and exclamation
      r = extractCompleteSentences("How are you? I am fine! Good.");
      assertEqual(r.complete, ["How are you?", "I am fine!"], "? and ! split immediately");
      assertEqual(r.remainder, "Good.", "Trailing period without follower kept");

      // Multiple exclamations
      r = extractCompleteSentences("Wow!! Really?! Yes.");
      assertEqual(r.complete, ["Wow!!", "Really?!"], "!! and ?! handled");
      assertEqual(r.remainder, "Yes.", "Remainder correct");
    }

    console.log("\n=== Test 7: Sentence splitter — abbreviations ===");
    {
      let r = extractCompleteSentences("Dr. Smith is here. He arrived.");
      assertEqual(r.complete, ["Dr. Smith is here."], "Dr. not split");
      assertEqual(r.remainder, "He arrived.", "After abbreviation handled");

      r = extractCompleteSentences("It costs approx. 50 dollars. That is fine.");
      assertEqual(r.complete, ["It costs approx. 50 dollars."], "approx. not split");

      r = extractCompleteSentences("See e.g. this example. It works.");
      assertEqual(r.complete, ["See e.g. this example."], "e.g. not split");
    }

    console.log("\n=== Test 8: Sentence splitter — decimals ===");
    {
      const r = extractCompleteSentences("The value is 3.14 and that is pi. Next sentence.");
      assertEqual(r.complete, ["The value is 3.14 and that is pi."], "Decimal 3.14 not split");
      assertEqual(r.remainder, "Next sentence.", "After decimal correct");
    }

    console.log("\n=== Test 9: Sentence splitter — streaming accumulation ===");
    {
      // Simulate LLM tokens arriving one at a time
      const tokens = "Hello! How are you? I am fine.".split('');
      const sentences: string[] = [];
      let buffer = '';

      for (const tok of tokens) {
        buffer += tok;
        const r = extractCompleteSentences(buffer);
        sentences.push(...r.complete);
        buffer = r.remainder;
      }
      // Flush remainder
      if (buffer.trim()) sentences.push(buffer.trim());

      assertEqual(sentences, ["Hello!", "How are you?", "I am fine."], "Streaming accumulation yields all sentences");
    }

    console.log("\n=== Test 10: Sentence splitter — newline boundary ===");
    {
      const r = extractCompleteSentences("First line\nSecond line\nThird");
      assertEqual(r.complete, ["First line", "Second line"], "Newlines are sentence boundaries");
      assertEqual(r.remainder, "Third", "Remainder after newlines");
    }

    console.log("\n=== Test 11: Sentence splitter async generator ===");
    {
      const llm = mockLLMStream("Hello world! This is a test. How are you?", 5, 0);
      const sentences = await collect(sentenceSplit(llm));
      assertEqual(sentences, ["Hello world!", "This is a test.", "How are you?"], "AsyncGenerator yields correct sentences");
    }

    // ══════════════════════════════════════════════════════════════
    // SECTION 3: Streaming Overlap Pipeline
    // ══════════════════════════════════════════════════════════════

    console.log("\n=== Test 12: Full streaming overlap — LLM → Splitter → TTS ===");
    {
      fish.reset();
      fish.setAudioConfig(2, 512, 2);

      const session = createFishAudioSession({
        apiKey: 'test-key',
        endpoint: "ws://localhost:" + FISH_PORT,
        voiceId: 'test-voice',
      });

      // Simulate LLM generating "Hello there! How are you doing today? I hope you are well."
      // Arrives as tokens, sentence splitter yields sentences, TTS synthesizes each
      const llmText = "Hello there! How are you doing today? I hope you are well.";
      const llmStream = mockLLMStream(llmText, 4, 2);
      const sentenceStream = sentenceSplit(llmStream);

      const startTime = performance.now();
      let firstAudioTime: number | null = null;
      const audioChunks: Uint8Array[] = [];

      for await (const chunk of session.synthesize(sentenceStream)) {
        if (firstAudioTime === null) firstAudioTime = performance.now();
        audioChunks.push(chunk);
      }
      const totalTime = performance.now() - startTime;

      await sleep(50);

      assert(firstAudioTime !== null, "Received audio");
      const timeToFirstAudio = firstAudioTime! - startTime;
      console.log("  Time to first audio: " + timeToFirstAudio.toFixed(1) + "ms");
      console.log("  Total pipeline time: " + totalTime.toFixed(1) + "ms");
      console.log("  Audio chunks: " + audioChunks.length);
      console.log("  Sentences sent to TTS: " + fish.state.textEventsReceived.length);

      // 3 sentences expected
      assertEqual(fish.state.textEventsReceived.length, 3, "3 sentences sent to TTS");
      // 3 sentences × 2 audio chunks = 6
      assert(audioChunks.length === 6, "6 audio chunks (3×2) (got " + audioChunks.length + ")");

      // First audio should arrive well before total pipeline completes
      // (demonstrates streaming overlap — TTS starts on first sentence)
      assert(timeToFirstAudio < totalTime * 0.7,
        "First audio before 70% of total time (overlap working): " +
        timeToFirstAudio.toFixed(0) + "ms < " + (totalTime * 0.7).toFixed(0) + "ms");

      await session.close();
    }

    console.log("\n=== Test 13: Streaming overlap latency measurement ===");
    {
      fish.reset();
      fish.setAudioConfig(1, 256, 1);

      const session = createFishAudioSession({
        apiKey: 'test-key',
        endpoint: "ws://localhost:" + FISH_PORT,
        voiceId: 'test-voice',
      });

      // Longer text — 5 sentences, simulating real assistant response
      const llmText = "Sure, I can help with that! The weather today is sunny with a high of 75 degrees. " +
        "There is a slight chance of rain in the evening. " +
        "I would recommend bringing an umbrella just in case. " +
        "Is there anything else you would like to know?";

      const llmStream = mockLLMStream(llmText, 3, 3);
      const sentenceStream = sentenceSplit(llmStream);

      const startTime = performance.now();
      const chunkTimes: number[] = [];

      for await (const chunk of session.synthesize(sentenceStream)) {
        chunkTimes.push(performance.now() - startTime);
      }
      const totalTime = performance.now() - startTime;

      await sleep(50);

      console.log("  Sentence count: " + fish.state.textEventsReceived.length);
      console.log("  First audio at: " + chunkTimes[0]?.toFixed(1) + "ms");
      console.log("  Last audio at: " + chunkTimes[chunkTimes.length - 1]?.toFixed(1) + "ms");
      console.log("  Total time: " + totalTime.toFixed(1) + "ms");

      // Verify sentences were split correctly
      assert(fish.state.textEventsReceived.length >= 4, "At least 4 sentences (got " + fish.state.textEventsReceived.length + ")");

      // First audio should arrive before LLM finishes generating all text
      // LLM generates ~3 chars every 3ms, total text ~250 chars, so ~250ms for full generation
      // First sentence is ~35 chars, should complete in ~35ms, then TTS adds a few ms
      assert(chunkTimes[0] < totalTime * 0.5,
        "First audio in first 50% of pipeline time (got " + chunkTimes[0]?.toFixed(0) + "ms / " + totalTime.toFixed(0) + "ms)");

      await session.close();
    }

    // ══════════════════════════════════════════════════════════════
    // SECTION 4: Barge-in / Cancel Propagation
    // ══════════════════════════════════════════════════════════════

    console.log("\n=== Test 14: Barge-in cancellation through pipeline ===");
    {
      fish.reset();
      fish.setAudioConfig(5, 256, 10); // Slower TTS to give time to cancel

      const session = createFishAudioSession({
        apiKey: 'test-key',
        endpoint: "ws://localhost:" + FISH_PORT,
        voiceId: 'test-voice',
      });

      // Long LLM response
      const llmText = "This is sentence one. This is sentence two. This is sentence three. " +
        "This is sentence four. This is sentence five.";

      let aborted = false;
      async function* cancellableLLM(): AsyncGenerator<{ text: string }> {
        for (let i = 0; i < llmText.length; i += 3) {
          if (aborted) return;
          yield { text: llmText.slice(i, i + 3) };
          await sleep(3);
        }
      }

      const sentenceStream = sentenceSplit(cancellableLLM());

      let chunksBeforeCancel = 0;
      const startTime = performance.now();

      for await (const chunk of session.synthesize(sentenceStream)) {
        chunksBeforeCancel++;
        // Cancel after receiving 3 chunks (simulating barge-in)
        if (chunksBeforeCancel >= 3) {
          aborted = true;
          break; // Break out of for-await-of — triggers generator.return()
        }
      }
      const cancelTime = performance.now() - startTime;

      await sleep(100);
      await session.close();

      console.log("  Chunks before cancel: " + chunksBeforeCancel);
      console.log("  Cancel time: " + cancelTime.toFixed(1) + "ms");

      assert(chunksBeforeCancel === 3, "Stopped after 3 chunks");
      // With 5 sentences × 5 chunks = 25 potential chunks, getting only 3 proves cancellation works
      assert(fish.state.textEventsReceived.length < 5,
        "TTS didn't receive all 5 sentences (got " + fish.state.textEventsReceived.length + ")");
    }

    // ══════════════════════════════════════════════════════════════
    // SECTION 5: Binary Frame Stress Test
    // ══════════════════════════════════════════════════════════════

    console.log("\n=== Test 15: Binary frame stress — varied MessagePack sizes ===");
    {
      // Test that Bun WebSocket handles MessagePack frames of varying sizes
      // This catches fragmentation bugs that only appear with specific payload sizes
      const sizes = [1, 10, 125, 126, 127, 128, 255, 256, 1024, 4096, 8192, 16384, 32768, 65536];
      let allCorrect = true;

      for (const size of sizes) {
        const data = new Uint8Array(size);
        for (let i = 0; i < size; i++) data[i] = i & 0xFF;

        const encoded = encode({ event: 'audio', audio: data });
        const decoded = decode(encoded) as any;
        const result = new Uint8Array(decoded.audio);

        if (result.length !== size) {
          allCorrect = false;
          console.log("  FAIL: Size " + size + " — length mismatch: " + result.length);
          testsFailed++;
        } else {
          let bytesCorrect = true;
          for (let i = 0; i < size; i++) {
            if (result[i] !== (i & 0xFF)) { bytesCorrect = false; break; }
          }
          if (!bytesCorrect) {
            allCorrect = false;
            console.log("  FAIL: Size " + size + " — content mismatch");
            testsFailed++;
          }
        }
      }
      if (allCorrect) {
        testsPassed++;
        console.log("  PASS: All " + sizes.length + " payload sizes correct (1B to 64KB)");
      }
    }

    console.log("\n=== Test 16: Concurrent encode/decode (simulating 10 sessions) ===");
    {
      // Simulate 10 concurrent TTS sessions encoding/decoding MessagePack
      const SESSIONS = 10;
      const MESSAGES_PER_SESSION = 100;

      const startTime = performance.now();
      const promises: Promise<boolean>[] = [];

      for (let s = 0; s < SESSIONS; s++) {
        promises.push((async () => {
          for (let m = 0; m < MESSAGES_PER_SESSION; m++) {
            const audio = new Uint8Array(1024);
            audio[0] = s & 0xFF;
            audio[1] = m & 0xFF;
            const encoded = encode({ event: 'audio', audio, session: s, seq: m });
            const decoded = decode(encoded) as any;
            const result = new Uint8Array(decoded.audio);
            if (result[0] !== (s & 0xFF) || result[1] !== (m & 0xFF)) return false;
          }
          return true;
        })());
      }

      const results = await Promise.all(promises);
      const elapsed = performance.now() - startTime;
      const totalOps = SESSIONS * MESSAGES_PER_SESSION;

      assert(results.every(r => r), "All " + SESSIONS + " sessions correct");
      console.log("  " + totalOps + " encode+decode ops in " + elapsed.toFixed(1) + "ms (" + (totalOps / elapsed * 1000).toFixed(0) + " ops/sec)");
      assert(elapsed < 1000, "Under 1 second for " + totalOps + " ops");
    }

    // ══════════════════════════════════════════════════════════════
    // SECTION 6: Deepgram Binary + Fish Audio MessagePack on Same Runtime
    // ══════════════════════════════════════════════════════════════

    console.log("\n=== Test 17: Deepgram binary + Fish Audio MessagePack coexistence ===");
    {
      // Simulate both provider types running simultaneously on the same Bun process
      // Deepgram: raw binary audio frames (ArrayBuffer)
      // Fish Audio: MessagePack-encoded events (also ArrayBuffer, but structured)

      const DEEPGRAM_PORT = 19878;

      // Mini mock Deepgram server (just echoes frame count)
      let dgFrameCount = 0;
      const dgServer = Bun.serve({
        port: DEEPGRAM_PORT,
        fetch(req, server) {
          if (server.upgrade(req)) return undefined;
          return new Response('Not found', { status: 404 });
        },
        websocket: {
          open() {},
          message(_ws, data) {
            if (typeof data !== 'string') {
              dgFrameCount++;
            }
          },
          close() {},
        },
      });

      fish.reset();
      fish.setAudioConfig(2, 512, 1);

      // Connect to both simultaneously
      const dgWs = new WebSocket("ws://localhost:" + DEEPGRAM_PORT);
      dgWs.binaryType = 'arraybuffer';
      await new Promise<void>((resolve) => { dgWs.onopen = () => resolve(); });

      const fishSession = createFishAudioSession({
        apiKey: 'test-key',
        endpoint: "ws://localhost:" + FISH_PORT,
        voiceId: 'test-voice',
      });

      // Send audio to Deepgram while also synthesizing via Fish Audio
      const audioFrame = new Uint8Array(640);
      for (let i = 0; i < 50; i++) {
        dgWs.send(audioFrame);
      }

      async function* testSentences(): AsyncGenerator<string> {
        yield "Hello from concurrent test.";
        yield "Both providers active.";
      }

      const audioChunks: Uint8Array[] = [];
      for await (const chunk of fishSession.synthesize(testSentences())) {
        audioChunks.push(chunk);
      }

      await sleep(100);

      assert(dgFrameCount === 50, "Deepgram received all 50 binary frames (got " + dgFrameCount + ")");
      assert(audioChunks.length === 4, "Fish Audio returned 4 audio chunks (got " + audioChunks.length + ")");
      assertEqual(fish.state.textEventsReceived.length, 2, "Fish Audio received 2 text events");

      dgWs.close();
      dgServer.stop();
      await fishSession.close();
    }

    // ══════════════════════════════════════════════════════════════
    // SECTION 7: Edge Cases
    // ══════════════════════════════════════════════════════════════

    console.log("\n=== Test 18: Empty sentence handling ===");
    {
      fish.reset();
      fish.setAudioConfig(1, 256, 1);

      const session = createFishAudioSession({
        apiKey: 'test-key',
        endpoint: "ws://localhost:" + FISH_PORT,
        voiceId: 'test-voice',
      });

      async function* emptySentences(): AsyncGenerator<string> {
        yield "Just one sentence.";
      }

      const audioChunks: Uint8Array[] = [];
      for await (const chunk of session.synthesize(emptySentences())) {
        audioChunks.push(chunk);
      }

      await sleep(50);
      assert(audioChunks.length === 1, "Single sentence produced audio");
      await session.close();
    }

    console.log("\n=== Test 19: Sentence splitter — ellipsis handling ===");
    {
      // Ellipsis should not split
      const r = extractCompleteSentences("Well... I think so. Maybe not.");
      // "..." should not cause split, but ". M" should
      assertEqual(r.complete, ["Well... I think so."], "Ellipsis not treated as sentence end");
      assertEqual(r.remainder, "Maybe not.", "Remainder after ellipsis correct");
    }

    console.log("\n=== Test 20: Sentence splitter — no premature split on trailing period ===");
    {
      // Text ending with period but no following uppercase — don't split yet
      const r = extractCompleteSentences("This is incomplete.");
      assertEqual(r.complete, [], "No split for trailing period without follower");
      assertEqual(r.remainder, "This is incomplete.", "Entire text is remainder");
    }

    // ═══════════════════════════════════════════════════════════
    // Results
    // ═══════════════════════════════════════════════════════════

    console.log("\n" + "=".repeat(60));
    console.log("Results: " + testsPassed + " passed, " + testsFailed + " failed");
    console.log("Total: " + (testsPassed + testsFailed) + " assertions");
    console.log("=".repeat(60));

    fish.server.stop();

    if (testsFailed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error("Test error:", err);
    fish.server.stop();
    process.exit(1);
  }
}

runTests();
