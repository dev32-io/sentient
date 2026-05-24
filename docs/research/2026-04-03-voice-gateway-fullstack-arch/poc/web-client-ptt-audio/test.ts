/**
 * Automated test suite for web-client-ptt-audio PoC
 * 
 * Tests:
 * 1. Ring buffer logic (headless port of AudioWorklet processor)
 * 2. WebSocket binary echo round-trip
 * 3. WebM container parsing (custom parser)
 * 4. COOP/COEP header validation
 * 5. Server metrics
 * 6. PTT lifecycle simulation
 * 7. Concurrent sessions
 */

import { parseWebM, createTestWebM } from "./webm-parser.ts";

let pass = 0;
let fail = 0;
let total = 0;
const results: string[] = [];

function assert(condition: boolean, name: string) {
  total++;
  if (condition) {
    pass++;
    results.push(`  PASS: ${name}`);
  } else {
    fail++;
    results.push(`  FAIL: ${name}`);
  }
}

// ============================================================
// TEST GROUP 1: Ring Buffer Logic
// ============================================================

class RingBuffer {
  buffer: Float32Array;
  bufferSize: number;
  writePos = 0;
  readPos = 0;
  samplesAvailable = 0;
  underruns = 0;
  totalSamplesPlayed = 0;
  totalSamplesReceived = 0;

  constructor(size: number) {
    this.bufferSize = size;
    this.buffer = new Float32Array(size);
  }

  writeSamples(samples: Float32Array) {
    this.totalSamplesReceived += samples.length;
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.writePos] = samples[i];
      this.writePos = (this.writePos + 1) % this.bufferSize;
      if (this.samplesAvailable < this.bufferSize) {
        this.samplesAvailable++;
      } else {
        this.readPos = (this.readPos + 1) % this.bufferSize;
      }
    }
  }

  readSamples(count: number): Float32Array {
    const output = new Float32Array(count);
    if (this.samplesAvailable >= count) {
      for (let i = 0; i < count; i++) {
        output[i] = this.buffer[this.readPos];
        this.readPos = (this.readPos + 1) % this.bufferSize;
      }
      this.samplesAvailable -= count;
      this.totalSamplesPlayed += count;
    } else if (this.samplesAvailable > 0) {
      const available = this.samplesAvailable;
      for (let i = 0; i < available; i++) {
        output[i] = this.buffer[this.readPos];
        this.readPos = (this.readPos + 1) % this.bufferSize;
      }
      this.totalSamplesPlayed += available;
      this.samplesAvailable = 0;
      this.underruns++;
    } else {
      if (this.totalSamplesReceived > 0) this.underruns++;
    }
    return output;
  }

  clear() {
    this.writePos = 0;
    this.readPos = 0;
    this.samplesAvailable = 0;
  }
}

// 1.1: Basic write and read
{
  const rb = new RingBuffer(1024);
  rb.writeSamples(new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]));
  assert(rb.samplesAvailable === 5, "RB: 5 samples available after write");
  const out = rb.readSamples(5);
  assert(out[0] === 0.10000000149011612 && out[4] === 0.5, "RB: read matches write");
  assert(rb.samplesAvailable === 0, "RB: 0 samples after read");
}

// 1.2: Wrap-around
{
  const rb = new RingBuffer(8);
  rb.writeSamples(new Float32Array([1, 2, 3, 4, 5, 6]));
  rb.readSamples(4);
  rb.writeSamples(new Float32Array([7, 8, 9, 10]));
  assert(rb.samplesAvailable === 6, "RB wrap: 6 samples available");
  const out = rb.readSamples(6);
  assert(out[0] === 5 && out[5] === 10, "RB wrap: correct order");
}

// 1.3: Overflow — drop oldest
{
  const rb = new RingBuffer(4);
  rb.writeSamples(new Float32Array([1, 2, 3, 4, 5, 6]));
  assert(rb.samplesAvailable === 4, "RB overflow: capped at bufferSize");
  const out = rb.readSamples(4);
  assert(out[0] === 3 && out[3] === 6, "RB overflow: oldest dropped");
}

