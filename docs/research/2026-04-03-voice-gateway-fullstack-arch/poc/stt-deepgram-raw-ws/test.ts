/**
 * PoC Test: Raw WebSocket to Deepgram + Double-Endpointing
 * 
 * Uses a mock Deepgram server to validate:
 * 1. Bun binary WebSocket frame sending/receiving
 * 2. Double-endpointing (speech_final vs UtteranceEnd, first-wins)
 * 3. Transcript buffer accumulation and flush logic
 * 4. KeepAlive and CloseStream control messages
 * 5. Multi-utterance sequences
 */

import { DeepgramStreamingClient } from './deepgram-client';

// ─── Mock Deepgram Server ───────────────────────────────────────────

interface MockServerState {
  binaryFramesReceived: ArrayBuffer[];
  controlMessagesReceived: any[];
  authHeader: string | null;
  queryParams: URLSearchParams | null;
}

function createMockDeepgramServer(port: number): { server: any; state: MockServerState; sendEvent: (ws: any, event: any) => void } {
  const state: MockServerState = {
    binaryFramesReceived: [],
    controlMessagesReceived: [],
    authHeader: null,
    queryParams: null,
  };

  let activeWs: any = null;

  const server = Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);
      state.authHeader = req.headers.get('authorization');
      state.queryParams = url.searchParams;
      
      if (server.upgrade(req)) {
        return undefined;
      }
      return new Response('Not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        activeWs = ws;
        // Send metadata on connect (like real Deepgram)
        ws.send(JSON.stringify({
          type: 'Metadata',
          transaction_key: 'mock-txn-123',
          request_id: 'mock-req-456',
          sha256: 'mock-sha',
          created: new Date().toISOString(),
          duration: 0,
          channels: 1,
          models: ['nova-3'],
        }));
      },
      message(ws, data) {
        if (typeof data === 'string') {
          try {
            const msg = JSON.parse(data);
            state.controlMessagesReceived.push(msg);
            
            if (msg.type === 'CloseStream') {
              ws.close(1000, 'CloseStream received');
            }
          } catch {}
        } else {
          // Binary frame — store it
          if (data instanceof ArrayBuffer) {
            state.binaryFramesReceived.push(data);
          } else {
            // Buffer (Bun sends Buffer for binary)
            state.binaryFramesReceived.push(new Uint8Array(data).buffer);
          }
        }
      },
      close(ws) {
        activeWs = null;
      },
    },
  });

  function sendEvent(ws: any, event: any) {
    if (activeWs) {
      activeWs.send(JSON.stringify(event));
    }
  }

  return { server, state, sendEvent };
}

// ─── Deepgram Protocol Message Builders ─────────────────────────────

function makeResults(opts: {
  transcript: string;
  confidence?: number;
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
  duration?: number;
}) {
  return {
    type: 'Results',
    channel_index: [0, 1],
    duration: opts.duration ?? 1.5,
    start: opts.start ?? 0,
    is_final: opts.is_final ?? false,
    speech_final: opts.speech_final ?? false,
    channel: {
      alternatives: [{
        transcript: opts.transcript,
        confidence: opts.confidence ?? 0.98,
        words: opts.transcript.split(' ').map((w, i) => ({
          word: w,
          start: (opts.start ?? 0) + i * 0.3,
          end: (opts.start ?? 0) + (i + 1) * 0.3,
          confidence: opts.confidence ?? 0.98,
        })),
      }],
    },
  };
}

function makeSpeechStarted() {
  return { type: 'SpeechStarted', channel_index: [0], timestamp: 0.5 };
}

function makeUtteranceEnd() {
  return { type: 'UtteranceEnd', channel_index: [0], last_word_end: 2.5 };
}

// ─── Test Helpers ───────────────────────────────────────────────────

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

// ─── Tests ──────────────────────────────────────────────────────────

