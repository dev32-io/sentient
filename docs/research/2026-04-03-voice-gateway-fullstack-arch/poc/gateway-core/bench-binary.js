// Benchmark binary frame relay (simulating audio passthrough)
const { WebSocketServer } = require("ws");
const http = require("http");

const PORT = 9102;
const server = http.createServer();
const wss = new WebSocketServer({ server });

// Simulate 320-byte Opus frames (20ms @ 128kbps)
const OPUS_FRAME = Buffer.alloc(320, 0xAB);
let frameCount = 0;
let startTime;
const DURATION_MS = 5000;

wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    frameCount++;
    ws.send(data); // relay back (simulating STT/TTS relay)
  });
});

server.listen(PORT, () => {
  console.log(`Node binary relay server on ${PORT}`);
  const WebSocket = require("ws");
  const clients = [];
  let connected = 0;

  // 5 sessions (typical family usage)
  for (let i = 0; i < 5; i++) {
    const c = new WebSocket(`ws://localhost:${PORT}`);
    clients.push(c);
    c.on("open", () => {
      connected++;
      if (connected === 5) startBench();
    });
  }

  function startBench() {
    startTime = Date.now();
    frameCount = 0;

    for (const c of clients) {
      c.on("message", () => {
        if (Date.now() - startTime < DURATION_MS) {
          c.send(OPUS_FRAME);
        }
      });
      c.send(OPUS_FRAME);
    }

    setTimeout(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      const mem = process.memoryUsage();
      console.log(`\n--- Node.js Binary Relay Results ---`);
      console.log(`5 sessions, ${elapsed.toFixed(1)}s`);
      console.log(`Total frames relayed: ${frameCount}`);
      console.log(`Frames/sec: ${(frameCount / elapsed).toFixed(0)}`);
      console.log(`Frames/sec/session: ${(frameCount / elapsed / 5).toFixed(0)}`);
      console.log(`RSS: ${(mem.rss / 1024 / 1024).toFixed(1)}MB`);
      console.log(`(Need ~50 frames/sec/session for real-time Opus @ 20ms)`);
      clients.forEach(c => c.close());
      server.close();
      process.exit(0);
    }, DURATION_MS + 500);
  }
});