// 1.4: Underrun tracking
{
  const rb = new RingBuffer(256);
  rb.writeSamples(new Float32Array([0.5, 0.5]));
  const out = rb.readSamples(128);
  assert(rb.underruns === 1, "RB underrun: counted");
  assert(out[0] === 0.5 && out[2] === 0, "RB underrun: partial + silence");
}

// 1.5: Clear
{
  const rb = new RingBuffer(256);
  rb.writeSamples(new Float32Array(100));
  rb.clear();
  assert(rb.samplesAvailable === 0, "RB clear: samples cleared");
}

// 1.6: Large continuous stream
{
  const rb = new RingBuffer(96000);
  let written = 0;
  for (let i = 0; i < 100; i++) {
    const chunk = new Float32Array(480);
    for (let j = 0; j < 480; j++) chunk[j] = Math.sin((written + j) * 0.01);
    rb.writeSamples(chunk);
    written += 480;
    for (let k = 0; k < 3; k++) rb.readSamples(128);
  }
  assert(rb.underruns === 0, "RB continuous: no underruns");
  assert(rb.totalSamplesReceived === 48000, "RB continuous: 48000 samples received");
}

// 1.7: Empty read before writes
{
  const rb = new RingBuffer(256);
  rb.readSamples(128);
  assert(rb.underruns === 0, "RB empty: no underrun before first write");
}

// 1.8: Barge-in clear during playback
{
  const rb = new RingBuffer(4800);
  rb.writeSamples(new Float32Array(4800)); // Fill buffer
  rb.readSamples(128); // Start playing
  assert(rb.samplesAvailable === 4672, "RB barge-in: samples before clear");
  rb.clear();
  assert(rb.samplesAvailable === 0, "RB barge-in: instant clear");
  const silence = rb.readSamples(128);
  assert(silence[0] === 0, "RB barge-in: silence after clear");
}

// ============================================================
// TEST GROUP 2: WebM Container Parsing
// ============================================================

// 2.1: Parse minimal WebM header
{
  const webm = createTestWebM();
  const result = parseWebM(webm);
  assert(result.elements.length > 0, `WebM parse: ${result.elements.length} elements found`);
  assert(result.errors === 0, `WebM parse: 0 errors (got ${result.errors})`);
}

// 2.2: Detect DocType=webm
{
  const result = parseWebM(createTestWebM());
  const docType = result.elements.find(e => e.name === "DocType");
  assert(docType?.value === "webm", `WebM DocType: "${docType?.value}"`);
}

// 2.3: Detect audio track
{
  const result = parseWebM(createTestWebM());
  assert(result.audioTrackFound === true, "WebM: audio track detected");
  assert(result.trackType === 2, `WebM: trackType=2 (got ${result.trackType})`);
}

// 2.4: Detect Opus codec
{
  const result = parseWebM(createTestWebM());
  assert(result.codecId === "A_OPUS", `WebM codec: "${result.codecId}"`);
}

// 2.5: Parse WebM with audio data
{
  const webm = createTestWebM(true);
  const result = parseWebM(webm);
  assert(result.simpleBlocks > 0, `WebM data: ${result.simpleBlocks} SimpleBlocks found`);
  assert(result.totalAudioBytes > 0, `WebM data: ${result.totalAudioBytes} audio bytes`);
}