async function runTests() {
  const MOCK_PORT = 19876;
  const { server, state, sendEvent } = createMockDeepgramServer(MOCK_PORT);

  try {
    // ── Test 1: Connection + Auth ──
    console.log("\n=== Test 1: Connection and Auth ===");
    
    const client = new DeepgramStreamingClient({
      apiKey: 'test-key-12345',
      model: 'nova-3',
      endpointing: 300,
      utteranceEndMs: 1000,
    });

    let openReceived = false;
    client.on((event) => {
      if (event.type === 'open') openReceived = true;
    });

    await client.connect("ws://localhost:" + MOCK_PORT);
    await sleep(50);

    assert(client.isOpen, "Client reports open");
    assert(openReceived, "Open event emitted");
    assert(state.authHeader === 'Token test-key-12345', "Auth header sent correctly: " + state.authHeader);
    assert(state.queryParams !== null, "Query params sent");
    
    client.forceClose();
    await sleep(50);

    // ── Test 2: Binary Frame Transmission ──
    console.log("\n=== Test 2: Binary Frame Transmission ===");
    
    state.binaryFramesReceived = [];
    state.controlMessagesReceived = [];
    
    const client2 = new DeepgramStreamingClient({ apiKey: 'test-key' });
    await client2.connect("ws://localhost:" + MOCK_PORT);
    await sleep(50);

    // Send 100 simulated 320-byte audio frames (20ms of 16kHz 16-bit PCM)
    const frameSize = 320 * 2; // 320 samples * 2 bytes (16-bit)
    const frames: Uint8Array[] = [];
    for (let i = 0; i < 100; i++) {
      const frame = new Uint8Array(frameSize);
      // Fill with pseudo-audio (sine wave pattern)
      for (let j = 0; j < frameSize; j += 2) {
        const sample = Math.floor(Math.sin(j / 10 + i) * 16000);
        frame[j] = sample & 0xFF;
        frame[j + 1] = (sample >> 8) & 0xFF;
      }
      frames.push(frame);
      client2.sendAudio(frame);
    }
    
    await sleep(200);

    assert(state.binaryFramesReceived.length === 100, 
      "All 100 binary frames received (got " + state.binaryFramesReceived.length + ")");
    
    // Verify frame content integrity
    const firstRecv = new Uint8Array(state.binaryFramesReceived[0]);
    const firstSent = frames[0];
    let contentMatch = true;
    for (let i = 0; i < firstSent.length; i++) {
      if (firstRecv[i] !== firstSent[i]) {
        contentMatch = false;
        break;
      }
    }
    assert(contentMatch, "Binary frame content integrity preserved");
    assertEqual(firstRecv.length, frameSize, "Frame size correct (" + frameSize + " bytes)");

    client2.forceClose();
    await sleep(50);

    // ── Test 3: Double-Endpointing — speech_final wins ──
    console.log("\n=== Test 3: Double-Endpointing (speech_final first) ===");
    
    state.binaryFramesReceived = [];
    state.controlMessagesReceived = [];
    
    const client3 = new DeepgramStreamingClient({ apiKey: 'test-key' });
    const flushes3: Array<{ text: string; trigger: string }> = [];
    client3.onFlush((text, trigger) => {
      flushes3.push({ text, trigger });
    });

    const events3: string[] = [];
    client3.on((event) => {
      events3.push(event.type);
    });

    await client3.connect("ws://localhost:" + MOCK_PORT);
    await sleep(50);

    // Simulate: interim → is_final → speech_final → UtteranceEnd
    sendEvent(null, makeSpeechStarted());
    await sleep(10);
    
    // Interim result (not accumulated)
    sendEvent(null, makeResults({ transcript: 'what is the', is_final: false }));
    await sleep(10);
    
    // Final result (accumulated in buffer)
    sendEvent(null, makeResults({ transcript: 'what is the weather', is_final: true }));
    await sleep(10);
    
    // speech_final — should trigger flush
    sendEvent(null, makeResults({ transcript: '', is_final: true, speech_final: true }));
    await sleep(50);
    
    assertEqual(flushes3.length, 1, "Exactly one flush triggered");
    assertEqual(flushes3[0]?.trigger, 'speech_final', "Flush triggered by speech_final");
    assertEqual(flushes3[0]?.text, 'what is the weather', "Correct accumulated text");
    
    // UtteranceEnd arrives after — should NOT trigger second flush (already flushed)
    sendEvent(null, makeUtteranceEnd());
    await sleep(50);
    
    assertEqual(flushes3.length, 1, "No second flush after UtteranceEnd (first-wins)");
    assert(events3.includes('speech_started'), "SpeechStarted event emitted");
    assert(events3.includes('utterance_end'), "UtteranceEnd event still emitted");

    client3.forceClose();
    await sleep(50);

    // ── Test 4: Double-Endpointing — UtteranceEnd wins ──
    console.log("\n=== Test 4: Double-Endpointing (UtteranceEnd first) ===");
    
    state.binaryFramesReceived = [];
    state.controlMessagesReceived = [];
    
    const client4 = new DeepgramStreamingClient({ apiKey: 'test-key' });
    const flushes4: Array<{ text: string; trigger: string }> = [];
    client4.onFlush((text, trigger) => {
      flushes4.push({ text, trigger });
    });

    await client4.connect("ws://localhost:" + MOCK_PORT);
    await sleep(50);

    // Simulate noisy environment: is_final arrives, then UtteranceEnd before speech_final
    sendEvent(null, makeResults({ transcript: 'turn on the lights', is_final: true, start: 0 }));
    await sleep(10);
    
    // UtteranceEnd arrives first (noisy room, VAD stalls)
    sendEvent(null, makeUtteranceEnd());
    await sleep(50);
    
    assertEqual(flushes4.length, 1, "Exactly one flush triggered");
    assertEqual(flushes4[0]?.trigger, 'utterance_end', "Flush triggered by utterance_end");
    assertEqual(flushes4[0]?.text, 'turn on the lights', "Correct text");
    
    // Late speech_final — should NOT trigger second flush
    sendEvent(null, makeResults({ transcript: '', is_final: true, speech_final: true }));
    await sleep(50);
    
    assertEqual(flushes4.length, 1, "No second flush (first-wins)");

    client4.forceClose();
    await sleep(50);

    // ── Test 5: Multi-Segment Utterance ──
    console.log("\n=== Test 5: Multi-Segment Utterance ===");
    
    const client5 = new DeepgramStreamingClient({ apiKey: 'test-key' });
    const flushes5: Array<{ text: string; trigger: string }> = [];
    client5.onFlush((text, trigger) => {
      flushes5.push({ text, trigger });
    });

    await client5.connect("ws://localhost:" + MOCK_PORT);
    await sleep(50);

    // Simulate multi-segment: two is_final segments before speech_final
    sendEvent(null, makeResults({ transcript: 'hey can you', is_final: true, start: 0 }));
    await sleep(10);
    sendEvent(null, makeResults({ transcript: 'set a timer for five minutes', is_final: true, start: 1.0 }));
    await sleep(10);
    sendEvent(null, makeResults({ transcript: '', is_final: true, speech_final: true }));
    await sleep(50);
    
    assertEqual(flushes5.length, 1, "Single flush for multi-segment");
    assertEqual(flushes5[0]?.text, 'hey can you set a timer for five minutes', "Segments joined correctly");

    client5.forceClose();
    await sleep(50);

    // ── Test 6: Multiple Utterances (state reset) ──
    console.log("\n=== Test 6: Multiple Sequential Utterances ===");
    
    const client6 = new DeepgramStreamingClient({ apiKey: 'test-key' });
    const flushes6: Array<{ text: string; trigger: string }> = [];
    client6.onFlush((text, trigger) => {
      flushes6.push({ text, trigger });
    });

    await client6.connect("ws://localhost:" + MOCK_PORT);
    await sleep(50);

    // Utterance 1
    sendEvent(null, makeResults({ transcript: 'hello there', is_final: true }));
    await sleep(10);
    sendEvent(null, makeResults({ transcript: '', is_final: true, speech_final: true }));
    await sleep(50);
    
    // Utterance 2 (state should be reset)
    sendEvent(null, makeResults({ transcript: 'how are you', is_final: true }));
    await sleep(10);
    sendEvent(null, makeUtteranceEnd());
    await sleep(50);

    assertEqual(flushes6.length, 2, "Two flushes for two utterances");
    assertEqual(flushes6[0]?.text, 'hello there', "First utterance correct");
    assertEqual(flushes6[0]?.trigger, 'speech_final', "First triggered by speech_final");
    assertEqual(flushes6[1]?.text, 'how are you', "Second utterance correct");
    assertEqual(flushes6[1]?.trigger, 'utterance_end', "Second triggered by utterance_end");

    client6.forceClose();
    await sleep(50);

    // ── Test 7: KeepAlive Messages ──
    console.log("\n=== Test 7: KeepAlive + CloseStream Control Messages ===");
    
    state.controlMessagesReceived = [];
    
    const client7 = new DeepgramStreamingClient({ apiKey: 'test-key' });
    await client7.connect("ws://localhost:" + MOCK_PORT);
    
    // Wait long enough for at least one keepalive (interval is 8s, we'll check what we can)
    // For PoC, just verify close sends CloseStream
    client7.close(); // graceful close
    await sleep(100);
    
    const closeMsg = state.controlMessagesReceived.find((m: any) => m.type === 'CloseStream');
    assert(closeMsg !== undefined, "CloseStream message sent on graceful close");

    await sleep(50);

    // ── Test 8: Empty Transcript Handling ──
    console.log("\n=== Test 8: Empty Transcript (no spurious flush) ===");
    
    const client8 = new DeepgramStreamingClient({ apiKey: 'test-key' });
    const flushes8: Array<{ text: string; trigger: string }> = [];
    client8.onFlush((text, trigger) => {
      flushes8.push({ text, trigger });
    });

    await client8.connect("ws://localhost:" + MOCK_PORT);
    await sleep(50);

    // Empty is_final (happens with silence)
    sendEvent(null, makeResults({ transcript: '', is_final: true }));
    await sleep(10);
    sendEvent(null, makeResults({ transcript: '', is_final: true, speech_final: true }));
    await sleep(50);
    
    assertEqual(flushes8.length, 0, "No flush for empty transcripts");

    client8.forceClose();
    await sleep(50);

    // ── Test 9: Barge-in Reset ──
    console.log("\n=== Test 9: Barge-in Buffer Reset ===");
    
    const client9 = new DeepgramStreamingClient({ apiKey: 'test-key' });
    const flushes9: Array<{ text: string; trigger: string }> = [];
    client9.onFlush((text, trigger) => {
      flushes9.push({ text, trigger });
    });

    await client9.connect("ws://localhost:" + MOCK_PORT);
    await sleep(50);

    // Start accumulating
    sendEvent(null, makeResults({ transcript: 'tell me about', is_final: true }));
    await sleep(10);
    
    // User barges in — reset buffer
    client9.resetBuffer();
    
    // speech_final for old utterance — should not flush (buffer was cleared)
    sendEvent(null, makeResults({ transcript: '', is_final: true, speech_final: true }));
    await sleep(50);
    
    assertEqual(flushes9.length, 0, "No flush after barge-in reset");
    
    // New utterance should work normally
    sendEvent(null, makeResults({ transcript: 'never mind play music', is_final: true }));
    await sleep(10);
    sendEvent(null, makeResults({ transcript: '', is_final: true, speech_final: true }));
    await sleep(50);
    
    assertEqual(flushes9.length, 1, "New utterance flushes normally after reset");
    assertEqual(flushes9[0]?.text, 'never mind play music', "Correct post-reset text");

    client9.forceClose();
    await sleep(50);

    // ── Test 10: Binary Frame Throughput ──
    console.log("\n=== Test 10: Binary Frame Throughput Benchmark ===");
    
    state.binaryFramesReceived = [];
    
    const client10 = new DeepgramStreamingClient({ apiKey: 'test-key' });
    await client10.connect("ws://localhost:" + MOCK_PORT);
    await sleep(50);

    const FRAME_COUNT = 5000;
    const frame = new Uint8Array(640); // 20ms of 16kHz 16-bit PCM
    for (let i = 0; i < frame.length; i++) frame[i] = i & 0xFF;

    const startTime = performance.now();
    for (let i = 0; i < FRAME_COUNT; i++) {
      client10.sendAudio(frame);
    }
    const sendTime = performance.now() - startTime;
    
    // Wait for all frames to arrive
    await sleep(500);
    
    const recvCount = state.binaryFramesReceived.length;
    console.log("  Sent " + FRAME_COUNT + " frames in " + sendTime.toFixed(1) + "ms (" + (FRAME_COUNT / sendTime * 1000).toFixed(0) + " frames/sec)");
    console.log("  Received " + recvCount + " / " + FRAME_COUNT + " frames");
    assert(recvCount >= FRAME_COUNT * 0.99, "At least 99% frames received (" + recvCount + "/" + FRAME_COUNT + ")");
    
    // Real-time requirement: 50 frames/sec per session (20ms frames)
    const framesPerSec = FRAME_COUNT / sendTime * 1000;
    assert(framesPerSec > 500, "Throughput > 500 frames/sec (got " + framesPerSec.toFixed(0) + ", need 50/session × 10 sessions = 500)");

    client10.forceClose();
    await sleep(50);

    // ── Results ──
    console.log("\n" + "=".repeat(50));
    console.log("Results: " + testsPassed + " passed, " + testsFailed + " failed");
    console.log("=".repeat(50));

    server.stop();
    
    if (testsFailed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error("Test error:", err);
    server.stop();
    process.exit(1);
  }
}

runTests();