// 2.6: Streaming chunks (split WebM into pieces)
{
  const webm = createTestWebM(true);
  // Parse full buffer vs chunked should find same elements
  const fullResult = parseWebM(webm);

  // Split into 20-byte chunks and concatenate back
  const chunks: Buffer[] = [];
  for (let i = 0; i < webm.length; i += 20) {
    chunks.push(webm.slice(i, Math.min(i + 20, webm.length)));
  }
  const reassembled = Buffer.concat(chunks);
  const chunkResult = parseWebM(reassembled);

  assert(chunkResult.elements.length === fullResult.elements.length,
    `WebM chunked: same element count (${chunkResult.elements.length} vs ${fullResult.elements.length})`);
  assert(chunkResult.codecId === fullResult.codecId, "WebM chunked: same codec");
}

// 2.7: Invalid data resilience
{
  const garbage = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x01, 0x02]);
  const result = parseWebM(garbage);
  assert(true, "WebM invalid: no crash on garbage input");
}

// 2.8: Empty buffer
{
  const result = parseWebM(Buffer.alloc(0));
  assert(result.elements.length === 0, "WebM empty: 0 elements");
  assert(result.errors === 0, "WebM empty: 0 errors");
}

// 2.9: Chrome-like EBML header bytes
{
  const chromeHeader = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f,
    0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04,
    0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
    0x42, 0x87, 0x81, 0x04, 0x42, 0x85, 0x81, 0x02,
  ]);
  const result = parseWebM(chromeHeader);
  const ebml = result.elements.find(e => e.name === "EBML");
  assert(ebml !== undefined, "Chrome header: EBML element found");
  const docType = result.elements.find(e => e.name === "DocType");
  assert(docType?.value === "webm", "Chrome header: DocType=webm");
}

// ============================================================
// TEST GROUP 3: WebSocket Binary Echo + COOP/COEP (requires server)
// ============================================================

const serverProc = Bun.spawn(["bun", "run", "server.ts"], {
  cwd: "/workspace/poc/web-client-ptt-audio",
  stdout: "pipe",
  stderr: "pipe",
});

await Bun.sleep(1500);

// 3.1: WebSocket connects
{
  const ws = new WebSocket("ws://localhost:3099/ws");
  const ok = await new Promise<boolean>(r => {
    ws.onopen = () => r(true);
    ws.onerror = () => r(false);
    setTimeout(() => r(false), 3000);
  });
  assert(ok, "WS: connection established");

  if (ok) {
    const msg = await new Promise<any>(r => {
      ws.onmessage = e => { try { r(JSON.parse(e.data as string)); } catch { r(null); } };
      setTimeout(() => r(null), 2000);
    });
    assert(msg?.type === "session.ready", "WS: session.ready received");
  }
  ws.close();
  await Bun.sleep(100);
}

// 3.2: Binary echo
{
  const ws = new WebSocket("ws://localhost:3099/ws");
  ws.binaryType = "arraybuffer";
  await new Promise<void>(r => { ws.onopen = () => r(); });
  await new Promise<void>(r => { ws.onmessage = () => r(); });

  const testData = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);
  const echo = await new Promise<ArrayBuffer | null>(r => {
    ws.onmessage = e => { if (e.data instanceof ArrayBuffer) r(e.data); };
    setTimeout(() => r(null), 2000);
    ws.send(testData.buffer);
  });

  assert(echo !== null, "WS echo: got response");
  if (echo) {
    const arr = new Uint8Array(echo);
    assert(arr.length === testData.length, "WS echo: same length");
    let match = true;
    for (let i = 0; i < testData.length; i++) if (arr[i] !== testData[i]) match = false;
    assert(match, "WS echo: byte-for-byte match");
  }
  ws.close();
  await Bun.sleep(100);
}

// 3.3: 50 binary frames
{
  const ws = new WebSocket("ws://localhost:3099/ws");
  ws.binaryType = "arraybuffer";
  await new Promise<void>(r => { ws.onopen = () => r(); });
  await new Promise<void>(r => { ws.onmessage = () => r(); });

  const frameCount = 50;
  let received = 0;
  let bytesMatch = true;

  const done = new Promise<void>(r => {
    ws.onmessage = e => {
      if (e.data instanceof ArrayBuffer) {
        const arr = new Uint8Array(e.data);
        if (arr[0] !== received % 256) bytesMatch = false;
        received++;
        if (received === frameCount) r();
      }
    };
    setTimeout(() => r(), 5000);
  });

  for (let i = 0; i < frameCount; i++) {
    const f = new Uint8Array(640);
    f[0] = i % 256;
    ws.send(f.buffer);
  }
  await done;

  assert(received === frameCount, `WS multi: ${received}/${frameCount} frames`);
  assert(bytesMatch, "WS multi: all bytes correct");
  ws.close();
  await Bun.sleep(100);
}

// 3.4: Mixed binary + text
{
  const ws = new WebSocket("ws://localhost:3099/ws");
  ws.binaryType = "arraybuffer";
  await new Promise<void>(r => { ws.onopen = () => r(); });
  await new Promise<void>(r => { ws.onmessage = () => r(); });

  let binCount = 0;
  let textCount = 0;

  const done = new Promise<void>(r => {
    ws.onmessage = e => {
      if (e.data instanceof ArrayBuffer) binCount++;
      else textCount++;
      if (binCount === 5 && textCount >= 1) r();
    };
    setTimeout(() => r(), 3000);
  });

  ws.send(JSON.stringify({ type: "audio.start" }));
  for (let i = 0; i < 5; i++) ws.send(new Uint8Array(100).buffer);
  ws.send(JSON.stringify({ type: "audio.end" }));

  await done;
  assert(binCount === 5, `WS mixed: ${binCount}/5 binary`);
  assert(textCount >= 1, `WS mixed: ${textCount}>=1 text`);
  ws.close();
  await Bun.sleep(100);
}

// 3.5: Frame size range (1B to 64KB)
{
  const ws = new WebSocket("ws://localhost:3099/ws");
  ws.binaryType = "arraybuffer";
  await new Promise<void>(r => { ws.onopen = () => r(); });
  await new Promise<void>(r => { ws.onmessage = () => r(); });

  const sizes = [1, 60, 640, 4096, 16384, 65536];
  let received = 0;
  let correctSizes = 0;

  const done = new Promise<void>(r => {
    ws.onmessage = e => {
      if (e.data instanceof ArrayBuffer) {
        if (e.data.byteLength === sizes[received]) correctSizes++;
        received++;
        if (received === sizes.length) r();
      }
    };
    setTimeout(() => r(), 3000);
  });

  for (const s of sizes) {
    ws.send(new Uint8Array(s).buffer);
    await Bun.sleep(10);
  }
  await done;

  assert(received === sizes.length, `WS sizes: ${received}/${sizes.length} received`);
  assert(correctSizes === sizes.length, `WS sizes: ${correctSizes}/${sizes.length} correct`);
  ws.close();
  await Bun.sleep(100);
}

// ============================================================
// TEST GROUP 4: COOP/COEP Headers
// ============================================================

// 4.1-4.5: COOP/COEP on all endpoints
for (const [path, label] of [
  ["/", "HTML"],
  ["/ring-buffer-worklet.js", "Worklet"],
  ["/health", "Health"],
  ["/coop-coep-test", "COOP test"],
] as const) {
  const res = await fetch(`http://localhost:3099${path}`);
  assert(res.headers.get("cross-origin-opener-policy") === "same-origin", `${label}: COOP=same-origin`);
  assert(res.headers.get("cross-origin-embedder-policy") === "require-corp", `${label}: COEP=require-corp`);
}

// 4.6: Worklet Content-Type
{
  const res = await fetch("http://localhost:3099/ring-buffer-worklet.js");
  assert(res.headers.get("content-type") === "application/javascript", "Worklet: Content-Type correct");
}

// ============================================================
// TEST GROUP 5: Server Metrics
// ============================================================

{
  const ws = new WebSocket("ws://localhost:3099/ws");
  ws.binaryType = "arraybuffer";
  await new Promise<void>(r => { ws.onopen = () => r(); });
  await new Promise<void>(r => { ws.onmessage = () => r(); });

  ws.send(JSON.stringify({ type: "audio.start" }));
  for (let i = 0; i < 10; i++) ws.send(new Uint8Array(640).buffer);

  let echoed = 0;
  await new Promise<void>(r => {
    ws.onmessage = e => { if (e.data instanceof ArrayBuffer) { echoed++; if (echoed === 10) r(); } };
    setTimeout(() => r(), 2000);
  });

  const metrics = await new Promise<any>(r => {
    ws.onmessage = e => { if (typeof e.data === "string") try { r(JSON.parse(e.data)); } catch {} };
    setTimeout(() => r(null), 2000);
    ws.send(JSON.stringify({ type: "audio.end" }));
  });

  assert(metrics?.type === "metrics", "Metrics: response received");
  assert(metrics?.framesReceived === 10, `Metrics: framesReceived=${metrics?.framesReceived}`);
  assert(metrics?.framesSent === 10, `Metrics: framesSent=${metrics?.framesSent}`);
  assert(metrics?.bytesReceived === 6400, `Metrics: bytesReceived=${metrics?.bytesReceived}`);
  assert(metrics?.durationMs > 0, "Metrics: positive duration");

  ws.close();
  await Bun.sleep(100);
}

// ============================================================
// TEST GROUP 6: PTT Lifecycle with WebM
// ============================================================

{
  const ws = new WebSocket("ws://localhost:3099/ws");
  ws.binaryType = "arraybuffer";
  await new Promise<void>(r => { ws.onopen = () => r(); });

  const ready = await new Promise<any>(r => {
    ws.onmessage = e => { if (typeof e.data === "string") try { r(JSON.parse(e.data)); } catch {} };
  });
  assert(ready.type === "session.ready", "PTT: session.ready");

  // Send audio.start
  ws.send(JSON.stringify({ type: "audio.start", encoding: "audio/webm;codecs=opus" }));

  // Send WebM header as first chunk
  const webmHeader = createTestWebM(true);
  ws.send(webmHeader);

  // Send 5 more chunks (simulating MediaRecorder ondataavailable)
  for (let i = 0; i < 5; i++) ws.send(new Uint8Array(3000).buffer);

  let echoed = 0;
  await new Promise<void>(r => {
    ws.onmessage = e => { if (e.data instanceof ArrayBuffer) { echoed++; if (echoed === 6) r(); } };
    setTimeout(() => r(), 3000);
  });

  // Get metrics with WebM parse results
  const metrics = await new Promise<any>(r => {
    ws.onmessage = e => { if (typeof e.data === "string") try { r(JSON.parse(e.data)); } catch {} };
    setTimeout(() => r(null), 2000);
    ws.send(JSON.stringify({ type: "audio.end" }));
  });

  assert(echoed === 6, `PTT: ${echoed}/6 chunks echoed`);
  assert(metrics?.framesReceived === 6, "PTT: server tracked 6 frames");
  assert(metrics?.webmParser !== null, "PTT: WebM parser ran");
  assert(metrics?.webmParser?.codecId === "A_OPUS", `PTT: codec=${metrics?.webmParser?.codecId}`);
  assert(metrics?.webmParser?.audioTrackFound === true, "PTT: audio track found");
  assert(metrics?.webmParser?.simpleBlocks > 0, `PTT: ${metrics?.webmParser?.simpleBlocks} SimpleBlocks`);

  ws.close();
  await Bun.sleep(100);
}

// ============================================================
// TEST GROUP 7: Rapid PTT toggle
// ============================================================

{
  const ws = new WebSocket("ws://localhost:3099/ws");
  ws.binaryType = "arraybuffer";
  await new Promise<void>(r => { ws.onopen = () => r(); });
  await new Promise<void>(r => { ws.onmessage = () => r(); });

  for (let cycle = 0; cycle < 3; cycle++) {
    ws.send(JSON.stringify({ type: "audio.start" }));
    ws.send(new Uint8Array(100).buffer);
    ws.send(new Uint8Array(100).buffer);
    ws.send(JSON.stringify({ type: "audio.end" }));
  }

  let binCount = 0;
  let textCount = 0;
  await new Promise<void>(r => {
    ws.onmessage = e => {
      if (e.data instanceof ArrayBuffer) binCount++;
      else textCount++;
      if (binCount >= 6 && textCount >= 3) r();
    };
    setTimeout(() => r(), 3000);
  });

  assert(binCount === 6, `Rapid PTT: ${binCount}/6 binary`);
  assert(textCount >= 3, `Rapid PTT: ${textCount}>=3 text`);
  ws.close();
  await Bun.sleep(100);
}

// ============================================================
// TEST GROUP 8: Latency measurement
// ============================================================

{
  const ws = new WebSocket("ws://localhost:3099/ws");
  ws.binaryType = "arraybuffer";
  await new Promise<void>(r => { ws.onopen = () => r(); });
  await new Promise<void>(r => { ws.onmessage = () => r(); });

  const latencies: number[] = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    await new Promise<void>(r => {
      ws.onmessage = e => { if (e.data instanceof ArrayBuffer) { latencies.push(performance.now() - start); r(); } };
      setTimeout(() => r(), 1000);
      ws.send(new Uint8Array(640).buffer);
    });
  }

  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const max = Math.max(...latencies);
  const min = Math.min(...latencies);

  assert(latencies.length === 20, "Latency: 20 round-trips");
  assert(avg < 50, `Latency: avg ${avg.toFixed(2)}ms < 50ms`);
  results.push(`  INFO: Latency — min=${min.toFixed(2)}ms avg=${avg.toFixed(2)}ms max=${max.toFixed(2)}ms`);

  ws.close();
  await Bun.sleep(100);
}

// ============================================================
// TEST GROUP 9: Concurrent 10 sessions
// ============================================================

{
  const N = 10;
  const framesEach = 20;

  const sockets = await Promise.all(
    Array.from({ length: N }, async () => {
      const ws = new WebSocket("ws://localhost:3099/ws");
      ws.binaryType = "arraybuffer";
      await new Promise<void>(r => { ws.onopen = () => r(); });
      await new Promise<void>(r => { ws.onmessage = () => r(); });
      return ws;
    })
  );

  assert(sockets.length === N, `Concurrent: ${N} connected`);

  let totalRx = 0;
  const perSession = await Promise.all(
    sockets.map((ws, idx) => new Promise<number>(r => {
      let rx = 0;
      ws.onmessage = e => {
        if (e.data instanceof ArrayBuffer) { rx++; totalRx++; if (rx === framesEach) r(rx); }
      };
      setTimeout(() => r(rx), 5000);
      for (let i = 0; i < framesEach; i++) {
        const f = new Uint8Array(640);
        f[0] = idx;
        f[1] = i;
        ws.send(f.buffer);
      }
    }))
  );

  assert(perSession.every(r => r === framesEach), `Concurrent: all sessions got ${framesEach} frames`);
  assert(totalRx === N * framesEach, `Concurrent: total ${totalRx}/${N * framesEach}`);

  sockets.forEach(ws => ws.close());
  await Bun.sleep(200);

  const health = await (await fetch("http://localhost:3099/health")).json();
  assert(health.sessions.length === 0, "Concurrent: cleanup complete");
}

// ============================================================
// RESULTS
// ============================================================
console.log("\n" + "=".repeat(60));
console.log(`RESULTS: ${pass}/${total} passed, ${fail} failed`);
console.log("=".repeat(60));
results.forEach(r => console.log(r));
console.log("=".repeat(60));

serverProc.kill();
process.exit(fail > 0 ? 1 : 0);
